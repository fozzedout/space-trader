# Space Trader - Progress

**Spec:** `ECONOMY_BIBLE.md` is the canonical specification. This file tracks implementation tasks toward that spec.

**Status tracking:** set `Status` to `not started`, `in progress`, or `done`. Keep tasks derived from `ECONOMY_BIBLE.md` only; do not add implementation state notes.

**Task granularity:** tasks should be atomic (one clear outcome, a few hours of work). If a task grows, split it into smaller tasks here before starting.

---

## Implementation Tasks (from ECONOMY_BIBLE)

### Core Cleanup & Invariants

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Remove or disable `applySpaceElevator` | not started | §1 | `src/star-system.ts` |
| Remove global restocking/credit injection logic; only local production/consumption/trade/treasury changes | not started | §1 | `src/star-system.ts`, `src/local-server.ts` |
| Remove cross-system inventory/price sharing; only ships move goods and carry price info | not started | §1 | `src/star-system.ts`, `src/ship.ts`, `src/local-server.ts` |
| Enforce event order: admin -> player actions -> system ticks (asc systemId) -> ship ticks (asc shipId) | not started | §1.1, §12.1 | `src/local-server.ts` |
| Enforce deterministic RNG seeding (system: systemId+tick, ship: shipId+tick) | not started | §1.1, §18 | `src/star-system.ts`, `src/ship.ts` |
| Enforce cargo capacity on every trade (sum qty*weight <= cargoCapacity) | not started | §1.4 | `src/ship.ts`, `src/types.ts` |
| Ensure perishability applies only to system inventory (no cargo spoilage) | not started | §6 | `src/star-system.ts`, `src/ship.ts` |

### Goods Catalog & Balance Inputs

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Add goods: alloys, ship_parts, fertilizer, fuel to catalog and GoodId union | not started | §2 | `src/goods.ts`, `src/types.ts` |
| Add GoodBalance fields (baseProduction, baseConsumption, inputs, priceElasticity, minPriceMult, maxPriceMult, maxStockMult, spoilageRate, isContraband, productionTech, consumptionTech) | not started | §2, §14 | `src/types.ts`, `src/balance-config.ts` |
| Define per-good defaults (baseProd/Cons, basePrice, weight, elasticity, min/max price mult, maxStockMult, spoilageRate, contraband) | not started | §2, §6 | `src/goods.ts`, `src/balance-config.ts` |
| Define dependency table (inputs per unit output) and fixed production order | not started | §3 | `src/goods.ts`, `src/star-system.ts` |
| Add bootstrap config (seedInventory, bootstrapTicks, bootstrapRate) defaults | not started | §3.1, §14 | `src/balance-config.ts` |
| Add tech gating thresholds (productionTech, consumptionTech) to goods metadata | not started | §2 | `src/goods.ts`, `src/types.ts` |

### World Roles & Production/Consumption

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Add world role enum and role multipliers (agricultural, mining, industrial, high_tech, shipyard, resort, trade_hub) | not started | §4 | `src/types.ts`, `src/balance-config.ts`, `src/star-system.ts` |
| Implement BaseProd/BaseCons formula: pop * techMult * baseProd/Cons * roleMult * facilityLevel | not started | §5 | `src/star-system.ts` |
| Apply tech gating: BaseProd[g]=0 if techLevel < productionTech; BaseCons[g]=0 if techLevel < consumptionTech | not started | §2, §5 | `src/star-system.ts` |
| Add facilityLevel per good per system (default range 0.5-1.5) | not started | §5.1 | `src/types.ts`, `src/star-system.ts`, `src/balance-config.ts` |
| Implement optional player facility upgrades | not started | §5.1, §14 players | `src/star-system.ts`, `src/local-server.ts`, `src/types.ts` |

### System Tick Pipeline (Production/Inventory/Pricing)

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Implement system tick order: spoilage -> BaseProd/BaseCons -> input-limited production -> consumption -> floor & storage cap -> prices -> contracts | not started | §12.1 | `src/star-system.ts` |
| Apply spoilage at start of system tick (inventory[g] *= 1 - spoilageRate[g]) | not started | §6 | `src/star-system.ts` |
| Implement input-limited production using dependency table and fixed order (fractional inputs allowed) | not started | §3, §12.1 | `src/star-system.ts` |
| Apply consumption after production and clamp inventory[g] >= 0 | not started | §5 | `src/star-system.ts` |
| Compute targetStock[g], rawTargetStock, maxStock[g]; inactive goods keep basePrice and skip contracts | not started | §6 | `src/star-system.ts`, `src/balance-config.ts` |
| Enforce storage cap: inventory[g] = min(inventory[g], maxStock[g]) | not started | §6 | `src/star-system.ts` |
| Initialize price[g] = basePrice[g] before first system tick | not started | §6 | `src/star-system.ts` |
| Implement price formation: inventoryRatio -> targetPrice -> alpha smoothing (+ tradeHubAlphaBonus) -> clamp to basePrice*min/max | not started | §6 | `src/star-system.ts`, `src/balance-config.ts` |

### Treasury & Settlement

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Add treasury fields (startCreditsPerPop, startCreditsBase, minReserve) to system state | not started | §1.3, §14 treasury | `src/types.ts`, `src/balance-config.ts` |
| Initialize system treasury on creation | not started | §1.3 | `src/star-system.ts` |
| Enforce affordability checks for market trades and contract bonuses | not started | §1.3 | `src/star-system.ts` |
| Settlement: system buys reduce treasury, sells increase; allow partial fill if treasury short | not started | §1.3 | `src/star-system.ts` |
| Bonus payment prorated/zeroed if treasury insufficient | not started | §1.3 | `src/star-system.ts` |

### Contracts

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Add Contract data model (buy/sell, good, units, bonusPerUnit, createdTick, expiresTick, originSystemId) | not started | §7 | `src/types.ts`, `src/star-system.ts` |
| Implement shortage/surplus detection and contract creation on system ticks only | not started | §7 | `src/star-system.ts` |
| Implement contract TTL expiry and cancellation logic | not started | §7 | `src/star-system.ts` |
| Enforce max one buy and one sell contract per good; maxUnitsPerContract | not started | §7 | `src/star-system.ts`, `src/balance-config.ts` |
| Compute bonusPerUnit = basePrice * bonusFactor * shortageRatio (treasury-funded) | not started | §7 | `src/star-system.ts`, `src/balance-config.ts` |
| Arbitrage protection: bonus only for goods from different system; no same-tick same-system fulfill | not started | §7 | `src/star-system.ts`, `src/ship.ts` |
| Contracts only change on system ticks; no goods/credits reserved before fulfillment | not started | §7 | `src/star-system.ts` |
| Contract prioritization: highest bonus then earliest expiration | not started | §7.1 | `src/ship.ts` |
| One active contract target per ship | not started | §7.1 | `src/ship.ts` |
| Fulfillment: contract trade first then optional market trade; apply market depth/bulk pricing | not started | §7.2, §8.1 | `src/star-system.ts`, `src/ship.ts` |
| Partial fulfillment ordering by ascending shipId; allow multiple NPCs until remainingUnits exhausted | not started | §7.2, §8 | `src/star-system.ts`, `src/ship.ts` |

### NPC Behavior & Information

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Define NPC archetypes (local, regional, longHaul) with share, minMargin, maxRange, preferContracts | not started | §8 | `src/balance-config.ts`, `src/ship.ts` |
| Implement profit model: netMargin = sellPrice - buyPrice - travelCostPerUnit; operatingCostPerMinute is a credit sink | not started | §8 | `src/ship.ts` |
| Implement decision rule: trade if netMargin + contractBonus (+ contractMarginBoost if preferContracts) >= minMargin | not started | §8 | `src/ship.ts` |
| Implement info decay: confidence = exp(-ageMinutes / infoHalfLifeMinutes); riskPenalty uses volatility/basePrice; effective prices | not started | §8 | `src/ship.ts`, `src/balance-config.ts` |
| Implement trade hub bulletin: EMA of observed prices; hubPrice blend; decay via infoHalfLifeMinutes | not started | §8 | `src/star-system.ts`, `src/ship.ts` |
| Implement NPC learning: last N trades, avg profit/min, success rate; routeScore decay; alpha=1/routeMemorySize; epsilon explore | not started | §8 | `src/ship.ts`, `src/balance-config.ts` |
| Ensure price info storage is per-ship and only updated from visited systems/hubs | not started | §1, §8 | `src/ship.ts` |

### Trade Mechanics (Fuel, Travel, Market Depth)

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Add fuel as a tradeable good that occupies cargo weight | not started | §8 | `src/goods.ts`, `src/types.ts`, `src/ship.ts` |
| Implement fuelPerMinute * travelMinutes reservation on departure | not started | §8 | `src/ship.ts`, `src/balance-config.ts` |
| Handle no-fuel case: wait or retire when fuel unavailable | not started | §8 | `src/ship.ts` |
| Ensure no mid-route depletion (fuel reserved upfront and consumed on arrival) | not started | §8 | `src/ship.ts` |
| Implement market depth/bulk discounts: bulkFactor * log1p(qty/marketDepth) applied to whole trade | not started | §8.1 | `src/star-system.ts`, `src/balance-config.ts` |

### Risk & Failure

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Bankruptcy flow: if fuel/trade unaffordable, liquidate cargo at effective market price | not started | §8.2 | `src/ship.ts` |
| Apply forcedLiquidationDiscount to bankruptcy sales | not started | §8.2 | `src/ship.ts`, `src/balance-config.ts` |
| Retire ships after bankruptGraceTicks | not started | §8.2 | `src/ship.ts`, `src/balance-config.ts` |
| Supply chain collapse detection (inventory < criticalRatio*targetStock) and collapseTicks tracking | not started | §8.2 | `src/star-system.ts`, `src/balance-config.ts` |
| Crisis mode: apply crisisMinMargin, crisisBonus, crisisMaxRange for crisisDurationTicks; handle cooldown | not started | §8.2 | `src/star-system.ts`, `src/balance-config.ts` |

### Ships & NPC Fleet

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Define ship types with cargoMin/cargoMax, speedMultiplier, fuelMultiplier, operatingCostMultiplier | not started | §8.4 | `src/types.ts`, `src/balance-config.ts` |
| Assign cargoCapacity via lerp(cargoMin, cargoMax, rng()) per ship type | not started | §8.4 | `src/ship.ts` |
| Map archetypes to ship types (local->courier/trader, regional->trader/hauler, longHaul->hauler/freighter) | not started | §8.4 | `src/balance-config.ts`, `src/ship.ts` |
| NPC fleet sizing: startCredits range, perSystem + perMillionPop, maxTotal | not started | §8.5 | `src/local-server.ts`, `src/balance-config.ts` |
| Deterministic home per region; spawn at trade hub or home | not started | §8.5 | `src/local-server.ts`, `src/ship.ts` |
| Replacement ships: replacementIntervalTicks, spawn from treasury | not started | §8.5 | `src/local-server.ts`, `src/balance-config.ts` |
| requirePartsForSpawn consumes ship_parts or blocks spawn | not started | §8.5 | `src/local-server.ts`, `src/star-system.ts` |

### Regions & Galaxy Generation

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Partition systems into regions (4-10 systems per region; R regions) | not started | §9 | `src/local-server.ts` |
| Build MST + k-NN links and enforce min/maxLinksPerSystem | not started | §9 | `src/local-server.ts` |
| Assign regional anchors (trade_hub, shipyard) | not started | §9, §10 | `src/local-server.ts` |
| Apply region role bias weights to system role assignment | not started | §10 | `src/local-server.ts`, `src/star-system.ts` |
| Needs-consistent galaxy generation for required goods (Food/Metals/Alloys/ShipParts) | not started | §10 | `src/local-server.ts` |
| Validate generation; on failure reduce shipPartsTarget or allowSystemGrowth | not started | §10 | `src/local-server.ts`, `src/balance-config.ts` |
| Assign population by role (shipyard/high-tech higher, mining lower) and enforce minRegionPop | not started | §10 | `src/local-server.ts` |
| Persist region metadata on systems | not started | §9 | `src/types.ts`, `src/local-server.ts` |

### World Attributes & Population

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Add world attributes (resourceRichness, gravity, atmosphere, habitationQuality) to system state | not started | §10.4 | `src/types.ts`, `src/local-server.ts` |
| Apply world attributes to BaseProd/BaseCons modifiers | not started | §10.4 | `src/star-system.ts` |
| Apply gravity effects to fuelPerMinute and gravityPenalty (avg origin/dest gravity) | not started | §10.4 | `src/ship.ts`, `src/balance-config.ts` |
| Ensure population model is fixed (no growth/decline unless optional system added) | not started | §10.6 | `src/local-server.ts`, `src/star-system.ts` |

### Presets & Tuning Data (Ratio Presets)

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Add starting ratio presets (shipbuilding-heavy, balanced, luxury-leaning) as pre-sizing hints | not started | §11 | `src/local-server.ts`, `src/balance-config.ts` |
| Add DB tables `ratio_presets` and `tuning_settings` (active_ratio_preset) | not started | §11.1 | `src/local-storage.ts` |
| Seed default presets and active preset if missing | not started | §11.1 | `src/local-storage.ts` |
| Load active ratio preset and apply during galaxy generation | not started | §11.1 | `src/local-server.ts` |

### Evolution, Tech, and Shocks

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Implement rolePressure from trade balance and roleShiftThreshold logic | not started | §10.1 | `src/star-system.ts` |
| Track roleShiftTicks and apply role changes | not started | §10.1 | `src/star-system.ts` |
| Implement facilityLevel evolution/decay over time | not started | §10.1 | `src/star-system.ts` |
| Implement techPoints from wealth and computers consumption | not started | §10.2 | `src/star-system.ts` |
| Apply techThreshold and maxTechByRole caps | not started | §10.2 | `src/star-system.ts`, `src/balance-config.ts` |
| Implement deterministic shocks from (systemSeed, tick): blight, mine collapse, accident, war spike, discovery | not started | §10.3 | `src/star-system.ts` |
| Enforce one shock at a time per system (no stacking) | not started | §10.3 | `src/star-system.ts` |

### Player

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Add player startCredits and startShipType config | not started | §1.2, §14 players | `src/balance-config.ts`, `src/local-server.ts` |
| Apply player bankruptcy rules (same as NPC) | not started | §1.2 | `src/ship.ts`, `src/local-server.ts` |
| Implement player facility upgrades (if enabled) | not started | §1.2, §5.1 | `src/local-server.ts`, `src/star-system.ts` |
| Implement player reputation (contracts/contraband) and tariff effects | not started | §1.2 | `src/local-server.ts`, `src/types.ts` |

### Simulation Cadence & Determinism

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Apply player actions by timestamp before system ticks | not started | §12.1 | `src/local-server.ts` |
| Ensure ship arrivals trade at latest system state | not started | §12.1 | `src/ship.ts`, `src/star-system.ts` |
| Ensure contracts update only on system ticks | not started | §12.1 | `src/star-system.ts` |
| Implement optional regional tick cadence for evolution/tech (e.g., every 5 min) | not started | §12 | `src/local-server.ts` |
| Enforce deterministic ordering for ship ticks (asc shipId) | not started | §12.1, §18 | `src/local-server.ts` |

### Metrics & Health

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Add stability metrics (zero inventory, NPC credits growth, price volatility, contract fulfillment ratio, regional autonomy, NPC diversity, regional balance) | not started | §13 | `src/logging.ts`, `src/local-server.ts` |
| Implement metrics response: log crisis and apply health multipliers (crisisMinMargin, crisisBonus, crisisMaxRange) | not started | §13.1 | `src/star-system.ts`, `src/balance-config.ts` |
| Store per-run metadata in `tuning_runs` | not started | §13.2, §13.3 | `src/local-storage.ts` |
| Persist metrics snapshots in `metrics_snapshots` (metrics_json) | not started | §13.3 | `src/local-storage.ts`, `src/logging.ts` |
| Add DB schema/migrations for tuning tables | not started | §13.3 | `src/local-storage.ts` |

### Balance Config & Persistence

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Define BalanceConfig schema per §14 (goods, treasury, pricing, contracts, bootstrap, npcArchetypes, npcLearning, npc, infoDecay, travelCost, trade, facility, evolution, techProgression, blackMarket, factions, players, ships, worldAttributes, bankruptcy, events, health, regions) | not started | §14 | `src/balance-config.ts`, `src/types.ts` |
| Map existing config to new schema defaults; fill missing per-good parameters | not started | §14 | `src/balance-config.ts` |
| Add validation for parameter interactions (min<=max, non-negative rates) | not started | §14 | `src/balance-config.ts` |
| Add feature flag to gate new pipeline | not started | §14 | `src/balance-config.ts`, `src/local-server.ts` |
| Add `balance_config` table and load/merge with defaults | not started | §14.1 | `src/local-storage.ts`, `src/balance-config.ts` |
| Seed defaults into DB on first run; allow DB overrides at runtime | not started | §14.1 | `src/local-storage.ts`, `src/local-server.ts` |
| Remove legacy config path once new pipeline is stable | not started | §14 | `src/balance-config.ts` |

### Scaling & Performance

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Cache market snapshots per system tick to avoid per-ship full scans | not started | §17 | `src/star-system.ts`, `src/ship.ts` |
| Keep tick complexity bounded; avoid per-ship per-good loops where possible | not started | §17 | `src/star-system.ts`, `src/ship.ts` |
| Batch ticks and stagger ship updates by region for large fleets (>1000 ships) | not started | §17 | `src/local-server.ts` |
| Compute regional metrics on slower cadence (e.g., every 10 system ticks) | not started | §17 | `src/local-server.ts` |

### Backlog (Optional Systems)

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Black market: lawLevel, seizure on entry (lawLevel*seizureFactor), riskTolerance, contraband rules; exclude contraband from contracts/hub info | not started | §8.3 | `src/ship.ts`, `src/star-system.ts` |
| Factions: system faction, tariffs/sanctions, reputation; tariff revenue to treasury; optional faction contracts | not started | §10.5 | `src/types.ts`, `src/local-server.ts`, `src/star-system.ts` |

### Testing

| Task | Status | Spec | Files |
|------|--------|------|-------|
| Determinism tests for system and ship ticks | not started | §15.1, §18 | `src/*.test.ts` |
| Production/consumption order tests (incl. input-limited production) | not started | §15.1 | `src/*.test.ts` |
| Pricing tests (alpha smoothing, min/max clamps, targetStock) | not started | §15.1 | `src/*.test.ts` |
| Treasury & settlement tests (partial fills, bonus affordability) | not started | §15.1 | `src/*.test.ts` |
| Contract tests (creation/expiry/priority/fulfillment) | not started | §15.1 | `src/*.test.ts` |
| NPC decision tests (info decay, risk penalty, min margin) | not started | §15.1 | `src/*.test.ts` |
| Fuel & travel cost tests (reservation, cargo weight) | not started | §15.1 | `src/*.test.ts` |
| Crisis/collapse tests (thresholds, timers, health multipliers) | not started | §15.1 | `src/*.test.ts` |
| Galaxy generation tests (needs-consistent, anchors, link constraints) | not started | §15.1 | `src/*.test.ts` |
| Metrics/tuning persistence tests | not started | §15.1, §13.3 | `src/*.test.ts` |

---

## Minimal Viable Rework Path (§16)

1. Dependency table and input-limited production (no new goods yet).
2. Contracts and NPC contract preference.
3. Regions plus local/regional/long-haul archetypes.
4. New goods (alloys, ship_parts, fertilizer) and shipyard role.

---

## Determinism (§18)

- All RNG: deterministic, seeded per system or ship. System: systemId + tick; ship: shipId + tick.
- Contract creation: deterministic from inventory and thresholds.
- NPC route choice: deterministic from observed prices and ship seed.

---

## Notes

- All tests: `npm test`. CI: `main`, `develop`, `master`.
- No `src/index.ts`; `src/local-server.ts` only.
- Tuning workflow: edit ratios/rates in DB, run multi-hour simulations with fixed seeds, compare stability metrics, record iteration results before changing again.
