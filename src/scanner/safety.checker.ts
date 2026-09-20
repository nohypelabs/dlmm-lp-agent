/**
 * Token Safety Checker
 * Implements Tier 1-4 safety filters to detect rugpulls and scams
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { logger } from '../utils/logger';
import { TOKEN_FILTERS, OKX_CONFIG } from '../config/constants';
import { isTokenBlocked } from '../memory/blacklist';
import OKXIntegration, { OKXTokenRisk } from './okx.integration';

export interface SafetyCheckResult {
  passed: boolean;
  score: number; // 0-100
  tier: number; // 1-4
  checks: {
    [key: string]: {
      passed: boolean;
      message: string;
      critical: boolean;
    };
  };
  warnings: string[];
  errors: string[];
}

export class SafetyChecker {
  private connection: Connection;
  private okxIntegration: OKXIntegration;

  constructor(connection: Connection) {
    this.connection = connection;
    this.okxIntegration = new OKXIntegration(OKX_CONFIG.ENABLED);
  }

  /**
   * Run complete safety check on a token
   */
  async checkToken(mintAddress: string): Promise<SafetyCheckResult> {
    const result: SafetyCheckResult = {
      passed: false,
      score: 0,
      tier: 0,
      checks: {},
      warnings: [],
      errors: [],
    };

    try {
      // BLACKLIST CHECK: instant reject before any on-chain calls
      if (isTokenBlocked(mintAddress)) {
        logger.warn(`Token ${mintAddress} is blacklisted — instant reject`);
        result.errors.push('Token blacklisted');
        result.checks['blacklist'] = {
          passed: false,
          message: 'Token is on the deployer blacklist',
          critical: true,
        };
        result.score = 0;
        result.passed = false;
        return result;
      }

      logger.info(`Running safety check for token: ${mintAddress}`);

      const mintPubkey = new PublicKey(mintAddress);

      // TIER 1: CRITICAL SAFETY CHECKS (Instant Reject)
      await this.runTier1Checks(mintPubkey, result);

      if (!result.passed) {
        logger.warn(`Token ${mintAddress} FAILED Tier 1 checks`);
        return result;
      }

      // TIER 2: DISTRIBUTION CHECKS (Warnings + scoring)
      await this.runTier2Checks(mintPubkey, result);

      // TIER 3: OKX RISK CHECKS (Meridian-inspired - if enabled)
      if (OKX_CONFIG.ENABLED) {
        await this.runTier3Checks(mintAddress, result);
      }

      // Calculate score based on all checks
      result.score = this.calculateScore(result);
      result.tier = this.determineTier(result.score);

      // Re-evaluate passed flag: fail if any critical Tier 2 check failed
      const anyCriticalFailed = Object.values(result.checks)
        .some(c => c.critical && !c.passed);
      if (anyCriticalFailed) {
        result.passed = false;
      }

      logger.info(`Token ${mintAddress} safety score: ${result.score}/100 (Tier ${result.tier})`);
      if (result.warnings.length > 0) {
        logger.debug(`Warnings: ${result.warnings.join('; ')}`);
      }

      return result;
    } catch (error) {
      logger.error(`Error checking token ${mintAddress}`, error);
      result.errors.push(`Failed to check token: ${error}`);
      return result;
    }
  }

  /**
   * TIER 1: Critical Safety Checks
   * Any failure = INSTANT REJECT
   */
  private async runTier1Checks(
    mintPubkey: PublicKey,
    result: SafetyCheckResult
  ): Promise<void> {
    try {
      // Fetch mint account info
      const mintInfo = await getMint(this.connection, mintPubkey);

      // Check 1: No freeze authority
      const noFreezeAuthority = mintInfo.freezeAuthority === null;
      result.checks['no_freeze_authority'] = {
        passed: noFreezeAuthority,
        message: noFreezeAuthority
          ? 'No freeze authority (safe)'
          : 'Freeze authority enabled (CRITICAL RISK)',
        critical: true,
      };

      if (!noFreezeAuthority) {
        result.errors.push('Token has freeze authority - can freeze user accounts');
      }

      // Check 2: No mint authority (or very low supply inflation)
      const noMintAuthority = mintInfo.mintAuthority === null;
      result.checks['no_mint_authority'] = {
        passed: noMintAuthority,
        message: noMintAuthority
          ? 'No mint authority (safe)'
          : 'Mint authority enabled (HIGH RISK)',
        critical: true,
      };

      if (!noMintAuthority) {
        result.errors.push('Token has mint authority - can inflate supply');
      }

      // Check 3: Token has supply (not zero)
      const hasSupply = mintInfo.supply > BigInt(0);
      result.checks['has_supply'] = {
        passed: hasSupply,
        message: hasSupply
          ? `Token supply: ${(Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals)).toLocaleString()}`
          : 'Token has zero supply (INVALID)',
        critical: true,
      };

      if (!hasSupply) {
        result.errors.push('Token has zero supply');
      }

      // Check 4: Reasonable decimals (usually 6 or 9 for Solana tokens)
      const reasonableDecimals = mintInfo.decimals >= 0 && mintInfo.decimals <= 12;
      result.checks['reasonable_decimals'] = {
        passed: reasonableDecimals,
        message: `Decimals: ${mintInfo.decimals}`,
        critical: false,
      };

      if (!reasonableDecimals) {
        result.warnings.push(`Unusual decimals: ${mintInfo.decimals}`);
      }

      // Tier 1 passes if ALL critical checks pass
      const allCriticalPassed = Object.values(result.checks)
        .filter(check => check.critical)
        .every(check => check.passed);

      result.passed = allCriticalPassed;

      logger.debug(`Tier 1 checks ${allCriticalPassed ? 'PASSED' : 'FAILED'}`);
    } catch (error) {
      logger.error('Error in Tier 1 checks', error);
      result.errors.push(`Tier 1 check error: ${error}`);
      result.passed = false;
    }
  }

  /**
   * TIER 2: Distribution & Concentration Checks
   * Non-fatal by default, but single-holder dominance is critical.
   */
  private async runTier2Checks(
    mintPubkey: PublicKey,
    result: SafetyCheckResult,
  ): Promise<void> {
    try {
      const [mintInfo, largestAccounts] = await Promise.all([
        getMint(this.connection, mintPubkey),
        this.connection.getTokenLargestAccounts(mintPubkey),
      ]);

      const totalSupply = Number(mintInfo.supply);
      const holders = largestAccounts.value;

      if (totalSupply <= 0 || holders.length === 0) {
        result.warnings.push('Could not fetch holder distribution');
        return;
      }

      // Check 1: Single largest holder must not dominate
      const largestHolder = holders[0];
      const largestPct = (Number(largestHolder.amount) / totalSupply) * 100;
      const maxPct = TOKEN_FILTERS.MAX_TOP_HOLDER_PERCENT;
      const topHolderOk = largestPct <= maxPct;
      // Hard reject only if a single wallet controls >50% (clear rug/dev wallet).
      // 20-50% gets a warning + score penalty — common in early memecoins.
      const topHolderCritical = largestPct > 50;

      result.checks['top_holder_limit'] = {
        passed: topHolderOk,
        message: topHolderOk
          ? `Largest holder: ${largestPct.toFixed(1)}% (≤${maxPct}% limit)`
          : `Largest holder: ${largestPct.toFixed(1)}% exceeds ${maxPct}% (${topHolderCritical ? 'CRITICAL' : 'warning'})`,
        critical: topHolderCritical,
      };
      if (topHolderCritical) {
        result.errors.push(
          `Single holder controls ${largestPct.toFixed(1)}% of supply — likely dev/rug wallet`,
        );
      } else if (!topHolderOk) {
        result.warnings.push(
          `Largest holder ${largestPct.toFixed(1)}% > ${maxPct}% — concentrated but not critical`,
        );
      }

      // Check 2: Top 10 holder concentration (warning only)
      const top10Total = holders
        .slice(0, 10)
        .reduce((sum, acc) => sum + Number(acc.amount), 0);
      const top10Pct = (top10Total / totalSupply) * 100;
      const maxTop10Pct = TOKEN_FILTERS.MAX_TOP10_HOLDER_PCT || 60;
      const concentrationOk = top10Pct <= maxTop10Pct;

      result.checks['holder_concentration'] = {
        passed: concentrationOk,
        message: concentrationOk
          ? `Top 10 holders: ${top10Pct.toFixed(1)}% (≤${maxTop10Pct}% limit)`
          : `Top 10 holders: ${top10Pct.toFixed(1)}% exceeds ${maxTop10Pct}% — high concentration risk`,
        critical: false,
      };
      if (!concentrationOk) {
        result.warnings.push(
          `Top 10 holders control ${top10Pct.toFixed(1)}% of supply`,
        );
      }

      // Check 3: Bundler concentration (Meridian-inspired)
      // Bundlers are wallets that appear as top holders across many tokens (exchange wallets, OTC desks)
      // For now, we use a heuristic: if top-100 holders control > MAX_BUNDLERS_PCT, flag as potential bundler risk
      const maxBundlersPct = TOKEN_FILTERS.MAX_BUNDLERS_PCT || 30;
      if (holders.length >= 100) {
        const top100Total = holders
          .slice(0, 100)
          .reduce((sum, acc) => sum + Number(acc.amount), 0);
        const top100Pct = (top100Total / totalSupply) * 100;
        const bundlersOk = top100Pct <= maxBundlersPct;

        result.checks['bundler_concentration'] = {
          passed: bundlersOk,
          message: bundlersOk
            ? `Top 100 holders: ${top100Pct.toFixed(1)}% (≤${maxBundlersPct}% limit)`
            : `Top 100 holders: ${top100Pct.toFixed(1)}% exceeds ${maxBundlersPct}% — possible bundler/exchange concentration`,
          critical: false,
        };
        if (!bundlersOk) {
          result.warnings.push(
            `Top 100 holders concentration high (${top100Pct.toFixed(1)}%) — possible exchange/bundler presence`,
          );
        }
      } else {
        result.checks['bundler_concentration'] = {
          passed: true,
          message: `Insufficient holder data (${holders.length} holders) for bundler check`,
          critical: false,
        };
      }

      logger.debug(
        `Tier 2: largest holder ${largestPct.toFixed(1)}%, top-10 ${top10Pct.toFixed(1)}%`,
      );
    } catch (error) {
      // Non-fatal: network issue should not block the whole check
      logger.debug(`Tier 2 checks failed (non-fatal): ${error}`);
      result.warnings.push('Holder distribution check unavailable (network)');
    }
  }

  /**
   * TIER 3: OKX Risk Checks (Meridian-inspired)
   * Uses OKX OnchainOS API for advanced risk assessment.
   */
  private async runTier3Checks(
    mintAddress: string,
    result: SafetyCheckResult,
  ): Promise<void> {
    try {
      const okxResult = await this.okxIntegration.getTokenRisk(mintAddress);

      if (!okxResult.success || !okxResult.risk) {
        result.warnings.push('OKX risk data unavailable');
        return;
      }

      const risk = okxResult.risk;

      // Check 1: Risk level (critical if HIGH)
      const riskLevelOk = risk.risk_level !== 'HIGH' || OKX_CONFIG.MAX_RISK_LEVEL === 'HIGH';
      result.checks['okx_risk_level'] = {
        passed: riskLevelOk,
        message: `OKX Risk Level: ${risk.risk_level}`,
        critical: risk.risk_level === 'HIGH' && OKX_CONFIG.MAX_RISK_LEVEL !== 'HIGH',
      };
      if (!riskLevelOk) {
        result.errors.push(`OKX Risk Level is HIGH - token flagged as dangerous`);
      }

      // Check 2: Bundler concentration (warning only unless extreme)
      const bundlerOk = risk.bundle_pct <= OKX_CONFIG.MAX_BUNDLE_PCT;
      result.checks['okx_bundle_pct'] = {
        passed: bundlerOk,
        message: bundlerOk
          ? `Bundler concentration: ${risk.bundle_pct.toFixed(1)}% (≤${OKX_CONFIG.MAX_BUNDLE_PCT}%)`
          : `Bundler concentration: ${risk.bundle_pct.toFixed(1)}% exceeds ${OKX_CONFIG.MAX_BUNDLE_PCT}%`,
        critical: risk.bundle_pct > 80, // Only critical if >80% (clear wash trading)
      };
      if (risk.bundle_pct > 80) {
        result.errors.push(`Extreme bundler concentration (${risk.bundle_pct.toFixed(1)}%) - likely wash trading`);
      } else if (!bundlerOk) {
        result.warnings.push(`High bundler concentration (${risk.bundle_pct.toFixed(1)}%)`);
      }

      // Check 3: Sniper concentration (warning only)
      const sniperOk = risk.sniper_pct <= OKX_CONFIG.MAX_SNIPER_PCT;
      result.checks['okx_sniper_pct'] = {
        passed: sniperOk,
        message: `Sniper activity: ${risk.sniper_pct.toFixed(1)}%`,
        critical: false,
      };
      if (!sniperOk) {
        result.warnings.push(`High sniper activity (${risk.sniper_pct.toFixed(1)}%)`);
      }

      // Check 4: Suspicious wallet concentration (warning only)
      const suspiciousOk = risk.suspicious_pct <= OKX_CONFIG.MAX_SUSPICIOUS_PCT;
      result.checks['okx_suspicious_pct'] = {
        passed: suspiciousOk,
        message: `Suspicious wallets: ${risk.suspicious_pct.toFixed(1)}%`,
        critical: false,
      };
      if (!suspiciousOk) {
        result.warnings.push(`High suspicious wallet concentration (${risk.suspicious_pct.toFixed(1)}%)`);
      }

      // Check 5: Dev sold all (CRITICAL)
      const devSafe = !risk.dev_sold_all;
      result.checks['okx_dev_sold_all'] = {
        passed: devSafe,
        message: devSafe ? 'Dev has not sold all tokens' : 'Dev has sold all tokens (RUG PULL RISK)',
        critical: true,
      };
      if (!devSafe) {
        result.errors.push('Dev has sold all tokens - high rug pull risk');
      }

      // Check 6: Wash trading detected (CRITICAL)
      const noWashTrading = !risk.wash_trading_detected;
      result.checks['okx_wash_trading'] = {
        passed: noWashTrading,
        message: noWashTrading ? 'No wash trading detected' : 'Wash trading detected',
        critical: true,
      };
      if (!noWashTrading) {
        result.errors.push('Wash trading detected by OKX');
      }

      // Positive signal: Smart money buying
      if (risk.smart_money_buy) {
        result.warnings.push('Positive: Smart money buying detected');
      }

      logger.debug(
        `Tier 3 (OKX): risk=${risk.risk_level}, bundle=${risk.bundle_pct.toFixed(1)}%, ` +
        `sniper=${risk.sniper_pct.toFixed(1)}%, suspicious=${risk.suspicious_pct.toFixed(1)}%`,
      );
    } catch (error) {
      // Non-fatal: OKX failure should not block the whole check
      logger.debug(`Tier 3 checks failed (non-fatal): ${error}`);
      result.warnings.push('OKX risk check unavailable');
    }
  }

  /**
   * Calculate safety score (0-100)
   */
  private calculateScore(result: SafetyCheckResult): number {
    const totalChecks = Object.keys(result.checks).length;
    if (totalChecks === 0) return 0;

    const passedChecks = Object.values(result.checks).filter(c => c.passed).length;
    const baseScore = (passedChecks / totalChecks) * 100;

    // Penalty for critical failures
    const criticalFailures = Object.values(result.checks)
      .filter(c => c.critical && !c.passed).length;

    const penalty = criticalFailures * 50; // -50 points per critical failure

    return Math.max(0, Math.min(100, baseScore - penalty));
  }

  /**
   * Determine tier based on score
   */
  private determineTier(score: number): number {
    if (score >= 75) return 4;
    if (score >= 60) return 3;
    if (score >= 40) return 2;
    return 1;
  }

  /**
   * Get token age in days
   */
  async getTokenAge(mintAddress: string): Promise<number> {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      const signatures = await this.connection.getSignaturesForAddress(mintPubkey, { limit: 1 });

      if (signatures.length === 0) {
        return 0;
      }

      const firstSignature = signatures[signatures.length - 1];
      if (!firstSignature.blockTime) {
        return 0;
      }

      const creationTime = firstSignature.blockTime * 1000; // Convert to milliseconds
      const now = Date.now();
      const ageMs = now - creationTime;
      const ageDays = ageMs / (24 * 60 * 60 * 1000);

      logger.debug(`Token age: ${ageDays.toFixed(2)} days`);
      return ageDays;
    } catch (error) {
      logger.error('Error getting token age', error);
      return 0;
    }
  }

  /**
   * Check if token age meets criteria
   */
  async checkTokenAge(mintAddress: string): Promise<{
    passed: boolean;
    age: number;
    message: string;
  }> {
    const age = await this.getTokenAge(mintAddress);
    const minAge = TOKEN_FILTERS.MIN_TOKEN_AGE_DAYS;
    const maxAge = TOKEN_FILTERS.MAX_TOKEN_AGE_DAYS;

    const passed = age >= minAge && age <= maxAge;
    const message = passed
      ? `Token age: ${age.toFixed(1)} days (within ${minAge}-${maxAge} days range)`
      : `Token age: ${age.toFixed(1)} days (outside ${minAge}-${maxAge} days range)`;

    return { passed, age, message };
  }
}

export default SafetyChecker;
