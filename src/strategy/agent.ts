/**
 * DLMM LP Agent - Main Orchestrator
 *
 * Ties everything together:
 * 1. Scan for tokens (4-tier filter)
 * 2. Find DLMM pools
 * 3. Open LP positions
 * 4. Monitor & rebalance
 * 5. Auto-exit on risk limits
 * 6. Auto-entry in full_auto mode
 */

import { Connection, Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import bs58 from 'bs58';
import axios from 'axios';
import { logger } from '../utils/logger';
import {
  STRATEGY_CONFIG,
  POSITION_CONFIG,
  OPERATION_MODE,
  WALLET_CONFIG,
  TIME_CONSTANTS,
  EMERGENCY_STOPS,
  getRpcUrl,
  validateConfig,
} from '../config/constants';
import { DLMMPoolReader } from '../core/dlmm.pool';
import { TokenScanner } from '../scanner/token.scanner';
import { PositionManager, Position } from './position.manager';
import { Rebalancer } from './rebalancer';
import * as db from '../database/position.db';
import * as telegram from '../notifications/telegram.alert';
import { registerCommandHandlers, startCommandPolling, stopCommandPolling } from '../notifications/telegram.alert';
import { PoolDiscovery, DiscoveredCandidate } from '../scanner/pool.discovery';
import { scanHighVolume, shouldAlert, markAlerted, formatTokenAlert } from '../scanner/volume.scanner';
import * as poolMemory from '../memory/pool.memory';
import { recordPositionClose, formatLessonsForTelegram, getPerformanceSummary } from '../memory/lessons';
import { LPStrategy, getDefaultPreset } from '../memory/strategy.library';

const TOKEN_ENTRIES_FILE = path.join(process.cwd(), 'data', 'token-entries.json');

export interface AgentStatus {
  running: boolean;
  mode: string;
  paper: boolean;
  uptime: number;
  positions: number;
  totalValue: number;
  totalPnl: number;
  totalPnlPct: number;
  feesEarned: number;
  cyclesCompleted: number;
  lastScan: number;
  lastRebalance: number;
}

export class DLMMAgent {
  private connection: Connection;
  private wallet: Keypair | null = null;
  private poolReader: DLMMPoolReader;
  private scanner: TokenScanner;
  private positionManager: PositionManager;
  private rebalancer: Rebalancer;
  private discovery: PoolDiscovery;

  private running = false;
  private startTime = 0;
  private cyclesCompleted = 0;
  private lastScanTime = 0;
  private lastRebalanceTime = 0;
  private lastSnapshotDate = '';

  // Track re-entries per token mint address
  private tokenEntryCount: Map<string, number> = new Map();

  // Emergency stop state
  private rpcFailureCount = 0;
  private dailyPnl = 0;
  private dailyPnlDate = '';
  private lastSolPrice = 0;
  private lastSolPriceTime = 0;
  private emergencyPaused = false;

  private readonly SOL_MINT = 'So11111111111111111111111111111111111111112';

  constructor() {
    const rpcUrl = getRpcUrl();
    this.connection = new Connection(rpcUrl, 'confirmed');

    if (WALLET_CONFIG.PRIVATE_KEY && !OPERATION_MODE.PAPER_TRADING) {
      try {
        this.wallet = Keypair.fromSecretKey(bs58.decode(WALLET_CONFIG.PRIVATE_KEY));
        logger.info(`Wallet loaded: ${this.wallet.publicKey.toBase58()}`);
      } catch {
        logger.error('Invalid wallet private key');
      }
    }

    this.poolReader = new DLMMPoolReader(this.connection);
    this.scanner = new TokenScanner(this.connection);
    this.positionManager = new PositionManager(this.connection, this.wallet);
    this.rebalancer = new Rebalancer(this.connection, this.poolReader, this.positionManager);
    this.discovery = new PoolDiscovery(this.connection);
  }

  /**
   * Start the agent
   */
  async start(): Promise<void> {
    if (!validateConfig()) {
      logger.error('Invalid configuration. Aborting.');
      return;
    }

    this.running = true;
    this.startTime = Date.now();

    // Recover persisted state
    this.loadTokenEntries();
    const savedPositions = db.loadPositions();
    if (savedPositions.length > 0) {
      this.positionManager.restorePositions(savedPositions);
      const open = this.positionManager.getOpenPositions();
      if (open.length > 0) {
        logger.info(`Recovered ${open.length} open position(s) from disk`);
        await telegram.sendAlert(`♻️ Recovered ${open.length} open position(s) from previous session`);
      }
    }

    const mode = OPERATION_MODE.PAPER_TRADING ? 'PAPER' : 'LIVE';
    logger.info('='.repeat(50));
    logger.info('  DLMM LP AGENT STARTED');
    logger.info(`  Mode: ${mode} (${OPERATION_MODE.MODE})`);
    logger.info(`  Capital: $${STRATEGY_CONFIG.STARTING_CAPITAL}`);
    logger.info(`  Max Positions: ${STRATEGY_CONFIG.MAX_POSITIONS}`);
    logger.info(`  Target: +${STRATEGY_CONFIG.PROFIT_TARGET_PERCENT}%`);
    logger.info(`  Risk: -${STRATEGY_CONFIG.MAX_LOSS_PERCENT}% loss, -${STRATEGY_CONFIG.MAX_IL_PERCENT}% IL`);
    logger.info(`  Timeout: ${STRATEGY_CONFIG.POSITION_TIMEOUT_HOURS}h`);
    logger.info('='.repeat(50));

    const perf = getPerformanceSummary();
    const perfMsg = perf.totalTrades > 0
      ? `\nHistory: ${perf.totalTrades} trades | WR: ${(perf.winRate * 100).toFixed(0)}% | Avg PnL: ${perf.avgPnlPercent.toFixed(1)}%`
      : '';

    await telegram.sendAlert(
      `🤖 <b>DLMM LP Agent Started</b>\nMode: ${mode} (${OPERATION_MODE.MODE})\nCapital: $${STRATEGY_CONFIG.STARTING_CAPITAL}\nMax Positions: ${STRATEGY_CONFIG.MAX_POSITIONS}\nTarget: +${STRATEGY_CONFIG.PROFIT_TARGET_PERCENT}%\nTimeout: ${STRATEGY_CONFIG.POSITION_TIMEOUT_HOURS}h${perfMsg}`,
    );

    registerCommandHandlers(
      () => this.getStatus(),
      () => this.positionManager.getOpenPositions(),
      () => this.scanCandidatesForTelegram(),
      (poolAddress, mintAddress, symbol, strategy) => this.enterFromTelegram(poolAddress, mintAddress, symbol, strategy),
      (positionId) => this.positionManager.claimFees(positionId),
      (positionId) => this.positionManager.compoundFees(positionId),
    );
    startCommandPolling();

    // Main loop
    while (this.running) {
      try {
        await this.cycle();
        this.cyclesCompleted++;

        const waitMs = Math.min(TIME_CONSTANTS.REBALANCE_INTERVAL_MS, 5 * 60 * 1000);
        logger.info(`Cycle #${this.cyclesCompleted} complete. Next in ${(waitMs / 1000 / 60).toFixed(1)}min`);
        await this.sleep(waitMs);
      } catch (error) {
        logger.error(`Cycle error: ${error}`);
        this.rpcFailureCount++;
        await this.sleep(30000);
      }
    }

    logger.info('Agent stopped.');
  }

  /**
   * Single agent cycle
   */
  async cycle(): Promise<void> {
    // ── Emergency stop checks ──
    if (this.emergencyPaused) {
      logger.warn('EMERGENCY PAUSE active. Only monitoring positions — no new entries.');
    }

    // Check SOL price for dump detection
    await this.checkSolPrice();

    // Check daily drawdown
    this.checkDailyDrawdown();

    // RPC failure check
    if (this.rpcFailureCount >= EMERGENCY_STOPS.RPC_FAILURE_COUNT) {
      logger.error(`RPC failure count (${this.rpcFailureCount}) exceeds threshold. Entering degraded mode.`);
      this.emergencyPaused = true;
      await telegram.sendAlert(`🚨 <b>Emergency: RPC failures exceeded threshold</b>\nFailures: ${this.rpcFailureCount}\nPausing auto-entry.`);
    }

    const openPositions = this.positionManager.getOpenPositions();
    logger.info(`--- Cycle #${this.cyclesCompleted + 1} | Positions: ${openPositions.length}/${STRATEGY_CONFIG.MAX_POSITIONS} | Paused: ${this.emergencyPaused} ---`);

    // 1. Update all positions
    for (const pos of openPositions) {
      await this.positionManager.updatePosition(pos.id);
    }

    // 2. Check profit target - auto-exit when hit
    for (const pos of this.positionManager.getOpenPositions()) {
      if (pos.pnlPercent >= STRATEGY_CONFIG.PROFIT_TARGET_PERCENT) {
        logger.info(`TARGET HIT: ${pos.id} at +${pos.pnlPercent.toFixed(2)}%`);
        await telegram.sendAlert(
          `🎯 <b>TARGET HIT!</b>\nPosition: ${pos.id.slice(0, 16)}...\nPnL: +${pos.pnlPercent.toFixed(2)}%\nValue: $${pos.currentValueUsd.toFixed(2)}\nFees: $${pos.feesEarned.toFixed(4)}\nGas: $${pos.gasCosts.toFixed(6)}\n\nAuto-closing...`,
        );
        const closed = await this.positionManager.closePosition(pos.id, 'take_profit');
        if (closed) {
          await telegram.notifyPositionClosed(closed);
          this.recordClose(closed);
          this.trackDailyPnl(closed.pnl);
        }
      }
    }

    // 3. Check risk limits (loss/IL)
    const alerts = this.positionManager.checkRiskLimits();
    for (const alert of alerts) {
      logger.warn(`RISK ALERT: ${alert.reason}`);
      await telegram.notifyRiskAlert(alert.positionId, alert.reason);
      const exitReason = alert.reason.includes('IL') ? 'il_limit' : 'stop_loss';
      const closed = await this.positionManager.closePosition(alert.positionId, exitReason);
      if (closed) {
        await telegram.notifyPositionClosed(closed);
        this.recordClose(closed);
        this.trackDailyPnl(closed.pnl);
      }
    }

    // 4. Rebalance existing positions
    const rebalResult = await this.rebalancer.runCycle();
    if (rebalResult.rebalanced > 0 || rebalResult.closed > 0) {
      logger.info(`Rebalance: ${rebalResult.rebalanced} rebalanced, ${rebalResult.closed} closed`);
    }
    this.lastRebalanceTime = Date.now();

    // 5. Auto-entry in full_auto mode
    const currentOpen = this.positionManager.getOpenPositions().length;
    if (OPERATION_MODE.MODE === 'full_auto' && currentOpen < STRATEGY_CONFIG.MAX_POSITIONS && !this.emergencyPaused) {
      const slotsAvailable = STRATEGY_CONFIG.MAX_POSITIONS - currentOpen;
      await this.scanAndEnter(slotsAvailable);
    } else if (currentOpen === 0) {
      logger.info('No open positions. Use /dlmm in Telegram to scan & enter.');
    }

    // 6. Background volume scanner
    try {
      const scanned = await scanHighVolume();
      for (const t of scanned.slice(0, 3)) {
        if (shouldAlert(t.mint)) {
          markAlerted(t.mint);
          await telegram.sendAlert(formatTokenAlert(t));
        }
      }
    } catch (error) {
      logger.debug(`Volume scan error: ${error}`);
      this.rpcFailureCount++;
    }

    // 7. Daily performance snapshot
    this.checkDailySnapshot();

    // 8. Persist positions + token entries
    db.savePositions(this.positionManager.getAllPositions());
    this.saveTokenEntries();

    // 9. Print status
    this.printStatus();

    // Reset RPC failure count on successful cycle
    this.rpcFailureCount = Math.max(0, this.rpcFailureCount - 1);
  }

  /**
   * Scan for tokens and enter new positions (used by auto mode)
   */
  async scanAndEnter(maxNew: number): Promise<void> {
    logger.info(`[Auto] Scanning for ${maxNew} new position(s)...`);
    this.lastScanTime = Date.now();

    try {
      const candidates = await this.discovery.discoverCandidates(maxNew * 3);
      logger.info(`[Auto] Found ${candidates.length} candidates`);

      for (const candidate of candidates) {
        if (maxNew <= 0) break;

        // Skip existing positions
        const existing = this.positionManager.getOpenPositions()
          .find(p => p.poolAddress === candidate.poolAddress);
        if (existing) continue;

        // Skip pools on cooldown
        if (poolMemory.isOnCooldown(candidate.poolAddress)) {
          logger.info(`[Auto] Skipping ${candidate.symbol}: pool on cooldown`);
          continue;
        }

        // Check re-entry limit
        const entryCount = this.tokenEntryCount.get(candidate.mintAddress) || 0;
        if (entryCount >= STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN) {
          logger.info(`[Auto] Skipping ${candidate.symbol}: max re-entries (${entryCount}/${STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN})`);
          continue;
        }

        // Pool memory score check
        const memScore = poolMemory.getPoolScore(candidate.poolAddress);
        if (memScore < 30) {
          logger.info(`[Auto] Skipping ${candidate.symbol}: low pool score (${memScore}/100)`);
          continue;
        }

        // Analyze pool
        const analysis = await this.poolReader.analyzePool(candidate.poolAddress);
        if (!analysis) continue;

        // Use strategy preset for auto-entry
        const strategy = getDefaultPreset();
        const positionSize = STRATEGY_CONFIG.STARTING_CAPITAL;
        const position = await this.positionManager.openPosition(
          candidate.poolAddress,
          positionSize,
          analysis.suggestedRange.min,
          analysis.suggestedRange.max,
          candidate.symbol,
          strategy,
        );

        if (position) {
          maxNew--;
          this.tokenEntryCount.set(candidate.mintAddress, entryCount + 1);
          this.saveTokenEntries();
          await telegram.notifyPositionOpened(position);
          await telegram.sendAlert(
            `📊 <b>Auto Entry #${entryCount + 1}/${STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN}</b>\nToken: ${candidate.symbol}\nCapital: $${positionSize}\nScore: ${candidate.score}\nVolume 24h: $${candidate.volume24h.toLocaleString()}\nStrategy: ${strategy.id}`,
          );
          logger.info(`[Auto] Entry #${entryCount + 1}: $${positionSize} in ${candidate.symbol} score: ${candidate.score}`);
        }
      }
    } catch (error) {
      logger.error(`[Auto] Scan and enter failed: ${error}`);
      this.rpcFailureCount++;
    }
  }

  /**
   * Get current agent status
   */
  getStatus(): AgentStatus {
    const pnl = this.positionManager.getTotalPnL();
    return {
      running: this.running,
      mode: OPERATION_MODE.MODE,
      paper: OPERATION_MODE.PAPER_TRADING,
      uptime: Date.now() - this.startTime,
      positions: this.positionManager.getOpenPositions().length,
      totalValue: this.positionManager.getTotalValue(),
      totalPnl: pnl.pnl,
      totalPnlPct: pnl.pnlPercent,
      feesEarned: pnl.fees,
      cyclesCompleted: this.cyclesCompleted,
      lastScan: this.lastScanTime,
      lastRebalance: this.lastRebalanceTime,
    };
  }

  /**
   * Print status summary
   */
  printStatus(): void {
    const status = this.getStatus();
    const positions = this.positionManager.getOpenPositions();
    const upHours = (status.uptime / TIME_CONSTANTS.MILLISECONDS_PER_HOUR).toFixed(1);

    logger.info('─'.repeat(40));
    logger.info(`Status | ${status.paper ? 'PAPER' : 'LIVE'} | Uptime: ${upHours}h | Cycles: ${status.cyclesCompleted} | Paused: ${this.emergencyPaused}`);
    logger.info(`Value: $${status.totalValue.toFixed(2)} | PnL: $${status.totalPnl.toFixed(4)} (${status.totalPnlPct.toFixed(2)}%) | Fees: $${status.feesEarned.toFixed(4)}`);
    logger.info(`Daily PnL: $${this.dailyPnl.toFixed(4)} | RPC fails: ${this.rpcFailureCount}`);

    for (const pos of positions) {
      const hoursOpen = ((Date.now() - pos.entryTime) / (1000 * 60 * 60)).toFixed(1);
      logger.info(`  ${pos.id.slice(0, 12)}... | $${pos.currentValueUsd.toFixed(2)} | PnL: ${pos.pnlPercent.toFixed(2)}% | IL: ${pos.ilPercent.toFixed(2)}% | Fees: $${pos.feesEarned.toFixed(4)} | Gas: $${pos.gasCosts.toFixed(6)} | ${hoursOpen}h`);
    }
    logger.info('─'.repeat(40));
  }

  /**
   * Scan candidates for Telegram interactive selection.
   */
  async scanCandidatesForTelegram(): Promise<DiscoveredCandidate[]> {
    logger.info('[Telegram] Scanning candidates...');
    try {
      const candidates = await this.discovery.discoverCandidates(5);
      const filtered = candidates.filter(c => {
        const entryCount = this.tokenEntryCount.get(c.mintAddress) || 0;
        return entryCount < STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN;
      });
      logger.info(`[Telegram] Returning ${filtered.length} candidates`);
      return filtered;
    } catch (error) {
      logger.error(`[Telegram] Scan failed: ${error}`);
      return [];
    }
  }

  /**
   * Enter a position from Telegram user selection.
   */
  async enterFromTelegram(poolAddress: string, mintAddress: string, symbol: string, strategy?: LPStrategy): Promise<boolean> {
    const resolvedStrategy = strategy ?? getDefaultPreset();
    logger.info(`[Telegram] Entry: ${symbol} (${poolAddress}) | Strategy: ${resolvedStrategy.id}`);

    const openPositions = this.positionManager.getOpenPositions();
    if (openPositions.length >= STRATEGY_CONFIG.MAX_POSITIONS) {
      logger.warn('[Telegram] Max positions reached');
      return false;
    }

    const entryCount = this.tokenEntryCount.get(mintAddress) || 0;
    if (entryCount >= STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN) {
      logger.warn(`[Telegram] Max re-entries reached for ${symbol}`);
      return false;
    }

    try {
      const analysis = await this.poolReader.analyzePool(poolAddress);
      if (!analysis) {
        logger.error(`[Telegram] Pool analysis failed`);
        return false;
      }

      if (poolMemory.isOnCooldown(poolAddress)) {
        logger.warn(`[Telegram] Pool ${symbol} is on cooldown`);
        await telegram.sendAlert(`⛔ <b>${symbol}</b> pool is on cooldown.`);
        return false;
      }

      const positionSize = STRATEGY_CONFIG.STARTING_CAPITAL;
      const position = await this.positionManager.openPosition(
        poolAddress,
        positionSize,
        analysis.suggestedRange.min,
        analysis.suggestedRange.max,
        symbol,
        resolvedStrategy,
      );

      if (position) {
        this.tokenEntryCount.set(mintAddress, entryCount + 1);
        this.saveTokenEntries();
        await telegram.notifyPositionOpened(position);
        logger.info(`[Telegram] Entry #${entryCount + 1}: $${positionSize} in ${symbol}`);
        db.savePositions(this.positionManager.getAllPositions());
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`[Telegram] Entry failed: ${error}`);
      return false;
    }
  }

  /**
   * Stop the agent gracefully
   */
  stop(): void {
    logger.info('Stopping agent...');
    this.running = false;
    stopCommandPolling();
  }

  // ── Private helpers ──

  private recordClose(pos: Position): void {
    const symbol = pos.tokenSymbol ?? pos.tokenX.slice(0, 8);
    const reason = pos.exitReason ?? 'manual';

    poolMemory.recordClose({
      poolAddress: pos.poolAddress,
      tokenSymbol: symbol,
      positionId: pos.id,
      entryTime: pos.entryTime,
      exitTime: Date.now(),
      entryPrice: pos.entryPrice,
      exitPrice: pos.currentPrice,
      pnlPercent: pos.pnlPercent,
      feesEarned: pos.feesEarned,
      exitReason: reason,
    });

    recordPositionClose({
      tokenSymbol: symbol,
      poolAddress: pos.poolAddress,
      pnlPercent: pos.pnlPercent,
      feesEarned: pos.feesEarned,
      durationMs: Date.now() - pos.entryTime,
      exitReason: reason,
    });
  }

  /**
   * Emergency: check SOL price for dump detection
   */
  private async checkSolPrice(): Promise<void> {
    try {
      const now = Date.now();
      // Check every 5 minutes
      if (now - this.lastSolPriceTime < 5 * 60 * 1000) return;

      const resp = await axios.get(
        'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112',
        { timeout: 5000 },
      );
      const pairs = resp.data?.pairs;
      if (pairs && pairs.length > 0) {
        const solPrice = parseFloat(pairs[0].priceUsd || '0');
        if (solPrice > 0) {
          if (this.lastSolPrice > 0) {
            const changePct = ((solPrice - this.lastSolPrice) / this.lastSolPrice) * 100;
            if (changePct <= -EMERGENCY_STOPS.SOL_DUMP_PERCENT) {
              logger.error(`SOL DUMP DETECTED: ${changePct.toFixed(2)}% in last 5min!`);
              await telegram.sendAlert(
                `🚨 <b>SOL DUMP ALERT!</b>\nSOL: $${solPrice.toFixed(2)} (${changePct.toFixed(2)}%)\nThreshold: -${EMERGENCY_STOPS.SOL_DUMP_PERCENT}%\n\nClosing all positions...`,
              );
              // Close all open positions
              for (const pos of this.positionManager.getOpenPositions()) {
                const closed = await this.positionManager.closePosition(pos.id, 'stop_loss');
                if (closed) {
                  await telegram.notifyPositionClosed(closed);
                  this.recordClose(closed);
                  this.trackDailyPnl(closed.pnl);
                }
              }
              this.emergencyPaused = true;
            }
          }
          this.lastSolPrice = solPrice;
          this.lastSolPriceTime = now;
        }
      }
    } catch {
      // Non-fatal: SOL price check is best-effort
    }
  }

  /**
   * Emergency: check daily drawdown
   */
  private checkDailyDrawdown(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyPnlDate) {
      this.dailyPnl = 0;
      this.dailyPnlDate = today;
    }

    const drawdownPct = (this.dailyPnl / STRATEGY_CONFIG.STARTING_CAPITAL) * 100;
    if (drawdownPct <= -EMERGENCY_STOPS.MAX_DAILY_DRAWDOWN) {
      logger.error(`Daily drawdown ${drawdownPct.toFixed(2)}% exceeds threshold -${EMERGENCY_STOPS.MAX_DAILY_DRAWDOWN}%`);
      this.emergencyPaused = true;
    }
  }

  private trackDailyPnl(pnl: number): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyPnlDate) {
      this.dailyPnl = 0;
      this.dailyPnlDate = today;
    }
    this.dailyPnl += pnl;
  }

  /**
   * Daily performance snapshot
   */
  private async checkDailySnapshot(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastSnapshotDate) {
      this.lastSnapshotDate = today;
      try {
        const snapshot = db.buildDailySnapshot(this.positionManager.getAllPositions());
        db.savePerformance(snapshot);
        await telegram.sendAlert(
          `📊 <b>Daily Summary</b>\nDate: ${today}\nPnL: $${snapshot.totalPnl.toFixed(4)} (${snapshot.totalPnlPercent.toFixed(2)}%)\nFees: $${snapshot.totalFeesEarned.toFixed(4)}\nPositions: ${snapshot.positionsClosed} closed, ${snapshot.positionsOpen} open\nBest: ${snapshot.bestPosition?.tokenSymbol ?? 'N/A'} ${snapshot.bestPosition?.pnlPercent.toFixed(2) ?? ''}%\nWorst: ${snapshot.worstPosition?.tokenSymbol ?? 'N/A'} ${snapshot.worstPosition?.pnlPercent.toFixed(2) ?? ''}%`,
        );
      } catch (error) {
        logger.debug(`Daily snapshot error: ${error}`);
      }
    }
  }

  /**
   * Load token entry counts from disk
   */
  private loadTokenEntries(): void {
    try {
      if (fs.existsSync(TOKEN_ENTRIES_FILE)) {
        const data = JSON.parse(fs.readFileSync(TOKEN_ENTRIES_FILE, 'utf8'));
        this.tokenEntryCount = new Map(Object.entries(data));
        logger.info(`Loaded ${this.tokenEntryCount.size} token entry records`);
      }
    } catch {
      logger.debug('No token entries file found or invalid — starting fresh');
    }
  }

  /**
   * Save token entry counts to disk
   */
  private saveTokenEntries(): void {
    try {
      const data = Object.fromEntries(this.tokenEntryCount);
      const tmp = TOKEN_ENTRIES_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, TOKEN_ENTRIES_FILE);
    } catch (error) {
      logger.debug(`Failed to save token entries: ${error}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
