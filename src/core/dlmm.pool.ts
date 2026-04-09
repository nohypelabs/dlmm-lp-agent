/**
 * DLMM Pool Reader
 *
 * Reads and analyzes Meteora DLMM pool data:
 * - Pool info (TVL, volume, fees)
 * - Bin liquidity distribution
 * - Active bin & current price
 * - Optimal bin ranges for LP entry
 */

import { Connection, PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import BN from 'bn.js';
import axios from 'axios';
import { logger } from '../utils/logger';
import { DLMM_CONFIG } from '../config/constants';

const DEXSCREENER_API = 'https://api.dexscreener.com';

// Module-level cache for getLbPairs (shared with pool.discovery to avoid double-fetching)
const LB_PAIRS_CACHE_TTL_MS = 5 * 60 * 1000;
let lbPairsCache: { pairs: Awaited<ReturnType<typeof DLMM.getLbPairs>>; expiresAt: number } | null = null;

export interface PoolInfo {
  address: string;
  tokenX: { mint: string; decimals: number };
  tokenY: { mint: string; decimals: number };
  binStep: number;
  activeId: number;
  activePricePerToken: number;
  totalLiquidity: number;
  feeRate: number;
}

export interface BinInfo {
  binId: number;
  price: number;
  liquidityX: number;
  liquidityY: number;
  totalLiquidity: number;
  isActive: boolean;
}

export interface PoolAnalysis {
  pool: PoolInfo;
  bins: BinInfo[];
  activeBin: BinInfo | null;
  suggestedRange: { min: number; max: number; binCount: number };
  liquidityConcentration: number;
}

export class DLMMPoolReader {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Find DLMM pools for a token pair.
   *
   * Fast path: DexScreener token API lookup (HTTP, no RPC).
   * Slow fallback: on-chain getLbPairs with 12s timeout + 5-min module cache.
   */
  async findPools(tokenMintA: string, tokenMintB: string): Promise<string[]> {
    logger.info(`Searching DLMM pools for ${tokenMintA.slice(0, 8)}... / ${tokenMintB.slice(0, 8)}...`);

    // Fast path: query DexScreener for tokenMintA, filter for Meteora pairs
    const dsResults = await this.findPoolsViaDexScreener(tokenMintA, tokenMintB);
    if (dsResults.length > 0) return dsResults;

    // Slow fallback: on-chain with cache + timeout
    return this.findPoolsOnChain(tokenMintA, tokenMintB);
  }

  private async findPoolsViaDexScreener(tokenMintA: string, tokenMintB: string): Promise<string[]> {
    try {
      const resp = await axios.get(
        `${DEXSCREENER_API}/tokens/v1/solana/${tokenMintA}`,
        { timeout: 8_000 },
      );
      const data: Array<{ chainId: string; dexId?: string; pairAddress: string; quoteToken?: { address: string } }> =
        Array.isArray(resp.data) ? resp.data : (resp.data?.pairs ?? []);

      const matching = data.filter(p =>
        p.chainId === 'solana' &&
        p.dexId?.toLowerCase().includes('meteora') &&
        (p.quoteToken?.address === tokenMintB || tokenMintB === ''),
      );

      return matching.map(p => p.pairAddress).slice(0, 5);
    } catch {
      return [];
    }
  }

  private async findPoolsOnChain(tokenMintA: string, tokenMintB: string): Promise<string[]> {
    try {
      let allPairs = lbPairsCache && Date.now() < lbPairsCache.expiresAt
        ? lbPairsCache.pairs
        : null;

      if (!allPairs) {
        logger.debug('[DLMMPoolReader] Fetching all LB pairs on-chain (slow — up to 12s)...');
        allPairs = await Promise.race([
          DLMM.getLbPairs(this.connection),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('getLbPairs timeout after 12s')), 12_000),
          ),
        ]);
        lbPairsCache = { pairs: allPairs, expiresAt: Date.now() + LB_PAIRS_CACHE_TTL_MS };
        logger.debug(`[DLMMPoolReader] LB pairs cached: ${allPairs.length} pairs (TTL 5min)`);
      }

      const matching = allPairs.filter(p => {
        const xMint = p.account.tokenXMint.toBase58();
        const yMint = p.account.tokenYMint.toBase58();
        return (
          (xMint === tokenMintA && yMint === tokenMintB) ||
          (xMint === tokenMintB && yMint === tokenMintA)
        );
      });

      logger.info(`Found ${matching.length} DLMM pools`);
      return matching.map(p => p.publicKey.toBase58());
    } catch (error) {
      logger.error(`Failed to find pools: ${error}`);
      return [];
    }
  }

  /**
   * Get detailed pool information
   */
  async getPoolInfo(poolAddress: string): Promise<PoolInfo | null> {
    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
      const activeBin = await dlmmPool.getActiveBin();

      const tokenX = dlmmPool.tokenX;
      const tokenY = dlmmPool.tokenY;
      const binStep = dlmmPool.lbPair.binStep;

      const pricePerToken = activeBin.pricePerToken
        ? parseFloat(activeBin.pricePerToken)
        : 0;

      return {
        address: poolAddress,
        tokenX: {
          mint: tokenX.publicKey.toBase58(),
          decimals: tokenX.mint.decimals,
        },
        tokenY: {
          mint: tokenY.publicKey.toBase58(),
          decimals: tokenY.mint.decimals,
        },
        binStep,
        activeId: activeBin.binId,
        activePricePerToken: pricePerToken,
        totalLiquidity: 0,
        feeRate: binStep / 10000,
      };
    } catch (error) {
      logger.error(`Failed to get pool info for ${poolAddress}: ${error}`);
      return null;
    }
  }

  /**
   * Get bin liquidity around the active bin
   */
  async getBins(poolAddress: string, range: number = 30): Promise<BinInfo[]> {
    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
      const activeBin = await dlmmPool.getActiveBin();
      const activeId = activeBin.binId;

      const minBinId = activeId - range;
      const maxBinId = activeId + range;

      const result = await dlmmPool.getBinsBetweenLowerAndUpperBound(minBinId, maxBinId);

      const bins: BinInfo[] = [];
      for (const bin of result.bins) {
        const liqX = bin.xAmount ? parseFloat(bin.xAmount.toString()) : 0;
        const liqY = bin.yAmount ? parseFloat(bin.yAmount.toString()) : 0;
        const price = bin.pricePerToken ? parseFloat(bin.pricePerToken) : 0;

        bins.push({
          binId: bin.binId,
          price,
          liquidityX: liqX,
          liquidityY: liqY,
          totalLiquidity: liqX + liqY,
          isActive: bin.binId === activeId,
        });
      }

      logger.info(`Fetched ${bins.length} bins around active bin ${activeId}`);
      return bins;
    } catch (error) {
      logger.error(`Failed to get bins: ${error}`);
      return [];
    }
  }

  /**
   * Analyze pool and suggest optimal LP range
   */
  async analyzePool(poolAddress: string): Promise<PoolAnalysis | null> {
    const pool = await this.getPoolInfo(poolAddress);
    if (!pool) return null;

    const bins = await this.getBins(poolAddress, 50);
    if (bins.length === 0) return null;

    const activeBin = bins.find(b => b.isActive) || null;

    // Calculate liquidity concentration
    const totalLiq = bins.reduce((sum, b) => sum + b.totalLiquidity, 0);
    const nearActiveLiq = bins
      .filter(b => Math.abs(b.binId - pool.activeId) <= 10)
      .reduce((sum, b) => sum + b.totalLiquidity, 0);
    const concentration = totalLiq > 0 ? nearActiveLiq / totalLiq : 0;

    // Suggest range based on bin step and config
    const rangePct = DLMM_CONFIG.DEFAULT_BIN_RANGE_PERCENT;
    const binsPerPercent = 100 / pool.binStep;
    const halfBins = Math.floor((rangePct * binsPerPercent) / 2);

    const suggestedRange = {
      min: pool.activeId - halfBins,
      max: pool.activeId + halfBins,
      binCount: halfBins * 2 + 1,
    };

    pool.totalLiquidity = totalLiq;

    logger.info(`Pool analysis: Active bin ${pool.activeId}, price $${pool.activePricePerToken.toFixed(6)}`);
    logger.info(`Liquidity concentration: ${(concentration * 100).toFixed(1)}% within ±10 bins`);
    logger.info(`Suggested range: bins ${suggestedRange.min}-${suggestedRange.max} (${suggestedRange.binCount} bins)`);

    return { pool, bins, activeBin, suggestedRange, liquidityConcentration: concentration };
  }
}
