/**
 * OKX OnchainOS Integration
 *
 * Provides smart money and risk data for tokens via OKX OnchainOS API.
 * Used by Meridian for advanced safety checks.
 *
 * Key data points:
 * - risk_level: Overall risk assessment (LOW, MEDIUM, HIGH)
 * - bundle_pct: Percentage of tokens held by bundlers (exchange wallets, OTC desks)
 * - sniper_pct: Percentage of tokens held by snipers
 * - suspicious_pct: Percentage of tokens held by suspicious wallets
 * - smart_money_buy: Whether smart money is buying
 * - dev_sold_all: Whether dev has sold all tokens
 */

import axios from 'axios';
import { logger } from '../utils/logger';

const OKX_ONCHAINOS_API = 'https://www.okx.com/api/v5/explorer/onchain/token/token-advanced-info';

export interface OKXTokenRisk {
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  bundle_pct: number;
  sniper_pct: number;
  suspicious_pct: number;
  smart_money_buy: boolean;
  dev_sold_all: boolean;
  wash_trading_detected: boolean;
}

export interface OKXRiskCheckResult {
  success: boolean;
  risk?: OKXTokenRisk;
  error?: string;
}

export class OKXIntegration {
  private enabled: boolean;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  /**
   * Get risk data for a token from OKX OnchainOS.
   */
  async getTokenRisk(tokenMint: string): Promise<OKXRiskCheckResult> {
    if (!this.enabled) {
      return { success: false, error: 'OKX integration disabled' };
    }

    try {
      const resp = await axios.get(OKX_ONCHAINOS_API, {
        params: {
          tokenContractAddress: tokenMint,
          chainIndex: '501', // Solana chain ID
        },
        timeout: 10_000,
        headers: {
          'Accept': 'application/json',
        },
      });

      if (resp.data?.code !== '0') {
        return {
          success: false,
          error: `OKX API error: ${resp.data?.msg || 'Unknown error'}`,
        };
      }

      const data = resp.data?.data?.[0];
      if (!data) {
        return { success: false, error: 'No data returned' };
      }

      // Parse risk data from OKX response
      // Structure varies, so we handle it defensively
      const risk: OKXTokenRisk = {
        risk_level: this.parseRiskLevel(data.riskLevel || data.risk_level),
        bundle_pct: this.parsePercentage(data.bundlePct || data.bundle_pct || 0),
        sniper_pct: this.parsePercentage(data.sniperPct || data.sniper_pct || 0),
        suspicious_pct: this.parsePercentage(data.suspiciousPct || data.suspicious_pct || 0),
        smart_money_buy: !!data.smartMoneyBuy || !!data.smart_money_buy,
        dev_sold_all: !!data.devSoldAll || !!data.dev_sold_all,
        wash_trading_detected: this.detectWashTrading(data),
      };

      logger.debug(
        `[OKX] Token ${tokenMint.slice(0, 8)}...: risk=${risk.risk_level}, ` +
        `bundle=${risk.bundle_pct.toFixed(1)}%, sniper=${risk.sniper_pct.toFixed(1)}%, ` +
        `suspicious=${risk.suspicious_pct.toFixed(1)}%, smart_money=${risk.smart_money_buy}`,
      );

      return { success: true, risk };
    } catch (error: any) {
      logger.warn(`[OKX] Failed to fetch risk for ${tokenMint.slice(0, 8)}...: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if token is safe based on OKX risk data.
   * Returns false if risk is HIGH or critical flags are present.
   */
  async isTokenSafe(tokenMint: string): Promise<{ safe: boolean; reason?: string }> {
    const result = await this.getTokenRisk(tokenMint);

    if (!result.success || !result.risk) {
      // If OKX fails, we can't make a safety determination - proceed with caution
      return { safe: true, reason: 'OKX data unavailable' };
    }

    const risk = result.risk;

    // Hard reject: HIGH risk
    if (risk.risk_level === 'HIGH') {
      return { safe: false, reason: `HIGH risk level detected by OKX` };
    }

    // Hard reject: Dev sold all tokens
    if (risk.dev_sold_all) {
      return { safe: false, reason: 'Dev has sold all tokens (rug pull risk)' };
    }

    // Hard reject: Wash trading detected
    if (risk.wash_trading_detected) {
      return { safe: false, reason: 'Wash trading detected' };
    }

    // Warning: High bundler concentration (not a hard reject)
    if (risk.bundle_pct > 50) {
      logger.warn(
        `[OKX] ${tokenMint.slice(0, 8)}...: High bundler concentration (${risk.bundle_pct.toFixed(1)}%)`,
      );
    }

    // Warning: High sniper percentage
    if (risk.sniper_pct > 20) {
      logger.warn(
        `[OKX] ${tokenMint.slice(0, 8)}...: High sniper activity (${risk.sniper_pct.toFixed(1)}%)`,
      );
    }

    // Warning: High suspicious wallet percentage
    if (risk.suspicious_pct > 15) {
      logger.warn(
        `[OKX] ${tokenMint.slice(0, 8)}...: High suspicious wallet concentration (${risk.suspicious_pct.toFixed(1)}%)`,
      );
    }

    // Positive signal: Smart money is buying
    if (risk.smart_money_buy) {
      logger.info(
        `[OKX] ${tokenMint.slice(0, 8)}...: Smart money buying detected (positive signal)`,
      );
    }

    return { safe: true };
  }

  /**
   * Parse risk level from OKX response.
   */
  private parseRiskLevel(level: any): 'LOW' | 'MEDIUM' | 'HIGH' {
    if (!level) return 'MEDIUM';
    const normalized = String(level).toUpperCase();
    if (normalized.includes('HIGH')) return 'HIGH';
    if (normalized.includes('LOW')) return 'LOW';
    return 'MEDIUM';
  }

  /**
   * Parse percentage value (could be 0-1 or 0-100).
   */
  private parsePercentage(value: any): number {
    const num = parseFloat(value);
    if (isNaN(num)) return 0;
    // If value is <= 1, assume it's 0-1 scale and convert to percentage
    return num <= 1 ? num * 100 : num;
  }

  /**
   * Detect wash trading from OKX data.
   */
  private detectWashTrading(data: any): boolean {
    // OKX may provide explicit wash trading flag
    if (data.washTrading || data.wash_trading) {
      return true;
    }

    // Heuristic: Very high trading volume with low liquidity and high sniper/bundler activity
    const volume = data.volume24h || data.volume_24h || 0;
    const liquidity = data.liquidity || data.tvl || 0;
    const sniperPct = this.parsePercentage(data.sniperPct || data.sniper_pct || 0);
    const bundlePct = this.parsePercentage(data.bundlePct || data.bundle_pct || 0);

    if (liquidity > 0 && volume / liquidity > 10) {
      // Volume > 10x liquidity could indicate wash trading
      if (sniperPct > 30 || bundlePct > 40) {
        return true;
      }
    }

    return false;
  }
}

export default OKXIntegration;
