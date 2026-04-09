/**
 * DLMM LP Agent - Main Orchestrator
 *
 * Ties everything together:
 * 1. Scan for tokens (4-tier filter)
 * 2. Find DLMM pools
 * 3. Open LP positions
 * 4. Monitor & rebalance
 * 5. Auto-exit on risk limits
 */

import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
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

  // Track re-entries per token mint address: { mint -> entryCount }
  private tokenEntryCount: Map<string, number> = new Map();

  // SOL mint for pairing
  private readonly SOL_MINT = 'So11111111111111111111111111111111111111112';

  constructor() {
    const rpcUrl = getRpcUrl();
    this.connection = new Connection(rpcUrl, 'confirmed');

    // Setup wallet if available
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

    const mode = OPERATION_MODE.PAPER_TRADING ? 'PAPER' : 'LIVE';
    logger.info('='.repeat(50));
    logger.info('  DLMM LP AGENT STARTED');
    logger.info(`  Mode: ${mode}`);
    logger.info(`  Capital: $${STRATEGY_CONFIG.STARTING_CAPITAL}`);
    logger.info(`  Max Positions: ${STRATEGY_CONFIG.MAX_POSITIONS}`);
    logger.info(`  Target: +${STRATEGY_CONFIG.TARGET_DAILY_GAIN}%/day`);
    logger.info(`  Risk: -${STRATEGY_CONFIG.MAX_LOSS_PERCENT}% max loss, -${STRATEGY_CONFIG.MAX_IL_PERCENT}% max IL`);
    logger.info('='.repeat(50));

    const perf = getPerformanceSummary();
    const perfMsg = perf.totalTrades > 0
      ? `\nHistory: ${perf.totalTrades} trades | WR: ${(perf.winRate * 100).toFixed(0)}% | Avg PnL: ${perf.avgPnlPercent.toFixed(1)}%`
      : '';

    await telegram.sendAlert(
      `🤖 <b>DLMM LP Agent Started</b>\nMode: ${mode}\nCapital: $${STRATEGY_CONFIG.STARTING_CAPITAL}\nMax Positions: ${STRATEGY_CONFIG.MAX_POSITIONS}\nTarget: +${STRATEGY_CONFIG.PROFIT_TARGET_PERCENT}%\nMax Re-entry: ${STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN}x per token${perfMsg}`,
    );

    // Start Telegram command listener with scan & entry providers
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

        // Wait before next cycle
        const waitMs = Math.min(TIME_CONSTANTS.REBALANCE_INTERVAL_MS, 5 * 60 * 1000); // Max 5 min
        logger.info(`Cycle #${this.cyclesCompleted} complete. Next in ${(waitMs / 1000 / 60).toFixed(1)}min`);
        await this.sleep(waitMs);
      } catch (error) {
        logger.error(`Cycle error: ${error}`);
        await this.sleep(30000); // Wait 30s on error
      }
    }

    logger.info('Agent stopped.');
  }

  /**
   * Single agent cycle
   */
  async cycle(): Promise<void> {
    const openPositions = this.positionManager.getOpenPositions();
    logger.info(`--- Cycle #${this.cyclesCompleted + 1} | Positions: ${openPositions.length}/${STRATEGY_CONFIG.MAX_POSITIONS} ---`);

    // 1. Update all positions
    for (const pos of openPositions) {
      await this.positionManager.updatePosition(pos.id);
    }

    // 2. Check profit target - auto-exit when hit
    for (const pos of this.positionManager.getOpenPositions()) {
      if (pos.pnlPercent >= STRATEGY_CONFIG.PROFIT_TARGET_PERCENT) {
        logger.info(`TARGET HIT: ${pos.id} at +${pos.pnlPercent.toFixed(2)}% (target: ${STRATEGY_CONFIG.PROFIT_TARGET_PERCENT}%)`);
        await telegram.sendAlert(
          `🎯 <b>TARGET HIT!</b>\nPosition: ${pos.id.slice(0, 16)}...\nPnL: +${pos.pnlPercent.toFixed(2)}%\nValue: $${pos.currentValueUsd.toFixed(2)}\nFees: $${pos.feesEarned.toFixed(4)}\n\nAuto-closing position...`,
        );
        const closed = await this.positionManager.closePosition(pos.id, 'take_profit');
        if (closed) {
          await telegram.notifyPositionClosed(closed);
          this.recordClose(closed);
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
      }
    }

    // 4. Rebalance existing positions
    const rebalResult = await this.rebalancer.runCycle();
    if (rebalResult.rebalanced > 0 || rebalResult.closed > 0) {
      logger.info(`Rebalance: ${rebalResult.rebalanced} rebalanced, ${rebalResult.closed} closed`);
    }
    this.lastRebalanceTime = Date.now();

    // 5. Entry is now user-driven via /dlmm Telegram command
    // Auto-scan disabled — user picks tokens interactively
    const currentOpen = this.positionManager.getOpenPositions().length;
    if (currentOpen === 0) {
      logger.info('No open positions. Use /dlmm in Telegram to scan & enter.');
    }

    // 6. Background volume scanner — auto-alert high volume tokens
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
    }

    // 7. Persist positions
    db.savePositions(this.positionManager.getAllPositions());

    // 8. Print status
    this.printStatus();
  }

  /**
   * Scan for tokens and enter new positions
   */
  async scanAndEnter(maxNew: number): Promise<void> {
    logger.info(`Scanning for ${maxNew} new position(s)...`);
    this.lastScanTime = Date.now();

    try {
      // Auto-discover trending tokens with DLMM pools
      const candidates = await this.discovery.discoverCandidates(maxNew * 3);
      logger.info(`Found ${candidates.length} candidates from auto-discovery`);

      for (const candidate of candidates) {
        if (maxNew <= 0) break;

        // Skip if we already have an OPEN position in this pool
        const existing = this.positionManager.getOpenPositions()
          .find(p => p.poolAddress === candidate.poolAddress);
        if (existing) continue;

        // Skip pools on cooldown (bad recent exit)
        if (poolMemory.isOnCooldown(candidate.poolAddress)) {
          logger.info(`Skipping ${candidate.symbol}: pool on cooldown`);
          continue;
        }

        // Check re-entry limit per token (max 3x entry for same token)
        const entryCount = this.tokenEntryCount.get(candidate.mintAddress) || 0;
        if (entryCount >= STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN) {
          logger.info(`Skipping ${candidate.symbol}: max re-entries reached (${entryCount}/${STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN})`);
          continue;
        }

        // Log pool memory score for transparency
        const memScore = poolMemory.getPoolScore(candidate.poolAddress);
        if (memScore < 30) {
          logger.info(`Skipping ${candidate.symbol}: low pool memory score (${memScore}/100)`);
          continue;
        }

        // Analyze pool
        const analysis = await this.poolReader.analyzePool(candidate.poolAddress);
        if (!analysis) continue;

        // All-in: use full capital for single position
        const positionSize = STRATEGY_CONFIG.STARTING_CAPITAL;
        const position = await this.positionManager.openPosition(
          candidate.poolAddress,
          positionSize,
          analysis.suggestedRange.min,
          analysis.suggestedRange.max,
          candidate.symbol,
        );

        if (position) {
          maxNew--;
          // Track entry count for this token
          this.tokenEntryCount.set(candidate.mintAddress, entryCount + 1);
          await telegram.notifyPositionOpened(position);
          await telegram.sendAlert(
            `📊 <b>ALL-IN Entry #${entryCount + 1}/${STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN}</b>\nToken: ${candidate.symbol}\nCapital: $${positionSize}\nScore: ${candidate.score}\nVolume 24h: $${candidate.volume24h.toLocaleString()}`,
          );
          logger.info(`ALL-IN entry #${entryCount + 1}: $${positionSize} in ${candidate.symbol} (${candidate.poolAddress.slice(0, 8)}...) score: ${candidate.score}`);
        }
      }
    } catch (error) {
      logger.error(`Scan and enter failed: ${error}`);
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
    logger.info(`Status | ${status.paper ? 'PAPER' : 'LIVE'} | Uptime: ${upHours}h | Cycles: ${status.cyclesCompleted}`);
    logger.info(`Value: $${status.totalValue.toFixed(2)} | PnL: $${status.totalPnl.toFixed(4)} (${status.totalPnlPct.toFixed(2)}%) | Fees: $${status.feesEarned.toFixed(4)}`);

    for (const pos of positions) {
      logger.info(`  ${pos.id.slice(0, 12)}... | $${pos.currentValueUsd.toFixed(2)} | PnL: ${pos.pnlPercent.toFixed(2)}% | IL: ${pos.ilPercent.toFixed(2)}%`);
    }
    logger.info('─'.repeat(40));
  }

  /**
   * Scan candidates for Telegram interactive selection.
   * Returns top 5 scored candidates.
   */
  async scanCandidatesForTelegram(): Promise<DiscoveredCandidate[]> {
    logger.info('[Telegram] Scanning candidates for user selection...');
    try {
      const candidates = await this.discovery.discoverCandidates(5);

      // Filter out tokens that already hit max re-entry
      const filtered = candidates.filter(c => {
        const entryCount = this.tokenEntryCount.get(c.mintAddress) || 0;
        return entryCount < STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN;
      });

      logger.info(`[Telegram] Returning ${filtered.length} candidates for selection`);
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
    logger.info(`[Telegram] User selected entry: ${symbol} (${poolAddress}) | Strategy: ${resolvedStrategy.id}`);

    // Check if we have room
    const openPositions = this.positionManager.getOpenPositions();
    if (openPositions.length >= STRATEGY_CONFIG.MAX_POSITIONS) {
      logger.warn('[Telegram] Max positions reached');
      return false;
    }

    // Check re-entry limit
    const entryCount = this.tokenEntryCount.get(mintAddress) || 0;
    if (entryCount >= STRATEGY_CONFIG.MAX_REENTRY_PER_TOKEN) {
      logger.warn(`[Telegram] Max re-entries reached for ${symbol}`);
      return false;
    }

    try {
      // Analyze pool
      const analysis = await this.poolReader.analyzePool(poolAddress);
      if (!analysis) {
        logger.error(`[Telegram] Pool analysis failed for ${poolAddress}`);
        return false;
      }

      // Check pool cooldown before Telegram entry too
      if (poolMemory.isOnCooldown(poolAddress)) {
        logger.warn(`[Telegram] Pool ${symbol} is on cooldown — entry blocked`);
        await telegram.sendAlert(`⛔ <b>${symbol}</b> pool is on cooldown (recent bad exit). Try another token.`);
        return false;
      }

      // All-in entry
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
        await telegram.notifyPositionOpened(position);
        logger.info(`[Telegram] Entry #${entryCount + 1}: $${positionSize} in ${symbol}`);
        // Persist immediately
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

  /**
   * Record a closed position into pool memory + lessons system.
   */
  private recordClose(pos: Position): void {
    const symbol = pos.tokenSymbol ?? pos.tokenX.slice(0, 8);
    const reason = pos.exitReason ?? 'manual';

    poolMemory.recordClose({
      poolAddress:   pos.poolAddress,
      tokenSymbol:   symbol,
      positionId:    pos.id,
      entryTime:     pos.entryTime,
      exitTime:      Date.now(),
      entryPrice:    pos.entryPrice,
      exitPrice:     pos.currentPrice,
      pnlPercent:    pos.pnlPercent,
      feesEarned:    pos.feesEarned,
      exitReason:    reason,
    });

    recordPositionClose({
      tokenSymbol:  symbol,
      poolAddress:  pos.poolAddress,
      pnlPercent:   pos.pnlPercent,
      feesEarned:   pos.feesEarned,
      durationMs:   Date.now() - pos.entryTime,
      exitReason:   reason,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
