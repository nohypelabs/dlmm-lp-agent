# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Automated LP agent for Meteora DLMM on Solana. Targets new token launches (3-30 days old) with a quick-flip strategy: open concentrated liquidity positions, harvest fees, auto-rebalance 6-12x daily, and exit on profit target or risk breach.

## Commands

```bash
pnpm dev                # Start agent via ts-node (paper mode by default)
pnpm build              # Compile TypeScript to dist/
pnpm start              # Run compiled build from dist/
pnpm test               # Paper trading simulation
pnpm test:integration   # Full cycle integration test
pnpm test:scanner       # Tier 1 safety scanner only
pnpm test:tier2         # Tier 1 + Tier 2 (volume/liquidity)
pnpm test:tier34        # All 4 tiers
pnpm scanner            # Run scanner standalone
```

Tests are plain ts-node scripts (no Jest/Mocha). Run a single test with `ts-node tests/<file>.ts`.

## Architecture

**Entry**: `src/index.ts` → creates `DLMMAgent`, registers SIGINT/SIGTERM, calls `agent.start()`.

**DLMMAgent** (`src/strategy/agent.ts`) is the central orchestrator. It runs a main loop: each cycle checks emergency stops (SOL price dump, daily drawdown, RPC failures), updates open positions, checks profit/risk limits, runs the rebalancer, auto-enters new positions in `full_auto` mode, persists state to disk, and takes daily performance snapshots.

On startup, the agent recovers persisted positions from `data/positions.json` and token entry counts from `data/token-entries.json`. This enables crash recovery — open positions survive agent restarts.

### 4-Tier Scanner System

`TokenScanner` (`src/scanner/token.scanner.ts`) orchestrates weighted scoring (0-100):

| Tier | Weight | Module | Checks |
|------|--------|--------|--------|
| 1 | 40% | `safety.checker.ts` | Freeze/mint authority, supply, decimals, holder distribution |
| 2 | 25% | `volume.analyzer.ts` | 24h volume, liquidity, trader count, buy/sell ratio |
| 3 | 20% | `price.analyzer.ts` | Volatility, range-bound detection, trend direction |
| 4 | 15% | `smart.signals.ts` | Jupiter listing, DexScreener trending, recent listing |

Token is recommended if combined score >= 75 and all tiers pass. Pool discovery now uses all 4 tiers (previously only Tier 1+2).

**Pool discovery** (`src/scanner/pool.discovery.ts`) tries three strategies in order: DexScreener search for Meteora pairs (primary) → Meteora DLMM API (fallback, may be down) → DexScreener boosted tokens. Each candidate is validated on-chain via `DLMM.create()` which filters out non-DLMM pools. Uses `getEffectiveFilters()` from lessons to merge evolved thresholds with static `TOKEN_FILTERS`.

### Strategy Layer

- **PositionManager** (`src/strategy/position.manager.ts`) — opens/closes positions via Meteora SDK. Dual-path: paper (simulated) vs live (on-chain). Uses proper DLMM concentrated liquidity math for IL/PnL (not Uniswap V2 formula). Simulates fee accrual for paper positions. Tracks gas costs. Transaction retry with exponential backoff.
- **Rebalancer** (`src/strategy/rebalancer.ts`) — detects out-of-range positions, IL/loss breaches, scheduled rebalances, and position timeout (default 48h). Caches pool analysis within each evaluation to avoid double RPC calls.
- **Strategy presets** (`src/memory/strategy.library.ts`): `spot_balanced`, `curve_balanced`, `bid_ask`, `single_sided_token`.

### IL/PnL Calculation

Uses DLMM concentrated liquidity math, not Uniswap V2. Key formulas:
- `calculateBinAmounts()` — computes X/Y token composition based on current price vs bin range
- Out of range low → 100% X; out of range high → 100% Y; in range → concentrated formula
- `IL = |hodlValue - positionValue| / hodlValue * 100`
- `PnL = currentValue + feesEarned - totalValueUsd - gasCosts`

### Emergency Stops

Defined in `EMERGENCY_STOPS` (constants.ts) and checked every cycle:
- **SOL dump**: closes all positions if SOL drops >10% in 5 minutes
- **Daily drawdown**: pauses auto-entry if daily loss exceeds 15% of capital
- **RPC failures**: enters degraded mode after 3 consecutive RPC failures

### Memory System

- **PoolMemory** (`src/memory/pool.memory.ts`) — per-pool win rate, avg PnL, cooldowns (stop_loss=4h, il_limit=2h). Score formula: `winRate*40 + avgPnlScore*40 + feeScore*20`.
- **Lessons** (`src/memory/lessons.ts`) — auto-derives lessons from outcomes. Threshold evolution: nudges `MIN_DAILY_VOLUME` and `MAX_IL_PERCENT` after every 5 trades (max 15% shift per step). `getEffectiveFilters()` merges evolved thresholds with static config — scanner and pool discovery use this instead of raw `TOKEN_FILTERS`.
- **Blacklist** (`src/memory/blacklist.ts`) — blocks tokens and deployer wallets. Persisted to `data/deployer-blacklist.json`.

### Persistence

All JSON file-based (no database). Atomic writes via tmp + rename:
- `data/positions.json` — current positions (loaded on startup for crash recovery)
- `data/performance.json` — daily snapshots (auto-generated each day)
- `data/token-entries.json` — re-entry counts per token (survives restarts)
- `data/pool-memory.json`, `data/lessons.json` — runtime memory (gitignored)

### External APIs

DexScreener (token discovery, prices), Meteora DLMM API (pool list), Jupiter (metadata), Birdeye (trader counts), Telegram Bot API (notifications + commands), Solana RPC (on-chain data).

## Configuration

All config in `src/config/constants.ts`, loaded from `.env` via dotenv. Key groups: `SOLANA_CONFIG`, `WALLET_CONFIG`, `STRATEGY_CONFIG`, `POSITION_CONFIG`, `TOKEN_FILTERS`, `DLMM_CONFIG`, `OPERATION_MODE`, `TELEGRAM_CONFIG`, `SAFETY_THRESHOLDS`, `EMERGENCY_STOPS`.

New config values: `POSITION_TIMEOUT_HOURS` (default 48), `SLIPPAGE_BPS` (default 300 = 3%), `PROFIT_TARGET_PERCENT` (default 10).

Default mode is `full_auto`. Default capital is $60.

`validateConfig()` runs at startup — hard errors block startup, warnings log and continue.

## Key Patterns

- **Paper vs live dual-path**: every position operation branches on `PAPER_TRADING` flag. Paper mode activates automatically when no wallet is configured. Paper positions simulate fee accrual at ~0.02%/hour.
- **Module-level caching**: `dlmm.pool.ts` and `pool.discovery.ts` share a `lbPairsCache` with 5-minute TTL to avoid redundant `getLbPairs()` calls.
- **DexScreener fast path**: pool discovery tries DexScreener HTTP first, falls back to slow on-chain `getLbPairs()` with 12-second hard timeout. DexScreener search is primary; Meteora API is fallback.
- **Evolved thresholds**: scanner and pool discovery must call `getEffectiveFilters()` from `lessons.ts` instead of importing `TOKEN_FILTERS` directly — this merges static config with runtime-evolved thresholds.
- **Transaction retry**: `sendWithRetry()` in PositionManager retries failed transactions up to 3 times with exponential backoff (1s, 2s, 4s).
- **Telegram uses raw axios** against the Bot API directly (not the `node-telegram-bot-api` dependency, which is unused).

## Systemd Service

Production runs via `dlmm-agent.service` (user `dracarys`, `Restart=on-failure`, 30s restart delay).
