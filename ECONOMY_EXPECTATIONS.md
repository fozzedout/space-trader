# ECONOMY EXPECTATIONS

This document is the design guide for the trading economy and NPC trading behavior.
It supersedes the previous revision and is written to support an **Elite-like “always a trade to do”** galaxy while still allowing:
- different world identities (clear exports/imports),
- tech-gated goods (to keep progression and plausibility),
- and NPCs that **avoid dead-end trades** via a look-ahead profitability check.

The key change from earlier iterations is that **every inhabited economy is a consumer in some regard**, and the simulation includes a **post-pass guarantee** that ensures there are always *some* profitable routes available from each system (within the same search radius NPCs use).

---

## 1) Design Goals

### 1.1 Primary goals
1. **Profitable trading is always available**
   - From any inhabited system, at least *M* goods (default: **M=3**) must have at least one profitable destination within the NPC look-ahead radius (default: **15 systems**).
2. **Economy identity is preserved**
   - Agricultural feels like agriculture, mining feels like mining, etc.
   - You should see obvious patterns: food/textiles flow out of agricultural; metals flow out of mining; machinery/weapons flow out of industrial; electronics/computers flow out of high-tech; luxuries concentrate around resorts.
3. **NPCs behave rationally**
   - NPCs do not buy into “no sell” situations.
   - NPCs keep fuel reserves and can recover from low credits without soft-locking.
4. **Tech gating remains meaningful**
   - Advanced goods are not universally available early.
   - Low-tech worlds still participate in trade via baseline goods.

### 1.2 Non-goals
- Perfect economic realism.
- A perfectly balanced single “best route” for every player.
- Completely stable prices (some volatility is desirable for texture).

---

## 2) Core Mechanical Assumptions

### 2.1 Taxes and profit threshold
- Purchase tax is **3% on buy only** (no tax on sales).
- NPCs require a minimum **0.01% profit margin after tax** before committing to a trade.

**Effective prices**
- EffectiveBuy = BuyPrice × 1.03
- NetSell = SellPrice (no tax on sales)
- ProfitMargin = (NetSell − EffectiveBuy) / EffectiveBuy

> With only 3% buy tax and no sell tax, trades need only slightly more than 3% raw price spread to be profitable. The 0.01% minimum allows NPCs to exploit many small profitable opportunities, prioritizing trade volume over large margins.

### 2.2 Look-ahead verification
Before buying a good, an NPC checks whether at least one destination within **±20 systems** can sell that good at ProfitMargin ≥ 0.01% after tax.

This is an explicit anti-dead-end mechanism and must remain aligned with the economy model (see Section 8).

### 2.3 Fuel reserve and “can always move”
NPCs reserve credits for fuel so they do not buy themselves immobile. The economy must be designed so that:
- even low-credit NPCs can always make short hops and find *some* sell.

---

## 3) Tech Levels (Updated)

### 3.1 Removing Tech Level 0
For a galactic space game, “pre-agricultural” worlds are not valid inhabited markets.

**Rule:**
- **No inhabited system may have TechLevel 0.**
- The minimum inhabited tech level is **TechLevel.AGRICULTURAL (1)**.

Implementation:
- Remove the enum entry and renumber. This requires migrating saved data and any hard-coded values.

This document assumes **valid inhabited tech levels are 1–7**.

### 3.2 Tech level scale (valid range)
1. AGRICULTURAL
2. MEDIEVAL
3. RENAISSANCE
4. EARLY_INDUSTRIAL
5. INDUSTRIAL
6. POST_INDUSTRIAL
7. HI_TECH

---

## 4) Goods, Gating, and “Always-Tradeable” Baseline

### 4.1 Current goods set
Goods (id → basePrice, weight, volatility, productionTech, consumptionTech):

- food → 10, 1, 0.1, produce 0, consume 0  *(will be treated as 1/1 for inhabited markets; see 4.2)*
- textiles → 20, 1, 0.15, produce 1, consume 1
- metals → 50, 2, 0.2, produce 2, consume 2
- luxuries → 300, 1, 0.4, produce 3, consume 3
- machinery → 200, 5, 0.25, produce 4, consume 5  *(recommended tweak; see 4.3)*
- medicines → 150, 1, 0.2, produce 5, consume 5  *(recommended tweak; see 4.3)*
- weapons → 800, 3, 0.5, produce 5, consume 2
- electronics → 500, 2, 0.3, produce 6, consume 6
- narcotics → 2000, 1, 0.6, produce 6, consume 6
- computers → 1000, 1, 0.35, produce 7, consume 7

### 4.2 Baseline consumption rule (critical)
To guarantee that *every* economy is a consumer and trade never fully collapses, define a **baseline consumption basket**:

**Baseline imports (always demanded when consumable by tech):**
- food
- textiles
- metals
- luxuries

Additionally, **medicines** should become a baseline import as soon as the tech model allows it (see recommended tweak below).

Baseline imports do **not** mean all worlds pay extreme premiums; it means:
- every world has **some** positive demand multipliers for baseline goods it can consume,
- so there is *always* a destination that “counts as a consumer” for *something*.

### 4.3 Recommended gating tweaks (high impact, low content cost)
These tweaks dramatically improve connectivity and prevent whole tech tiers from becoming trade-poor while still keeping progression:

1) **Machinery consumptionTech: 5 → 4**
- Rationale: worlds at TL4 (Early Industrial) can plausibly *use* machinery, even if advanced machinery is better later.
- Result: TL4 worlds become viable machinery consumers, creating earlier Industrial-style routes.

2) **Medicines consumptionTech: 5 → 3 (or 4)**
- Rationale: “medicine demand” is one of the best universal sinks. Restricting consumption to TL5 removes a major trade stabilizer.
- Result: higher-tech worlds can export medicines into mid-tech space, keeping trade alive and making “health” a meaningful import.

If you want strict “advanced medicine” realism, split into:
- basic_medicines (consume 2–3, produce 4–5)
- medicines (consume 5, produce 5)
…but this document assumes the simpler **consumptionTech lowered** change.

### 4.4 Gating constraints (hard rules)
For a system of tech `T` and good `g`:
- If `T < g.consumptionTech`: the system **cannot consume** `g` (no consumer multipliers; demand = 0).
- If `T < g.productionTech`: the system **cannot produce** `g` (no producer multipliers; supply = 0).

---

## 5) World Types and Economic Identity

### 5.1 WorldType list
- AGRICULTURAL — produces food, textiles
- INDUSTRIAL — produces metals, machinery, weapons
- HIGH_TECH — produces electronics, computers, narcotics
- MINING — produces metals
- TRADE_HUB — no natural specialization (logistics-driven)
- RESORT — produces luxuries; high consumption

### 5.2 “Roles” per good (SP/P/N/C/SC)
Each WorldType assigns a **role** to each good (subject to tech gating), which determines its pricing multiplier.

Roles:
- **SP** (Special Producer): 0.55× base (typical range 0.45–0.65)
- **P**  (Producer):         0.75× base (typical range 0.65–0.85)
- **N**  (Neutral):          1.00× base (typical range 0.90–1.10)
- **C**  (Consumer):         1.50× base (typical range 1.40–1.70)
- **SC** (Special Consumer): 2.00× base (typical range 1.80–2.20)

> These numbers are “design defaults.” You may randomize inside the ranges per system for variety, but preserve role ordering.

### 5.3 Tech-masking of roles
Roles must be masked by tech level:

- If the system cannot **consume** a good due to gating: roles **C/SC** clamp down to **N**.
- If the system cannot **produce** a good due to gating: roles **P/SP** clamp up to **N**.
- If both production and consumption are gated off (rare for baseline goods): set role to **N** and do not list the good in that market.

This ensures you never assign “strong consumer” pricing to a world that cannot consume the item.

---

## 6) Recommended Role Matrix (Detailed)

This matrix is designed to:
- create strong, readable trade lanes,
- keep low/mid tech worlds connected using baseline goods,
- and ensure every WorldType has both exports and imports.

> Apply tech-masking from Section 5.3.

### 6.1 AGRICULTURAL
**Exports**
- food: SP
- textiles: SP

**Imports (always a consumer of something)**
- metals: C
- luxuries: C
- weapons: C (security & conflict demand; gated by consumptionTech=2, so only TL2+)
- medicines: C (if consumable; recommended consumptionTech lowered)
- machinery: C (only if consumable)

**Other**
- electronics/computers/narcotics: N → C at higher tech if you want richer late-game agri worlds.

### 6.2 MINING
**Exports**
- metals: SP

**Imports**
- food: SC (mining outposts overpay for supplies)
- textiles: C
- luxuries: C
- machinery: C (mining equipment)
- medicines: C/SC (hazard work)
- weapons: C (security)

**Other**
- electronics: N → C at TL6+
- narcotics: N (optional C at TL6+)

### 6.3 INDUSTRIAL
**Exports**
- machinery: SP
- weapons: P/SP
- metals: P

**Imports**
- food: SC
- textiles: C
- luxuries: C
- medicines: C (industrial workforce demand)
- electronics: C at TL6+ (industrial automation)
- computers: C at TL7 (advanced control systems)
- narcotics: N/C (optional for “vice” flavor)

### 6.4 HIGH_TECH
**Exports**
- electronics: SP
- narcotics: P/SP
- computers: SP (TL7 only)

**Imports**
- metals: C
- machinery: C
- food: C
- textiles: C
- luxuries: C
- medicines: C
- weapons: C (security for valuable assets)

### 6.5 TRADE_HUB (Logistics economy)
Trade hubs should feel like:
- good places to *find things* (breadth),
- decent sinks (consistent demand),
- but not the “best producer” of everything.

**Default behavior**
- Mild consumer bias on most consumable goods: C (not SC)
- Mild producer bias on 1–2 high-volume goods to keep flow: P on food/textiles or metals (choose based on hub’s surrounding region)

Suggested roles:
- food: P
- textiles: P
- metals: P or N
- luxuries: C
- machinery: C
- medicines: C
- weapons: C
- electronics: C
- narcotics: C
- computers: C

**Important constraint:** keep spreads narrower than specialized economies (Section 7.4).

### 6.6 RESORT
Resorts are defined by consumption and luxury culture.

**Exports**
- luxuries: P (or SP if you want resorts to be the main luxury producers)

**Imports (high consumption)**
- food: SC
- textiles: C
- medicines: C/SC (public health, tourism)
- electronics: C (at TL6+)
- computers: C (at TL7)
- narcotics: SC (at TL6+, if your setting supports it)

**Other**
- metals/machinery/weapons: N (unless you want “fortified resort” variants)

---

## 7) Price Generation Model (Extremely Detailed)

### 7.1 Price formula (per system, per good)
For a system `S` and good `g`:

1) Determine role `R` for (S, g) using:
   - WorldType role matrix
   - tech-masking
   - baseline demand overlay (Section 7.3)

2) Choose multiplier `m_role`:
   - SP ≈ 0.55
   - P  ≈ 0.75
   - N  ≈ 1.00
   - C  ≈ 1.50
   - SC ≈ 2.00

3) Apply volatility noise:
   - volatilityNoise = randomUniform(-v, +v) where v = g.volatility
   - clamp volatility impact to prevent role inversion:
     - SP and SC goods should not cross into the opposite side often.
     - Suggested clamp: finalMultiplier ∈ [m_role × (1 - 0.5v), m_role × (1 + 0.5v)]

4) Apply local “market state” modifiers (optional but recommended):
   - supplyPressure (surplus lowers price, shortage raises)
   - demandPressure (high demand raises price)

5) Final price:
   - price = g.basePrice × finalMultiplier
   - clamp to a reasonable absolute min/max (to prevent broken extremes):
     - minPrice = base × 0.25
     - maxPrice = base × 3.00

### 7.2 Preventing role inversion (important)
Without guardrails, high volatility goods (narcotics, weapons) can invert:
- producer becomes more expensive than consumer
- consumer becomes cheap

To preserve an Elite-like “readable” economy:
- Do not allow volatility to fully override role.
- Use the clamp described in 7.1(3).
- Optionally tie volatility to *stock level* rather than purely random.

### 7.3 Baseline demand overlay (how “everyone is a consumer” works)
After role assignment, apply a baseline demand overlay for baseline goods that are consumable by tech.

For baseline goods (food/textiles/metals/luxuries and medicines once enabled):
- If the role is **N** and the world can consume the good:
  - upgrade to **C** with small probability (e.g., 20–40%) OR
  - apply a +Δ multiplier (e.g., +0.10 to +0.20) without changing role label

Goal:
- even “neutral” worlds still pay *some* premium for baseline imports,
- preventing dead zones where nothing is a consumer.

### 7.4 Trade hub spread narrowing
Trade hubs should not outcompete specialized worlds.
Enforce narrower multipliers for TRADE_HUB:
- SP/P clamp upward (less cheap): e.g., P = 0.90 instead of 0.80
- C/SC clamp downward (less expensive): e.g., C = 1.30 instead of 1.40

This makes hubs:
- good for availability,
- but not the best for pure margin.

---

## 8) NPC Trading Behavior (Aligned With Economy)

### 8.1 Candidate selection
NPC picks candidate goods based on:
- affordability (after reserving fuel + buffers),
- expected profit (price ratio),
- weight/space constraints (optional),
- legality/risk (optional for narcotics/weapons).

### 8.2 Look-ahead profitability check (must match game logic)
For each candidate good `g` in current system `S`:
1. Compute effective buy price at S (with 3% buy tax).
2. Search systems within ±20 systems.
3. For each destination D:
   - compute net sell at D (no tax on sales)
   - compute profit margin
4. Accept `g` if any D yields margin ≥ 0.01%

If none, NPC skips `g`.

### 8.3 Fuel reserve and spendable credits
NPCs can use up to **80% of their credits** for trading, reserving 20% for fuel and taxes:
- Minimum fuel reserve (enough for 5 LY minimum travel)
- 20% credit reserve for fuel/tax buffer
- Remaining 80% available for trading

This allows NPCs to participate in trade more actively while maintaining mobility.

### 8.4 Low-credit recovery behavior
If credits drop below a low-credit threshold:
- NPC may sell cargo even at a small loss to regain mobility.
- This prevents deadlocks and keeps the galaxy populated.

### 8.5 “Air purifier tax” behavior
NPCs with cargo are not removed for inability to pay a tiny recurring tax. They must be allowed to trade back to solvency.

---

## 9) Profit Availability Guarantee Pass (Critical System)

This is the mechanism that makes the design promise true:
**“From every inhabited system, profitable trades exist.”**

### 9.1 When to run
Run the guarantee pass whenever:
- generating a new region/galaxy,
- regenerating markets,
- or periodically (e.g., daily tick) if your economy drifts.

### 9.2 What it guarantees
For each inhabited system `S`:
- there exist at least **M** goods (default 3) such that:
  - S can buy them (price exists),
  - and within ±20 systems there is at least one destination with ProfitMargin ≥ 0.01% after tax.

### 9.3 How it fixes failures (adjustment ladder)
If a system fails the guarantee:

**Step 1 (least intrusive):** adjust baseline demand in nearby destinations
- For baseline goods, slightly increase consumer multiplier (e.g., +0.05 to +0.15) for a subset of nearby systems that can consume the good.

**Step 2:** adjust S’s export competitiveness for tech-valid exports
- If S is meant to export a good but is too expensive, nudge its producer multiplier down toward SP.

**Step 3:** introduce a “regional sink” behavior
- If the region is over-supplied, tag one system as a stronger consumer for a baseline good category.

**Step 4 (last resort):** widen search radius temporarily for guarantee (but do not change NPC behavior)
- Prefer not to do this. The guarantee should match NPC logic. Only use as a debug tool.

### 9.4 Keep it invisible
The guarantee pass should not feel like cheating:
- adjust in small increments,
- spread adjustments across multiple systems,
- prefer baseline goods (they are plausible “always needed” items).

---

## 10) Balancing Against Infinite Money Loops

If profit is always available, you must prevent a single two-system loop from being permanently optimal.

Recommended dampeners:

### 10.1 Stock-based price elasticity (recommended)
Each market holds stock levels per good:
- Producers restock faster on export goods.
- Consumers “consume” stock over time.

Price responds to stock:
- low stock → price rises
- high stock → price falls

This naturally reduces repeated loop profitability.

### 10.2 Volume tiers (“best price for first N units”)
For each good in each system:
- the first N units use the best multiplier,
- after that, price moves toward neutral.

This keeps trading profitable, but prevents infinite exploitation.

### 10.3 Volatility tied to state, not pure RNG
High-volatility goods (narcotics, weapons) should swing more when stock is low or when events occur, not randomly every tick.

---

## 11) WorldType ↔ TechLevel Constraints (Recommended Defaults)

To avoid “thin markets” where only 1–2 goods exist, constrain minimum tech per WorldType:

- AGRICULTURAL: TL1+
- MINING: TL2+
- RESORT: TL3+
- TRADE_HUB: TL3+
- INDUSTRIAL: TL4+ (or TL5+ if you want machinery + medicines to define it)
- HIGH_TECH: TL6+

This ensures each economy can both export and import multiple goods.

---

## 12) Worked Examples (After Removing TL0)

### 12.1 Agricultural (TL1) → Industrial (TL5) food run
- Food base 10
- Agricultural SP ≈ 0.55 → price ≈ 5.5
- Industrial SC ≈ 2.00 (if food is SC there) → price ≈ 20

Effective buy: 5.5 × 1.03 = 5.665
Net sell: 20 (no tax on sales)
Margin: (20 − 5.665) / 5.665 ≈ 253%

### 12.2 Mining (TL2) → High-tech (TL6) metals run
- Metals base 50
- Mining SP ≈ 0.55 → 27.5
- High-tech C ≈ 1.50 → 75

Effective buy: 27.5 × 1.03 = 28.325
Net sell: 75 (no tax on sales)
Margin: (75 − 28.325) / 28.325 ≈ 165%

### 12.3 Industrial (TL5) → Medieval (TL2) weapons run (bridge good)
Weapons consumeTech=2, produceTech=5
- Industrial P/SP cheap
- Medieval C/SC expensive
This creates strong mid-game connectivity without requiring high-tech goods.

---

## 13) Implementation Checklist

### 13.1 Data changes
- Disallow inhabited tech = 0.
- Treat food as production/consumption tech ≥ 1 for inhabited markets (or remove the 0 entry in the enum and renumber).
- Apply recommended tweaks:
  - machinery consumptionTech 5 → 4
  - medicines consumptionTech 5 → 3 or 4

### 13.2 Economy configuration
- Encode role matrix per WorldType (Section 6).
- Apply tech-masking.
- Apply baseline demand overlay.
- Apply hub spread narrowing.
- Implement guarantee pass.

### 13.3 NPC behavior
- Ensure look-ahead uses after-tax margin formula exactly.
- Ensure fuel reserve and low-credit recovery match expectations.

---

## 14) Success Criteria and Debugging Signals

You can validate the economy by checking:

1. **Route coverage**
   - For every inhabited system, count goods with ≥1 profitable destination within 15 systems.
   - Expect ≥ M (default 3).

2. **Trade diversity**
   - No single good dominates all routes everywhere.
   - Baseline goods keep low-tech trading alive; advanced goods add late-game spice.

3. **NPC health**
   - NPCs rarely stall with no valid trade.
   - Low-credit NPCs recover and re-enter normal trading.

4. **Player experience**
   - Players can always find a “reasonable” profitable trade nearby.
   - Best routes require discovery and vary over time.

---

## Appendix A: Suggested role multiplier ranges (for tuning)
- SP: 0.45–0.65
- P:  0.65–0.85
- N:  0.90–1.10
- C:  1.40–1.70
- SC: 1.80–2.20

If margins feel too high everywhere:
- compress C/SC ranges downward,
- increase hub narrowing,
- strengthen elasticity/volume tiers.

If margins feel too low:
- widen SP downwards and C upwards for the *specialized* goods only,
- or increase baseline demand overlay slightly.

---

## Appendix B: Default parameter values
- buy tax: 3%
- sell tax: 0% (no tax on sales)
- min profit margin: 0.01% after tax
- look-ahead radius: 20 systems
- profit guarantee M: 3 goods per system
- trade hub narrowing: producer +0.10, consumer −0.10 (relative to defaults)
- credit reserve for trading: 80% (20% reserved for fuel/taxes)
- rest gating threshold: 30% of starting credits or 1.5× recovery threshold
