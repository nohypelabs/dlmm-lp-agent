/**
 * Configuration Constants for DLMM LP Agent
 */

import dotenv from 'dotenv';
dotenv.config();

// Solana Network Configuration
export const SOLANA_CONFIG = {
  RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
  NETWORK: process.env.SOLANA_NETWORK || 'mainnet-beta',
  COMMITMENT: 'confirmed' as const,
};

// Get RPC URL with Helius key if available
export const getRpcUrl = (): string => {
  if (SOLANA_CONFIG.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${SOLANA_CONFIG.HELIUS_API_KEY}`;
  }
  return SOLANA_CONFIG.RPC_URL;
};

// Wallet Configuration
export const WALLET_CONFIG = {
  PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || '',
};

// Strategy Parameters
export const STRATEGY_CONFIG = {
  STARTING_CAPITAL: parseFloat(process.env.STARTING_CAPITAL || '150'),
  MAX_POSITIONS: parseInt(process.env.MAX_POSITIONS || '1'),
  TARGET_DAILY_GAIN: parseFloat(process.env.TARGET_DAILY_GAIN || '20'),
  MAX_LOSS_PERCENT: parseFloat(process.env.MAX_LOSS_PERCENT || '10'),
  MAX_IL_PERCENT: parseFloat(process.env.MAX_IL_PERCENT || '10'),
  REBALANCE_FREQUENCY: parseInt(process.env.REBALANCE_FREQUENCY || '6'),
  MAX_REENTRY_PER_TOKEN: parseInt(process.env.MAX_REENTRY_PER_TOKEN || '3'),
  PROFIT_TARGET_PERCENT: parseFloat(process.env.PROFIT_TARGET_PERCENT || '10'),
};

// Calculate position sizing
export const POSITION_CONFIG = {
  POSITION_SIZE: STRATEGY_CONFIG.STARTING_CAPITAL / STRATEGY_CONFIG.MAX_POSITIONS,
  RESERVE_AMOUNT: STRATEGY_CONFIG.STARTING_CAPITAL * 0.05, // 5% reserve (smaller for all-in)
  ACTIVE_CAPITAL: STRATEGY_CONFIG.STARTING_CAPITAL * 0.95, // 95% active
};

// Token Filter Configuration
export const TOKEN_FILTERS = {
  MIN_TOKEN_AGE_DAYS: parseInt(process.env.MIN_TOKEN_AGE_DAYS || '1'),
  MAX_TOKEN_AGE_DAYS: parseInt(process.env.MAX_TOKEN_AGE_DAYS || '30'),
  MIN_DAILY_VOLUME: parseFloat(process.env.MIN_DAILY_VOLUME || '50000'),
  MAX_DAILY_VOLUME: parseFloat(process.env.MAX_DAILY_VOLUME || '50000000'),
  MIN_LIQUIDITY: parseFloat(process.env.MIN_LIQUIDITY || '10000'),
  MAX_TOP_HOLDER_PERCENT: 20, // 20% max for single holder
  MIN_UNIQUE_TRADERS: 100,
  MIN_BUY_SELL_RATIO: 0.7,
  MAX_BUY_SELL_RATIO: 1.3,
};

// DLMM Configuration
export const DLMM_CONFIG = {
  METEORA_PROGRAM_ID: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM Program
  BIN_STEP_OPTIONS: [0.25, 0.5, 1, 2], // Bin step percentages
  DEFAULT_BIN_RANGE_PERCENT: 8, // ±8% default range
  MIN_BIN_RANGE_PERCENT: 5,
  MAX_BIN_RANGE_PERCENT: 15,
};

// Operation Mode
export const OPERATION_MODE = {
  MODE: process.env.MODE || 'manual_approve', // 'full_auto' or 'manual_approve'
  PAPER_TRADING: process.env.PAPER_TRADING === 'true',
  DRY_RUN: process.env.DRY_RUN === 'true',
};

// Telegram Configuration
export const TELEGRAM_CONFIG = {
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  ENABLED: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
};

// Safety Thresholds
export const SAFETY_THRESHOLDS = {
  TIER_1: {
    MIN_SCORE: 0,
    CRITICAL_CHECKS: [
      'no_freeze_authority',
      'no_mint_authority',
      'max_holder_check',
      'min_liquidity',
      'contract_verified',
    ],
  },
  TIER_2: {
    MIN_SCORE: 40,
  },
  TIER_3: {
    MIN_SCORE: 60,
  },
  TIER_4: {
    MIN_SCORE: 75,
  },
};

// Logging Configuration
export const LOG_CONFIG = {
  LEVEL: process.env.LOG_LEVEL || 'info', // 'debug', 'info', 'warn', 'error'
  LOG_TO_FILE: true,
  LOG_DIR: 'logs',
};

// Performance Metrics
export const METRICS_CONFIG = {
  TRACK_PERFORMANCE: true,
  SAVE_INTERVAL_MINUTES: 60,
  METRICS_FILE: 'performance.json',
};

// Emergency Stop Conditions
export const EMERGENCY_STOPS = {
  SOL_DUMP_PERCENT: 10, // Exit all if SOL dumps >10% in 1 hour
  MAX_DAILY_DRAWDOWN: 15, // Pause if daily loss >15%
  RPC_FAILURE_COUNT: 3, // Emergency mode after N failed RPC calls
};

// Time Constants
export const TIME_CONSTANTS = {
  MILLISECONDS_PER_DAY: 24 * 60 * 60 * 1000,
  MILLISECONDS_PER_HOUR: 60 * 60 * 1000,
  REBALANCE_INTERVAL_MS: (24 * 60 * 60 * 1000) / STRATEGY_CONFIG.REBALANCE_FREQUENCY,
};

// Validation
export const validateConfig = (): boolean => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Hard errors (agent will not start) ─────────────────────────
  if (!WALLET_CONFIG.PRIVATE_KEY && !OPERATION_MODE.PAPER_TRADING) {
    errors.push('WALLET_PRIVATE_KEY is required for live trading (or set PAPER_TRADING=true)');
  }
  if (STRATEGY_CONFIG.STARTING_CAPITAL <= 0) {
    errors.push('STARTING_CAPITAL must be > 0');
  }
  if (STRATEGY_CONFIG.MAX_POSITIONS <= 0) {
    errors.push('MAX_POSITIONS must be > 0');
  }
  if (STRATEGY_CONFIG.MAX_LOSS_PERCENT <= 0 || STRATEGY_CONFIG.MAX_LOSS_PERCENT > 100) {
    errors.push('MAX_LOSS_PERCENT must be between 1 and 100');
  }
  if (STRATEGY_CONFIG.PROFIT_TARGET_PERCENT <= 0) {
    errors.push('PROFIT_TARGET_PERCENT must be > 0');
  }
  if (TOKEN_FILTERS.MIN_TOKEN_AGE_DAYS < 0) {
    errors.push('MIN_TOKEN_AGE_DAYS must be >= 0');
  }
  if (TOKEN_FILTERS.MIN_DAILY_VOLUME <= 0) {
    errors.push('MIN_DAILY_VOLUME must be > 0');
  }

  // ── Warnings (agent starts but may work poorly) ─────────────────
  if (!SOLANA_CONFIG.HELIUS_API_KEY) {
    warnings.push(
      'HELIUS_API_KEY not set — using public RPC (rate-limited, expect slowness)',
    );
  }
  if (!TELEGRAM_CONFIG.ENABLED) {
    warnings.push('Telegram not configured — no real-time alerts (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)');
  }
  if (OPERATION_MODE.PAPER_TRADING) {
    warnings.push('PAPER_TRADING=true — simulated mode, no real funds used');
  }
  if (
    !OPERATION_MODE.PAPER_TRADING &&
    STRATEGY_CONFIG.STARTING_CAPITAL > 500
  ) {
    warnings.push(
      `Large capital deployed: $${STRATEGY_CONFIG.STARTING_CAPITAL} — ensure this is intentional`,
    );
  }

  // ── Print summary ───────────────────────────────────────────────
  console.log('\n── Config Validation ──────────────────────────');
  console.log(`  Mode      : ${OPERATION_MODE.PAPER_TRADING ? 'PAPER' : 'LIVE'} (${OPERATION_MODE.MODE})`);
  console.log(`  Capital   : $${STRATEGY_CONFIG.STARTING_CAPITAL} | Positions: ${STRATEGY_CONFIG.MAX_POSITIONS}`);
  console.log(`  Target    : +${STRATEGY_CONFIG.PROFIT_TARGET_PERCENT}% | Stop: -${STRATEGY_CONFIG.MAX_LOSS_PERCENT}% | Max IL: -${STRATEGY_CONFIG.MAX_IL_PERCENT}%`);
  console.log(`  RPC       : ${SOLANA_CONFIG.HELIUS_API_KEY ? 'Helius (fast)' : 'Public (slow)'}`);
  console.log(`  Telegram  : ${TELEGRAM_CONFIG.ENABLED ? 'enabled' : 'disabled'}`);
  console.log('───────────────────────────────────────────────\n');

  if (warnings.length > 0) {
    warnings.forEach(w => console.warn(`  ⚠  ${w}`));
    console.log('');
  }
  if (errors.length > 0) {
    console.error('Configuration errors — agent will not start:');
    errors.forEach(err => console.error(`  ✗  ${err}`));
    console.log('');
    return false;
  }

  return true;
};

// Export all
export default {
  SOLANA_CONFIG,
  WALLET_CONFIG,
  STRATEGY_CONFIG,
  POSITION_CONFIG,
  TOKEN_FILTERS,
  DLMM_CONFIG,
  OPERATION_MODE,
  TELEGRAM_CONFIG,
  SAFETY_THRESHOLDS,
  LOG_CONFIG,
  METRICS_CONFIG,
  EMERGENCY_STOPS,
  TIME_CONSTANTS,
  getRpcUrl,
  validateConfig,
};
