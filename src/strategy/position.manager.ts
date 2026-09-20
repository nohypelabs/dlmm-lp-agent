/**
 * Position Manager
 *
 * Manages LP positions lifecycle:
 * - Open positions (add liquidity to DLMM bins)
 * - Track positions (value, PnL, IL) using proper DLMM concentrated liquidity math
 * - Close positions (remove liquidity)
 * - Paper trading simulation with fee estimation
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import { StrategyType } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import { logger } from '../utils/logger';
import { STRATEGY_CONFIG, POSITION_CONFIG, OPERATION_MODE } from '../config/constants';
import { LPStrategy } from '../memory/strategy.library';

export interface Position {
  id: string;
  poolAddress: string;
  tokenX: string;
  tokenY: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  onChainPositionKey?: string;
  binRange: { min: number; max: number };
  entryPrice: number;
  entryTime: number;
  amountX: number;
  amountY: number;
  totalValueUsd: number;
  currentValueUsd: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  ilPercent: number;
  feesEarned: number;
  gasCosts: number;
  status: 'open' | 'closed' | 'rebalancing';
  isPaper: boolean;
  tokenSymbol?: string;
  strategy?: string;
  exitReason?: 'take_profit' | 'stop_loss' | 'il_limit' | 'rebalance' | 'manual';
  lastFeeUpdateTime?: number;
}

export class PositionManager {
  private connection: Connection;
  private wallet: Keypair | null;
  public positions: Map<string, Position> = new Map();
  private isPaper: boolean;

  constructor(connection: Connection, wallet: Keypair | null = null) {
    this.connection = connection;
    this.wallet = wallet;
    this.isPaper = OPERATION_MODE.PAPER_TRADING || !wallet;
  }

  /**
   * Restore positions from persisted data (called on startup).
   */
  restorePositions(saved: Position[]): void {
    for (const pos of saved) {
      if (pos.status === 'open') {
        if (pos.gasCosts === undefined) pos.gasCosts = 0;
        if (pos.lastFeeUpdateTime === undefined) pos.lastFeeUpdateTime = pos.entryTime;
        this.positions.set(pos.id, pos);
        logger.info(`Recovered position ${pos.id}: ${pos.tokenSymbol ?? 'unknown'} $${pos.currentValueUsd.toFixed(2)}`);
      }
    }
  }

  /**
   * Calculate token amounts for a DLMM concentrated liquidity position
   * based on current price vs the position's bin range.
   *
   * In DLMM, as price moves through bins, the X/Y composition changes:
   * - Price up: position sells X for Y (less X, more Y)
   * - Price down: position sells Y for X (more X, less Y)
   * - Out of range high: 100% Y (all sold to Y)
   * - Out of range low: 100% X (all sold to X)
   */
  private calculateBinAmounts(
    entryAmountX: number,
    entryAmountY: number,
    entryPrice: number,
    currentPrice: number,
    binRangeMin: number,
    binRangeMax: number,
  ): { amountX: number; amountY: number } {
    // Convert bin IDs to prices (approximate: each bin step is ~1%)
    // binPrice = entryPrice * (1.01)^(binId - activeBinId)
    // For simplicity, use the entry price as the active bin reference
    const binStepPct = 0.01; // 1% per bin (standard DLMM)
    const priceLow = entryPrice * Math.pow(1 + binStepPct, binRangeMin);
    const priceHigh = entryPrice * Math.pow(1 + binStepPct, binRangeMax);

    // Total liquidity value at entry (L = value / f(price))
    // For concentrated liquidity: value = L * (2*sqrt(P) - sqrt(Pa) - P/sqrt(Pb))
    // Simplified: track ratio of change

    if (currentPrice <= priceLow) {
      // Out of range LOW: position is 100% token X
      // At entry, total value was split. Now all converted to X at the lower bound price.
      const entryValue = entryAmountX * entryPrice + entryAmountY;
      return { amountX: entryValue / priceLow, amountY: 0 };
    }

    if (currentPrice >= priceHigh) {
      // Out of range HIGH: position is 100% token Y
      const entryValue = entryAmountX * entryPrice + entryAmountY;
      return { amountX: 0, amountY: entryValue };
    }

    // In range: use concentrated liquidity formula
    // L = totalValue / (2*sqrt(P) - sqrt(Pa) - P/sqrt(Pb))
    const entryValue = entryAmountX * entryPrice + entryAmountY;
    const sqrtPa = Math.sqrt(priceLow);
    const sqrtPb = Math.sqrt(priceHigh);
    const sqrtP0 = Math.sqrt(entryPrice);
    const L = entryValue / (2 * sqrtP0 - sqrtPa - entryPrice / sqrtPb);

    // At current price P:
    const sqrtP = Math.sqrt(currentPrice);
    const yAmount = L * (sqrtP - sqrtPa);
    const xAmount = L * (1 / sqrtP - 1 / sqrtPb);

    return {
      amountX: Math.max(0, xAmount),
      amountY: Math.max(0, yAmount),
    };
  }

  /**
   * Calculate impermanent loss for a concentrated liquidity position.
   * IL = (positionValue - hodlValue) / hodlValue
   * Returns negative number (loss). We return absolute value for display.
   */
  private calculateDLMMIL(
    entryAmountX: number,
    entryAmountY: number,
    entryPrice: number,
    currentPrice: number,
    binRangeMin: number,
    binRangeMax: number,
  ): number {
    const { amountX, amountY } = this.calculateBinAmounts(
      entryAmountX, entryAmountY, entryPrice, currentPrice, binRangeMin, binRangeMax,
    );

    const currentValue = amountX * currentPrice + amountY;
    const hodlValue = entryAmountX * currentPrice + entryAmountY;

    if (hodlValue === 0) return 0;
    // IL is always negative or zero
    return Math.abs(((hodlValue - currentValue) / hodlValue) * 100);
  }

  /**
   * Open a new LP position
   */
  async openPosition(
    poolAddress: string,
    amountUsd: number,
    minBinId: number,
    maxBinId: number,
    tokenSymbol?: string,
    strategy?: LPStrategy,
  ): Promise<Position | null> {
    const openPositions = this.getOpenPositions();
    if (openPositions.length >= STRATEGY_CONFIG.MAX_POSITIONS) {
      logger.warn(`Max positions reached (${STRATEGY_CONFIG.MAX_POSITIONS}). Cannot open new.`);
      return null;
    }

    const maxSize = POSITION_CONFIG.POSITION_SIZE;
    if (amountUsd > maxSize) {
      logger.warn(`Position size $${amountUsd} exceeds max $${maxSize}. Capping.`);
      amountUsd = maxSize;
    }

    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
      const activeBin = await dlmmPool.getActiveBin();
      const entryPrice = activeBin.pricePerToken
        ? parseFloat(activeBin.pricePerToken)
        : 0;

      if (entryPrice <= 0) {
        logger.error('Invalid entry price from active bin');
        return null;
      }

      const positionId = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const tokenXDecimals = dlmmPool.tokenX.mint.decimals;
      const tokenYDecimals = dlmmPool.tokenY.mint.decimals;

      const effectiveSide = strategy?.side ?? 'both';
      const effectiveMinBin = strategy
        ? activeBin.binId - strategy.binsBelow
        : minBinId;
      const effectiveMaxBin = strategy
        ? activeBin.binId + strategy.binsAbove
        : maxBinId;

      if (this.isPaper) {
        // Paper trading: simulate position
        let paperAmountX: number;
        let paperAmountY: number;
        if (effectiveSide === 'token_only') {
          paperAmountX = amountUsd / entryPrice;
          paperAmountY = 0;
        } else if (effectiveSide === 'sol_only') {
          paperAmountX = 0;
          paperAmountY = amountUsd;
        } else {
          paperAmountX = amountUsd / 2 / entryPrice;
          paperAmountY = amountUsd / 2;
        }

        const position: Position = {
          id: positionId,
          poolAddress,
          tokenX: dlmmPool.tokenX.publicKey.toBase58(),
          tokenY: dlmmPool.tokenY.publicKey.toBase58(),
          tokenXDecimals,
          tokenYDecimals,
          binRange: { min: effectiveMinBin, max: effectiveMaxBin },
          entryPrice,
          entryTime: Date.now(),
          amountX: paperAmountX,
          amountY: paperAmountY,
          totalValueUsd: amountUsd,
          currentValueUsd: amountUsd,
          currentPrice: entryPrice,
          pnl: 0,
          pnlPercent: 0,
          ilPercent: 0,
          feesEarned: 0,
          gasCosts: 0,
          status: 'open',
          isPaper: true,
          tokenSymbol,
          strategy: strategy?.id ?? 'spot_balanced',
          lastFeeUpdateTime: Date.now(),
        };

        this.positions.set(positionId, position);
        logger.info(`[PAPER] Opened position ${positionId}: $${amountUsd} in ${poolAddress}`);
        logger.info(`  Strategy: ${position.strategy} | Side: ${effectiveSide} | Range: bins ${effectiveMinBin}-${effectiveMaxBin} | Entry: $${entryPrice.toFixed(6)}`);
        return position;
      }

      // Live trading
      if (!this.wallet) {
        logger.error('No wallet configured for live trading');
        return null;
      }

      const shapeToStrategyType = (shape: LPStrategy['shape']): StrategyType => {
        switch (shape) {
          case 'curve':   return StrategyType.Curve;
          case 'bid_ask': return StrategyType.BidAsk;
          default:        return StrategyType.Spot;
        }
      };
      const strategyType = strategy ? shapeToStrategyType(strategy.shape) : StrategyType.Spot;

      let totalXAmount: BN;
      let totalYAmount: BN;
      if (effectiveSide === 'token_only') {
        totalXAmount = new BN(Math.floor((amountUsd / entryPrice) * 10 ** dlmmPool.tokenX.mint.decimals));
        totalYAmount = new BN(0);
      } else if (effectiveSide === 'sol_only') {
        totalXAmount = new BN(0);
        totalYAmount = new BN(Math.floor(amountUsd * 10 ** dlmmPool.tokenY.mint.decimals));
      } else {
        totalXAmount = new BN(Math.floor((amountUsd / 2 / entryPrice) * 10 ** dlmmPool.tokenX.mint.decimals));
        totalYAmount = new BN(Math.floor((amountUsd / 2) * 10 ** dlmmPool.tokenY.mint.decimals));
      }

      const newPosition = new Keypair();
      const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: this.wallet.publicKey,
        totalXAmount,
        totalYAmount,
        strategy: {
          maxBinId: effectiveMaxBin,
          minBinId: effectiveMinBin,
          strategyType,
        },
      });

      // Sign and send with retry
      let totalGas = 0;
      for (const tx of Array.isArray(createPositionTx) ? createPositionTx : [createPositionTx]) {
        const sig = await this.sendWithRetry(tx, [this.wallet, newPosition]);
        totalGas += 0.000005; // ~5000 lamports per tx estimate
        logger.info(`[LIVE] Open TX confirmed: ${sig}`);
      }

      const liveAmountX = totalXAmount.toNumber() / 10 ** dlmmPool.tokenX.mint.decimals;
      const liveAmountY = totalYAmount.toNumber() / 10 ** dlmmPool.tokenY.mint.decimals;

      const position: Position = {
        id: positionId,
        poolAddress,
        tokenX: dlmmPool.tokenX.publicKey.toBase58(),
        tokenY: dlmmPool.tokenY.publicKey.toBase58(),
        tokenXDecimals,
        tokenYDecimals,
        onChainPositionKey: newPosition.publicKey.toBase58(),
        binRange: { min: effectiveMinBin, max: effectiveMaxBin },
        entryPrice,
        entryTime: Date.now(),
        amountX: liveAmountX,
        amountY: liveAmountY,
        totalValueUsd: amountUsd,
        currentValueUsd: amountUsd,
        currentPrice: entryPrice,
        pnl: 0,
        pnlPercent: 0,
        ilPercent: 0,
        feesEarned: 0,
        gasCosts: totalGas,
        status: 'open',
        isPaper: false,
        tokenSymbol,
        strategy: strategy?.id ?? 'spot_balanced',
        lastFeeUpdateTime: Date.now(),
      };

      this.positions.set(positionId, position);
      logger.info(`[LIVE] Opened position ${positionId}: $${amountUsd} | Strategy: ${position.strategy} | Side: ${effectiveSide}`);
      return position;
    } catch (error) {
      logger.error(`Failed to open position: ${error}`);
      return null;
    }
  }

  /**
   * Update position with current prices and proper DLMM value calculation.
   */
  async updatePosition(positionId: string): Promise<Position | null> {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open') return null;

    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(position.poolAddress));
      const activeBin = await dlmmPool.getActiveBin();
      const currentPrice = activeBin.pricePerToken
        ? parseFloat(activeBin.pricePerToken)
        : position.currentPrice;

      position.currentPrice = currentPrice;

      // ── Calculate current value using DLMM bin math ──
      if (!position.isPaper && position.onChainPositionKey && this.wallet) {
        // Live: fetch real on-chain position data
        try {
          const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(this.wallet.publicKey);
          const onChainPos = userPositions.find(
            p => p.publicKey.toBase58() === position.onChainPositionKey,
          );
          if (onChainPos) {
            const { feeX, feeY } = onChainPos.positionData;
            const feeXUsd =
              (parseInt(feeX.toString()) / 10 ** position.tokenXDecimals) * currentPrice;
            const feeYUsd = parseInt(feeY.toString()) / 10 ** position.tokenYDecimals;
            position.feesEarned = feeXUsd + feeYUsd;

            const totalX = onChainPos.positionData.totalXAmount;
            const totalY = onChainPos.positionData.totalYAmount;
            position.amountX = parseFloat(totalX) / 10 ** position.tokenXDecimals;
            position.amountY = parseFloat(totalY) / 10 ** position.tokenYDecimals;

            position.currentValueUsd = position.amountX * currentPrice + position.amountY;
          }
        } catch {
          // Non-fatal: use bin-based estimation
          const { amountX, amountY } = this.calculateBinAmounts(
            position.amountX, position.amountY, position.entryPrice, currentPrice,
            position.binRange.min, position.binRange.max,
          );
          position.currentValueUsd = amountX * currentPrice + amountY;
        }
      } else {
        // Paper: simulate bin-based value changes
        const { amountX, amountY } = this.calculateBinAmounts(
          position.amountX, position.amountY, position.entryPrice, currentPrice,
          position.binRange.min, position.binRange.max,
        );
        position.currentValueUsd = amountX * currentPrice + amountY;

        // ── Simulate fee accrual for paper positions ──
        const now = Date.now();
        const hoursSinceUpdate = (now - (position.lastFeeUpdateTime ?? position.entryTime)) / (1000 * 60 * 60);
        if (hoursSinceUpdate > 0.01) { // at least ~36 seconds
          // Estimate: assume position earns ~0.01-0.05% of its value per hour from fees
          // This is conservative for active DLMM pools with $50k-500k daily volume
          const hourlyFeeRate = 0.0002; // 0.02% per hour (~0.5% per day)
          const estimatedFee = position.currentValueUsd * hourlyFeeRate * hoursSinceUpdate;
          position.feesEarned += estimatedFee;
          position.lastFeeUpdateTime = now;
        }
      }

      // ── Calculate IL using DLMM concentrated liquidity formula ──
      position.ilPercent = this.calculateDLMMIL(
        position.amountX, position.amountY, position.entryPrice, currentPrice,
        position.binRange.min, position.binRange.max,
      );

      // ── Calculate PnL (includes fees, excludes gas) ──
      position.pnl = position.currentValueUsd + position.feesEarned - position.totalValueUsd - position.gasCosts;
      position.pnlPercent = (position.pnl / position.totalValueUsd) * 100;

      return position;
    } catch (error) {
      logger.error(`Failed to update position ${positionId}: ${error}`);
      return null;
    }
  }

  /**
   * Close a position (remove liquidity + claim fees)
   */
  async closePosition(positionId: string, reason: Position['exitReason'] = 'manual'): Promise<Position | null> {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open') {
      logger.warn(`Position ${positionId} not found or already closed`);
      return null;
    }

    await this.updatePosition(positionId);
    position.exitReason = reason;

    if (this.isPaper) {
      position.status = 'closed';
      logger.info(`[PAPER] Closed position ${positionId} (${reason}): PnL $${position.pnl.toFixed(4)} (${position.pnlPercent.toFixed(2)}%) Fees: $${position.feesEarned.toFixed(4)}`);
      return position;
    }

    if (!this.wallet) {
      logger.error('No wallet configured for live trading');
      return null;
    }

    if (!position.onChainPositionKey) {
      logger.error(`Position ${positionId} has no on-chain key — cannot close`);
      return null;
    }

    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(position.poolAddress));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(this.wallet.publicKey);
      const onChainPos = userPositions.find(
        p => p.publicKey.toBase58() === position.onChainPositionKey,
      );

      if (!onChainPos) {
        logger.warn(`On-chain position ${position.onChainPositionKey} not found — may already be closed`);
        position.status = 'closed';
        return position;
      }

      const removeTxs = await dlmmPool.removeLiquidity({
        user: this.wallet.publicKey,
        position: onChainPos.publicKey,
        fromBinId: onChainPos.positionData.lowerBinId,
        toBinId: onChainPos.positionData.upperBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      let gasCost = 0;
      for (const tx of removeTxs) {
        const sig = await this.sendWithRetry(tx, [this.wallet]);
        gasCost += 0.000005;
        logger.info(`[LIVE] Remove liquidity TX confirmed: ${sig}`);
      }
      position.gasCosts += gasCost;

      position.status = 'closed';
      // Recalculate final PnL with gas
      position.pnl = position.currentValueUsd + position.feesEarned - position.totalValueUsd - position.gasCosts;
      position.pnlPercent = (position.pnl / position.totalValueUsd) * 100;

      logger.info(`[LIVE] Closed position ${positionId} (${reason}): PnL $${position.pnl.toFixed(4)} (${position.pnlPercent.toFixed(2)}%) | Fees: $${position.feesEarned.toFixed(4)} | Gas: $${position.gasCosts.toFixed(6)}`);
      return position;
    } catch (error) {
      logger.error(`Failed to close position ${positionId}: ${error}`);
      return null;
    }
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'open');
  }

  /**
   * Get all positions (including closed)
   */
  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get total portfolio value
   */
  getTotalValue(): number {
    return this.getOpenPositions().reduce((sum, p) => sum + p.currentValueUsd, 0);
  }

  /**
   * Get total PnL
   */
  getTotalPnL(): { pnl: number; pnlPercent: number; fees: number } {
    const positions = this.getOpenPositions();
    const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);
    const totalFees = positions.reduce((sum, p) => sum + p.feesEarned, 0);
    const totalInvested = positions.reduce((sum, p) => sum + p.totalValueUsd, 0);
    return {
      pnl: totalPnl,
      pnlPercent: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0,
      fees: totalFees,
    };
  }

  /**
   * Check if any position needs attention (IL too high, loss limit)
   */
  checkRiskLimits(): { positionId: string; reason: string }[] {
    const alerts: { positionId: string; reason: string }[] = [];

    for (const position of this.getOpenPositions()) {
      if (Math.abs(position.ilPercent) >= STRATEGY_CONFIG.MAX_IL_PERCENT) {
        alerts.push({
          positionId: position.id,
          reason: `IL ${position.ilPercent.toFixed(2)}% exceeds max ${STRATEGY_CONFIG.MAX_IL_PERCENT}%`,
        });
      }

      if (position.pnlPercent <= -STRATEGY_CONFIG.MAX_LOSS_PERCENT) {
        alerts.push({
          positionId: position.id,
          reason: `Loss ${position.pnlPercent.toFixed(2)}% exceeds max ${STRATEGY_CONFIG.MAX_LOSS_PERCENT}%`,
        });
      }
    }

    return alerts;
  }

  /**
   * Send a transaction with retry and exponential backoff.
   */
  private async sendWithRetry(
    tx: any,
    signers: Keypair[],
    maxRetries = 3,
  ): Promise<string> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        for (const signer of signers) {
          tx.sign(signer);
        }
        const sig = await this.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 2,
        });
        await this.connection.confirmTransaction(sig, 'confirmed');
        return sig;
      } catch (error: any) {
        const isLastAttempt = attempt === maxRetries - 1;
        if (isLastAttempt) throw error;

        const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        logger.warn(`TX attempt ${attempt + 1} failed: ${error.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('sendWithRetry: all attempts failed');
  }

  /**
   * Claim swap fees for an open position.
   */
  async claimFees(
    positionId: string,
  ): Promise<{ feeXUsd: number; feeYUsd: number; totalUsd: number } | null> {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open') {
      logger.warn(`claimFees: position ${positionId} not found or not open`);
      return null;
    }

    try {
      if (this.isPaper) {
        const totalUsd = position.feesEarned;
        const feeXUsd = totalUsd / 2;
        const feeYUsd = totalUsd / 2;
        position.feesEarned = 0;
        logger.info(
          `[PAPER] Claimed fees for ${positionId}: $${totalUsd.toFixed(4)}`,
        );
        return { feeXUsd, feeYUsd, totalUsd };
      }

      if (!this.wallet) {
        logger.error('claimFees: no wallet configured');
        return null;
      }
      if (!position.onChainPositionKey) {
        logger.error(`claimFees: position ${positionId} has no on-chain key`);
        return null;
      }

      const dlmmPool = await DLMM.create(this.connection, new PublicKey(position.poolAddress));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(this.wallet.publicKey);
      const onChainPos = userPositions.find(
        p => p.publicKey.toBase58() === position.onChainPositionKey,
      );

      if (!onChainPos) {
        logger.warn(`claimFees: on-chain position not found`);
        return null;
      }

      const { feeX, feeY } = onChainPos.positionData;
      const currentPrice = position.currentPrice || 1;
      const feeXUsd =
        (parseInt(feeX.toString()) / 10 ** position.tokenXDecimals) * currentPrice;
      const feeYUsd = parseInt(feeY.toString()) / 10 ** position.tokenYDecimals;
      const totalUsd = feeXUsd + feeYUsd;

      const claimTxs = await dlmmPool.claimSwapFee({
        owner: this.wallet.publicKey,
        position: onChainPos,
      });

      for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
        await this.sendWithRetry(tx, [this.wallet]);
        position.gasCosts += 0.000005;
      }

      position.feesEarned = 0;
      logger.info(`[LIVE] Claimed fees for ${positionId}: $${totalUsd.toFixed(4)}`);
      return { feeXUsd, feeYUsd, totalUsd };
    } catch (error) {
      logger.error(`claimFees failed for ${positionId}: ${error}`);
      return null;
    }
  }

  /**
   * Compound fees back into the position.
   */
  async compoundFees(positionId: string): Promise<boolean> {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open') {
      logger.warn(`compoundFees: position ${positionId} not found or not open`);
      return false;
    }

    const claimed = await this.claimFees(positionId);
    if (!claimed) return false;

    const { feeXUsd, feeYUsd, totalUsd } = claimed;

    if (totalUsd < 0.01) {
      logger.info(`compoundFees: fees $${totalUsd.toFixed(6)} are dust — skipping`);
      return false;
    }

    try {
      if (this.isPaper) {
        position.totalValueUsd += totalUsd;
        position.currentValueUsd += totalUsd;
        logger.info(`[PAPER] Compounded $${totalUsd.toFixed(4)} into ${positionId}`);
        return true;
      }

      if (!this.wallet) return false;
      if (!position.onChainPositionKey) return false;

      const dlmmPool = await DLMM.create(this.connection, new PublicKey(position.poolAddress));
      const currentPrice = position.currentPrice || 1;

      const totalXAmount = new BN(
        Math.floor((feeXUsd / currentPrice) * 10 ** position.tokenXDecimals),
      );
      const totalYAmount = new BN(
        Math.floor(feeYUsd * 10 ** position.tokenYDecimals),
      );

      const addLiqTx = await dlmmPool.addLiquidityByStrategy({
        positionPubKey: new PublicKey(position.onChainPositionKey),
        totalXAmount,
        totalYAmount,
        strategy: {
          maxBinId: position.binRange.max,
          minBinId: position.binRange.min,
          strategyType: StrategyType.Spot,
        },
        user: this.wallet.publicKey,
        slippage: STRATEGY_CONFIG.SLIPPAGE_BPS / 10000,
      });

      for (const tx of Array.isArray(addLiqTx) ? addLiqTx : [addLiqTx]) {
        await this.sendWithRetry(tx, [this.wallet]);
        position.gasCosts += 0.000005;
      }

      logger.info(`[LIVE] Compounded $${totalUsd.toFixed(4)} into ${positionId}`);
      return true;
    } catch (error) {
      logger.error(`compoundFees failed for ${positionId}: ${error}`);
      return false;
    }
  }
}
