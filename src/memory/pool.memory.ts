/**
 * Pool Memory
 *
 * Remembers historical performance per pool so the agent can:
 * - Score pools based on past results (prefer winners, avoid losers)
 * - Put pools on cooldown after bad exits
 * - Skip pools that have consistently underperformed
 *
 * Persists to data/pool-memory.json — survives restarts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

const MEMORY_FILE = path.join(process.cwd(), 'data', 'pool-memory.json');
const COOLDOWN_DURATIONS: Record<string, number> = {
  stop_loss: 4 * 60 * 60 * 1000,  // 4h after stop loss
  il_limit:  2 * 60 * 60 * 1000,  // 2h after IL breach
  manual:    0,                     // no cooldown
  rebalance: 0,
  take_profit: 0,
};

export interface PoolHistoryEntry {
  positionId: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  feesEarned: number;
  durationMs: number;
  exitReason: string;
}

export interface PoolRecord {
  address: string;
  tokenSymbol: string;
  history: PoolHistoryEntry[];
  // Derived stats (recalculated on each write)
  entryCount: number;
  winCount: number;
  winRate: number;        // 0–1
  avgPnlPercent: number;
  totalFeesEarned: number;
  score: number;          // 0–100: higher = better candidate
  cooldownUntil: number;  // epoch ms, 0 = no cooldown
  notes: string[];
}

interface PoolMemoryStore {
  version: 1;
  updatedAt: number;
  pools: Record<string, PoolRecord>;
}

// ─── I/O ───────────────────────────────────────────────────────

function load(): PoolMemoryStore {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    }
  } catch {
    logger.warn('pool.memory: failed to load, starting fresh');
  }
  return { version: 1, updatedAt: Date.now(), pools: {} };
}

function save(store: PoolMemoryStore): void {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    store.updatedAt = Date.now();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    logger.error(`pool.memory: save failed: ${err}`);
  }
}

// ─── Score calculation ─────────────────────────────────────────
// Combines win rate, avg PnL, and recency into a 0–100 score.
// Pools with < 2 entries get a neutral 50.

function calcScore(record: PoolRecord): number {
  if (record.entryCount < 2) return 50;

  const winRateScore = record.winRate * 40;        // max 40pts
  const avgPnlScore  = Math.min(Math.max(record.avgPnlPercent, -20), 20) / 20 * 40; // max 40pts
  const feeScore     = Math.min(record.totalFeesEarned / 10, 1) * 20; // max 20pts (capped at $10 fees)

  return Math.round(Math.max(0, Math.min(100, winRateScore + avgPnlScore + feeScore)));
}

function recompute(record: PoolRecord): void {
  record.entryCount      = record.history.length;
  record.winCount        = record.history.filter(h => h.pnlPercent > 0).length;
  record.winRate         = record.entryCount > 0 ? record.winCount / record.entryCount : 0;
  record.avgPnlPercent   = record.entryCount > 0
    ? record.history.reduce((s, h) => s + h.pnlPercent, 0) / record.entryCount
    : 0;
  record.totalFeesEarned = record.history.reduce((s, h) => s + h.feesEarned, 0);
  record.score           = calcScore(record);
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Record a closed position into pool memory.
 */
export function recordClose(params: {
  poolAddress: string;
  tokenSymbol: string;
  positionId: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnlPercent: number;
  feesEarned: number;
  exitReason: string;
}): void {
  const store = load();

  if (!store.pools[params.poolAddress]) {
    store.pools[params.poolAddress] = {
      address: params.poolAddress,
      tokenSymbol: params.tokenSymbol,
      history: [],
      entryCount: 0,
      winCount: 0,
      winRate: 0,
      avgPnlPercent: 0,
      totalFeesEarned: 0,
      score: 50,
      cooldownUntil: 0,
      notes: [],
    };
  }

  const record = store.pools[params.poolAddress];
  record.tokenSymbol = params.tokenSymbol; // keep fresh

  record.history.push({
    positionId: params.positionId,
    entryTime:  params.entryTime,
    exitTime:   params.exitTime,
    entryPrice: params.entryPrice,
    exitPrice:  params.exitPrice,
    pnlPercent: params.pnlPercent,
    feesEarned: params.feesEarned,
    durationMs: params.exitTime - params.entryTime,
    exitReason: params.exitReason,
  });

  // Apply cooldown for bad exits
  const cooldownMs = COOLDOWN_DURATIONS[params.exitReason] ?? 0;
  if (cooldownMs > 0) {
    record.cooldownUntil = Date.now() + cooldownMs;
    logger.info(`pool.memory: ${params.tokenSymbol} on ${params.exitReason} cooldown for ${cooldownMs / 3600000}h`);
  }

  recompute(record);
  save(store);
  logger.info(`pool.memory: recorded close for ${params.tokenSymbol} | score=${record.score} winRate=${(record.winRate * 100).toFixed(0)}%`);
}

/**
 * Check if a pool is on cooldown. Returns true = skip this pool.
 */
export function isOnCooldown(poolAddress: string): boolean {
  const store = load();
  const record = store.pools[poolAddress];
  if (!record) return false;
  return record.cooldownUntil > Date.now();
}

/**
 * Get pool record (null if never seen).
 */
export function getPoolRecord(poolAddress: string): PoolRecord | null {
  const store = load();
  return store.pools[poolAddress] ?? null;
}

/**
 * Get pool score (0–100). Returns 50 for unknown pools.
 */
export function getPoolScore(poolAddress: string): number {
  return getPoolRecord(poolAddress)?.score ?? 50;
}

/**
 * Add a manual note to a pool (e.g. "high wash trading suspected").
 */
export function addNote(poolAddress: string, tokenSymbol: string, note: string): void {
  const store = load();
  if (!store.pools[poolAddress]) {
    store.pools[poolAddress] = {
      address: poolAddress,
      tokenSymbol,
      history: [],
      entryCount: 0, winCount: 0, winRate: 0,
      avgPnlPercent: 0, totalFeesEarned: 0,
      score: 50, cooldownUntil: 0, notes: [],
    };
  }
  store.pools[poolAddress].notes.push(`[${new Date().toISOString()}] ${note}`);
  save(store);
}

/**
 * Get all pool records sorted by score descending.
 */
export function getRankedPools(): PoolRecord[] {
  const store = load();
  return Object.values(store.pools).sort((a, b) => b.score - a.score);
}
