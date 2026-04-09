/**
 * Position Manager
 *
 * Manages LP positions lifecycle:
 * - Open positions (add liquidity to DLMM bins)
 * - Track positions (value, PnL, IL)
 * - Close positions (remove liquidity)
 * - Paper trading simulation
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
  onChainPositionKey?: string; // PublicKey of the on-chain position account (live only)
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
  status: 'open' | 'closed' | 'rebalancing';
  isPaper: boolean;
  tokenSymbol?: string;
  strategy?: string;
  exitReason?: 'take_profit' | 'stop_loss' | 'il_limit' | 'rebalance' | 'manual';
}

export class PositionManager {
  private connection: Connection;
  private wallet: Keypair | null;
  private positions: Map<string, Position> = new Map();
  private isPaper: boolean;

  constructor(connection: Connection, wallet: Keypair | null = null) {
    this.connection = connection;
    this.wallet = wallet;
    this.isPaper = OPERATION_MODE.PAPER_TRADING || !wallet;
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
    // Check position limits
    const openPositions = this.getOpenPositions();
    if (openPositions.length >= STRATEGY_CONFIG.MAX_POSITIONS) {
      logger.warn(`Max positions reached (${STRATEGY_CONFIG.MAX_POSITIONS}). Cannot open new.`);
      return null;
    }

    // Check position size
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

      const positionId = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const tokenXDecimals = dlmmPool.tokenX.mint.decimals;
      const tokenYDecimals = dlmmPool.tokenY.mint.decimals;

      if (this.isPaper) {
        // Paper trading: simulate position
        // Apply strategy-driven bin range override when a preset is provided
        const effectiveSide = strategy?.side ?? 'both';
        const paperMinBin = strategy
          ? activeBin.binId - strategy.binsBelow
          : minBinId;
        const paperMaxBin = strategy
          ? activeBin.binId + strategy.binsAbove
          : maxBinId;

        // Compute simulated token amounts based on entry side
        let paperAmountX: number;
        let paperAmountY: number;
        if (effectiveSide === 'token_only') {
          paperAmountX = amountUsd / entryPrice;
          paperAmountY = 0;
        } else if (effectiveSide === 'sol_only') {
          paperAmountX = 0;
          paperAmountY = amountUsd;
        } else {
          paperAmountX = amountUsd / 2 / entryPrice; // Split 50/50
          paperAmountY = amountUsd / 2;
        }

        const position: Position = {
          id: positionId,
          poolAddress,
          tokenX: dlmmPool.tokenX.publicKey.toBase58(),
          tokenY: dlmmPool.tokenY.publicKey.toBase58(),
          tokenXDecimals,
          tokenYDecimals,
          binRange: { min: paperMinBin, max: paperMaxBin },
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
          status: 'open',
          isPaper: true,
          tokenSymbol,
          strategy: strategy?.id ?? 'spot_balanced',
        };

        this.positions.set(positionId, position);
        logger.info(`[PAPER] Opened position ${positionId}: $${amountUsd} in ${poolAddress}`);
        logger.info(`  Strategy: ${position.strategy} | Side: ${effectiveSide} | Range: bins ${paperMinBin}-${paperMaxBin} | Entry: $${entryPrice.toFixed(6)}`);
        return position;
      }

      // Live trading
      if (!this.wallet) {
        logger.error('No wallet configured for live trading');
        return null;
      }

      // Resolve StrategyType from preset shape
      const shapeToStrategyType = (shape: LPStrategy['shape']): StrategyType => {
        switch (shape) {
          case 'curve':   return StrategyType.Curve;
          case 'bid_ask': return StrategyType.BidAsk;
          default:        return StrategyType.Spot;
        }
      };
      const strategyType = strategy ? shapeToStrategyType(strategy.shape) : StrategyType.Spot;
      const entrySide = strategy?.side ?? 'both';

      // Apply strategy-driven bin range override
      const effectiveMinBin = strategy
        ? activeBin.binId - strategy.binsBelow
        : minBinId;
      const effectiveMaxBin = strategy
        ? activeBin.binId + strategy.binsAbove
        : maxBinId;

      // Calculate token amounts based on entry side
      let totalXAmount: BN;
      let totalYAmount: BN;
      if (entrySide === 'token_only') {
        // All capital deployed as token X; Y (SOL) stays at zero
        totalXAmount = new BN(Math.floor((amountUsd / entryPrice) * 10 ** dlmmPool.tokenX.mint.decimals));
        totalYAmount = new BN(0);
      } else if (entrySide === 'sol_only') {
        // All capital deployed as token Y (SOL); X stays at zero
        totalXAmount = new BN(0);
        totalYAmount = new BN(Math.floor(amountUsd * 10 ** dlmmPool.tokenY.mint.decimals));
      } else {
        // Default: 50/50 split
        totalXAmount = new BN(Math.floor((amountUsd / 2 / entryPrice) * 10 ** dlmmPool.tokenX.mint.decimals));
        totalYAmount = new BN(Math.floor((amountUsd / 2) * 10 ** dlmmPool.tokenY.mint.decimals));
      }

      // Create position with the resolved strategy
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

      // Sign and send transaction
      for (const tx of Array.isArray(createPositionTx) ? createPositionTx : [createPositionTx]) {
        tx.sign(this.wallet, newPosition);
        const sig = await this.connection.sendRawTransaction(tx.serialize());
        await this.connection.confirmTransaction(sig, 'confirmed');
        logger.info(`[LIVE] TX confirmed: ${sig}`);
      }

      // Derive human-readable amounts from the BN values we sent on-chain
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
        status: 'open',
        isPaper: false,
        tokenSymbol,
        strategy: strategy?.id ?? 'spot_balanced',
      };

      this.positions.set(positionId, position);
      logger.info(`[LIVE] Opened position ${positionId}: $${amountUsd} | Strategy: ${position.strategy} | Side: ${entrySide}`);
      return position;
    } catch (error) {
      logger.error(`Failed to open position: ${error}`);
      return null;
    }
  }

  /**
   * Update position with current prices
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

      // Calculate current value
      const xValue = position.amountX * currentPrice;
      const yValue = position.amountY;
      position.currentValueUsd = xValue + yValue;

      // Calculate PnL
      position.pnl = position.currentValueUsd - position.totalValueUsd;
      position.pnlPercent = (position.pnl / position.totalValueUsd) * 100;

      // Calculate IL using standard DLMM formula: IL = 2√k/(1+k) - 1, where k = priceRatio
      const priceRatio = currentPrice / position.entryPrice;
      const sqrtK = Math.sqrt(priceRatio);
      const ilFactor = (2 * sqrtK) / (1 + priceRatio) - 1;
      position.ilPercent = Math.abs(ilFactor * 100);

      // Real on-chain fee tracking (live only)
      if (!position.isPaper && position.onChainPositionKey && this.wallet) {
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

            // Update actual on-chain amounts
            const totalX = onChainPos.positionData.totalXAmount;
            const totalY = onChainPos.positionData.totalYAmount;
            position.amountX = parseFloat(totalX) / 10 ** position.tokenXDecimals;
            position.amountY = parseFloat(totalY) / 10 ** position.tokenYDecimals;
          }
        } catch {
          // Non-fatal: fall through with last known values
        }
      }

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

    // Snapshot latest values before closing
    await this.updatePosition(positionId);
    position.exitReason = reason;

    if (this.isPaper) {
      position.status = 'closed';
      logger.info(`[PAPER] Closed position ${positionId} (${reason}): PnL $${position.pnl.toFixed(4)} (${position.pnlPercent.toFixed(2)}%)`);
      return position;
    }

    // Live: remove 100% liquidity and claim fees in one shot
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
        bps: new BN(10000), // 100%
        shouldClaimAndClose: true, // harvest fees + close position account
      });

      for (const tx of removeTxs) {
        tx.sign(this.wallet);
        const sig = await this.connection.sendRawTransaction(tx.serialize());
        await this.connection.confirmTransaction(sig, 'confirmed');
        logger.info(`[LIVE] Remove liquidity TX confirmed: ${sig}`);
      }

      position.status = 'closed';
      logger.info(`[LIVE] Closed position ${positionId} (${reason}): PnL $${position.pnl.toFixed(4)} (${position.pnlPercent.toFixed(2)}%) | Fees earned: $${position.feesEarned.toFixed(4)}`);
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
      // IL check
      if (Math.abs(position.ilPercent) >= STRATEGY_CONFIG.MAX_IL_PERCENT) {
        alerts.push({
          positionId: position.id,
          reason: `IL ${position.ilPercent.toFixed(2)}% exceeds max ${STRATEGY_CONFIG.MAX_IL_PERCENT}%`,
        });
      }

      // Loss check
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
   * Claim swap fees for an open position.
   *
   * Paper mode: reads feesEarned, resets it, and returns the simulated amounts.
   * Live mode: calls claimSwapFee on-chain, signs every returned transaction,
   *            derives USD values from on-chain feeX/feeY, then resets feesEarned.
   *
   * Returns null on any non-fatal error.
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
        // Paper: treat the accumulated feesEarned as the claimed amount.
        // Assume roughly equal split between X and Y for simulation purposes.
        const totalUsd = position.feesEarned;
        const feeXUsd = totalUsd / 2;
        const feeYUsd = totalUsd / 2;
        position.feesEarned = 0;
        logger.info(
          `[PAPER] Claimed fees for ${positionId}: $${totalUsd.toFixed(4)} (X: $${feeXUsd.toFixed(4)}, Y: $${feeYUsd.toFixed(4)})`,
        );
        return { feeXUsd, feeYUsd, totalUsd };
      }

      // Live mode
      if (!this.wallet) {
        logger.error('claimFees: no wallet configured for live trading');
        return null;
      }
      if (!position.onChainPositionKey) {
        logger.error(`claimFees: position ${positionId} has no on-chain key`);
        return null;
      }

      const dlmmPool = await DLMM.create(this.connection, new PublicKey(position.poolAddress));

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
        this.wallet.publicKey,
      );
      const onChainPos = userPositions.find(
        p => p.publicKey.toBase58() === position.onChainPositionKey,
      );

      if (!onChainPos) {
        logger.warn(
          `claimFees: on-chain position ${position.onChainPositionKey} not found — may already be closed`,
        );
        return null;
      }

      // Snapshot fee amounts before claiming (they will be zeroed after the tx)
      const { feeX, feeY } = onChainPos.positionData;
      const currentPrice = position.currentPrice || 1;
      const feeXUsd =
        (parseInt(feeX.toString()) / 10 ** position.tokenXDecimals) * currentPrice;
      const feeYUsd = parseInt(feeY.toString()) / 10 ** position.tokenYDecimals;
      const totalUsd = feeXUsd + feeYUsd;

      // Execute claim
      const claimTxs = await dlmmPool.claimSwapFee({
        owner: this.wallet.publicKey,
        position: onChainPos,
      });

      for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
        tx.sign(this.wallet);
        const sig = await this.connection.sendRawTransaction(tx.serialize());
        await this.connection.confirmTransaction(sig, 'confirmed');
        logger.info(`[LIVE] Claim fee TX confirmed: ${sig}`);
      }

      position.feesEarned = 0;
      logger.info(
        `[LIVE] Claimed fees for ${positionId}: $${totalUsd.toFixed(4)} (X: $${feeXUsd.toFixed(4)}, Y: $${feeYUsd.toFixed(4)})`,
      );
      return { feeXUsd, feeYUsd, totalUsd };
    } catch (error) {
      logger.error(`claimFees failed for ${positionId}: ${error}`);
      return null;
    }
  }

  /**
   * Compound fees back into the position (claim then re-add liquidity).
   *
   * Paper mode: adds the claimed USD value directly to totalValueUsd and
   *             currentValueUsd so PnL tracking reflects compounded growth.
   * Live mode: computes 50/50 token split from claimed USD and calls
   *            addLiquidityByStrategy with a Spot strategy over the same
   *            bin range the position was opened with.
   *
   * Returns true on success, false when fees are dust (<$0.01) or on error.
   */
  async compoundFees(positionId: string): Promise<boolean> {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open') {
      logger.warn(`compoundFees: position ${positionId} not found or not open`);
      return false;
    }

    // 1. Claim first
    const claimed = await this.claimFees(positionId);
    if (!claimed) {
      logger.warn(`compoundFees: claimFees returned null for ${positionId}`);
      return false;
    }

    const { feeXUsd, feeYUsd, totalUsd } = claimed;

    // Dust guard
    if (totalUsd < 0.01) {
      logger.info(`compoundFees: fees $${totalUsd.toFixed(6)} are dust — skipping ${positionId}`);
      return false;
    }

    try {
      if (this.isPaper) {
        // Paper: re-add the fee value to the position's tracked size
        position.totalValueUsd += totalUsd;
        position.currentValueUsd += totalUsd;
        logger.info(
          `[PAPER] Compounded $${totalUsd.toFixed(4)} into ${positionId} — new value: $${position.currentValueUsd.toFixed(4)}`,
        );
        return true;
      }

      // Live mode
      if (!this.wallet) {
        logger.error('compoundFees: no wallet configured for live trading');
        return false;
      }
      if (!position.onChainPositionKey) {
        logger.error(`compoundFees: position ${positionId} has no on-chain key`);
        return false;
      }

      const dlmmPool = await DLMM.create(this.connection, new PublicKey(position.poolAddress));
      const currentPrice = position.currentPrice || 1;

      // Split claimed USD 50/50 into token amounts
      const totalXAmount = new BN(
        Math.floor((feeXUsd / currentPrice) * 10 ** position.tokenXDecimals),
      );
      const totalYAmount = new BN(
        Math.floor(feeYUsd * 10 ** position.tokenYDecimals),
      );

      const { minBinId, maxBinId } = {
        minBinId: position.binRange.min,
        maxBinId: position.binRange.max,
      };

      const addLiqTx = await dlmmPool.addLiquidityByStrategy({
        positionPubKey: new PublicKey(position.onChainPositionKey),
        totalXAmount,
        totalYAmount,
        strategy: {
          maxBinId,
          minBinId,
          strategyType: StrategyType.Spot,
        },
        user: this.wallet.publicKey,
        slippage: 0.5,
      });

      for (const tx of Array.isArray(addLiqTx) ? addLiqTx : [addLiqTx]) {
        tx.sign(this.wallet);
        const sig = await this.connection.sendRawTransaction(tx.serialize());
        await this.connection.confirmTransaction(sig, 'confirmed');
        logger.info(`[LIVE] Add liquidity (compound) TX confirmed: ${sig}`);
      }

      logger.info(
        `[LIVE] Compounded $${totalUsd.toFixed(4)} into ${positionId}`,
      );
      return true;
    } catch (error) {
      logger.error(`compoundFees failed for ${positionId}: ${error}`);
      return false;
    }
  }
}
