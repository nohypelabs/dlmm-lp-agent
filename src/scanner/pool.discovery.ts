/**
 * Pool Discovery
 *
 * Discovers Solana memecoin candidates with VALID Meteora DLMM pools.
 *
 * Flow:
 * 1. Fetch trending/boosted Solana memecoins from DexScreener
 * 2. For each token, find its Meteora DLMM pool (on-chain validation)
 * 3. Filter by age, volume, liquidity
 * 4. Score via TokenScanner safety checks
 * 5. Return validated candidates only
 */

import { Connection, PublicKey } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import axios from 'axios';
import { logger } from '../utils/logger';
import { TOKEN_FILTERS } from '../config/constants';
import { getEffectiveFilters } from '../memory/lessons';
import { TokenScanner, TokenCandidate } from './token.scanner';
import { isTokenBlocked } from '../memory/blacklist';

const DEXSCREENER_API = 'https://api.dexscreener.com';
const METEORA_DLMM_API = 'https://dlmm-api.meteora.ag';
const METEORA_POOL_DISCOVERY_API = 'https://pool-discovery-api.datapi.meteora.ag';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Module-level cache for getLbPairs — shared across all PoolDiscovery instances
// to avoid repeated slow on-chain fetches within the same process lifetime.
const LB_PAIRS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let lbPairsCache: { pairs: Awaited<ReturnType<typeof DLMM.getLbPairs>>; expiresAt: number } | null = null;

/** Raw pair record returned by DexScreener. */
interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceUsd: string;
  volume: { h24: number };
  liquidity: { usd: number };
  pairCreatedAt: number; // epoch ms
  fdv: number;
}

/** Discovered candidate enriched with pool info and scanner score. */
export interface DiscoveredCandidate {
  mintAddress: string;
  symbol: string;
  name: string;
  poolAddress: string;
  dexId: string;
  volume24h: number;
  liquidity: number;
  ageDays: number;
  priceUsd: number;
  fdv: number;
  /** Score from the TokenScanner (0-100), or -1 if scanning failed. */
  score: number;
  /** Full TokenCandidate when available. */
  candidate: TokenCandidate | null;
}

/** In-memory cache entry. */
interface CacheEntry {
  result: DiscoveredCandidate;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class PoolDiscovery {
  private connection: Connection;
  private tokenScanner: TokenScanner;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(connection: Connection, cacheTtlMs: number = DEFAULT_CACHE_TTL_MS) {
    this.connection = connection;
    this.tokenScanner = new TokenScanner(connection);
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Discover top DLMM pool candidates — memecoin focused.
   *
   * Only returns tokens that have a VERIFIED Meteora DLMM pool on-chain.
   */
  async discoverCandidates(limit: number = 3): Promise<DiscoveredCandidate[]> {
    logger.info(`[PoolDiscovery] Starting memecoin discovery (limit=${limit})`);

    // Step 1: Fetch trending Solana memecoin pairs
    const pairs = await this.fetchMemecoins();
    if (pairs.length === 0) {
      logger.warn('[PoolDiscovery] No memecoin pairs found');
      return [];
    }
    logger.info(`[PoolDiscovery] Fetched ${pairs.length} pairs total (Meteora API + DexScreener)`);

    // Step 2: Filter by age, volume, liquidity
    const filtered = this.filterPairs(pairs);
    logger.info(`[PoolDiscovery] ${filtered.length} pairs passed basic filters`);

    if (filtered.length === 0) return [];

    // Step 3: Deduplicate by base token (keep highest volume pair per token)
    const byToken = new Map<string, DexScreenerPair>();
    for (const pair of filtered) {
      const mint = pair.baseToken.address;
      const existing = byToken.get(mint);
      if (!existing || (pair.volume?.h24 ?? 0) > (existing.volume?.h24 ?? 0)) {
        byToken.set(mint, pair);
      }
    }
    const uniqueTokens = Array.from(byToken.values());
    logger.info(`[PoolDiscovery] ${uniqueTokens.length} unique tokens after dedup`);

    // Step 4: For each token, find & validate Meteora DLMM pool on-chain
    // Rate-limit: 600ms between tokens to avoid RPC 429s on public endpoints
    const validated: DiscoveredCandidate[] = [];

    for (const pair of uniqueTokens) {
      if (validated.length >= limit * 2) break; // Get enough to score

      const cached = this.getFromCache(pair.baseToken.address);
      if (cached) {
        validated.push(cached);
        continue;
      }

      const candidate = await this.validateAndScore(pair);
      if (candidate) {
        this.addToCache(candidate);
        validated.push(candidate);
        logger.info(`[PoolDiscovery] ✅ ${candidate.symbol}: DLMM pool valid, score=${candidate.score}`);
      }

      // Throttle between tokens to avoid public RPC rate limits
      await new Promise(r => setTimeout(r, 600));
    }

    // Step 5: Sort by score desc, take top N
    validated.sort((a, b) => b.score - a.score);
    const top = validated.slice(0, limit);

    logger.info(
      `[PoolDiscovery] Returning ${top.length} validated candidates: ` +
        top.map(c => `${c.symbol}(score:${c.score}, vol:$${(c.volume24h / 1000).toFixed(0)}K)`).join(', '),
    );

    return top;
  }

  // ─── Fetching ──────────────────────────────────────────────────

  /**
   * Fetch boosted token mints from DexScreener.
   * These are trending tokens (mostly from pump.fun).
   */
  private async fetchDexScreenerBoostedMints(limit: number = 30): Promise<string[]> {
    try {
      const resp = await axios.get(`${DEXSCREENER_API}/token-boosts/top/v1`, { timeout: 12_000 });
      const solanaMints: string[] = (resp.data ?? [])
        .filter((b: any) => b.chainId === 'solana')
        .map((b: any) => b.tokenAddress)
        .slice(0, limit);

      logger.debug(`[PoolDiscovery] Fetched ${solanaMints.length} boosted tokens`);
      return solanaMints;
    } catch (error: any) {
      logger.warn(`[PoolDiscovery] Failed to fetch boosted tokens: ${error.message}`);
      return [];
    }
  }

  /**
   * For a list of token mints, fetch all their pairs and filter for Meteora DLMM ones.
   */
  private async fetchMeteoraPairsForTokens(tokenMints: string[]): Promise<DexScreenerPair[]> {
    const allPairs: DexScreenerPair[] = [];

    // Process in batches of 5 to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < tokenMints.length; i += batchSize) {
      const batch = tokenMints.slice(i, i + batchSize);
      try {
        const pairResp = await axios.get(
          `${DEXSCREENER_API}/tokens/v1/solana/${batch.join(',')}`,
          { timeout: 12_000 },
        );
        const data: DexScreenerPair[] = Array.isArray(pairResp.data)
          ? pairResp.data
          : (pairResp.data?.pairs ?? []);

        // Filter for Meteora pairs
        const meteoraPairs = data
          .filter(p => p.chainId === 'solana' && p.dexId?.toLowerCase() === 'meteora')
          .filter(p => p.pairCreatedAt); // Only include pairs with creation time

        allPairs.push(...meteoraPairs);
      } catch (error: any) {
        logger.debug(`[PoolDiscovery] Failed to fetch pairs for batch: ${error.message}`);
      }

      // Small delay between batches
      if (i + batchSize < tokenMints.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    logger.debug(`[PoolDiscovery] Found ${allPairs.length} Meteora pairs from ${tokenMints.length} tokens`);
    return allPairs;
  }

  /**
   * Fetch from Meteora Pool Discovery API with category="trending".
   * NOTE: Currently returning 404 - API endpoint may have changed or is down.
   * Kept as fallback in case it comes back online.
   *
   * API: https://pool-discovery-api.datapi.meteora.ag/pairs?category=trending
   */
  private async fetchFromMeteoraPoolDiscovery(): Promise<DexScreenerPair[]> {
    try {
      const resp = await axios.get(`${METEORA_POOL_DISCOVERY_API}/pairs`, {
        params: {
          category: 'trending',
          limit: 50,
        },
        timeout: 12_000,
      });

      const raw = resp.data;
      const pools: any[] = Array.isArray(raw) ? raw : (raw?.data ?? raw?.pools ?? []);
      if (pools.length === 0) {
        logger.warn('[PoolDiscovery] Meteora Pool Discovery API returned no trending pools');
        return [];
      }

      const now = Date.now();
      const result: DexScreenerPair[] = [];

      for (const pool of pools) {
        // Extract pool data - structure varies
        const address = pool.address || pool.pool_address || pool.pubkey || '';
        if (!address) continue;

        // Get token mints
        const mintX = pool.token_x_mint || pool.tokenXMint || pool.mint_x || '';
        const mintY = pool.token_y_mint || pool.tokenYMint || pool.mint_y || '';

        // Only SOL-paired pools
        const hasSol = mintX === SOL_MINT || mintY === SOL_MINT;
        if (!hasSol) continue;

        const baseMint = mintY === SOL_MINT ? mintX : mintY;
        if (!baseMint) continue;

        // Token info
        const tokenX = pool.token_x || pool.tokenX || {};
        const tokenY = pool.token_y || pool.tokenY || {};
        const baseToken = mintY === SOL_MINT ? tokenX : tokenY;

        const name = baseToken?.name || baseToken?.symbol || baseMint.slice(0, 6);
        const symbol = baseToken?.symbol || name.split('/')[0]?.trim() || baseMint.slice(0, 6);

        // Pool metrics
        const vol24h = pool.volume_24h || pool.trade_volume_24h || pool.volume || 0;
        const liq = pool.tvl || pool.liquidity || pool.total_liquidity || 0;
        const price = pool.price || pool.current_price || 0;
        const fdv = pool.fdv || pool.market_cap || 0;

        // Created at - varies by API response
        let createdAt = 0;
        if (pool.created_at) {
          createdAt = typeof pool.created_at === 'number'
            ? (pool.created_at < 1e12 ? pool.created_at * 1000 : pool.created_at)
            : (new Date(pool.created_at as string).getTime() || 0);
        } else if (pool.pair_created_at) {
          createdAt = typeof pool.pair_created_at === 'number'
            ? (pool.pair_created_at < 1e12 ? pool.pair_created_at * 1000 : pool.pair_created_at)
            : (new Date(pool.pair_created_at as string).getTime() || 0);
        }

        result.push({
          chainId: 'solana',
          dexId: 'meteora',
          url: '',
          pairAddress: address,
          baseToken: { address: baseMint, symbol, name },
          quoteToken: { address: SOL_MINT, symbol: 'SOL', name: 'Solana' },
          priceUsd: String(price),
          volume: { h24: vol24h },
          liquidity: { usd: liq },
          pairCreatedAt: createdAt || now,
          fdv,
        });
      }

      logger.info(`[PoolDiscovery] Meteora Pool Discovery (trending): ${result.length} pairs`);
      return result;
    } catch (error: any) {
      logger.warn(`[PoolDiscovery] Meteora Pool Discovery API failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch DLMM candidates from multiple sources.
   *
   * Strategy 0 (primary): DexScreener boosted tokens (trending = new tokens).
   *   This is the BEST proxy for trending tokens when Meteora API is down.
   *   We search for DLMM pools for each boosted token.
   *
   * Strategy 1 (fallback): DexScreener search for Meteora pairs.
   *   DexScreener uses dexId="meteora" for all Meteora pools (DLMM + DAMM).
   *   On-chain DLMM.create() validation filters out non-DLMM pools.
   *
   * Strategy 2 (fallback): Meteora Pool Discovery API (currently 404 - down/changed).
   *
   * Strategy 3 (fallback): Meteora DLMM API (may be down).
   */
  private async fetchMemecoins(): Promise<DexScreenerPair[]> {
    let allPairs: DexScreenerPair[] = [];

    // ── Strategy 0: DexScreener boosted tokens (trending = new tokens) ──
    // This is PRIMARY - boosted tokens are guaranteed to be trending/new
    const boostedMints = await this.fetchDexScreenerBoostedMints();
    logger.info(`[PoolDiscovery] Strategy 0 (DexScreener boosted - trending): ${boostedMints.length} tokens`);

    // For each boosted token, fetch all pairs and look for Meteora DLMM ones
    if (boostedMints.length > 0) {
      const boostedPairs = await this.fetchMeteoraPairsForTokens(boostedMints);
      allPairs.push(...boostedPairs);
      logger.info(`[PoolDiscovery] Strategy 0 found ${boostedPairs.length} Meteora pairs from boosted tokens`);
    }

    // ── Fallbacks if we got 0 results ──
    if (allPairs.length === 0) {
      logger.warn('[PoolDiscovery] No pairs from boosted tokens, trying fallbacks...');

      // ── Strategy 1: DexScreener search for Meteora pairs ──
      const searchQueries = [
        'meteora sol',
        'meteora dlmm',
        'meteora solana meme',
      ];
      for (const q of searchQueries) {
        try {
          const resp = await axios.get<{ pairs: DexScreenerPair[] }>(
            `${DEXSCREENER_API}/latest/dex/search`,
            { params: { q }, timeout: 12_000 },
          );
          const pairs = (resp.data?.pairs ?? []).filter(
            p => p.chainId === 'solana' && p.dexId?.toLowerCase() === 'meteora',
          );
          allPairs.push(...pairs);
        } catch { /* continue */ }
      }
      logger.info(`[PoolDiscovery] Strategy 1 (DexScreener search): added pairs`);

      // ── Strategy 2: Meteora Pool Discovery API (currently 404) ───────
      const trendingPairs = await this.fetchFromMeteoraPoolDiscovery();
      allPairs.push(...trendingPairs);
      logger.info(`[PoolDiscovery] Strategy 2 (Meteora Pool Discovery): ${trendingPairs.length} pairs`);

      // ── Strategy 3: Meteora DLMM API (fallback, may be down) ───────
      const meteoraApiPairs = await this.fetchFromMeteoraDLMM();
      allPairs.push(...meteoraApiPairs);
      logger.info(`[PoolDiscovery] Strategy 3 (Meteora DLMM API): ${meteoraApiPairs.length} pairs`);
    }

    // ── Deduplicate by pairAddress, sort by volume ──────────────────
    const seen = new Set<string>();
    allPairs = allPairs.filter(p => {
      if (!p.pairAddress || seen.has(p.pairAddress)) return false;
      seen.add(p.pairAddress);
      return true;
    });
    allPairs.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));

    logger.info(`[PoolDiscovery] Total unique pairs after dedup: ${allPairs.length}`);
    return allPairs;
  }

  /**
   * Query Meteora DLMM API for top pools sorted by 24h volume.
   * All results are real DLMM pools — no DAMM/PumpSwap contamination.
   * Converts to DexScreenerPair shape for downstream compatibility.
   */
  private async fetchFromMeteoraDLMM(): Promise<DexScreenerPair[]> {
    try {
      const resp = await axios.get(`${METEORA_DLMM_API}/pair/all_with_pagination`, {
        params: { page: 0, limit: 100, sort_key: 'volume', order_by: 'desc' },
        timeout: 12_000,
      });

      const raw = resp.data;
      const pairs: any[] = Array.isArray(raw) ? raw : (raw?.data ?? raw?.pairs ?? []);
      if (pairs.length === 0) return [];

      const now = Date.now();
      const DEFAULT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // fallback: assume 7-day-old pool
      const result: DexScreenerPair[] = [];

      for (const p of pairs) {
        const mintX: string = p.mint_x ?? p.tokenXMint ?? '';
        const mintY: string = p.mint_y ?? p.tokenYMint ?? '';
        const addr: string  = p.address ?? p.pubkey ?? p.pool_address ?? '';

        if (!addr) continue;

        // Only SOL-paired pools
        const hasSol = mintX === SOL_MINT || mintY === SOL_MINT;
        if (!hasSol) continue;

        const baseMint = mintY === SOL_MINT ? mintX : mintY;
        if (!baseMint) continue;

        const name: string   = p.name ?? '';
        const symbol: string = name.split('/')[0]?.trim() || baseMint.slice(0, 6);
        const vol24h: number = p.trade_volume_24h ?? p.volume_24h ?? p.volume ?? 0;
        const liq: number    = p.liquidity ?? p.tvl ?? 0;
        const price: number  = p.current_price ?? p.price ?? 0;

        // Parse created_at defensively (ISO string or Unix seconds/ms)
        let createdAt = 0;
        if (p.created_at) {
          createdAt = typeof p.created_at === 'number'
            ? (p.created_at < 1e12 ? p.created_at * 1000 : p.created_at)
            : (new Date(p.created_at as string).getTime() || 0);
        }
        // If unknown, default to 7 days ago so age filter doesn't hard-reject
        const pairCreatedAt = createdAt > 0 ? createdAt : now - DEFAULT_AGE_MS;

        result.push({
          chainId: 'solana',
          dexId: 'meteora',
          url: '',
          pairAddress: addr,
          baseToken: { address: baseMint, symbol, name },
          quoteToken: { address: SOL_MINT, symbol: 'SOL', name: 'Solana' },
          priceUsd: String(price),
          volume: { h24: vol24h },
          liquidity: { usd: liq },
          pairCreatedAt,
          fdv: p.market_cap ?? p.fdv ?? 0,
        });
      }

      return result;
    } catch (error) {
      logger.warn(`[PoolDiscovery] Meteora API fetch failed: ${error}`);
      return [];
    }
  }

  // ─── Filtering ─────────────────────────────────────────────────

  private filterPairs(pairs: DexScreenerPair[]): DexScreenerPair[] {
    const now = Date.now();
    const evolved = getEffectiveFilters();

    return pairs.filter(pair => {
      if (!pair.pairCreatedAt) return false;

      // Age filter (min 1 day default)
      const ageDays = (now - pair.pairCreatedAt) / (24 * 60 * 60 * 1000);
      if (ageDays < TOKEN_FILTERS.MIN_TOKEN_AGE_DAYS) return false;
      if (ageDays > TOKEN_FILTERS.MAX_TOKEN_AGE_DAYS) return false;

      // Volume filter — uses evolved thresholds when available
      const vol24h = pair.volume?.h24 ?? 0;
      if (vol24h < evolved.MIN_DAILY_VOLUME) return false;
      if (vol24h > TOKEN_FILTERS.MAX_DAILY_VOLUME) return false;

      // Liquidity floor — uses evolved thresholds
      const liq = pair.liquidity?.usd ?? 0;
      if (liq < evolved.MIN_LIQUIDITY) return false;

      // Market cap filter (Meridian-inspired)
      const mcap = pair.fdv ?? 0;
      if (mcap < evolved.MIN_MCAP_USD) {
        logger.debug(`[PoolDiscovery] ${pair.baseToken.symbol}: MCAP $${(mcap/1000).toFixed(0)}K below min $${(evolved.MIN_MCAP_USD/1000).toFixed(0)}K`);
        return false;
      }
      if (mcap > evolved.MAX_MCAP_USD) {
        logger.debug(`[PoolDiscovery] ${pair.baseToken.symbol}: MCAP $${(mcap/1000000).toFixed(0)}M above max $${(evolved.MAX_MCAP_USD/1000000).toFixed(0)}M`);
        return false;
      }

      // Fee/TVL ratio filter (Meridian-inspired) - requires fee data
      // Estimate fee: ~0.25% of volume per day for DLMM pools
      const estimatedDailyFees = vol24h * 0.0025;
      const feeTvlRatio = liq > 0 ? estimatedDailyFees / liq : 0;
      if (feeTvlRatio < evolved.MIN_FEE_ACTIVE_TVL_RATIO) {
        logger.debug(`[PoolDiscovery] ${pair.baseToken.symbol}: Fee/TVL ratio ${feeTvlRatio.toFixed(3)} below min ${evolved.MIN_FEE_ACTIVE_TVL_RATIO}`);
        return false;
      }

      // Minimum token fees filter (Meridian-inspired)
      // Only accept pools that generate at least MIN_TOKEN_FEES_SOL worth of fees daily
      const currentPriceUsd = parseFloat(pair.priceUsd) || 0;
      if (currentPriceUsd > 0 && TOKEN_FILTERS.MIN_TOKEN_FEES_SOL > 0) {
        const SOL_PRICE_USD = 150; // Approximate SOL price
        const minFeesUsd = TOKEN_FILTERS.MIN_TOKEN_FEES_SOL * SOL_PRICE_USD;
        if (estimatedDailyFees < minFeesUsd) {
          logger.debug(`[PoolDiscovery] ${pair.baseToken.symbol}: Daily fees $${estimatedDailyFees.toFixed(2)} below min $${minFeesUsd.toFixed(2)}`);
          return false;
        }
      }

      // ATH distance filter (Meridian-inspired)
      // Reject if price is within MAX_ATH_DISTANCE_PCT% of ATH (potential pump-n-dump)
      // Note: DexScreener doesn't provide ATH data directly, so this is a placeholder
      // In full implementation, you would fetch ATH data from DexScreener's token detail API
      // For now, we skip this check as it requires additional API calls

      // Blocked launchpads check (Meridian-inspired)
      // Check if token is from a blocked launchpad
      if (TOKEN_FILTERS.BLOCKED_LAUNCHPADS.length > 0) {
        const mint = pair.baseToken.address;
        const isBlocked = TOKEN_FILTERS.BLOCKED_LAUNCHPADS.some(blocked =>
          mint.startsWith(blocked) || blocked.includes(mint)
        );
        if (isBlocked) {
          logger.debug(`[PoolDiscovery] ${pair.baseToken.symbol}: Token from blocked launchpad`);
          return false;
        }
      }

      // Must be paired with SOL or USDC (not random token pairs)
      const quote = pair.quoteToken?.address ?? '';
      const isSolPair = quote === SOL_MINT || pair.quoteToken?.symbol === 'SOL';
      const isUsdcPair = pair.quoteToken?.symbol === 'USDC' || pair.quoteToken?.symbol === 'USDT';
      if (!isSolPair && !isUsdcPair) return false;

      return true;
    });
  }

  // ─── Validation & Scoring ──────────────────────────────────────

  /**
   * For a given DexScreener pair, find its Meteora DLMM pool on-chain
   * and run safety scoring.
   */
  private async validateAndScore(pair: DexScreenerPair): Promise<DiscoveredCandidate | null> {
    const mintAddress = pair.baseToken.address;
    const sym = pair.baseToken.symbol;
    const now = Date.now();
    const ageDays = (now - pair.pairCreatedAt) / (24 * 60 * 60 * 1000);

    // Blacklist check — skip before any RPC calls
    if (isTokenBlocked(mintAddress)) {
      logger.debug(`[PoolDiscovery] ❌ ${sym}: blacklisted`);
      return null;
    }

    const dexId = pair.dexId?.toLowerCase() ?? '';
    let validPoolAddress: string | null = null;

    // DexScreener uses dexId="meteora" for both DLMM and DAMM pools.
    // Always try direct DLMM validation — DLMM.create() will reject DAMM pools.
    if (dexId === 'meteora') {
      const isValid = await this.validateDlmmPool(pair.pairAddress);
      if (isValid) {
        validPoolAddress = pair.pairAddress;
        logger.debug(`[PoolDiscovery] ✅ ${sym}: direct DLMM pool confirmed`);
      } else {
        logger.debug(`[PoolDiscovery]    ${sym}: not a DLMM pool, searching for one...`);
      }
    }

    // If direct validation failed or pair isn't from Meteora, search for a DLMM pool.
    if (!validPoolAddress) {
      validPoolAddress = await this.findDlmmPoolForToken(mintAddress);
    }

    if (!validPoolAddress) {
      logger.info(`[PoolDiscovery] ❌ ${sym}: no DLMM pool found (dexId=${dexId})`);
      return null;
    }

    // Score via safety checker
    try {
      const candidate = await this.tokenScanner.scanToken(mintAddress, {
        includeTier2: true,
        includeTier3: true,
        includeTier4: true,
      });

      // Skip tokens that failed any tier (e.g. Tier 2 volume check)
      if (candidate && !candidate.recommended) {
        logger.debug(`[PoolDiscovery] ❌ ${sym}: not recommended (score=${candidate.score}, tiers failed)`);
        return null;
      }

      const score = candidate?.score ?? -1;
      logger.info(
        `[PoolDiscovery] ✅ ${sym}: pool=${validPoolAddress.slice(0, 8)}... score=${score} vol=$${((pair.volume?.h24 ?? 0) / 1000).toFixed(0)}K liq=$${((pair.liquidity?.usd ?? 0) / 1000).toFixed(0)}K`,
      );

      return {
        mintAddress,
        symbol: sym,
        name: pair.baseToken.name,
        poolAddress: validPoolAddress,
        dexId: 'meteora',
        volume24h: pair.volume?.h24 ?? 0,
        liquidity: pair.liquidity?.usd ?? 0,
        ageDays,
        priceUsd: parseFloat(pair.priceUsd) || 0,
        fdv: pair.fdv ?? 0,
        score,
        candidate,
      };
    } catch (error) {
      logger.error(`[PoolDiscovery] Scoring failed for ${sym}: ${error}`);
      return null;
    }
  }

  /**
   * Validate that a pool address is actually a Meteora DLMM pool.
   * Retries once after 1s on failure to handle transient 429s.
   */
  private async validateDlmmPool(poolAddress: string): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
        await dlmmPool.getActiveBin();
        return true;
      } catch (err: any) {
        const is429 = err?.message?.includes('429') || err?.message?.includes('Too Many');
        if (is429 && attempt === 0) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        return false;
      }
    }
    return false;
  }

  /**
   * Search for a Meteora DLMM pool for a given token mint.
   *
   * Fast path: query DexScreener token API (HTTP, no RPC cost).
   * Slow fallback: on-chain getLbPairs with a hard 12s timeout and
   *                module-level 5-minute result cache.
   */
  private async findDlmmPoolForToken(tokenMint: string): Promise<string | null> {
    // Fast path: DexScreener token lookup → no RPC calls
    try {
      const result = await this.findDlmmPoolViaDexScreener(tokenMint);
      if (result) return result;
    } catch {
      logger.debug(`[PoolDiscovery] DexScreener lookup failed for ${tokenMint.slice(0, 8)}...`);
    }

    // Slow fallback: on-chain with timeout + cache
    return this.findDlmmPoolOnChain(tokenMint);
  }

  /**
   * Query DexScreener for this token's pairs, then filter for Meteora DLMM ones.
   * Validates each candidate on-chain before returning.
   */
  private async findDlmmPoolViaDexScreener(tokenMint: string): Promise<string | null> {
    const resp = await axios.get(
      `${DEXSCREENER_API}/tokens/v1/solana/${tokenMint}`,
      { timeout: 8_000 },
    );
    const data: DexScreenerPair[] = Array.isArray(resp.data)
      ? resp.data
      : (resp.data?.pairs ?? []);

    const meteoraPairs = data
      .filter(
        // DexScreener uses "meteora" for all Meteora pools. DLMM.create() validation
        // below will confirm which ones are actually DLMM (vs DAMM).
        p => p.chainId === 'solana' && p.dexId?.toLowerCase() === 'meteora',
      )
      .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));

    if (meteoraPairs.length === 0) return null;

    for (const pair of meteoraPairs.slice(0, 3)) {
      const isValid = await this.validateDlmmPool(pair.pairAddress);
      if (isValid) {
        logger.debug(
          `[PoolDiscovery] DexScreener found DLMM pool for ${tokenMint.slice(0, 8)}...: ${pair.pairAddress.slice(0, 8)}...`,
        );
        return pair.pairAddress;
      }
    }
    return null;
  }

  /**
   * On-chain fallback: fetch all LB pairs with a 12s hard timeout.
   * Results are cached for 5 minutes at the module level to avoid
   * redundant full-scan fetches within the same process.
   */
  private async findDlmmPoolOnChain(tokenMint: string): Promise<string | null> {
    try {
      let allPairs = lbPairsCache && Date.now() < lbPairsCache.expiresAt
        ? lbPairsCache.pairs
        : null;

      if (!allPairs) {
        logger.debug('[PoolDiscovery] Falling back to on-chain getLbPairs (slow — may take up to 12s)...');
        allPairs = await Promise.race([
          DLMM.getLbPairs(this.connection),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('getLbPairs timeout after 12s')), 12_000),
          ),
        ]);
        lbPairsCache = { pairs: allPairs, expiresAt: Date.now() + LB_PAIRS_CACHE_TTL_MS };
        logger.debug(`[PoolDiscovery] LB pairs cached: ${allPairs.length} pairs (TTL 5min)`);
      }

      const matching = allPairs.filter(p => {
        const xMint = p.account.tokenXMint.toBase58();
        const yMint = p.account.tokenYMint.toBase58();
        return (
          (xMint === tokenMint && yMint === SOL_MINT) ||
          (xMint === SOL_MINT && yMint === tokenMint) ||
          xMint === tokenMint ||
          yMint === tokenMint
        );
      });

      if (matching.length === 0) return null;

      const solPair = matching.find(p => {
        const xMint = p.account.tokenXMint.toBase58();
        const yMint = p.account.tokenYMint.toBase58();
        return xMint === SOL_MINT || yMint === SOL_MINT;
      });

      const bestMatch = solPair || matching[0];
      const poolAddr = bestMatch.publicKey.toBase58();
      const valid = await this.validateDlmmPool(poolAddr);
      return valid ? poolAddr : null;
    } catch (error) {
      logger.debug(`[PoolDiscovery] On-chain fallback failed for ${tokenMint.slice(0, 8)}...: ${error}`);
      return null;
    }
  }

  // ─── Cache management ──────────────────────────────────────────

  private getFromCache(mintAddress: string): DiscoveredCandidate | null {
    const entry = this.cache.get(mintAddress);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(mintAddress);
      return null;
    }
    return entry.result;
  }

  private addToCache(candidate: DiscoveredCandidate): void {
    this.cache.set(candidate.mintAddress, {
      result: candidate,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  pruneCache(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      logger.debug(`[PoolDiscovery] Pruned ${pruned} expired cache entries`);
    }
    return pruned;
  }
}

export default PoolDiscovery;
