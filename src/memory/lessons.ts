/**
 * Lessons System
 *
 * After every position closes, the agent derives a lesson from the outcome.
 * Lessons feed back into screening thresholds and decision making so the bot
 * improves over time without needing an LLM.
 *
 * Three components:
 *   1. Lesson log       — human-readable observations (data/lessons.json)
 *   2. Threshold tuner  — nudges TOKEN_FILTERS based on win/loss patterns
 *   3. Prompt injector  — formats top lessons for Telegram status messages
 *
 * Persists to data/lessons.json — survives restarts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

const LESSONS_FILE = path.join(process.cwd(), 'data', 'lessons.json');
const MIN_POSITIONS_TO_EVOLVE = 5;  // don't tune thresholds until we have real data
const MAX_THRESHOLD_SHIFT     = 0.15; // never move a threshold more than 15% in one step
const MAX_LESSONS             = 50;  // trim oldest unpinned lessons beyond this

export type LessonType = 'avoid' | 'prefer' | 'observation';

export interface Lesson {
  id: string;
  createdAt: number;
  source: 'auto' | 'manual';
  type: LessonType;
  text: string;
  pinned: boolean;
  // context that generated this lesson
  poolAddress?: string;
  tokenSymbol?: string;
  pnlPercent?: number;
  exitReason?: string;
}

export interface ThresholdState {
  MIN_DAILY_VOLUME: number;
  MIN_LIQUIDITY: number;
  MAX_IL_PERCENT: number;
  PROFIT_TARGET_PERCENT: number;
  MAX_LOSS_PERCENT: number;
  MIN_MCAP_USD: number;
  MAX_MCAP_USD: number;
  MIN_FEE_ACTIVE_TVL_RATIO: number;
}

interface LessonsStore {
  version: 1;
  updatedAt: number;
  lessons: Lesson[];
  thresholds: ThresholdState;
  performance: PerformanceSummary;
}

interface PerformanceSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPercent: number;
  totalFeesEarned: number;
  bestTrade: { symbol: string; pnlPercent: number } | null;
  worstTrade: { symbol: string; pnlPercent: number } | null;
}

// ─── I/O ───────────────────────────────────────────────────────

function defaultThresholds(): ThresholdState {
  return {
    MIN_DAILY_VOLUME:      50_000,
    MIN_LIQUIDITY:         10_000,
    MAX_IL_PERCENT:        10,
    PROFIT_TARGET_PERCENT: 10,
    MAX_LOSS_PERCENT:      10,
    MIN_MCAP_USD:          150_000,
    MAX_MCAP_USD:          10_000_000,
    MIN_FEE_ACTIVE_TVL_RATIO: 0.05,
  };
}

function load(): LessonsStore {
  try {
    if (fs.existsSync(LESSONS_FILE)) {
      return JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8'));
    }
  } catch {
    logger.warn('lessons: failed to load, starting fresh');
  }
  return {
    version: 1,
    updatedAt: Date.now(),
    lessons: [],
    thresholds: defaultThresholds(),
    performance: {
      totalTrades: 0, wins: 0, losses: 0,
      winRate: 0, avgPnlPercent: 0, totalFeesEarned: 0,
      bestTrade: null, worstTrade: null,
    },
  };
}

function save(store: LessonsStore): void {
  try {
    fs.mkdirSync(path.dirname(LESSONS_FILE), { recursive: true });
    store.updatedAt = Date.now();
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    logger.error(`lessons: save failed: ${err}`);
  }
}

// ─── Threshold evolution ───────────────────────────────────────
// Nudge thresholds based on patterns across recent trades.
// Uses a lightweight rule set — no LLM needed.

function evolveThresholds(store: LessonsStore, recent: PerformanceSummary): void {
  if (store.performance.totalTrades < MIN_POSITIONS_TO_EVOLVE) return;

  const t = store.thresholds;
  const shift = (current: number, factor: number): number => {
    const delta = current * Math.min(Math.abs(factor), MAX_THRESHOLD_SHIFT) * Math.sign(factor);
    return Math.round(current + delta);
  };

  // If win rate is poor (<40%), raise volume floor — we're picking too-thin markets
  if (recent.winRate < 0.4) {
    t.MIN_DAILY_VOLUME = shift(t.MIN_DAILY_VOLUME, 0.1);
    logger.info(`lessons: win rate ${(recent.winRate * 100).toFixed(0)}% → raised MIN_DAILY_VOLUME to $${t.MIN_DAILY_VOLUME.toLocaleString()}`);
  }

  // If win rate is high (>70%), we can afford to loosen volume floor slightly
  if (recent.winRate > 0.7 && t.MIN_DAILY_VOLUME > 20_000) {
    t.MIN_DAILY_VOLUME = shift(t.MIN_DAILY_VOLUME, -0.05);
    logger.info(`lessons: win rate ${(recent.winRate * 100).toFixed(0)}% → eased MIN_DAILY_VOLUME to $${t.MIN_DAILY_VOLUME.toLocaleString()}`);
  }

  // If IL exits are frequent (>30% of losses), tighten IL threshold
  if (store.lessons.filter(l => l.exitReason === 'il_limit').length / Math.max(store.performance.totalTrades, 1) > 0.3) {
    t.MAX_IL_PERCENT = Math.max(5, t.MAX_IL_PERCENT - 1);
    logger.info(`lessons: too many IL exits → tightened MAX_IL_PERCENT to ${t.MAX_IL_PERCENT}%`);
  }
}

// ─── Lesson derivation ─────────────────────────────────────────

function deriveLesson(params: {
  tokenSymbol: string;
  poolAddress: string;
  pnlPercent: number;
  feesEarned: number;
  durationMs: number;
  exitReason: string;
  volumeAtEntry?: number;
  liquidityAtEntry?: number;
}): Lesson | null {
  const { tokenSymbol, poolAddress, pnlPercent, feesEarned, durationMs, exitReason } = params;
  const durationH = (durationMs / 3_600_000).toFixed(1);
  let type: LessonType;
  let text: string;

  if (exitReason === 'take_profit' && pnlPercent >= 8) {
    type = 'prefer';
    text = `${tokenSymbol}: hit +${pnlPercent.toFixed(1)}% TP in ${durationH}h. Fees earned: $${feesEarned.toFixed(2)}. Pool showed good volume — worth revisiting.`;
  } else if (exitReason === 'stop_loss') {
    type = 'avoid';
    text = `${tokenSymbol}: stopped out at ${pnlPercent.toFixed(1)}% after ${durationH}h. Avoid re-entering this pool for at least 4h.`;
  } else if (exitReason === 'il_limit') {
    type = 'avoid';
    text = `${tokenSymbol}: IL limit breached in ${durationH}h. High price volatility — consider tighter bin range next time.`;
  } else if (pnlPercent < -5 && exitReason !== 'stop_loss') {
    type = 'observation';
    text = `${tokenSymbol}: lost ${pnlPercent.toFixed(1)}% over ${durationH}h (${exitReason}). Monitor if pattern repeats.`;
  } else if (feesEarned > 2 && pnlPercent >= 0) {
    type = 'prefer';
    text = `${tokenSymbol}: earned $${feesEarned.toFixed(2)} fees in ${durationH}h with ${pnlPercent.toFixed(1)}% PnL. High fee pool — good candidate.`;
  } else {
    return null; // not interesting enough to log
  }

  return {
    id: `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    source: 'auto',
    type,
    text,
    pinned: false,
    poolAddress,
    tokenSymbol,
    pnlPercent,
    exitReason,
  };
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Call after every position closes. Records performance, derives lesson,
 * and evolves thresholds if enough data exists.
 */
export function recordPositionClose(params: {
  tokenSymbol: string;
  poolAddress: string;
  pnlPercent: number;
  feesEarned: number;
  durationMs: number;
  exitReason: string;
  volumeAtEntry?: number;
  liquidityAtEntry?: number;
}): void {
  const store = load();
  const perf = store.performance;

  // Update running performance stats
  perf.totalTrades++;
  if (params.pnlPercent > 0) perf.wins++; else perf.losses++;
  perf.winRate = perf.wins / perf.totalTrades;
  perf.avgPnlPercent = (perf.avgPnlPercent * (perf.totalTrades - 1) + params.pnlPercent) / perf.totalTrades;
  perf.totalFeesEarned += params.feesEarned;

  if (!perf.bestTrade || params.pnlPercent > perf.bestTrade.pnlPercent) {
    perf.bestTrade = { symbol: params.tokenSymbol, pnlPercent: params.pnlPercent };
  }
  if (!perf.worstTrade || params.pnlPercent < perf.worstTrade.pnlPercent) {
    perf.worstTrade = { symbol: params.tokenSymbol, pnlPercent: params.pnlPercent };
  }

  // Derive and store lesson
  const lesson = deriveLesson(params);
  if (lesson) {
    store.lessons.push(lesson);
    logger.info(`lessons: derived [${lesson.type}] — ${lesson.text}`);

    // Trim oldest unpinned lessons if over cap
    const unpinned = store.lessons.filter(l => !l.pinned);
    if (unpinned.length > MAX_LESSONS) {
      const oldest = unpinned.sort((a, b) => a.createdAt - b.createdAt)[0];
      store.lessons = store.lessons.filter(l => l.id !== oldest.id);
    }
  }

  // Evolve thresholds every 5 trades
  if (perf.totalTrades % 5 === 0) {
    evolveThresholds(store, perf);
  }

  save(store);
}

/**
 * Add a manual lesson via Telegram.
 */
export function addManualLesson(text: string, type: LessonType = 'observation'): Lesson {
  const store = load();
  const lesson: Lesson = {
    id: `lesson_${Date.now()}_manual`,
    createdAt: Date.now(),
    source: 'manual',
    type,
    text: text.slice(0, 400),
    pinned: false,
  };
  store.lessons.push(lesson);
  save(store);
  return lesson;
}

/**
 * Pin/unpin a lesson so it's never trimmed.
 */
export function pinLesson(lessonId: string, pin: boolean): boolean {
  const store = load();
  const lesson = store.lessons.find(l => l.id === lessonId);
  if (!lesson) return false;
  lesson.pinned = pin;
  save(store);
  return true;
}

/**
 * Get current evolved thresholds (use these instead of raw TOKEN_FILTERS).
 */
export function getThresholds(): ThresholdState {
  return load().thresholds;
}

/**
 * Get effective token filters by merging static TOKEN_FILTERS with evolved thresholds.
 * Use this in scanner code instead of importing TOKEN_FILTERS directly.
 */
export function getEffectiveFilters(): {
  MIN_DAILY_VOLUME: number;
  MIN_LIQUIDITY: number;
  MAX_IL_PERCENT: number;
  PROFIT_TARGET_PERCENT: number;
  MAX_LOSS_PERCENT: number;
  MIN_MCAP_USD: number;
  MAX_MCAP_USD: number;
  MIN_FEE_ACTIVE_TVL_RATIO: number;
} {
  const evolved = getThresholds();
  return {
    MIN_DAILY_VOLUME: evolved.MIN_DAILY_VOLUME,
    MIN_LIQUIDITY: evolved.MIN_LIQUIDITY,
    MAX_IL_PERCENT: evolved.MAX_IL_PERCENT,
    PROFIT_TARGET_PERCENT: evolved.PROFIT_TARGET_PERCENT,
    MAX_LOSS_PERCENT: evolved.MAX_LOSS_PERCENT,
    MIN_MCAP_USD: evolved.MIN_MCAP_USD,
    MAX_MCAP_USD: evolved.MAX_MCAP_USD,
    MIN_FEE_ACTIVE_TVL_RATIO: evolved.MIN_FEE_ACTIVE_TVL_RATIO,
  };
}

/**
 * Get top N lessons for display (pinned first, then most recent).
 */
export function getTopLessons(n = 5): Lesson[] {
  const store = load();
  const pinned = store.lessons.filter(l => l.pinned);
  const recent = store.lessons
    .filter(l => !l.pinned)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, n - pinned.length);
  return [...pinned, ...recent].slice(0, n);
}

/**
 * Get performance summary for status messages.
 */
export function getPerformanceSummary(): PerformanceSummary {
  return load().performance;
}

/**
 * Format top lessons as a Telegram-ready string.
 */
export function formatLessonsForTelegram(): string {
  const lessons = getTopLessons(5);
  if (lessons.length === 0) return 'No lessons yet — start trading to build memory.';

  const emoji: Record<LessonType, string> = {
    prefer: '✅',
    avoid: '🚫',
    observation: '📝',
  };

  return lessons
    .map((l, i) => `${i + 1}. ${emoji[l.type]} ${l.text}`)
    .join('\n\n');
}
