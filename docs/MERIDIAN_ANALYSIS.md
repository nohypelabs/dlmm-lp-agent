# Meridian Learning System Analysis

## Executive Summary

Meridian uses an **LLM-powered ReAct agent** for decision-making, while dlmm-lp-agent uses a **deterministic weighted scoring system**. Both approaches have trade-offs.

---

## Comparison Table

| Aspect | Meridian | dlmm-lp-agent |
|--------|----------|---------------|
| **Decision Engine** | LLM ReAct agent (OpenRouter/OpenAI) | Deterministic weighted scoring (0-100) |
| **Learning** | LLM studies top LPers, derives natural language lessons | Structured threshold evolution (numeric) |
| **Memory** | Structured decision log + lessons.json | lessons.json + pool-memory.json + blacklist |
| **Threshold Evolution** | LLM analyzes performance, adjusts config | Rule-based: nudge thresholds based on win/loss patterns |
| **Data Sources** | OKX OnchainOS, Pool screening API, Jupiter | DexScreener, Meteora API, Jupiter, Birdeye |
| **Shared Learning** | HiveMind (sync lessons/presets across agents) | None (local-only) |
| **Cost** | LLM API costs per cycle | No LLM costs (local computation) |
| **Speed** | Slower (LLM inference + API calls) | Faster (deterministic, no LLM) |
| **Predictability** | Less predictable (LLM can vary) | Highly predictable |
| **Explainability** | Natural language reasoning from LLM | Numeric scores + lesson text |

---

## Meridian's Learning System

### 1. Structured Decision Log

Meridian keeps a detailed decision log in `decision-log.json`:

```json
{
  "actor": "screener" | "manager",
  "pool_or_position": "address",
  "action": "deploy" | "close" | "skip" | "no-deploy",
  "summary": "brief summary",
  "reason": "detailed reasoning",
  "risks": ["risk1", "risk2"],
  "metrics": { "score": 85, "volume": 50000, "liquidity": 10000 },
  "rejected_alternatives": ["pool1", "pool2"],
  "timestamp": 1715234567890
}
```

**Why this matters:**
- Full audit trail of every decision
- Recent decisions injected back into system prompt
- LLM can answer "why did you deploy?" without guessing

### 2. Lessons Derived from Top LPers

Meridian uses LPAgent API to study top LPers:

```javascript
studyTopLPers(poolAddress, limit) {
  // Fetches on-chain behavior of top performers:
  // - Hold duration
  // - Entry/exit timing
  // - Win rates
  // - Bin preferences
  // LLM derives patterns and saves as natural language lessons
}
```

**Example lessons:**
- "Top LPers in this pool prefer bid_ask strategy with 15 bins below"
- "Best entries happen within 2h of volume spikes"
- "Avoid this pool on weekends (wash trading detected)"

### 3. Threshold Evolution

Meridian uses LLM to analyze closed positions and adjust thresholds:

```javascript
evolveThresholds() {
  // After 5+ closed positions:
  // LLM analyzes win rate, avg PnL, fee yields
  // Proposes threshold changes with reasoning
  // Updates user-config.json automatically
}
```

### 4. HiveMind (Shared Learning)

Agents can sync lessons and presets via `api.agentmeridian.xyz`:

**Shared:**
- Lessons from all agents
- Strategy presets
- Crowd performance context

**Not shared:**
- Private keys
- Wallet balances
- Specific position data

---

## dlmm-lp-agent's Learning System

### 1. Lessons JSON

Stores natural language lessons (similar to Meridian):

```json
{
  "lessons": [
    {
      "id": "lesson_...",
      "type": "avoid" | "prefer" | "observation",
      "text": "TOKEN: hit +8.5% TP in 12h. Good volume.",
      "pinned": false,
      "pnlPercent": 8.5,
      "exitReason": "take_profit"
    }
  ]
}
```

### 2. Threshold Evolution

**Rule-based (no LLM):**

```typescript
// Evolves every 5 trades
if (winRate < 0.4) {
  // Raise volume floor - picking too-thin markets
  MIN_DAILY_VOLUME += 10%;
}
if (winRate > 0.7 && MIN_DAILY_VOLUME > 20000) {
  // Loosen volume floor - can afford more risk
  MIN_DAILY_VOLUME -= 5%;
}
if (ilLosses / totalLosses > 0.3) {
  // Too many IL exits - tighten IL threshold
  MAX_IL_PERCENT -= 1;
}
```

**Advantages:**
- Predictable
- No LLM costs
- Fast

**Limitations:**
- Limited to predefined rules
- Can't discover new patterns
- Natural language lessons don't affect logic

### 3. Pool Memory

Per-pool tracking:

```json
{
  "poolAddress": {
    "winRate": 0.75,
    "avgPnlPercent": 5.2,
    "totalEntries": 4,
    "cooldownUntil": 1715234567890,
    "score": 72
  }
}
```

---

## Key Differences

### Decision Making

**Meridian (LLM-based):**
- LLM reasons over live data + memory
- Can handle edge cases not in code
- Can explain reasoning in natural language
- Cost: ~$0.01-0.05 per cycle

**dlmm-lp-agent (deterministic):**
- Weighted scoring (Tier 1-4)
- Always same result for same inputs
- Cost: $0 per cycle
- Limited to coded logic

### Learning Capability

**Meridian:**
- LLM can discover new patterns from data
- Can adapt to market regime changes
- Can generate novel strategies

**dlmm-lp-agent:**
- Only learns via pre-coded threshold nudges
- Can't discover new patterns
- Rigid to market changes unless rules added

### Shared Learning

**Meridian:**
- HiveMind syncs learning across all agents
- Crowd intelligence effect

**dlmm-lp-agent:**
- No sharing - each agent learns independently
- Slower to discover best practices

---

## Recommendations for dlmm-lp-agent

### Short Term (Easy Wins)

1. **Add Structured Decision Log**
   - Log every deploy/close/skip with reasoning
   - Enable "why did you X?" queries

2. **Enhance Threshold Evolution**
   - Add more rules: MCAP drift, volume spikes, seasonal patterns
   - Make lessons actionable (not just observations)

3. **Pool-Level Cooldowns**
   - Already partially implemented via pool-memory.json
   - Tighten: stop_loss = 4h, il_limit = 2h cooldowns

### Medium Term

4. **Implement Simple HiveMind**
   - Optional sync server for lessons.json
   - Opt-in crowd learning

5. **Add Decision Replay Mode**
   - Replay past decisions with new thresholds
   - A/B test threshold changes

6. **Pattern Detection**
   - Detect wash trading, volume spikes, pump-n-dump
   - Add to safety checker

### Long Term (Hybrid Approach)

7. **Optional LLM Mode**
   - Add flag: `USE_LLM_FOR_DECISIONS=false`
   - When enabled: LLM reviews top candidates + makes final decision
   - Fallback to deterministic if LLM unavailable

8. **Top LPer Analysis**
   - Integrate LPAgent API (same as Meridian)
   - Study on-chain behavior of winners

9. **Natural Language Lessons → Actionable Rules**
   - Parse lessons for patterns
   - Auto-generate new threshold rules

---

## Conclusion

**Meridian excels at:**
- Flexible, adaptive reasoning
- Natural language explanations
- Shared learning via HiveMind
- Discovering novel patterns

**dlmm-lp-agent excels at:**
- Zero operating costs (no LLM)
- Predictable, fast execution
- Easier debugging
- Lower complexity

**Best approach:** Hybrid
- Use deterministic scoring as baseline
- Optional LLM layer for final decision / reasoning
- Shared learning for crowd intelligence
- Always log structured decisions for replay
