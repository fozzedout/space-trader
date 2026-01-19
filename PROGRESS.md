# Space Trader – Progress

**Spec:** `ECONOMY_BIBLE.md` is the canonical specification. This file tracks implementation tasks toward that spec.

---

## Project State

- **What it is:** Trading economy simulator: 20 star systems, 100 NPCs, deterministic tick-based markets. Local Node.js only.
- **StarSystem** – Per-system economy: prod/consumption, markets, arrivals/departures, pricing.
- **Ship** – NPC/player: cargo, credits, phases `at_station` | `traveling`, trade/travel.
- **local-server.ts** – HTTP API; in-memory `StarSystem`/`Ship` plus SQLite via `local-storage.ts`.
- **Ticks:** System/station 30s; traveling ships 11s. Storage: SQLite, hourly flush.

---

## Critical Issues (to be addressed per ECONOMY_BIBLE)

- **Zero inventory death spiral** – No recovery; production/consumption imbalance.
- **Inventory drift** – Static prod/cons, space elevator is non-canonical (§1) and must be removed/disabled.
- **NPC profitability** – Low margin, no travel-cost or contract-based decisions.
- **Price volatility** – Wide multipliers, no target-stock-based formation or smoothing per spec.
- **No supply chain** – No dependency-driven production, contracts, or inter-system coordination.
- **NPC behavior** – Greedy, no archetypes, info decay, learning, or fuel.

---

## Implementation Tasks (from ECONOMY_BIBLE)

### Core Invariants & Cleanup

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Remove or disable `applySpaceElevator` | not started | §1 | `src/star-system.ts` |
| Remove any global restocking/credit injection logic; only local production/consumption/trade/treasury changes | not started | §1 | `src/star-system.ts`, `src/local-server.ts` |
| System isolation: no global price info or instant goods transfer; only ships move goods and carry price info | not started | §1 | `src/ship.ts`, `src/star-system.ts` |
| Event stream ordering: admin → player actions → system ticks (asc systemId) → ship ticks (asc shipId) | not started | §1.1, §18 | `src/local-server.ts`, ship/star-system |
| Cargo capacity: `sum(qty[g] * weight[g]) <= cargoCapacity` on every trade | not started | §1.4 | `src/ship.ts`, `src/types.ts` |

### Goods & Production

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Expand goods: alloys, ship_parts, fertilizer, fuel (narcotics optional, already present) | not started | §2 | `src/goods.ts`, `src/types.ts` |
| GoodBalance: baseProduction, baseConsumption, inputs, priceElasticity, min/maxPriceMult, maxStockMult, spoilageRate, isContraband | not started | §2, §14 | `src/goods.ts`, `src/balance-config.ts`, `src/types.ts` |
| Tech gating: BaseProd[g]=0 if techLevel &lt; productionTech; BaseCons[g]=0 if &lt; consumptionTech | not started | §2 | `src/star-system.ts` |
| Dependency table and input-limited production; production in fixed order (§3); fractional inputs | not started | §3 | `src/star-system.ts`, `src/goods.ts` |
| Bootstrap: seedInventory, bootstrapTicks, bootstrapRate; seed production when inputs missing | not started | §3.1 | `src/star-system.ts`, `src/balance-config.ts` |

### World Roles & Formulas

| Task | Status | Spec | Files |
|------|--------|------|-------|
| World role multipliers (agricultural, mining, industrial, high_tech, shipyard, resort, trade_hub) | not started | §4 | `src/star-system.ts`, `src/types.ts` |
| BaseProd, BaseCons formulas: pop × techMult × baseProd/Cons × roleMult × facilityLevel | not started | §5 | `src/star-system.ts` |
| Facility levels: facilityLevel[g], default 0.5–1.5; player upgrades (optional) | not started | §5.1, §14 facility | `src/star-system.ts`, `src/types.ts` |

### Inventory, Price, Storage

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Inventory targets: targetStock[g], rawTargetStock, maxStock[g]; inactive goods keep basePrice and skip contracts | not started | §6 | `src/star-system.ts` |
| Inventory floor: clamp inventory[g] >= 0 after production/consumption | not started | §5 | `src/star-system.ts` |
| Storage cap: inventory[g] = min(inventory[g], maxStock[g]); discard excess | not started | §6 | `src/star-system.ts` |
| Spoilage: `inventory[g] *= (1 - spoilageRate[g])` at start of system tick | not started | §6 | `src/star-system.ts` |
| Price formation: inventoryRatio, targetPrice, alpha smoothing (+ tradeHubAlphaBonus), clamp to basePrice×minMult/maxMult | not started | §6 | `src/star-system.ts`, `src/balance-config.ts` |
| Price init: set price[g] = basePrice[g] before first system tick | not started | §6 | `src/star-system.ts` |
| Perishability applies only to system inventory (no cargo spoilage in transit) | not started | §6 | `src/star-system.ts`, `src/ship.ts` |

### Treasury & Settlement

| Task | Status | Spec | Files |
|------|--------|------|-------|
| System treasury: startCreditsPerPop×pop + startCreditsBase; minReserve; affordability checks | not started | §1.3, §14 treasury | `src/star-system.ts`, `src/types.ts` |
| Settlement: buy reduces treasury, sell increases; partial fill if treasury short; bonus prorated/zeroed if insufficient | not started | §1.3 | `src/star-system.ts` |

### Contracts

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Contracts: shortage/surplus triggers, create/cancel/expire, TTL, max one buy+one sell per good, maxUnitsPerContract | not started | §7 | `src/star-system.ts`, `src/types.ts` |
| Contract bonus: bonusPerUnit = basePrice × bonusFactor × shortageRatio; paid from treasury | not started | §7 | `src/star-system.ts` |
| Arbitrage protection: bonus only for goods from different system; no same-tick same-system fulfill | not started | §7 | `src/star-system.ts`, `src/ship.ts` |
| Contracts only change on system ticks; no goods or credits reserved until fulfillment | not started | §7 | `src/star-system.ts` |
| Contract prioritization (highest bonus, earliest expiration); one active contract target per ship | not started | §7.1 | `src/ship.ts` |
| Fulfillment: market price + bulk/depth; contract first then optional market trade; ascending shipId for partial | not started | §7.2 | `src/star-system.ts`, `src/ship.ts` |

### NPC Behavior & Information

| Task | Status | Spec | Files |
|------|--------|------|-------|
| NPC archetypes: local, regional, longHaul (share, minMargin, maxRange, preferContracts) | not started | §8 | `src/ship.ts`, `src/balance-config.ts` |
| Profit model: netMargin = sellPrice − buyPrice − travelCostPerUnit; operatingCostPerMinute is a credit sink | not started | §8 | `src/ship.ts` |
| Decision: trade if netMargin + contractBonus (+ contractMarginBoost if preferContracts) ≥ minMargin | not started | §8 | `src/ship.ts` |
| Info decay: confidence = exp(−ageMinutes / infoHalfLifeMinutes); riskPenalty uses volatility/basePrice; effectiveSellPrice/effectiveBuyPrice | not started | §8 | `src/ship.ts` |
| Trade hub bulletin: EMA of observed prices; hubPrice blend; decay via infoHalfLifeMinutes | not started | §8 | `src/star-system.ts`, `src/ship.ts` |
| NPC learning: track last N trades, avg profit/min, success rate; routeScore decay, update with alpha=1/routeMemorySize; epsilon explore | not started | §8 | `src/ship.ts`, `src/balance-config.ts` |
| Fleet: multiShipThresholdUnits; multiple NPCs can fulfill until remainingUnits exhausted | not started | §7, §8 | `src/star-system.ts`, `src/ship.ts` |

### Fuel, Travel, Trade Mechanics

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Fuel: fuelPerMinute × travelMinutes; reserve on departure; fuel occupies cargo; no mid-route depletion; wait/retire if none | not started | §8 | `src/ship.ts`, `src/types.ts` |
| Bulk discounts / market depth: marketDepth, bulkFactor×log1p(qty/marketDepth), effectivePrice; apply to whole trade | not started | §8.1 | `src/star-system.ts` |

### Risk & Failure

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Bankruptcy: if fuel/trade unaffordable, liquidate cargo at effective market price then apply forcedLiquidationDiscount; retire after bankruptGraceTicks | not started | §8.2 | `src/ship.ts` |
| Supply chain collapse: criticalRatio×targetStock; regional crisis after collapseTicks; crisis mode (minMargin, bonus, maxRange) for crisisDurationTicks; cooldown | not started | §8.2 | `src/star-system.ts`, `src/balance-config.ts` |

### Ships & NPC Fleet

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Ship types: cargoMin/cargoMax, speedMultiplier, fuelMultiplier, operatingCostMultiplier | not started | §8.4 | `src/ship.ts`, `src/types.ts`, `src/balance-config.ts` |
| Capacity: cargoCapacity = lerp(cargoMin, cargoMax, rng()) per ship type | not started | §8.4 | `src/ship.ts` |
| Archetype-to-type mapping: local→courier/trader, regional→trader/hauler, longHaul→hauler/freighter | not started | §8.4 | `src/balance-config.ts`, `src/ship.ts` |
| NPC fleet: startCredits range, perSystem + perMillionPop, maxTotal; deterministic home per region; spawn at trade hub or home | not started | §8.5 | `src/local-server.ts`, `src/ship.ts` |
| Replacement ships (optional): replacementIntervalTicks, from treasury; requirePartsForSpawn consumes ship_parts or blocks spawn | not started | §8.5 | `src/local-server.ts`, `src/balance-config.ts` |

### Galaxy & Regions

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Regions: 4–10 systems, MST + k-NN links, min/maxLinksPerSystem; partition into R regions; anchor trade_hub and shipyard | not started | §9, §10 | `src/local-server.ts`, `src/star-system.ts` |
| Region role bias weights; anchor assignment rules (trade_hub/shipyard, allow merged anchor for small regions) | not started | §10 | `src/local-server.ts` |
| Galaxy generation: needs-consistent; requiredFood/Metals/Alloys/ShipParts; world counts; validate; shipPartsTarget reduction / allowSystemGrowth on failure | not started | §10 | `src/local-server.ts` |
| Population assignment: by role (shipyard/high-tech higher, mining lower); enforce minRegionPop | not started | §10 | `src/local-server.ts` |
| World attributes: resourceRichness, gravity, atmosphere, habitationQuality; apply to BaseProd, fuelPerMinute, gravityPenalty (avg origin/dest gravity) | not started | §10.4 | `src/star-system.ts`, `src/types.ts` |

### Population & Presets

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Population base model: fixed (no growth/decline) unless optional system added | not started | §10.6 | `src/local-server.ts`, `src/star-system.ts` |
| Starting ratio presets (shipbuilding-heavy, balanced, luxury-leaning) as pre-sizing hints; store in DB tables `ratio_presets` and `tuning_settings` (active_ratio_preset); seed defaults if missing | not started | §11.1 | `src/local-server.ts`, `src/local-storage.ts` |

### Evolution & Shocks

| Task | Status | Spec | Files |
|------|--------|------|-------|
| World evolution: rolePressure from trade balance; roleShiftThreshold, roleShiftTicks; facilityLevel evolution/decay | not started | §10.1 | `src/star-system.ts` |
| Tech progression: techPoints from wealth and computers consumption; techThreshold; maxTechByRole caps | not started | §10.2 | `src/star-system.ts` |
| Economic shocks: deterministic from (systemSeed, tick); crop blight, mine collapse, industrial accident, war spike, new discovery; one per system, no stacking | not started | §10.3 | `src/star-system.ts` |

### Player

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Player: startCredits/startShipType, bankruptcy (same as NPC), facility upgrades, reputation (contracts/contraband; affects tariffs) | not started | §1.2, §14 players | `src/local-server.ts`, `src/ship.ts`, `src/types.ts` |

### Simulation Cadence

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Tick order: admin → player actions (timestamp) → system ticks (asc systemId) → ship ticks (asc shipId) | not started | §12.1 | `src/local-server.ts` |
| System tick order: spoilage → BaseProd/BaseCons → input-limited production → consumption → floor & storage cap → prices → contracts | not started | §12.1 | `src/star-system.ts` |
| Ship arrivals trade at latest system state; contracts only update on system ticks | not started | §12.1 | `src/ship.ts`, `src/star-system.ts` |
| Optional regional tick (e.g. 5 min) for evolution/tech if needed | not started | §12 | `src/local-server.ts` |

### Metrics & Health

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Stability metrics: zero inventory, NPC credits growth, price volatility, contract fulfillment ratio, regional autonomy, NPC diversity, regional balance | not started | §13 | `src/logging` or metrics module, `src/local-server.ts` |
| Metrics response: log crisis, apply health.* multipliers (crisisMinMargin, crisisBonus, crisisMaxRange), no goods/credits injection | not started | §13.1 | `src/star-system.ts` |
| Tuning workflow support: store per-run metadata in `tuning_runs` and metrics snapshots in `metrics_snapshots` (metrics_json) for iteration tracking | not started | §13.3 | `src/local-storage.ts`, `src/logging.ts` |

### Scaling & Performance

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Cache market snapshots per system tick; avoid per-ship full scans; keep tick complexity bounded | not started | §17 | `src/star-system.ts`, `src/ship.ts` |
| Batch ticks and stagger ship updates by region for large fleets (>1000 ships) | not started | §17 | `src/local-server.ts` |
| Compute regional metrics on slower cadence (e.g., every 10 system ticks) | not started | §17 | `src/local-server.ts` |

### Balance Config & Migration

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Migrate balance-config to ECONOMY_BIBLE §14 schema: goods, treasury, pricing, contracts, bootstrap, npcArchetypes, npcLearning, npc, infoDecay, travelCost, trade, facility, evolution, techProgression, blackMarket, factions, players, ships, worldAttributes, bankruptcy, events, health, regions | not started | §14 | `src/balance-config.ts` |
| Persist BalanceConfig in `balance_config` table; seed defaults on first run; DB overrides code defaults at runtime | not started | §14.1 | `src/local-storage.ts`, `src/balance-config.ts`, `src/local-server.ts` |
| Gate new pipeline with feature flag; validate parameter interactions; remove legacy once stable | not started | §14 | `src/balance-config.ts` |

### Testing

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Validation tests for spec: determinism, production order, contracts, treasury, crisis, etc. | not started | §15.1 | `src/*.test.ts` |

### Backlog (Optional Systems)

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Black market: lawLevel, seizure on entry (lawLevel×seizureFactor), riskTolerance, isContraband; exclude contraband from contracts/hub info | not started | §8.3 | `src/ship.ts`, `src/star-system.ts` |
| Factions: system faction, tariffs/sanctions, reputation; tariff revenue to treasury; faction contracts (optional) | not started | §10.5 | `src/types.ts`, `src/local-server.ts`, `src/star-system.ts` |

---

## Minimal Viable Rework Path (§16)

1. Dependency table and input-limited production (no new goods yet).
2. Contracts and NPC contract preference.
3. Regions plus local / regional / long-haul archetypes.
4. New goods (alloys, ship_parts, fertilizer) and shipyard role.

---

## Determinism (§18)

- All RNG: deterministic, seeded per system or ship. System: systemId + tick; ship: shipId + tick.
- Contract creation: deterministic from inventory and thresholds.
- NPC route choice: deterministic from observed prices and ship seed.

---

## Superseded / Prior Exploration

Options 1–8 (supply chain, dynamic prod/cons, route planning, galactic bank, price stability, adaptive economy, simplified supply-driven, hybrid) in earlier versions of this file are superseded by **ECONOMY_BIBLE.md**. The spec uses contracts, info decay, crisis multipliers, and balance-config-driven behavior instead of magic restocking or central injection.

---

## Notes

- All tests: `npm test`. CI: `main`, `develop`, `master`.
- No `src/index.ts`; `src/local-server.ts` only.
- Tuning workflow: edit ratios/rates in DB, run multi-hour simulations with fixed seeds, compare stability metrics, record iteration results before changing again.
