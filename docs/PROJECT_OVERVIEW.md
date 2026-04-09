# DLMM LP Agent - Project Overview

**Created**: March 31, 2026
**Version**: 0.1.0 (Development)
**Status**: Phase B Complete + Robustness Hardening Done

---

## 🎯 Project Goal

Build an automated Liquidity Provider agent for Meteora DLMM that targets new token launches on Solana with aggressive quick-flip strategy.

---

## 📊 Strategy Specifications

### Capital & Risk Management
- **Starting Capital**: $50 USD
- **Target Daily Gain**: 20%
- **Max Loss per Position**: 10%
- **Max Impermanent Loss**: 10% (auto-exit)
- **Position Count**: 3 simultaneous positions
- **Capital Allocation**: $15 per position, $5 reserve

### Token Criteria
- **Age**: 3-7 days from creation (new launches)
- **Volume**: $50k - $500k daily (sweet spot)
- **Liquidity**: Minimum $10k
- **Safety**: Must pass Tier 1-4 screening filters

### Execution Strategy
- **Entry**: Auto-detect or manual CA input
- **Bin Range**: ±5-8% from current price (tight)
- **Rebalancing**: 6-12x daily (semi-aggressive)
- **Exit**: +20% profit OR -10% loss/IL

---

## 🏗️ Implementation Plan

### **Option A: Quick PoC (2-3 hours)** - CURRENT
**Goal**: Validate approach with minimal viable product

**Deliverables**:
- ✅ Basic project structure
- ⏳ Token scanner (Tier 1 filters only)
- ⏳ Solana connection + DLMM pool reading
- ⏳ Test with SOL-TROLL, SOL-POPCAT
- ⏳ Documentation of results

**Success Criteria**:
- Can connect to Solana RPC
- Can read DLMM pool data
- Can evaluate token safety (basic)
- Can identify bin ranges

---

### **Option C: Token Scanner (3-4 days)** - NEXT
**Goal**: Build comprehensive token discovery system

**Deliverables**:
- Complete Tier 1-4 safety filters
- Auto-detection of new launches
- Volume & liquidity analysis
- Trending score algorithm
- Top 10 candidate ranking system

**Success Criteria**:
- Detects tokens aged 3-7 days
- Filters out rugpulls/scams
- Scores tokens 0-100
- Returns top candidates daily

---

### **Option B: Full Foundation (1 week)** - AFTER C
**Goal**: Solid foundation for strategy implementation

**Deliverables**:
- Complete Phase 1 components
- Paper trading framework
- Database setup (positions, performance)
- Logging & monitoring system
- Error handling & retry logic

**Success Criteria**:
- Can simulate trades without real funds
- All transactions logged
- Performance metrics tracked
- System runs 24/7 stable

---

## 🔐 Safety Filters Overview

### Tier 1: Critical Safety (Instant Reject)
- Age < 3 days or > 30 days
- Freeze authority enabled
- Mint authority enabled
- Top holder > 20% supply
- Liquidity < $10k
- No verified contract

### Tier 2: Volume & Activity
- 24h volume: $50k - $500k
- Unique traders: > 100 wallets
- Buy/Sell ratio: 0.7 - 1.3
- Liquidity/Volume ratio: > 5%

### Tier 3: Price Action (Range-Bound)
- 7-day volatility: 30-60%
- Current phase: Consolidation
- Bin distribution: ±15% range

### Tier 4: Smart Money Signals
- Listed on Jupiter
- Listed on Birdeye/DEXScreener
- Active community (>500 members)
- Fresh DLMM listings (<7 days)

---

## 📈 Performance Expectations

### Daily Target: 20%

**Breakdown**:
- Fees earned: 5-10%
- Price appreciation: 10-15%
- Rebalancing alpha: 5%

**Realistic Outcomes**:
- ✅ Good days: 25-40% (all 3 positions profit)
- ⚖️ Average days: 10-15% (mixed results)
- ❌ Bad days: -5% to -10% (stopped out)

**Win Rate Needed**:
- 70% win rate (7/10 positions profit)
- Average winner: +30%
- Average loser: -10%
- Net: 18-20% daily

---

## 🛠️ Tech Stack

### Core Dependencies
- `@solana/web3.js` - Blockchain interaction
- `@meteora-ag/dlmm` - DLMM SDK
- `@project-serum/anchor` - Smart contracts
- `axios` - HTTP requests
- `node-telegram-bot-api` - Notifications

### Development
- TypeScript 5.3+
- Node.js 20+
- pnpm (package manager)

### Infrastructure
- Helius RPC (Solana endpoint)
- PostgreSQL (future - for now in-memory)
- Telegram Bot API

---

## 📊 Operation Modes

### Mode 1: Full Auto
- Agent selects all 3 positions automatically
- Zero user intervention required
- Sends notifications only
- Best for: Hands-off operation

### Mode 2: Manual Approve
- Agent scans and ranks top 10 candidates
- User approves top 3 to enter
- Agent handles execution & exits
- Best for: Learning & control

---

## 🚨 Risk Management

### Position-Level Stops
- Max loss: 10% → immediate exit
- Max IL: 10% → immediate exit
- Volume drop >70% → exit
- Large holder dump detected → exit

### Portfolio-Level Stops
- Daily drawdown >15% → pause new entries
- SOL dumps >10% in 1h → exit all positions
- RPC connection lost → emergency mode

### Emergency Procedures
- Manual override via Telegram
- Instant position liquidation
- Withdraw all funds to wallet
- Detailed alert logs

---

## 📝 Development Log

### March 31, 2026 - Initial Setup
- ✅ Project structure created
- ✅ Package.json configured
- ✅ TypeScript setup
- ✅ Documentation framework

### April 1–5, 2026 - Phase A & B Implementation
- ✅ 4-tier token scanner (`src/scanner/`)
  - Tier 1: mint/freeze authority, supply check
  - Tier 2: volume, liquidity, buy/sell ratio
  - Tier 3: price action & volatility
  - Tier 4: smart money signals (Jupiter, Birdeye listing)
- ✅ DLMM pool integration (`src/core/dlmm.pool.ts`)
- ✅ Position manager: open, update, close (paper + live)
- ✅ Rebalancer: auto-rebalance out-of-range positions
- ✅ Pool discovery via DexScreener + on-chain validation
- ✅ Database persistence (SQLite via `position.db.ts`)
- ✅ Telegram alerts + interactive bot flow
- ✅ Systemd service for 24/7 operation

### April 6–8, 2026 - Telegram Interactive Flow + Memory System
- ✅ Full interactive Telegram commands:
  - `/dlmm` — scan candidates → strategy selection → token entry
  - `/positions` — live position status
  - `/claim` — claim swap fees
  - `/compound` — compound fees back into position
  - `/lessons` — view performance lessons
  - `/strategies` — list/select strategy presets
  - `/blacklist` — manage token/deployer blacklist
- ✅ Memory system (`src/memory/`):
  - `pool.memory.ts` — per-pool score, cooldown tracking, close history
  - `lessons.ts` — performance lesson recorder + summary
  - `blacklist.ts` — token & deployer blacklist (persist to `data/`)
  - `strategy.library.ts` — reusable LP strategy presets
- ✅ Background volume scanner with auto-alert
- ✅ All-in capital strategy (full capital per position)
- ✅ Integration test suite + paper trading simulator
- ✅ Fee claim & compound (paper + live on-chain)

### April 9, 2026 - Robustness Hardening (commit `a197bfc`)
- ✅ **Fix 1: `getLbPairs()` bottleneck eliminated**
  - `pool.discovery.ts` & `dlmm.pool.ts`: DexScreener HTTP fast path first
  - On-chain fallback with 12s `Promise.race()` hard timeout
  - Module-level 5-min cache → no double-fetching within same process
- ✅ **Fix 2: `.gitignore` runtime data files**
  - `data/lessons.json`, `data/pool-memory.json`, `data/positions.json` excluded
  - `data/deployer-blacklist.json` retained as seed file
- ✅ **Fix 3: SafetyChecker Tier 2 holder checks**
  - `runTier2Checks()`: `getTokenLargestAccounts` on-chain
  - Critical: single holder > 20% → `passed = false`
  - Warning: top-10 > 50% supply → warning, non-blocking
  - Network failure → non-fatal warning, agent continues
- ✅ **Fix 4: `validateConfig()` hardened**
  - Validate all numeric thresholds at startup
  - Hard errors (agent stops) vs warnings (agent continues)
  - Startup config summary printed on every launch

---

## 🗂️ Current File Structure

```
src/
  config/constants.ts       — all env config + validateConfig()
  core/
    connection.ts           — RPC connection manager
    dlmm.pool.ts            — pool reader + analyzePool()
  scanner/
    token.scanner.ts        — 4-tier scanning orchestrator
    safety.checker.ts       — Tier 1+2 on-chain safety (Tier 2 added)
    pool.discovery.ts       — DexScreener + on-chain pool discovery
    volume.scanner.ts       — background high-volume alert scanner
    volume.analyzer.ts      — 24h volume metrics
    metadata.fetcher.ts     — token metadata fetcher
    price.analyzer.ts       — Tier 3 price action
    smart.signals.ts        — Tier 4 smart money signals
  strategy/
    agent.ts                — main orchestrator + main loop
    position.manager.ts     — position lifecycle (open/update/close/claim/compound)
    rebalancer.ts           — out-of-range rebalance logic
  memory/
    pool.memory.ts          — per-pool score + cooldown
    lessons.ts              — trade lessons + win rate tracking
    blacklist.ts            — token/deployer blacklist
    strategy.library.ts     — LP strategy presets
  database/position.db.ts   — SQLite persistence
  notifications/
    telegram.alert.ts       — bot alerts + interactive command handlers
  utils/logger.ts           — winston logger
  index.ts                  — entry point
tests/
  integration.ts            — full cycle integration test
  paper.trading.ts          — paper trading simulation
  test.scanner.ts / tier2 / tier34
data/
  deployer-blacklist.json   — seed blacklist (tracked in git)
  lessons.json              — runtime (gitignored)
  pool-memory.json          — runtime (gitignored)
  positions.json            — runtime (gitignored)
```

---

## 🎯 Next Steps

1. Run paper trading test end-to-end dengan real RPC
2. Konfigurasi `.env` production (Helius key + Telegram bot)
3. Monitor 24h paper trading run, review lessons output
4. Evaluasi apakah siap switch ke live trading
5. (Optional) Tambah Tier 3+4 checks ke SafetyChecker standalone

---

## 📞 Contact & Support

For questions or issues, refer to:
- `/docs/PHASE-1-POC.md` — initial PoC results
- `/docs/PHASE-2-TIER2.md` — Tier 2 scanner docs
- `/docs/PHASE-3-TIER34.md` — Tier 3 & 4 docs
- `/docs/POC-RESULTS.md` — benchmark results

---

**Last Updated**: April 9, 2026
**Next Review**: After paper trading validation run
