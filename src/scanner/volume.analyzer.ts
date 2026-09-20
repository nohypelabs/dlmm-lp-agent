/**
 * Volume & Liquidity Analyzer
 * Tier 2: Analyzes trading volume, liquidity, and trader activity
 */

import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../utils/logger';
import { TOKEN_FILTERS } from '../config/constants';
import { getEffectiveFilters } from '../memory/lessons';

export interface VolumeMetrics {
  volume24h: number;
  liquidity: number;
  uniqueTraders24h: number;
  buyCount24h: number;
  sellCount24h: number;
  buySellRatio: number;
  liquidityVolumeRatio: number;
  passed: boolean;
  score: number; // 0-100
  warnings: string[];
}

export class VolumeAnalyzer {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Analyze volume and liquidity metrics for a token
   */
  async analyze(mintAddress: string): Promise<VolumeMetrics> {
    const result: VolumeMetrics = {
      volume24h: 0,
      liquidity: 0,
      uniqueTraders24h: 0,
      buyCount24h: 0,
      sellCount24h: 0,
      buySellRatio: 0,
      liquidityVolumeRatio: 0,
      passed: false,
      score: 0,
      warnings: [],
    };

    try {
      logger.info(`Analyzing volume for token: ${mintAddress}`);

      // Try multiple data sources
      const birdeye = await this.fetchBirdeyeData(mintAddress);
      const dexscreener = await this.fetchDexScreenerData(mintAddress);

      // Use best available data
      if (birdeye) {
        result.volume24h = birdeye.volume24h || 0;
        result.liquidity = birdeye.liquidity || 0;
        result.uniqueTraders24h = birdeye.uniqueTraders || 0;
        result.buyCount24h = birdeye.buyCount || 0;
        result.sellCount24h = birdeye.sellCount || 0;
      } else if (dexscreener) {
        result.volume24h = dexscreener.volume24h || 0;
        result.liquidity = dexscreener.liquidity || 0;
        // DexScreener doesn't provide trader counts
      }

      // Calculate ratios
      if (result.buyCount24h > 0 && result.sellCount24h > 0) {
        result.buySellRatio = result.buyCount24h / result.sellCount24h;
      }

      if (result.liquidity > 0 && result.volume24h > 0) {
        result.liquidityVolumeRatio = (result.liquidity / result.volume24h) * 100;
      }

      // Run Tier 2 checks
      result.passed = this.checkTier2Criteria(result);
      result.score = this.calculateScore(result);

      logger.info(`Volume analysis complete: ${result.passed ? 'PASSED' : 'FAILED'} (${result.score}/100)`);

      return result;
    } catch (error) {
      logger.error(`Error analyzing volume for ${mintAddress}`, error);
      return result;
    }
  }

  /**
   * Fetch data from Birdeye API
   */
  private async fetchBirdeyeData(mintAddress: string): Promise<any> {
    try {
      logger.debug(`Fetching Birdeye data for ${mintAddress}`);

      // Birdeye public API (limited, no key needed for basic data)
      const response = await axios.get(
        `https://public-api.birdeye.so/public/token_overview?address=${mintAddress}`,
        { timeout: 5000 }
      );

      if (response.data && response.data.data) {
        const data = response.data.data;
        logger.debug(`Birdeye data fetched successfully`);

        return {
          volume24h: data.v24hUSD || 0,
          liquidity: data.liquidity || 0,
          uniqueTraders: data.uniqueWallet24h || 0,
          buyCount: data.buy24h || 0,
          sellCount: data.sell24h || 0,
        };
      }

      return null;
    } catch (error) {
      logger.debug(`Birdeye fetch failed (not critical): ${error}`);
      return null;
    }
  }

  /**
   * Fetch data from DexScreener API
   */
  private async fetchDexScreenerData(mintAddress: string): Promise<any> {
    try {
      logger.debug(`Fetching DexScreener data for ${mintAddress}`);

      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
        { timeout: 5000 }
      );

      if (response.data && response.data.pairs && response.data.pairs.length > 0) {
        // Get the pair with highest liquidity
        const pairs = response.data.pairs;
        const bestPair = pairs.sort((a: any, b: any) =>
          (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
        )[0];

        logger.debug(`DexScreener data fetched successfully`);

        return {
          volume24h: bestPair.volume?.h24 || 0,
          liquidity: bestPair.liquidity?.usd || 0,
          priceChange24h: bestPair.priceChange?.h24 || 0,
        };
      }

      return null;
    } catch (error) {
      logger.debug(`DexScreener fetch failed (not critical): ${error}`);
      return null;
    }
  }

  /**
   * Check if metrics meet Tier 2 criteria
   */
  private checkTier2Criteria(metrics: VolumeMetrics): boolean {
    const checks: { [key: string]: boolean } = {};
    const evolved = getEffectiveFilters();

    // Check 1: Volume in acceptable range (uses evolved thresholds)
    checks.volumeRange =
      metrics.volume24h >= evolved.MIN_DAILY_VOLUME &&
      metrics.volume24h <= TOKEN_FILTERS.MAX_DAILY_VOLUME;

    if (!checks.volumeRange) {
      metrics.warnings.push(
        `Volume ${metrics.volume24h.toFixed(0)} outside ${evolved.MIN_DAILY_VOLUME}-${TOKEN_FILTERS.MAX_DAILY_VOLUME} range`
      );
    }

    // Check 2: Sufficient liquidity (uses evolved thresholds)
    checks.minLiquidity = metrics.liquidity >= evolved.MIN_LIQUIDITY;

    if (!checks.minLiquidity) {
      metrics.warnings.push(
        `Liquidity $${metrics.liquidity.toFixed(0)} below minimum $${evolved.MIN_LIQUIDITY}`
      );
    }

    // Check 3: Minimum unique traders (if available)
    if (metrics.uniqueTraders24h > 0) {
      checks.minTraders = metrics.uniqueTraders24h >= TOKEN_FILTERS.MIN_UNIQUE_TRADERS;

      if (!checks.minTraders) {
        metrics.warnings.push(
          `Only ${metrics.uniqueTraders24h} unique traders (min ${TOKEN_FILTERS.MIN_UNIQUE_TRADERS})`
        );
      }
    } else {
      checks.minTraders = true; // Skip if data not available
    }

    // Check 4: Balanced buy/sell ratio (if available)
    if (metrics.buySellRatio > 0) {
      checks.balancedRatio =
        metrics.buySellRatio >= TOKEN_FILTERS.MIN_BUY_SELL_RATIO &&
        metrics.buySellRatio <= TOKEN_FILTERS.MAX_BUY_SELL_RATIO;

      if (!checks.balancedRatio) {
        metrics.warnings.push(
          `Buy/sell ratio ${metrics.buySellRatio.toFixed(2)} outside ${TOKEN_FILTERS.MIN_BUY_SELL_RATIO}-${TOKEN_FILTERS.MAX_BUY_SELL_RATIO} range (potential dump)`
        );
      }
    } else {
      checks.balancedRatio = true; // Skip if data not available
    }

    // Check 5: Adequate liquidity/volume ratio
    if (metrics.liquidityVolumeRatio > 0) {
      checks.liquidityRatio = metrics.liquidityVolumeRatio >= 5; // At least 5%

      if (!checks.liquidityRatio) {
        metrics.warnings.push(
          `Liquidity/Volume ratio ${metrics.liquidityVolumeRatio.toFixed(1)}% too low (min 5%)`
        );
      }
    } else {
      checks.liquidityRatio = true; // Skip if can't calculate
    }

    // All critical checks must pass
    return Object.values(checks).every(check => check);
  }

  /**
   * Calculate Tier 2 score (0-100)
   */
  private calculateScore(metrics: VolumeMetrics): number {
    let score = 0;
    const evolved = getEffectiveFilters();

    // Volume score (0-30 points) — uses evolved thresholds
    if (metrics.volume24h >= evolved.MIN_DAILY_VOLUME) {
      const volumeRatio = Math.min(
        metrics.volume24h / evolved.MIN_DAILY_VOLUME,
        TOKEN_FILTERS.MAX_DAILY_VOLUME / evolved.MIN_DAILY_VOLUME
      );
      score += Math.min(30, volumeRatio * 10);
    }

    // Liquidity score (0-25 points) — uses evolved thresholds
    if (metrics.liquidity >= evolved.MIN_LIQUIDITY) {
      const liquidityRatio = metrics.liquidity / evolved.MIN_LIQUIDITY;
      score += Math.min(25, liquidityRatio * 5);
    }

    // Trader count score (0-20 points)
    if (metrics.uniqueTraders24h > 0) {
      const traderRatio = metrics.uniqueTraders24h / TOKEN_FILTERS.MIN_UNIQUE_TRADERS;
      score += Math.min(20, traderRatio * 10);
    }

    // Buy/sell ratio score (0-15 points)
    if (metrics.buySellRatio > 0) {
      const idealRatio = 1.0;
      const deviation = Math.abs(metrics.buySellRatio - idealRatio);
      score += Math.max(0, 15 - (deviation * 20));
    }

    // Liquidity/volume ratio score (0-10 points)
    if (metrics.liquidityVolumeRatio > 0) {
      score += Math.min(10, metrics.liquidityVolumeRatio);
    }

    return Math.min(100, Math.round(score));
  }

  /**
   * Get volume summary for display
   */
  getVolumeSummary(metrics: VolumeMetrics): string {
    return `
Volume 24h: $${metrics.volume24h.toLocaleString()}
Liquidity: $${metrics.liquidity.toLocaleString()}
Unique Traders: ${metrics.uniqueTraders24h}
Buy/Sell Ratio: ${metrics.buySellRatio.toFixed(2)}
Liq/Vol Ratio: ${metrics.liquidityVolumeRatio.toFixed(1)}%
Score: ${metrics.score}/100
Status: ${metrics.passed ? '✅ PASSED' : '❌ FAILED'}
    `.trim();
  }
}

export default VolumeAnalyzer;
