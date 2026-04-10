/**
 * Token Scanner
 * Discovers and evaluates new token launches
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { SafetyChecker, SafetyCheckResult } from './safety.checker';
import { VolumeAnalyzer, VolumeMetrics } from './volume.analyzer';
import { MetadataFetcher, TokenMetadata } from './metadata.fetcher';
import { PriceAnalyzer, PriceMetrics } from './price.analyzer';
import { SmartSignalsAnalyzer, SmartSignals } from './smart.signals';
import { logger } from '../utils/logger';

export interface TokenCandidate {
  mintAddress: string;
  symbol: string;
  name: string;
  metadata: TokenMetadata;
  safetyCheck: SafetyCheckResult;
  volumeMetrics?: VolumeMetrics;
  priceMetrics?: PriceMetrics;
  smartSignals?: SmartSignals;
  age: number;
  score: number;
  tier: number;
  recommended: boolean;
}

export class TokenScanner {
  private connection: Connection;
  private safetyChecker: SafetyChecker;
  private volumeAnalyzer: VolumeAnalyzer;
  private metadataFetcher: MetadataFetcher;
  private priceAnalyzer: PriceAnalyzer;
  private smartSignalsAnalyzer: SmartSignalsAnalyzer;

  constructor(connection: Connection) {
    this.connection = connection;
    this.safetyChecker = new SafetyChecker(connection);
    this.volumeAnalyzer = new VolumeAnalyzer(connection);
    this.metadataFetcher = new MetadataFetcher(connection);
    this.priceAnalyzer = new PriceAnalyzer(connection);
    this.smartSignalsAnalyzer = new SmartSignalsAnalyzer(connection);
  }

  /**
   * Scan and evaluate a single token (with configurable tier analysis)
   */
  async scanToken(
    mintAddress: string,
    options: {
      includeTier2?: boolean;
      includeTier3?: boolean;
      includeTier4?: boolean;
    } = {}
  ): Promise<TokenCandidate | null> {
    try {
      logger.info(`Scanning token: ${mintAddress}`);

      // Fetch metadata
      const metadata = await this.metadataFetcher.fetchMetadata(mintAddress);

      // Tier 1: Safety check
      const safetyCheck = await this.safetyChecker.checkToken(mintAddress);

      if (!safetyCheck.passed) {
        const failedChecks = Object.entries(safetyCheck.checks)
          .filter(([, c]) => !c.passed)
          .map(([k, c]) => `${k}(${c.message})`)
          .join(', ');
        logger.warn(`Token ${metadata.symbol} failed safety: ${failedChecks}`);
        return null;
      }

      // Check age
      const ageCheck = await this.safetyChecker.checkTokenAge(mintAddress);

      if (!ageCheck.passed) {
        logger.warn(`Token ${metadata.symbol} age check failed: ${ageCheck.message}`);
        // Don't return null - age check might fail for established tokens
      }

      // Tier 2: Volume & liquidity analysis
      let volumeMetrics: VolumeMetrics | undefined;
      if (options.includeTier2) {
        volumeMetrics = await this.volumeAnalyzer.analyze(mintAddress);

        if (!volumeMetrics.passed) {
          logger.warn(`Token ${metadata.symbol} failed Tier 2 volume checks`);
        }
      }

      // Tier 3: Price action analysis
      let priceMetrics: PriceMetrics | undefined;
      if (options.includeTier3) {
        priceMetrics = await this.priceAnalyzer.analyze(mintAddress);

        if (!priceMetrics.passed) {
          logger.warn(`Token ${metadata.symbol} failed Tier 3 price checks`);
        }
      }

      // Tier 4: Smart money signals
      let smartSignals: SmartSignals | undefined;
      if (options.includeTier4) {
        smartSignals = await this.smartSignalsAnalyzer.analyze(mintAddress);

        if (!smartSignals.passed) {
          logger.warn(`Token ${metadata.symbol} failed Tier 4 smart signals`);
        }
      }

      // Calculate combined score from all tiers
      const combinedScore = this.calculateCombinedScore(
        safetyCheck,
        volumeMetrics,
        priceMetrics,
        smartSignals
      );

      // Determine if recommended based on all criteria
      const allTiersPassed =
        safetyCheck.passed &&
        (!volumeMetrics || volumeMetrics.passed) &&
        (!priceMetrics || priceMetrics.passed) &&
        (!smartSignals || smartSignals.passed);

      // Create candidate object
      const candidate: TokenCandidate = {
        mintAddress,
        symbol: metadata.symbol,
        name: metadata.name,
        metadata,
        safetyCheck,
        volumeMetrics,
        priceMetrics,
        smartSignals,
        age: ageCheck.age,
        score: combinedScore,
        tier: this.determineCombinedTier(combinedScore),
        recommended: combinedScore >= 75 && allTiersPassed,
      };

      logger.success(`Token ${metadata.symbol} scanned - Score: ${candidate.score}/100 (Tier ${candidate.tier})`);

      return candidate;
    } catch (error) {
      logger.error(`Error scanning token ${mintAddress}`, error);
      return null;
    }
  }

  /**
   * Calculate combined score from all tiers
   * Weights:
   * - Tier 1 (Safety): 40% (most critical)
   * - Tier 2 (Volume): 25%
   * - Tier 3 (Price): 20%
   * - Tier 4 (Smart Signals): 15%
   */
  private calculateCombinedScore(
    safetyCheck: SafetyCheckResult,
    volumeMetrics?: VolumeMetrics,
    priceMetrics?: PriceMetrics,
    smartSignals?: SmartSignals
  ): number {
    let totalWeight = 0;
    let weightedScore = 0;

    // Tier 1 (Safety): 40% weight - ALWAYS included
    const tier1Weight = 0.4;
    weightedScore += safetyCheck.score * tier1Weight;
    totalWeight += tier1Weight;

    // Tier 2 (Volume): 25% weight
    if (volumeMetrics) {
      const tier2Weight = 0.25;
      weightedScore += volumeMetrics.score * tier2Weight;
      totalWeight += tier2Weight;
    }

    // Tier 3 (Price): 20% weight
    if (priceMetrics) {
      const tier3Weight = 0.2;
      weightedScore += priceMetrics.score * tier3Weight;
      totalWeight += tier3Weight;
    }

    // Tier 4 (Smart Signals): 15% weight
    if (smartSignals) {
      const tier4Weight = 0.15;
      weightedScore += smartSignals.score * tier4Weight;
      totalWeight += tier4Weight;
    }

    // Normalize if not all tiers included
    if (totalWeight < 1) {
      weightedScore = (weightedScore / totalWeight);
    }

    return Math.round(weightedScore);
  }

  /**
   * Determine tier from combined score
   */
  private determineCombinedTier(score: number): number {
    if (score >= 80) return 4; // Excellent
    if (score >= 65) return 3; // Good
    if (score >= 50) return 2; // Fair
    return 1; // Poor
  }

  /**
   * Scan multiple tokens
   */
  async scanTokens(
    mintAddresses: string[],
    options: {
      includeTier2?: boolean;
      includeTier3?: boolean;
      includeTier4?: boolean;
    } = {}
  ): Promise<TokenCandidate[]> {
    logger.info(`Scanning ${mintAddresses.length} tokens...`);

    const candidates: TokenCandidate[] = [];

    for (const mintAddress of mintAddresses) {
      const candidate = await this.scanToken(mintAddress, options);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    // Sort by score (highest first)
    candidates.sort((a, b) => b.score - a.score);

    logger.info(`Found ${candidates.length} viable candidates out of ${mintAddresses.length} tokens`);

    return candidates;
  }

  /**
   * Get top N candidates
   */
  getTopCandidates(candidates: TokenCandidate[], count: number = 3): TokenCandidate[] {
    return candidates.slice(0, count);
  }

  /**
   * Print candidate report
   */
  printCandidateReport(candidate: TokenCandidate): void {
    console.log('\n' + '='.repeat(60));
    console.log(`Token: ${candidate.symbol} (${candidate.name})`);
    console.log(`Address: ${candidate.mintAddress}`);
    console.log(`Age: ${candidate.age.toFixed(1)} days`);
    console.log(`Combined Score: ${candidate.score}/100 (Tier ${candidate.tier})`);
    console.log(`Recommended: ${candidate.recommended ? '✅ YES' : '❌ NO'}`);

    console.log('\n--- TIER 1: SAFETY CHECKS ---');
    console.log(`Score: ${candidate.safetyCheck.score}/100`);

    for (const [checkName, check] of Object.entries(candidate.safetyCheck.checks)) {
      const icon = check.passed ? '✅' : '❌';
      const critical = check.critical ? ' [CRITICAL]' : '';
      console.log(`  ${icon} ${checkName}: ${check.message}${critical}`);
    }

    if (candidate.safetyCheck.warnings.length > 0) {
      console.log('\nTier 1 Warnings:');
      candidate.safetyCheck.warnings.forEach(w => console.log(`  ⚠️  ${w}`));
    }

    // Show Tier 2 volume metrics if available
    if (candidate.volumeMetrics) {
      console.log('\n--- TIER 2: VOLUME & LIQUIDITY ---');
      console.log(`Score: ${candidate.volumeMetrics.score}/100`);
      console.log(`Status: ${candidate.volumeMetrics.passed ? '✅ PASSED' : '❌ FAILED'}`);
      console.log(`  Volume 24h: $${candidate.volumeMetrics.volume24h.toLocaleString()}`);
      console.log(`  Liquidity: $${candidate.volumeMetrics.liquidity.toLocaleString()}`);
      console.log(`  Unique Traders: ${candidate.volumeMetrics.uniqueTraders24h}`);
      console.log(`  Buy/Sell Ratio: ${candidate.volumeMetrics.buySellRatio.toFixed(2)}`);
      console.log(`  Liq/Vol Ratio: ${candidate.volumeMetrics.liquidityVolumeRatio.toFixed(1)}%`);

      if (candidate.volumeMetrics.warnings.length > 0) {
        console.log('\nWarnings:');
        candidate.volumeMetrics.warnings.forEach(w => console.log(`  ⚠️  ${w}`));
      }
    }

    // Show Tier 3 price metrics if available
    if (candidate.priceMetrics) {
      console.log('\n--- TIER 3: PRICE ACTION ---');
      console.log(`Score: ${candidate.priceMetrics.score}/100`);
      console.log(`Status: ${candidate.priceMetrics.passed ? '✅ PASSED' : '❌ FAILED'}`);
      console.log(`  Current Price: $${candidate.priceMetrics.currentPrice.toFixed(8)}`);
      console.log(`  24h Change: ${candidate.priceMetrics.priceChange24h >= 0 ? '+' : ''}${candidate.priceMetrics.priceChange24h.toFixed(2)}%`);
      console.log(`  7d Change: ${candidate.priceMetrics.priceChange7d >= 0 ? '+' : ''}${candidate.priceMetrics.priceChange7d.toFixed(2)}%`);
      console.log(`  Volatility (7d): ${candidate.priceMetrics.volatility7d.toFixed(1)}%`);
      console.log(`  Trend: ${candidate.priceMetrics.trendDirection.toUpperCase()}`);
      console.log(`  Range-bound: ${candidate.priceMetrics.isRangeBound ? 'YES ✓' : 'NO'}`);

      if (candidate.priceMetrics.warnings.length > 0) {
        console.log('\nWarnings:');
        candidate.priceMetrics.warnings.forEach(w => console.log(`  ⚠️  ${w}`));
      }
    }

    // Show Tier 4 smart signals if available
    if (candidate.smartSignals) {
      console.log('\n--- TIER 4: SMART MONEY SIGNALS ---');
      console.log(`Score: ${candidate.smartSignals.score}/100`);
      console.log(`Status: ${candidate.smartSignals.passed ? '✅ PASSED' : '❌ FAILED'}`);
      console.log(`  Jupiter Listed: ${candidate.smartSignals.isListedJupiter ? 'YES ✓' : 'NO'}`);
      console.log(`  Trending: ${candidate.smartSignals.isTrending ? 'YES ✓' : 'NO'}`);
      console.log(`  Trending Score: ${candidate.smartSignals.trendingScore}/100`);
      console.log(`  Recent Listing: ${candidate.smartSignals.hasRecentListing ? 'YES ✓' : 'NO'}`);
      console.log(`  24h Transactions: ${candidate.smartSignals.txCount24h}`);

      if (candidate.smartSignals.signals.length > 0) {
        console.log('\nPositive Signals:');
        candidate.smartSignals.signals.forEach(s => console.log(`  ✨ ${s}`));
      }

      if (candidate.smartSignals.warnings.length > 0) {
        console.log('\nWarnings:');
        candidate.smartSignals.warnings.forEach(w => console.log(`  ⚠️  ${w}`));
      }
    }

    console.log('='.repeat(60));
  }
}

export default TokenScanner;
