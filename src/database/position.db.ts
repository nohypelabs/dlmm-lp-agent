/**
 * Position Database
 *
 * JSON file-based persistence for positions and performance history.
 * Stores data in data/positions.json and data/performance.json.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { Position } from '../strategy/position.manager';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
const PERFORMANCE_FILE = path.join(DATA_DIR, 'performance.json');

export interface DailySnapshot {
  date: string; // YYYY-MM-DD
  totalValueUsd: number;
  totalPnl: number;
  totalPnlPercent: number;
  totalFeesEarned: number;
  positionsOpen: number;
  positionsClosed: number;
  bestPosition: { id: string; tokenSymbol: string; pnlPercent: number } | null;
  worstPosition: { id: string; tokenSymbol: string; pnlPercent: number } | null;
}

export interface PerformanceHistory {
  startDate: string;
  startingCapital: number;
  dailySnapshots: DailySnapshot[];
  lifetimePnl: number;
  lifetimeFeesEarned: number;
  totalPositionsOpened: number;
  totalPositionsClosed: number;
}

/**
 * Ensure the data directory exists.
 */
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    logger.info(`Created data directory: ${DATA_DIR}`);
  }
}

/**
 * Safely write JSON to a file with atomic rename to avoid corruption.
 */
function writeJsonFile(filePath: string, data: unknown): void {
  ensureDataDir();
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Safely read and parse a JSON file. Returns null if the file does not exist
 * or cannot be parsed.
 */
function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.error(`Failed to read ${filePath}`, error);
    return null;
  }
}

/**
 * Save positions to disk.
 */
export function savePositions(positions: Position[]): void {
  try {
    writeJsonFile(POSITIONS_FILE, positions);
    logger.debug(`Saved ${positions.length} positions to ${POSITIONS_FILE}`);
  } catch (error) {
    logger.error('Failed to save positions', error);
  }
}

/**
 * Load positions from disk.
 * Returns an empty array when no persisted data exists.
 */
export function loadPositions(): Position[] {
  const positions = readJsonFile<Position[]>(POSITIONS_FILE);
  if (!positions) {
    logger.debug('No persisted positions found, starting fresh');
    return [];
  }
  logger.info(`Loaded ${positions.length} positions from disk`);
  return positions;
}

/**
 * Save a daily performance snapshot.
 * Appends to (or updates) the snapshot for the given date.
 */
export function savePerformance(snapshot: DailySnapshot): void {
  try {
    let history = readJsonFile<PerformanceHistory>(PERFORMANCE_FILE);

    if (!history) {
      history = {
        startDate: snapshot.date,
        startingCapital: snapshot.totalValueUsd,
        dailySnapshots: [],
        lifetimePnl: 0,
        lifetimeFeesEarned: 0,
        totalPositionsOpened: 0,
        totalPositionsClosed: 0,
      };
    }

    // Replace existing snapshot for the same date, or append
    const existingIdx = history.dailySnapshots.findIndex(s => s.date === snapshot.date);
    if (existingIdx >= 0) {
      history.dailySnapshots[existingIdx] = snapshot;
    } else {
      history.dailySnapshots.push(snapshot);
    }

    // Keep snapshots sorted chronologically
    history.dailySnapshots.sort((a, b) => a.date.localeCompare(b.date));

    // Recalculate lifetime aggregates from snapshots
    history.lifetimePnl = history.dailySnapshots.reduce((sum, s) => sum + s.totalPnl, 0);
    history.lifetimeFeesEarned = history.dailySnapshots.reduce((sum, s) => sum + s.totalFeesEarned, 0);
    history.totalPositionsOpened = history.dailySnapshots.reduce((sum, s) => sum + s.positionsOpen, 0);
    history.totalPositionsClosed = history.dailySnapshots.reduce((sum, s) => sum + s.positionsClosed, 0);

    writeJsonFile(PERFORMANCE_FILE, history);
    logger.debug(`Saved performance snapshot for ${snapshot.date}`);
  } catch (error) {
    logger.error('Failed to save performance', error);
  }
}

/**
 * Build a DailySnapshot from a set of positions for today (or a given date).
 */
export function buildDailySnapshot(positions: Position[], date?: string): DailySnapshot {
  const snapshotDate = date ?? new Date().toISOString().slice(0, 10);

  const openPositions = positions.filter(p => p.status === 'open');
  const closedPositions = positions.filter(p => p.status === 'closed');

  const totalValueUsd = openPositions.reduce((sum, p) => sum + p.currentValueUsd, 0);
  const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);
  const totalInvested = positions.reduce((sum, p) => sum + p.totalValueUsd, 0);
  const totalPnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const totalFeesEarned = positions.reduce((sum, p) => sum + p.feesEarned, 0);

  let bestPosition: DailySnapshot['bestPosition'] = null;
  let worstPosition: DailySnapshot['worstPosition'] = null;

  for (const p of positions) {
    const symbol = p.tokenSymbol ?? p.tokenX.slice(0, 8);
    if (!bestPosition || p.pnlPercent > bestPosition.pnlPercent) {
      bestPosition = { id: p.id, tokenSymbol: symbol, pnlPercent: p.pnlPercent };
    }
    if (!worstPosition || p.pnlPercent < worstPosition.pnlPercent) {
      worstPosition = { id: p.id, tokenSymbol: symbol, pnlPercent: p.pnlPercent };
    }
  }

  return {
    date: snapshotDate,
    totalValueUsd,
    totalPnl,
    totalPnlPercent,
    totalFeesEarned,
    positionsOpen: openPositions.length,
    positionsClosed: closedPositions.length,
    bestPosition,
    worstPosition,
  };
}

/**
 * Retrieve daily stats for a given date range (inclusive).
 * When no range is specified, returns all snapshots.
 */
export function getDailyStats(from?: string, to?: string): DailySnapshot[] {
  const history = readJsonFile<PerformanceHistory>(PERFORMANCE_FILE);
  if (!history) {
    return [];
  }

  let { dailySnapshots } = history;

  if (from) {
    dailySnapshots = dailySnapshots.filter(s => s.date >= from);
  }
  if (to) {
    dailySnapshots = dailySnapshots.filter(s => s.date <= to);
  }

  return dailySnapshots;
}

/**
 * Get the full performance history object, or null if none exists.
 */
export function getPerformanceHistory(): PerformanceHistory | null {
  return readJsonFile<PerformanceHistory>(PERFORMANCE_FILE);
}
