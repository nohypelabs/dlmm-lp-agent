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
import { TokenScanner, TokenCandidate } from './token.scanner';
import { isTokenBlocked } from '../memory/blacklist';

const DEXSCREENER_API = 'https://api.dexscreener.com';
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
    logger.info(`[PoolDiscovery] Fetched ${pairs.length} memecoin pairs from DexScreener`);

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
   * Fetch Solana memecoins from multiple DexScreener sources.
   * Specifically targets Meteora DLMM pairs first, then broadens.
   */
  private async fetchMemecoins(): Promise<DexScreenerPair[]> {
    let allPairs: DexScreenerPair[] = [];

    // Strategy 1: Direct search for Meteora DLMM memecoins
    const meteoraQueries = [
      'meteora dlmm meme',
      'meteora dlmm SOL',
      'meteora memecoin',
    ];

    for (const q of meteoraQueries) {
      try {
        const resp = await axios.get<{ pairs: DexScreenerPair[] }>(
          `${DEXSCREENER_API}/latest/dex/search`,
          { params: { q }, timeout: 15_000 },
        );
        const pairs = (resp.data?.pairs ?? []).filter(
          (p: DexScreenerPair) =>
            p.chainId === 'solana' &&
            p.dexId?.toLowerCase().includes('meteora'),
        );
        allPairs.push(...pairs);
      } catch {
        // continue
      }
    }

    logger.info(`[PoolDiscovery] Meteora-specific search: ${allPairs.length} pairs`);

    // Strategy 2: Boosted/trending tokens — then check if they have Meteora pools
    try {
      const resp = await axios.get(`${DEXSCREENER_API}/token-boosts/top/v1`, {
        timeout: 15_000,
      });
      const boosts = resp.data ?? [];
      const solanaMints: string[] = boosts
        .filter((b: any) => b.chainId === 'solana')
        .map((b: any) => b.tokenAddress)
        .slice(0, 30);

      // Fetch all pairs for these tokens, we'll find Meteora ones later
      for (let i = 0; i < solanaMints.length; i += 5) {
        const batch = solanaMints.slice(i, i + 5).join(',');
        try {
          const pairResp = await axios.get(
            `${DEXSCREENER_API}/tokens/v1/solana/${batch}`,
            { timeout: 15_000 },
          );
          const data = Array.isArray(pairResp.data) ? pairResp.data : (pairResp.data?.pairs ?? []);
          const solanaPairs = data.filter(
            (p: DexScreenerPair) => p.chainId === 'solana',
          );
          allPairs.push(...solanaPairs);
        } catch {
          // skip
        }
      }
    } catch {
      logger.debug('[PoolDiscovery] Boosted endpoint failed');
    }

    // Strategy 3: General memecoin search
    const memeQueries = ['solana meme new', 'SOL memecoin trending', 'pump.fun meme'];
    for (const q of memeQueries) {
      try {
        const resp = await axios.get<{ pairs: DexScreenerPair[] }>(
          `${DEXSCREENER_API}/latest/dex/search`,
          { params: { q }, timeout: 15_000 },
        );
        const pairs = (resp.data?.pairs ?? []).filter(
          (p: DexScreenerPair) => p.chainId === 'solana',
        );
        allPairs.push(...pairs);
      } catch {
        // continue
      }
    }

    // Deduplicate by pairAddress
    const seen = new Set<string>();
    allPairs = allPairs.filter(p => {
      if (seen.has(p.pairAddress)) return false;
      seen.add(p.pairAddress);
      return true;
    });

    // Sort by 24h volume desc
    allPairs.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));

    logger.info(`[PoolDiscovery] Total unique pairs: ${allPairs.length}`);
    return allPairs;
  }

  // ─── Filtering ─────────────────────────────────────────────────

  private filterPairs(pairs: DexScreenerPair[]): DexScreenerPair[] {
    const now = Date.now();

    return pairs.filter(pair => {
      if (!pair.pairCreatedAt) return false;

      // Age filter (min 1 day default)
      const ageDays = (now - pair.pairCreatedAt) / (24 * 60 * 60 * 1000);
      if (ageDays < TOKEN_FILTERS.MIN_TOKEN_AGE_DAYS) return false;
      if (ageDays > TOKEN_FILTERS.MAX_TOKEN_AGE_DAYS) return false;

      // Volume filter
      const vol24h = pair.volume?.h24 ?? 0;
      if (vol24h < TOKEN_FILTERS.MIN_DAILY_VOLUME) return false;
      if (vol24h > TOKEN_FILTERS.MAX_DAILY_VOLUME) return false;

      // Liquidity floor
      const liq = pair.liquidity?.usd ?? 0;
      if (liq < TOKEN_FILTERS.MIN_LIQUIDITY) return false;

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

    // Only attempt direct DLMM validation when DexScreener explicitly marks
    // the pair as DLMM (dexId === 'meteora_dlmm').
    // 'meteora' without '_dlmm' = DAMM / Stable pool — DLMM.create() will fail.
    if (dexId === 'meteora_dlmm') {
      const isValid = await this.validateDlmmPool(pair.pairAddress);
      if (isValid) {
        validPoolAddress = pair.pairAddress;
        logger.debug(`[PoolDiscovery] ✅ ${sym}: direct DLMM pool confirmed`);
      } else {
        logger.debug(`[PoolDiscovery]    ${sym}: direct pool invalid, searching...`);
      }
    }

    // For DAMM pairs (dexId='meteora') or failed direct validation,
    // search for an actual DLMM pool for this token.
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
        includeTier3: false,
        includeTier4: false,
      });

      const score = candidate?.score ?? -1;
      logger.info(
        `[PoolDiscovery] ✅ ${sym}: pool=${validPoolAddress.slice(0, 8)}... score=${score} vol=$${((pair.volume?.h24 ?? 0) / 1000).toFixed(0)}K liq=$${((pair.liquidity?.usd ?? 0) / 1000).toFixed(0)}K`,
      );

      return {
        mintAddress,
        symbol: sym,
        name: pair.baseToken.name,
        poolAddress: validPoolAddress,
        dexId: 'meteora_dlmm',
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
        // Only actual DLMM pairs — skip DAMM (dexId='meteora')
        p => p.chainId === 'solana' && p.dexId?.toLowerCase() === 'meteora_dlmm',
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
