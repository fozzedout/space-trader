# Space Trader Economy Bible (Expanded Goods & Supply Chain)

This document defines the core economic model for the Space Trader simulation. It is the authoritative specification for galaxy generation, market dynamics, NPC behavior, and goods dependencies. The goal is emergent complexity from simple, deterministic rules while preserving system isolation and canonical trading.

---

## 1) Core Goals and Invariants

- Deterministic: same seed + event stream = same outcomes.
- System isolation: no instant goods or price info transfer; only ships move goods and carry price info.
- Emergent complexity: simple local rules yield regional specialization and global flows.
- No "magic" stabilization: no global restocking or credit injection.
- Trade is logistics: it exists to satisfy production chains and population needs; arbitrage is secondary.
- Most NPCs stay local; a small fraction are long-haul traders.
- This document is the canonical spec and supersedes `ECONOMY_EXPECTATIONS.md`.
- `applySpaceElevator` (inventory/production correction toward target levels) is non-canonical and should be removed or disabled to match this spec.

## 1.1) Event Stream and Determinism

The "event stream" is the ordered list of:
- Player actions (trades, travel, contracts accepted).
- Admin commands (initialize, tick, reset).
- System ticks (market updates, contract updates).
- Ship ticks (movement and trading).
- Deterministic shocks (seeded events).

Determinism means processing these in a stable, explicit order. System ticks are processed in ascending `systemId`, and ship ticks in ascending `shipId`.

## 1.2) Player Interaction

Players participate as canonical ships:
- Player trades affect markets exactly like NPC trades.
- Players can accept and fulfill contracts; bonuses apply the same way.
- Player reputation is optional and can affect contract availability and tariffs.
- Reputation is stored per faction and changes based on completed contracts and contraband seizures.
- Player investments can upgrade `facilityLevel[g]` for a system by paying local costs.
- Player-triggered events (e.g., blockades, strikes) are optional and must be deterministic or admin-triggered.
- Market manipulation is allowed only through normal trading mechanics (no special exemptions).
- Players start with `players.startCredits` and a default ship type `players.startShipType`.
- Player bankruptcy follows the same rules as NPCs; respawn or reset is admin-controlled.
Player settings live in `BalanceConfig.players`.

## 1.3) Credit and Settlement

Base model uses system treasuries for settlement (no infinite liquidity):
- Each system has `systemTreasury` initialized to `treasury.startCreditsPerPop * pop + treasury.startCreditsBase`.
- Buying from ships reduces treasury; selling to ships increases treasury.
- Contract bonuses are paid from treasury after the market trade.
- If treasury is insufficient, the trade is partially filled up to available credits; bonus is prorated or zeroed.
- Treasury cannot drop below `treasury.minReserve`; affordability checks use `treasury - minReserve`.

Credit sources: initial system treasuries, NPC/player starting credits.
Credit sinks: operating costs, forced liquidation discount, tariffs (if configured as sink), and facility upgrades.
This makes the economy mildly deflationary unless replacement spawning or treasury injections are enabled.

Treasury settings live in `BalanceConfig.treasury`. If `treasury.enabled` is false, systems are infinitely liquid and the economy can inflate.

## 1.4) Cargo and Capacity

- Cargo capacity is measured in cargo units.
- Total used capacity is `sum(qty[g] * weight[g])`.
- A ship cannot exceed its capacity; any trade must keep used capacity <= `cargoCapacity`.

---

## 2) Goods List (Expanded)

Core goods are used in the production chain and market pricing. Optional black-market goods are explicitly marked.

**Core goods**
- food
- textiles
- metals (raw ore)
- alloys (processed metals)
- machinery
- electronics
- computers
- medicines
- luxuries
- weapons
- ship_parts (engines, hulls, assemblies)
- fertilizer
- fuel (ship travel and energy)

**Optional**
- narcotics (black-market, high volatility)

**Goods properties**
- `weight` is cargo units per 1 unit of good.
- `volatility` is used in price uncertainty and info-decay risk penalties.
- `ship_parts` are consumed by shipyards for construction/repair and exported for inter-regional demand.

**Tech gating**
```
Good         productionTech        consumptionTech
food         AGRICULTURAL          AGRICULTURAL
textiles     AGRICULTURAL          AGRICULTURAL
metals       MEDIEVAL              MEDIEVAL
alloys       EARLY_INDUSTRIAL      EARLY_INDUSTRIAL
machinery    EARLY_INDUSTRIAL      EARLY_INDUSTRIAL
electronics  POST_INDUSTRIAL       POST_INDUSTRIAL
computers    HI_TECH               HI_TECH
medicines    INDUSTRIAL            RENAISSANCE
luxuries     RENAISSANCE           RENAISSANCE
weapons      INDUSTRIAL            MEDIEVAL
ship_parts   HI_TECH               POST_INDUSTRIAL
fertilizer   EARLY_INDUSTRIAL      AGRICULTURAL
fuel         INDUSTRIAL            EARLY_INDUSTRIAL
narcotics    POST_INDUSTRIAL       POST_INDUSTRIAL
```
If `system.techLevel < productionTech`, then `BaseProd[g] = 0`. If `system.techLevel < consumptionTech`, then `BaseCons[g] = 0`.
Use `GoodBalance.productionTech` and `GoodBalance.consumptionTech` as the implementation source of truth.

---

## 3) Dependency Table (Inputs per 1 Unit Output)

All ratios are small integers or halves to keep the system readable and predictable.

```
Output        Inputs (per 1 unit)                 Notes
food          0.1 machinery + 0.2 fertilizer       Agri is input-sensitive but not fragile.
textiles      0.2 food + 0.1 machinery             Population + machines produce textiles.
metals        0.1 machinery + 0.1 food             Mining needs equipment and labor.
alloys        1 metals + 0.2 machinery             Refining step.
machinery     1 alloys + 0.5 electronics           Industrial output.
electronics   1 alloys + 0.5 machinery             High-tech components.
computers     1 electronics + 0.5 machinery        High-tech output.
medicines     0.2 food + 0.2 electronics           Pharma uses organics + devices.
luxuries      0.5 textiles + 0.2 food + 0.2 electronics
weapons       1 alloys + 0.5 electronics
ship_parts    2 alloys + 1 machinery + 1 electronics + 0.5 computers
fertilizer    0.5 food + 0.5 machinery             Industrial fertilizers.
fuel          0.5 metals + 0.2 machinery           Refined propellant and energy cells.
narcotics     0.2 food + 0.5 electronics           Optional, high value.
```

**Production rule:** If inputs are missing, output is limited by the scarcest input.
Inputs are consumed from `inventory[input_i]` in the production step. "Per 1 unit" means the listed amounts are removed from inventory to produce 1 unit of output.
`GoodBalance.inputs` must match this table; they are the implementation source for dependencies.

**Production order**
To keep determinism with cycles, goods are produced in a fixed order each tick:
1. metals
2. food
3. fertilizer
4. textiles
5. alloys
6. machinery
7. electronics
8. computers
9. medicines
10. luxuries
11. weapons
12. ship_parts
13. fuel
14. narcotics (if enabled)
This order is stable and should be used in every system tick.

**Fractional inputs**
When computing `maxByInputs[g]`, use the limiting input ratio with floating point math. Output is fractional; inventory changes are applied as floats. The system may round for display, but internal state uses floats.

**Fuel**
Fuel has local base consumption (industrial power and transport) and separate ship travel consumption in Section 8.

---

## 3.1) Bootstrap and Circular Dependencies

Circular dependencies (e.g., food requires fertilizer and fertilizer requires food) can stall if all inputs start at zero. To prevent deadlocks:
- Initialize each market with a small seed inventory: `seedInventory[g] = BaseCons[g] * bootstrapSeedTicks`.
- For first `bootstrapTicks`, allow a minimal "seed production" up to `bootstrapRate[g]` even if inputs are missing.
- After bootstrap, enforce input-limited production strictly.

Bootstrap settings are defined in `BalanceConfig.bootstrap`.
Bootstrap rule:
```
if bootstrapTicksRemaining > 0:
  Output[g] = min(BaseProd[g], max(inputLimitedOutput, bootstrapRate[g]))
else:
  Output[g] = inputLimitedOutput
```

---

## 4) World Roles and Specialization

World roles define production and consumption multipliers. Multipliers are simple scalars.

**World roles**
- agricultural: +3x food, +2x textiles; +1.5x food consumption; relies on fertilizer/machinery.
- mining: +3x metals; +1.5x machinery consumption; high food demand.
- industrial: +2.5x alloys, +2x machinery; +1.5x metals and food consumption.
- high_tech: +2.5x electronics, +2.5x computers; +1.5x alloys and machinery consumption.
- shipyard: +3x ship_parts and weapons; +2x alloys, machinery, electronics consumption.
- resort: +2.5x luxuries; +2x food/textiles/medicines consumption.
- trade_hub: +1.2x on all production/consumption; high market liquidity.

Each system has exactly one `worldType` role.

If a (world role, good) multiplier is omitted, default to 1.0 (neutral). A multiplier of 0.0 means no production for that good in that role.

**Trade hub liquidity**
- Higher market depth: `trade.tradeHubDepthMultiplier` (reduces price impact of large trades).
- Faster price convergence: `alpha` can be increased by `pricing.tradeHubAlphaBonus` for trade hubs.

---

## 5) Production and Consumption Formulas

Definitions:
- `pop`: population (millions)
- `tl`: tech level (1-7)
- `baseProd[g]`: base production rate per tick for good g (from `GoodBalance.baseProduction`)
- `baseCons[g]`: base consumption rate per tick for good g (from `GoodBalance.baseConsumption`)
- `roleProdMult[worldType][g]`, `roleConsMult[worldType][g]`: role multipliers
- `techMult`: `(tl + 1)`
- `facilityLevel[g]`: infrastructure multiplier (default 1.0, range 0.5-1.5)

`tl` is the numeric value of the `TechLevel` enum (AGRICULTURAL=1 through HI_TECH=7).

**Base production capacity**
```
BaseProd[g] = pop * techMult * baseProd[g] * roleProdMult[worldType][g] * facilityLevel[g]
```

**Base consumption**
```
BaseCons[g] = pop * techMult * baseCons[g] * roleConsMult[worldType][g]
```

**Input-limited production**
```
maxByInputs[g] = min_i( inventory[input_i] / inputQtyPerUnit[g][i] )
Output[g] = min(BaseProd[g], maxByInputs[g])
Consume inputs: inventory[input_i] -= Output[g] * inputQtyPerUnit[g][i]
Produce output: inventory[g] += Output[g]
```
Unused production capacity is idle. Partial production is allowed up to input constraints.

**Consumption**
```
inventory[g] -= min(BaseCons[g], inventory[g])
```
If demand exceeds inventory, unmet demand is lost (not backlogged) and is reflected via contract shortages.

**Inventory floors**
```
inventory[g] = max(0, inventory[g])
```

---

## 5.1) Facility Capacity Constraints

Production is also limited by infrastructure:
```
facilityLevel[g] = system.facilityLevel[g] (default 1.0, range 0.5-1.5)
```
Facility levels can be generated with the system and can evolve slowly over time (see World Evolution).
Use `facility.defaultLevel`, `facility.minLevel`, and `facility.maxLevel` as bounds.
Players can fund upgrades: increase `facilityLevel[g]` by `facilityUpgradeStep` at cost `facilityUpgradeCost` (optional).
`facilityLevel` is per-good; if not tracked per-good, use a system-wide value as a fallback.

---

## 6) Inventory Targets and Price Formation

**Target stock per good**
```
rawTargetStock[g] = (BaseCons[g] * stockDays) + (BaseProd[g] * bufferDays)
targetStock[g] = max(pricing.minTargetStock, rawTargetStock[g])
```
- `stockDays`: default 10-20 ticks (1 tick = `TICK_INTERVAL_MS`)
- `bufferDays`: default 5-10 ticks
- `basePrice[g]` comes from `GoodBalance.basePrice`.
If `rawTargetStock[g]` is 0 (no local production or consumption), treat the good as inactive:
- Price is fixed at `basePrice[g]`.
- No shortage/surplus contracts are created for that good.

**Storage capacity**
```
maxStock[g] = targetStock[g] * maxStockMult[g]
if inventory[g] > maxStock[g]:
  inventory[g] = maxStock[g]
```
`maxStockMult[g]` is sourced from `GoodBalance.maxStockMult`.
Excess inventory is discarded (represents spoilage, warehousing loss, or local dumping).
By default, system inventory acts as the local depot. Regional pooling is optional and not in the base model.
Persistent surplus with no buyers is handled by storage caps and falling prices; no additional disposal mechanics are required.

**Perishability**
```
inventory[g] *= (1 - spoilageRate[g]) // per tick
```
Defaults: food and medicines have non-zero `spoilageRate`; other goods default to 0.
`spoilageRate[g]` is sourced from `GoodBalance.spoilageRate`.
Spoilage is applied at the start of the system tick (see Section 12).
Perishability does not apply to cargo in transit in the base model.

**Price formation**
```
inventoryRatio = inventory[g] / targetStock[g]
targetPrice = basePrice[g] * (1 + priceElasticity[g] * (1 - inventoryRatio))
smoothedPrice = price[g] * (1 - alpha) + targetPrice * alpha
price[g] = clamp(smoothedPrice, basePrice[g] * minMult, basePrice[g] * maxMult)
```
- `alpha`: smoothing factor (0.1-0.2)
- `priceElasticity[g]`: higher for luxuries/rarities, lower for staples
- `minMult`/`maxMult`: 0.5 and 2.5 for stability
At initialization, `price[g] = basePrice[g]` before the first system tick.

---

## 7) Contracts (Local Demand and Supply Signals)

Contracts are local and deterministic. They are the only explicit coordination mechanism.

**Shortage trigger**
```
shortageRatio = max(0, (targetStock[g] - inventory[g]) / targetStock[g])
if shortageRatio > shortageThreshold:
  create buy contract for shortage units
```
`shortage units = max(0, targetStock[g] - inventory[g])`.
Contract units are capped by `maxUnitsPerContract`.

**Surplus trigger**
```
surplusRatio = max(0, (inventory[g] - targetStock[g]) / targetStock[g])
if surplusRatio > surplusThreshold:
  create sell contract for surplus units
```
`surplus units = max(0, inventory[g] - targetStock[g])`.
Contract units are capped by `maxUnitsPerContract`.

**Contract bonus**
```
bonusPerUnit = basePrice[g] * bonusFactor * shortageRatio
```

**Contract lifecycle**
- Each system can maintain at most one active buy and one active sell contract per good.
- Total active contracts per good are capped by `maxContractsPerGood` (default 2), meaning at most one buy and one sell.
- Contracts have `contractTtlTicks`; when expired, they are removed.
- Fulfillment reduces `remainingUnits`; when it reaches 0, the contract is removed.
- If inventory recovers above the trigger threshold before expiration, the contract is canceled (shortageRatio <= shortageThreshold for buys, surplusRatio <= surplusThreshold for sells).
No goods or credits are reserved for a contract; expiration has no penalty beyond losing the bonus.

**Arbitrage protection**
- Contracts are system-owned and only created on system ticks.
- Bonus is paid only once per unit delivered from a different system (`originSystemId != systemId`).
- A ship cannot fulfill the same contract with goods bought in the same system on the same tick.

**Bonus mechanics**
- Buy contracts: fulfilling ship receives `bonusPerUnit` on top of the market sell price.
- Sell contracts: fulfilling ship receives `bonusPerUnit` on top of the market buy price.
- `preferContracts` allows an archetype to treat `bonusPerUnit` as a margin boost when evaluating routes.

Contracts do not move goods or credits until fulfilled. They simply create reliable margins that guide NPCs.

---

## 7.1) Contract Prioritization and Fulfillment

- If multiple contracts for the same good exist, choose the highest bonus, then earliest expiration.
- A ship may track at most one active contract target at a time.
- If a ship holds multiple fulfillable contracts (edge case), it completes the one with the earliest expiration first.

## 7.2) Contract Fulfillment Mechanics

- Fulfilling a contract uses the same market price and bulk/depth logic as a normal trade.
- A ship may fulfill a contract and execute one additional market trade in the same tick (contract first, then optional market trade).
- Buy contract fulfillment: ship sells goods to the system at effective sell price, then receives `bonusPerUnit`.
- Sell contract fulfillment: ship buys goods from the system at effective buy price, then receives `bonusPerUnit` (net discount).
- If multiple ships fulfill the same contract in a tick, processing order is ascending `shipId`; later ships may receive partial fulfillment.

## 8) NPC Behavior and Information Flow

**NPC archetypes**
- Local trader (70-80%): trades within system or immediate neighbors; low margin threshold.
- Regional trader (15-25%): trades within region; prioritizes contracts.
- Long-haul trader (2-5%): crosses regions only for high margins or shipyard contracts.

**Profit model**
```
netMargin = sellPrice - buyPrice - travelCostPerUnit
travelCostPerUnit = (operatingCostPerMinute * travelMinutes) / cargoUnits
```
`operatingCostPerMinute` is a credit cost; fuel is a separate physical cost.
`operatingCostPerMinute` is a pure credit sink (removed from the economy).

**Decision rule**
```
if netMargin + contractBonus >= minMargin[archetype]:
  trade
else:
  wait or seek contract
```
If `preferContracts` is true, apply `contractMarginBoost` to `contractBonus` when a contract exists.
Effective margin formula: `netMargin + contractBonus + (preferContracts ? contractMarginBoost : 0)`.

**Information**
- Ships carry observed prices and timestamps.
- No global price network; info decays by age.
- Price observations are updated on arrival and on completed trades.
- Trade hubs aggregate local info into a bulletin:
  - Bulletin price is an exponential moving average of observed prices from visiting ships.
  - When a ship is at a trade hub, it uses `hubPrice = trade.tradeHubInfoWeight * bulletinPrice + (1 - trade.tradeHubInfoWeight) * localMarketPrice`.
  - Bulletin values decay using the same `infoHalfLifeMinutes`.

**Information decay formula**
```
confidence = exp(-ageMinutes / infoHalfLifeMinutes)
riskPenalty = (1 - confidence) * volatility * infoRiskMultiplier * basePrice
effectiveSellPrice = observedSellPrice * confidence - riskPenalty
effectiveBuyPrice = observedBuyPrice * confidence + (1 - confidence) * basePrice + riskPenalty
```
Routes with low confidence are penalized via lower effective margin.

**NPC learning and adaptation**
- Each ship tracks the last N trades and their realized profit.
- Route choices are weighted by `routeScore = avgProfitPerMinute` with an `epsilon` exploration rate.
- Periodically decay route scores to allow adaptation to new market conditions.
- Exploration uses deterministic RNG seeded by ship seed and tick.
Route tracking details:
- Route key: `(originSystemId, destinationSystemId, goodId, action)`.
- Stored fields: average profit per minute, success rate, average travel time, and lastUpdatedTick.
Decay and update:
- On each ship tick: `routeScore *= routeScoreDecay`.
- On route completion: `routeScore = (1 - alpha) * routeScore + alpha * profitPerMinute`, with `alpha = 1 / routeMemorySize`.
- `profitPerMinute` uses net profit after operating costs and fuel costs.

**Fleet coordination**
- Contracts above `multiShipThresholdUnits` are splittable into multiple sub-deliveries.
- NPCs can join the same contract until `remainingUnits` is exhausted.

**Fuel and travel**
- Ships consume `fuel` per travel minute: `fuelUsed = fuelPerMinute * travelMinutes`.
- A ship must have sufficient fuel in cargo to begin travel; fuel is consumed on departure.
- Fuel occupies cargo space and competes with trade goods.
Fuel is stored in system markets like any other good; ships carry it as cargo.
Fuel is reserved at departure; ships do not deplete fuel mid-route.
If a ship cannot acquire fuel for any reachable destination, it waits; after `bankruptGraceTicks` with no valid move it is retired.
Emergency fuel or towing is not modeled in the base system.

`travelMinutes = jumps * minutesPerJump` (or distance-based if using continuous space).

---

## 8.1) Trade Mechanics Extensions

**Bulk discounts / market depth**
```
marketDepth = trade.marketDepthBase * (isTradeHub ? trade.tradeHubDepthMultiplier : 1.0)
bulkFactor = isBuy ? bulkDiscountBuyFactor : bulkDiscountSellFactor
discount = bulkFactor * log1p(qty / marketDepth)
effectivePrice = price * max(0.6, 1 - discount)
```
Large trades pay a discount (buys) or receive a haircut (sells). `marketDepth` is higher in trade hubs.

**Total trade cost**
- Buy: `totalCost = effectivePrice * qty` using `bulkDiscountBuyFactor`.
- Sell: `totalRevenue = effectivePrice * qty` using `bulkDiscountSellFactor`.
Bulk pricing is applied to the whole trade (not marginal per unit).

**Futures and short-selling (optional, not in base model)**
- If added later, futures settle at the current spot price on expiry.
- Short-selling requires collateral and can be liquidated if the margin falls below a threshold.

---

## 8.2) Risk and Failure

**NPC bankruptcy**
- If a ship cannot pay for fuel or a trade, it must sell cargo immediately at market price.
- Forced liquidation uses the pre-trade market price (including bulk effects) and applies `forcedLiquidationDiscount`.
- The liquidation discount is a credit sink (lost value).
- If credits remain <= 0 for `bankruptGraceTicks`, the ship is retired from the simulation.
- Replacement ships, if enabled, draw start credits from system treasury (no new credits are injected).

**Supply chain collapse detection**
- Track critical shortages: `inventory[g] < health.criticalRatio * targetStock[g]`.
- If a region has critical shortages for >= `health.collapseTicks`, flag a "regional crisis" event (logging only).
In crisis, enable a temporary "recovery mode" (no goods or credits are injected):
- `minMargin *= health.crisisMinMarginMultiplier` for local and regional archetypes.
- `contracts.bonusFactor *= health.crisisBonusMultiplier` in the affected region.
- `maxRange += health.crisisMaxRangeBonus` for all archetypes in the affected region.
- Duration: `health.crisisDurationTicks`, followed by a `health.crisisCooldownTicks` period where normal rules apply.
- Rollback: restore baseline values after the duration; do not stack crises during cooldown.

---

## 8.3) Black Market Rules (Optional)

- Narcotics are excluded from contracts and trade hub aggregation.
- Each system has `lawLevel` (0-1). On entry, narcotics cargo can be seized with probability `lawLevel * seizureFactor`.
- NPCs have `riskTolerance` (sampled from `riskToleranceRange`); only those above `riskThreshold` will trade narcotics.
- Use `GoodBalance.isContraband` to flag contraband goods.
Black market settings are defined in `BalanceConfig.blackMarket`.
Seizure destroys goods, applies no refund, and reduces faction reputation.
Contraband is extensible: weapons (or other goods) can be flagged `isContraband` in high-law systems if desired.

---

## 8.4) Ship Configuration

Ships have a type that defines capacity and operating profile.

**Ship type properties**
- `cargoMin` / `cargoMax`: cargo capacity range (in cargo units).
- `speedMultiplier`: multiplies `minutesPerJump`.
- `fuelMultiplier`: multiplies `fuelPerMinute`.
- `operatingCostMultiplier`: multiplies `operatingCostPerMinute`.

**Capacity selection**
```
cargoCapacity = lerp(cargoMin, cargoMax, rng())
```
Each ship draws a deterministic capacity within its type range.
Capacity draws use the ship RNG seed for determinism.

**Archetype to type mapping**
- local: courier/trader
- regional: trader/hauler
- longHaul: hauler/freighter

Ship type settings live in `BalanceConfig.ships`.

---

## 8.5) NPC Fleet Management

- Initial NPC credits are drawn from `npc.startCreditsRange` around `npc.startCredits`.
- Initial NPC count is `npc.perSystem * S + npc.perMillionPop * totalPopulation`, capped by `npc.maxTotal`.
- NPCs spawn at trade hubs or their home system, with empty cargo and a ship type per archetype weights.
- Home system is assigned deterministically within the ship's region; `npc.homeTradeHubShare` controls the share that spawn at trade hubs.
- Replacement ships are disabled by default; if `npc.replacementEnabled` is true, spawn replacements every `npc.replacementIntervalTicks` at trade hubs.
- Replacement ships draw start credits from the destination system treasury; if insufficient, the replacement is skipped.
- NPC lifecycle: active -> bankrupt grace -> retired; no implicit credit injection.
NPC fleet settings live in `BalanceConfig.npc`.
Ship construction and repair are abstracted; if `ships.requirePartsForSpawn` is true, NPC and player spawns consume `ships.spawnPartsCost` from the local market and are blocked if inventory is insufficient, otherwise spawning does not consume ship_parts.
Damage/repair mechanics are out of scope for the base model.

---

## 9) Regions and System Clustering

**Region definition**
- Each region has 4-10 systems.
- One or two anchor systems: trade hub and/or shipyard.
- Regions are semi-self-sufficient but export specialties.
- Regions are formed as connected clusters in the system graph (spatial clustering or jump links).

**Regional specialization examples**
- Agri region: food/textiles exports, imports machinery/electronics.
- Mining region: metals/alloys exports, imports food/machinery.
- Industrial region: machinery/alloys exports, imports metals/food.
- High-tech/shipyard region: ship_parts/weapons exports, imports alloys/machinery/food.

---

## 10) Galaxy Generation Algorithm (Needs-Consistent)

Input parameters:
- Total systems `S`
- Regions `R`
- Total population `P`
- Desired ship_parts output per region `shipPartsTarget` (units per tick)
- Base production rates per world type

**Region graph and connectivity**
- Generate system positions deterministically from the galaxy seed.
- Create jump links using a minimum spanning tree (MST) to guarantee connectivity.
- Add extra edges by connecting each system to its `k` nearest neighbors until `minLinksPerSystem` is met.
- Enforce `maxLinksPerSystem` by pruning the longest edges if needed.
- Partition the connected graph into regions using spatial clustering (e.g., k-means over positions) and then fix any disconnected region by swapping border nodes.
Connectivity settings are defined in `BalanceConfig.regions` (`minLinksPerSystem`, `maxLinksPerSystem`, `nearestNeighborCount`).

**Step 1: Create regions**
- Partition systems into R regions.
- Assign each region a role bias using `roleBiasWeights` as a weighted distribution.
  - Within a region, assign roles to systems by sampling the bias and ensuring connectivity and minimum role coverage.
- Anchor assignment: ensure at least one `trade_hub` and one `shipyard` per region (for very small regions, allow a single anchor that is a trade_hub and a shipyard if roles are merged).

**Step 2: Assign populations**
- Distribute population by role: shipyard/high-tech slightly higher, mining lower.
- Ensure each region has minimum population for stability (e.g. `minRegionPop = totalPop / R * 0.7`).

**Step 3: Compute required outputs**
For each region:
```
requiredFood = sum(pop * baseCons[food] * roleConsMult)
requiredMetals = inputs for alloys + machinery + weapons + ship_parts
requiredAlloys = inputs for machinery + electronics + weapons + ship_parts
requiredShipParts = shipPartsTarget
```

**Step 4: Derive world counts**
For each world type:
```
worldCount[type] = ceil(requiredOutput[primaryGood] / perWorldOutput[type][primaryGood])
```
Where:
- `primaryGood` mapping: agricultural->food, mining->metals, industrial->machinery, high_tech->electronics, shipyard->ship_parts.
- `perWorldOutput[type][good]` is computed from a representative population for that role using `BaseProd[g]` and role multipliers.

**Step 5: Validate and balance**
- Ensure food coverage >= 1.1x demand (small surplus).
- Ensure each input chain is satisfied with small surplus.
- If deficits exist, reassign existing systems to the missing role (do not create new systems unless `S` is allowed to grow).

**Sizing pass failure policy**
- If deficits remain after reassignments, reduce `shipPartsTarget` by `shipPartsTargetStep` until feasible.
- If still infeasible and `allowSystemGrowth` is true, add systems and re-run the sizing pass.
- If still infeasible and system growth is disabled, log a "generation deficit" and proceed with unmet demand.
Limit reductions to `maxTargetReductions` to avoid unbounded iteration.

This pass guarantees the generated galaxy is consistent with its own needs.

---

## 10.1) World Evolution

World roles can evolve based on sustained economic signals:
- Track `rolePressure[type]` from long-term import dependence and export surplus.
- If `rolePressure` stays above `roleShiftThreshold` for `roleShiftTicks`, update `worldType`.
- When a world shifts roles, gradually adjust `facilityLevel[g]` toward the new role's strengths.
Facility changes are bounded by `facility.minLevel`/`facility.maxLevel` and use `facility.evolutionRate`.

`rolePressure` can be computed from the rolling trade balance by good (imports vs exports) over a fixed window.
Evolution settings live in `BalanceConfig.evolution`.
Facility evolution rule:
- For goods where `role.productionMult[g] >= 1.5`, move `facilityLevel[g]` toward `facility.roleTargetLevel` by `facility.evolutionRate`.
- For other goods, decay toward `facility.defaultLevel` by `facility.decayRate`.

Role pressure suggestion:
```
netValue[g] = exportsValue[g] - importsValue[g] (rolling window)
rolePressure[type] = sum(netValue[g] for role goods) / (pop * basePriceScale)
```
Role goods are those with `role.productionMult[g] >= 1.5`.

---

## 10.2) Tech Level Progression

Tech progression is slow and deterministic:
```
techPoints += (avgWealthPerCapita * wealthFactor) + (consumption[computers] * compFactor)
if techPoints >= techThreshold: techLevel += 1, techPoints = 0
```
Tech level is capped at HI_TECH and cannot exceed role-based caps unless explicitly allowed.

Definitions:
- `avgWealthPerCapita` can be computed as `(inventoryValueAtBasePrice / pop)` averaged over a window.
- `consumption[computers]` is the per-tick consumption averaged over the same window.

Tech progression settings live in `BalanceConfig.techProgression`.
Role caps are defined in `techProgression.maxTechByRole`.

---

## 10.3) Economic Shocks

Deterministic shocks are derived from system seed and tick count:
- Crop blight: -30% food production for N ticks.
- Mine collapse: -40% metals production for N ticks.
- Industrial accident: -25% machinery/alloys for N ticks.
- War demand spike: +50% weapons consumption for N ticks.
- New discovery: +20% metals or electronics production for N ticks.

Shocks change role multipliers temporarily and are logged as events.
Use `events.shockChancePerTick`, `events.durationRangeTicks`, and `events.severityRange` for tuning.
Shocks are per-system and apply a temporary multiplier for the affected good(s) only.
Events are visible to players via the API; NPCs only observe them indirectly through prices unless stationed in the affected system.
Shock type selection is deterministic from `(systemSeed, tick)`; only one shock is active per system at a time (no stacking).

---

## 10.4) World Attributes and Habitation

Each system has static attributes that affect production and consumption:
- `resourceRichness` (0.5-1.5): multiplies primary output for mining/industrial.
- `gravity` (0.7-1.3): increases fuel usage and reduces production efficiency.
- `atmosphere` (0.8-1.2): affects agriculture and habitation quality.
- `habitationQuality` (0.6-1.4): increases labor efficiency and consumption of luxuries/medicines.

Example:
```
BaseProd[g] *= resourceRichness * habitationQuality * gravityPenalty
fuelPerMinute *= gravity
```
Ranges are defined in `worldAttributes` in the balance config.

Suggested formulas:
```
gravityPenalty = 1 / gravity
BaseProd[food] *= atmosphere
```
If an attribute is not used, it should default to 1.0.
For travel, use `effectiveGravity = (gravity_origin + gravity_dest) / 2` when computing fuel usage.

---

## 10.5) Factions and Trade Sanctions (Optional)

- Systems belong to factions; NPC ships have a home faction.
- Faction relations affect tariffs and contract availability.
- Sanctions can block trade of specific goods or entire routes.
- Tariffs apply as a percentage added to buy price or subtracted from sell price.
- Tariff revenue is credited to the system treasury (or faction treasury if a faction economy is implemented).
- Each player has a faction reputation score that modifies access to contracts and tariffs.
- Factions can offer faction-specific contracts (e.g., military goods).
- Faction settings live in `BalanceConfig.factions` (or are reserved if not implemented).
Factions are static unless a future political simulation is added.

---

## 10.6) Population (Base Model)

Population is fixed in the base model. Growth/decline can be added later as an optional subsystem.

---

## 11) Suggested Starting Ratios (Pre-Sizing)

These are initial proportions before the sizing pass corrects them.

- Shipbuilding-heavy: 4 agri : 3 mining : 2 industrial : 1 high-tech : 1 shipyard
- Balanced: 4 agri : 3 mining : 3 industrial : 2 high-tech : 1 shipyard
- Luxury-leaning: add 1 resort per region and raise food output multipliers

These ratios are counts per 11 worlds in a region before the sizing pass adjusts them.
Add 1 trade_hub anchor per region in all presets (in addition to the ratio).

## 11.1) Ratio Preset Storage (Tuning)

Starting ratios are not assumed stable. Presets must be stored in the database (not hard-coded) so they can be edited between long-running experiments.
- Store named presets with a `lastUpdated` timestamp for auditability.
- Galaxy generation loads the active preset from DB; if missing, seed the DB with the defaults from this section.

DB schema (SQLite):
```
ratio_presets (
  name TEXT PRIMARY KEY,
  ratios_json TEXT NOT NULL, -- worldType -> count
  last_updated INTEGER NOT NULL,
  notes TEXT
);

tuning_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL -- active_ratio_preset stored here
);
```

---

## 12) Simulation Cadence

- System tick: 30s (`TICK_INTERVAL_MS = 30000`)
  - Production, consumption, inventory update, price update, contract update.
- Ship tick: 10-15s
  - Trading decisions, travel progress, contract fulfillment.
- Optional regional tick: 5 min
  - Recompute regional demand summaries (no direct interventions). Use only if world evolution or tech progression depends on regional stats.

## 12.1) Tick and Event Order

Within a simulation round:
1. Apply queued admin commands (initialize, reset, manual ticks).
2. Apply queued player actions in timestamp order (trades, travel, contract accept).
3. Run due system ticks in ascending `systemId`.
4. Run due ship ticks in ascending `shipId`.

Ship ticks can occur multiple times between system ticks; ships always observe the latest completed system tick state.

**Order of operations (system tick)**
1. Apply spoilage for perishable goods.
2. Compute `BaseProd[g]` and `BaseCons[g]` (tech gating, role multipliers, facilityLevel).
3. Input-limited production: consume inputs, add outputs.
4. Apply consumption using post-production inventory (subtract from inventory, no backlog).
5. Apply inventory floor and storage cap.
6. Update prices using target stock and smoothing.
7. Update contracts (create/cancel/expire).

System ticks are processed in ascending `systemId` to maintain deterministic cross-region ordering.

**Ship tick vs system tick**
- Ship travel can progress between system ticks.
- If a ship arrives between system ticks, it trades at the most recent market state.
- Contracts only change on system ticks; ships can fulfill contracts at any time.

---

## 13) Stability and Tuning Metrics

**Definitions**
- Zero inventory events per 30 min: count of `(system, good, tick)` where `inventory[g] <= 0`, per 30 min window.
- Avg NPC credits growth: `(avgCreditsEnd - avgCreditsStart) / avgCreditsStart` over 30 min.
- Price volatility: standard deviation of price over a 30 min window, divided by mean.
- Contract fulfillment ratio: contracts fulfilled within 2 system ticks / contracts created in the same window.
- Regional autonomy: `1 - (imports / (imports + localProduction))` by value per region.
- NPC diversity: entropy of trade routes per 30 min window: `-sum(p_ij * log(p_ij))` where `p_ij` is share of trips from i to j.
- Regional balance: absolute import/export value gap per region; target is near zero.
Use `value = basePrice * qty` unless stated otherwise.

---

## 13.1) Metrics Response (Non-Magical)

This spec does not inject goods or credits. When metrics exceed thresholds:
- Log a regional crisis event.
- Temporarily relax NPC constraints using `health.*` crisis multipliers.
- Increase contract bonuses within the affected region using `health.crisisBonusMultiplier`.
- Flag the region for admin review or offline tuning.

These responses are policy changes, not direct market injections.
Thresholds can be derived from `health` and `contracts` settings.

## 13.2) Tuning Workflow (Iterative)

Because ratios and rates are expected to change over multiple iterations:
- Edit ratios/rates in the database between runs (DB is the source of truth for tuning).
- Use fixed seeds for comparability and run multi-hour simulations per iteration.
- Record metrics snapshots and run metadata (seed, active ratio preset, configVersion or timestamp) in the DB for each iteration before making the next change.

## 13.3) Tuning Data Persistence (DB)

Store iteration metadata and metrics snapshots in SQLite to support repeatable experiments.

DB schema (SQLite):
```
tuning_runs (
  run_id TEXT PRIMARY KEY,
  seed INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  active_ratio_preset TEXT NOT NULL,
  balance_config_version TEXT,
  notes TEXT
);

metrics_snapshots (
  run_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  metrics_json TEXT NOT NULL, -- fields from §13
  PRIMARY KEY (run_id, tick)
);
```

---

## 14) Balance Configuration Schema (Concrete)

This section defines a concrete `balance-config` schema with explicit dependencies and starting values. It is intended as the single source of truth for tunable economy constants.
Balance rates (production/consumption, pricing elasticity, thresholds, NPC costs, etc.) are expected to evolve; store `BalanceConfig` in the database for long-running tuning.
- On first run, seed the DB with the defaults below; after that, DB values override code defaults.
- Track a `lastUpdated` timestamp (and optional `configVersion` or run snapshot key) for audit and comparison.

## 14.1) BalanceConfig Persistence (DB)

Store BalanceConfig in SQLite as a single-row JSON payload and metadata.
DB schema (SQLite):
```
balance_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  config_version TEXT,
  last_updated INTEGER NOT NULL
);
```

**Type shape (TypeScript)**
```ts
type GoodInput = { goodId: GoodId; qty: number };

type GoodBalance = {
  basePrice: number;
  weight: number;
  volatility: number;
  productionTech: TechLevel;
  consumptionTech: TechLevel;
  baseProduction: number; // units per tick per pop * techMult
  baseConsumption: number; // units per tick per pop * techMult
  priceElasticity: number;
  minPriceMult: number;
  maxPriceMult: number;
  maxStockMult: number;
  spoilageRate: number;
  inputs?: GoodInput[];
  isContraband?: boolean;
};

type RoleMultipliers = {
  productionMult: Record<GoodId, number>;
  consumptionMult: Record<GoodId, number>;
};

type NpcArchetype = {
  share: number; // fraction of NPCs (sum to 1.0)
  minMargin: number;
  maxRange: number; // max jumps or distance units
  preferContracts: boolean;
};

type BalanceConfig = {
  goods: Record<GoodId, GoodBalance>;
  worldRoles: Record<WorldType, RoleMultipliers>;
  treasury: {
    enabled: boolean;
    startCreditsPerPop: number;
    startCreditsBase: number;
    minReserve: number;
  };
  pricing: {
    alpha: number;
    stockDays: number;
    bufferDays: number;
    tradeHubAlphaBonus: number;
    minTargetStock: number;
  };
  contracts: {
    shortageThreshold: number;
    surplusThreshold: number;
    bonusFactor: number;
    contractTtlTicks: number;
    maxContractsPerGood: number;
    maxUnitsPerContract: number;
    multiShipThresholdUnits: number;
  };
  bootstrap: {
    bootstrapTicks: number;
    bootstrapSeedTicks: number;
    bootstrapRate: Record<GoodId, number>;
  };
  npcArchetypes: {
    local: NpcArchetype;
    regional: NpcArchetype;
    longHaul: NpcArchetype;
  };
  npcLearning: {
    routeMemorySize: number;
    epsilonExplore: number;
    routeScoreDecay: number;
    contractMarginBoost: number;
  };
  npc: {
    startCredits: number;
    startCreditsRange: [number, number];
    perSystem: number;
    perMillionPop: number;
    replacementEnabled: boolean;
    replacementIntervalTicks: number;
    maxTotal: number;
    homeTradeHubShare: number;
  };
  infoDecay: {
    infoHalfLifeMinutes: number;
    infoRiskMultiplier: number;
  };
  travelCost: {
    operatingCostPerMinute: number;
    minutesPerJump: number;
    fuelPerMinute: number;
    fuelGoodId: GoodId;
  };
  trade: {
    bulkDiscountBuyFactor: number;
    bulkDiscountSellFactor: number;
    marketDepthBase: number;
    tradeHubDepthMultiplier: number;
    tradeHubInfoWeight: number;
  };
  facility: {
    defaultLevel: number;
    minLevel: number;
    maxLevel: number;
    evolutionRate: number;
    roleTargetLevel: number;
    decayRate: number;
  };
  evolution: {
    roleShiftThreshold: number;
    roleShiftTicks: number;
    rolePressureWindowTicks: number;
  };
  techProgression: {
    wealthFactor: number;
    compFactor: number;
    techThreshold: number;
    windowTicks: number;
    maxTechByRole: Record<WorldType, TechLevel>;
  };
  blackMarket: {
    lawLevelRange: [number, number];
    seizureFactor: number;
    riskThreshold: number;
    riskToleranceRange: [number, number];
    reputationPenalty: number;
  };
  factions: {
    enabled: boolean;
    baseTariffRate: number;
    relationRange: [number, number];
    sanctionThreshold: number;
  };
  players: {
    allowContracts: boolean;
    facilityUpgradeCost: number;
    facilityUpgradeStep: number;
    startCredits: number;
    startShipType: string;
    bankruptcyEnabled: boolean;
  };
  ships: {
    types: Record<string, {
      cargoMin: number;
      cargoMax: number;
      speedMultiplier: number;
      fuelMultiplier: number;
      operatingCostMultiplier: number;
    }>;
    archetypeWeights: Record<string, Record<string, number>>;
    requirePartsForSpawn: boolean;
    spawnPartsCost: { goodId: GoodId; qty: number };
  };
  worldAttributes: {
    resourceRichnessRange: [number, number];
    gravityRange: [number, number];
    atmosphereRange: [number, number];
    habitationQualityRange: [number, number];
  };
  bankruptcy: {
    bankruptGraceTicks: number;
    forcedLiquidationDiscount: number;
  };
  events: {
    shockChancePerTick: number;
    durationRangeTicks: [number, number];
    severityRange: [number, number];
  };
  health: {
    criticalRatio: number;
    collapseTicks: number;
    crisisMinMarginMultiplier: number;
    crisisBonusMultiplier: number;
    crisisMaxRangeBonus: number;
    crisisDurationTicks: number;
    crisisCooldownTicks: number;
  };
  regions: {
    minSystems: number;
    maxSystems: number;
    shipPartsTarget: number;
    shipPartsTargetStep: number;
    maxTargetReductions: number;
    allowSystemGrowth: boolean;
    minLinksPerSystem: number;
    maxLinksPerSystem: number;
    nearestNeighborCount: number;
    roleBiasWeights: Record<WorldType, number>;
  };
};
```

**Concrete starting values**
```ts
export const BALANCE_CONFIG: BalanceConfig = {
  goods: {
    food: {
      basePrice: 10,
      weight: 1,
      volatility: 0.1,
      productionTech: TechLevel.AGRICULTURAL,
      consumptionTech: TechLevel.AGRICULTURAL,
      baseProduction: 0.018,
      baseConsumption: 0.016,
      priceElasticity: 0.1,
      minPriceMult: 0.6,
      maxPriceMult: 2.0,
      maxStockMult: 3.0,
      spoilageRate: 0.01,
      inputs: [{ goodId: "machinery", qty: 0.1 }, { goodId: "fertilizer", qty: 0.2 }],
    },
    textiles: {
      basePrice: 20,
      weight: 1,
      volatility: 0.15,
      productionTech: TechLevel.AGRICULTURAL,
      consumptionTech: TechLevel.AGRICULTURAL,
      baseProduction: 0.006,
      baseConsumption: 0.004,
      priceElasticity: 0.12,
      minPriceMult: 0.6,
      maxPriceMult: 2.2,
      maxStockMult: 2.5,
      spoilageRate: 0.0,
      inputs: [{ goodId: "food", qty: 0.2 }, { goodId: "machinery", qty: 0.1 }],
    },
    metals: {
      basePrice: 50,
      weight: 2,
      volatility: 0.2,
      productionTech: TechLevel.MEDIEVAL,
      consumptionTech: TechLevel.MEDIEVAL,
      baseProduction: 0.008,
      baseConsumption: 0.006,
      priceElasticity: 0.12,
      minPriceMult: 0.6,
      maxPriceMult: 2.2,
      maxStockMult: 2.5,
      spoilageRate: 0.0,
      inputs: [{ goodId: "machinery", qty: 0.1 }, { goodId: "food", qty: 0.1 }],
    },
    alloys: {
      basePrice: 80,
      weight: 2,
      volatility: 0.2,
      productionTech: TechLevel.EARLY_INDUSTRIAL,
      consumptionTech: TechLevel.EARLY_INDUSTRIAL,
      baseProduction: 0.004,
      baseConsumption: 0.003,
      priceElasticity: 0.14,
      minPriceMult: 0.6,
      maxPriceMult: 2.3,
      maxStockMult: 2.2,
      spoilageRate: 0.0,
      inputs: [{ goodId: "metals", qty: 1.0 }, { goodId: "machinery", qty: 0.2 }],
    },
    machinery: {
      basePrice: 220,
      weight: 5,
      volatility: 0.25,
      productionTech: TechLevel.EARLY_INDUSTRIAL,
      consumptionTech: TechLevel.EARLY_INDUSTRIAL,
      baseProduction: 0.0025,
      baseConsumption: 0.002,
      priceElasticity: 0.16,
      minPriceMult: 0.5,
      maxPriceMult: 2.5,
      maxStockMult: 2.0,
      spoilageRate: 0.0,
      inputs: [{ goodId: "alloys", qty: 1.0 }, { goodId: "electronics", qty: 0.5 }],
    },
    electronics: {
      basePrice: 500,
      weight: 2,
      volatility: 0.3,
      productionTech: TechLevel.POST_INDUSTRIAL,
      consumptionTech: TechLevel.POST_INDUSTRIAL,
      baseProduction: 0.0018,
      baseConsumption: 0.0015,
      priceElasticity: 0.18,
      minPriceMult: 0.5,
      maxPriceMult: 2.6,
      maxStockMult: 2.0,
      spoilageRate: 0.0,
      inputs: [{ goodId: "alloys", qty: 1.0 }, { goodId: "machinery", qty: 0.5 }],
    },
    computers: {
      basePrice: 1000,
      weight: 1,
      volatility: 0.35,
      productionTech: TechLevel.HI_TECH,
      consumptionTech: TechLevel.HI_TECH,
      baseProduction: 0.0012,
      baseConsumption: 0.001,
      priceElasticity: 0.2,
      minPriceMult: 0.5,
      maxPriceMult: 2.8,
      maxStockMult: 1.8,
      spoilageRate: 0.0,
      inputs: [{ goodId: "electronics", qty: 1.0 }, { goodId: "machinery", qty: 0.5 }],
    },
    medicines: {
      basePrice: 30,
      weight: 1,
      volatility: 0.2,
      productionTech: TechLevel.INDUSTRIAL,
      consumptionTech: TechLevel.RENAISSANCE,
      baseProduction: 0.003,
      baseConsumption: 0.003,
      priceElasticity: 0.12,
      minPriceMult: 0.6,
      maxPriceMult: 2.2,
      maxStockMult: 2.5,
      spoilageRate: 0.005,
      inputs: [{ goodId: "food", qty: 0.2 }, { goodId: "electronics", qty: 0.2 }],
    },
    luxuries: {
      basePrice: 300,
      weight: 1,
      volatility: 0.4,
      productionTech: TechLevel.RENAISSANCE,
      consumptionTech: TechLevel.RENAISSANCE,
      baseProduction: 0.0015,
      baseConsumption: 0.0012,
      priceElasticity: 0.25,
      minPriceMult: 0.5,
      maxPriceMult: 3.0,
      maxStockMult: 1.8,
      spoilageRate: 0.0,
      inputs: [
        { goodId: "textiles", qty: 0.5 },
        { goodId: "food", qty: 0.2 },
        { goodId: "electronics", qty: 0.2 },
      ],
    },
    weapons: {
      basePrice: 800,
      weight: 3,
      volatility: 0.5,
      productionTech: TechLevel.INDUSTRIAL,
      consumptionTech: TechLevel.MEDIEVAL,
      baseProduction: 0.0008,
      baseConsumption: 0.0006,
      priceElasticity: 0.28,
      minPriceMult: 0.5,
      maxPriceMult: 3.0,
      maxStockMult: 1.6,
      spoilageRate: 0.0,
      inputs: [{ goodId: "alloys", qty: 1.0 }, { goodId: "electronics", qty: 0.5 }],
    },
    ship_parts: {
      basePrice: 2000,
      weight: 6,
      volatility: 0.35,
      productionTech: TechLevel.HI_TECH,
      consumptionTech: TechLevel.POST_INDUSTRIAL,
      baseProduction: 0.0005,
      baseConsumption: 0.0001,
      priceElasticity: 0.25,
      minPriceMult: 0.5,
      maxPriceMult: 3.0,
      maxStockMult: 1.5,
      spoilageRate: 0.0,
      inputs: [
        { goodId: "alloys", qty: 2.0 },
        { goodId: "machinery", qty: 1.0 },
        { goodId: "electronics", qty: 1.0 },
        { goodId: "computers", qty: 0.5 },
      ],
    },
    fertilizer: {
      basePrice: 60,
      weight: 2,
      volatility: 0.18,
      productionTech: TechLevel.EARLY_INDUSTRIAL,
      consumptionTech: TechLevel.AGRICULTURAL,
      baseProduction: 0.002,
      baseConsumption: 0.0015,
      priceElasticity: 0.12,
      minPriceMult: 0.6,
      maxPriceMult: 2.2,
      maxStockMult: 2.2,
      spoilageRate: 0.002,
      inputs: [{ goodId: "food", qty: 0.5 }, { goodId: "machinery", qty: 0.5 }],
    },
    fuel: {
      basePrice: 120,
      weight: 2,
      volatility: 0.22,
      productionTech: TechLevel.INDUSTRIAL,
      consumptionTech: TechLevel.EARLY_INDUSTRIAL,
      baseProduction: 0.0025,
      baseConsumption: 0.0003,
      priceElasticity: 0.15,
      minPriceMult: 0.5,
      maxPriceMult: 2.5,
      maxStockMult: 2.5,
      spoilageRate: 0.0,
      inputs: [{ goodId: "metals", qty: 0.5 }, { goodId: "machinery", qty: 0.2 }],
    },
    narcotics: {
      basePrice: 2000,
      weight: 1,
      volatility: 0.6,
      productionTech: TechLevel.POST_INDUSTRIAL,
      consumptionTech: TechLevel.POST_INDUSTRIAL,
      baseProduction: 0.0006,
      baseConsumption: 0.0004,
      priceElasticity: 0.3,
      minPriceMult: 0.4,
      maxPriceMult: 3.5,
      maxStockMult: 1.4,
      spoilageRate: 0.002,
      inputs: [{ goodId: "food", qty: 0.2 }, { goodId: "electronics", qty: 0.5 }],
      isContraband: true,
    },
  },
  treasury: {
    enabled: true,
    startCreditsPerPop: 1000,
    startCreditsBase: 50000,
    minReserve: 0,
  },
  worldRoles: {
    agricultural: {
      productionMult: {
        food: 3.0, textiles: 2.0, fertilizer: 1.1, fuel: 0.6,
        metals: 0.6, alloys: 0.6, machinery: 0.6, electronics: 0.6, computers: 0.5,
        medicines: 1.0, luxuries: 0.7, weapons: 0.4, ship_parts: 0.2, narcotics: 0.6,
      },
      consumptionMult: {
        food: 1.5, textiles: 1.1, fertilizer: 1.0, fuel: 1.0,
        metals: 1.0, alloys: 1.0, machinery: 1.2, electronics: 1.0, computers: 0.8,
        medicines: 1.0, luxuries: 0.8, weapons: 0.7, ship_parts: 0.3, narcotics: 0.6,
      },
    },
    mining: {
      productionMult: {
        metals: 3.0, alloys: 0.8, machinery: 0.6, electronics: 0.4, fuel: 1.2,
        food: 0.6, textiles: 0.5, medicines: 0.6, luxuries: 0.4, weapons: 0.5,
        computers: 0.4, ship_parts: 0.2, fertilizer: 0.6, narcotics: 0.4,
      },
      consumptionMult: {
        food: 1.6, machinery: 1.5, electronics: 1.1, textiles: 1.0, fuel: 1.1,
        metals: 1.0, alloys: 1.0, computers: 0.8, medicines: 1.1,
        luxuries: 0.7, weapons: 0.8, ship_parts: 0.3, fertilizer: 1.0, narcotics: 0.6,
      },
    },
    industrial: {
      productionMult: {
        alloys: 2.5, machinery: 2.0, weapons: 1.2, fertilizer: 1.2, fuel: 1.6,
        metals: 1.2, electronics: 0.9, computers: 0.7, ship_parts: 0.5,
        food: 0.6, textiles: 0.6, medicines: 0.8, luxuries: 0.6, narcotics: 0.5,
      },
      consumptionMult: {
        food: 1.5, metals: 1.5, alloys: 1.2, machinery: 1.1, electronics: 1.2, fuel: 1.2,
        textiles: 1.0, computers: 0.9, medicines: 1.0, luxuries: 0.8,
        weapons: 0.9, ship_parts: 0.4, fertilizer: 0.9, narcotics: 0.6,
      },
    },
    high_tech: {
      productionMult: {
        electronics: 2.5, computers: 2.5, medicines: 1.2, weapons: 1.1, fuel: 1.0,
        alloys: 0.9, machinery: 0.9, ship_parts: 0.8,
        food: 0.5, textiles: 0.5, metals: 0.6, luxuries: 0.8, fertilizer: 0.6, narcotics: 1.0,
      },
      consumptionMult: {
        food: 1.3, alloys: 1.5, machinery: 1.5, electronics: 1.2, computers: 1.0, fuel: 1.1,
        textiles: 1.0, metals: 1.0, medicines: 1.1, luxuries: 1.2, weapons: 1.0,
        ship_parts: 0.6, fertilizer: 0.7, narcotics: 0.9,
      },
    },
    shipyard: {
      productionMult: {
        ship_parts: 3.0, weapons: 2.0, machinery: 0.8, electronics: 0.8, fuel: 0.8,
        alloys: 0.8, computers: 0.8, food: 0.5, textiles: 0.5,
        metals: 0.6, medicines: 0.6, luxuries: 0.6, fertilizer: 0.6, narcotics: 0.4,
      },
      consumptionMult: {
        alloys: 2.0, machinery: 2.0, electronics: 2.0, computers: 1.5, food: 1.3, fuel: 1.3,
        textiles: 1.0, metals: 1.2, medicines: 1.0, luxuries: 0.8, weapons: 0.8,
        ship_parts: 0.6, fertilizer: 0.6, narcotics: 0.5,
      },
    },
    resort: {
      productionMult: {
        luxuries: 2.5, food: 0.7, textiles: 0.7, medicines: 0.8, fuel: 0.5,
        electronics: 0.6, computers: 0.6, metals: 0.4, alloys: 0.4, machinery: 0.4,
        weapons: 0.3, ship_parts: 0.2, fertilizer: 0.4, narcotics: 0.8,
      },
      consumptionMult: {
        food: 2.0, textiles: 2.0, medicines: 2.0, luxuries: 2.0, fuel: 1.0,
        electronics: 1.3, computers: 1.1, metals: 0.8, alloys: 0.8, machinery: 0.8,
        weapons: 0.6, ship_parts: 0.3, fertilizer: 0.8, narcotics: 1.2,
      },
    },
    trade_hub: {
      productionMult: {
        food: 1.2, textiles: 1.2, metals: 1.2, alloys: 1.2, machinery: 1.2, fuel: 1.2,
        electronics: 1.2, computers: 1.2, medicines: 1.2, luxuries: 1.2, weapons: 1.2,
        ship_parts: 1.2, fertilizer: 1.2, narcotics: 1.2,
      },
      consumptionMult: {
        food: 1.2, textiles: 1.2, metals: 1.2, alloys: 1.2, machinery: 1.2, fuel: 1.2,
        electronics: 1.2, computers: 1.2, medicines: 1.2, luxuries: 1.2, weapons: 1.2,
        ship_parts: 1.2, fertilizer: 1.2, narcotics: 1.2,
      },
    },
  },
  pricing: {
    alpha: 0.15,
    stockDays: 14,
    bufferDays: 7,
    tradeHubAlphaBonus: 0.05,
    minTargetStock: 1,
  },
  contracts: {
    shortageThreshold: 0.25,
    surplusThreshold: 0.25,
    bonusFactor: 0.35,
    contractTtlTicks: 6,
    maxContractsPerGood: 2,
    maxUnitsPerContract: 500,
    multiShipThresholdUnits: 200,
  },
  bootstrap: {
    bootstrapTicks: 6,
    bootstrapSeedTicks: 2,
    bootstrapRate: {
      food: 0.5,
      fertilizer: 0.3,
      metals: 0.2,
      textiles: 0.2,
      alloys: 0.1,
      machinery: 0.1,
      electronics: 0.05,
      computers: 0.03,
      medicines: 0.1,
      luxuries: 0.05,
      weapons: 0.03,
      ship_parts: 0.02,
      fuel: 0.1,
      narcotics: 0.02,
    },
  },
  npcArchetypes: {
    local: { share: 0.75, minMargin: 0.03, maxRange: 1, preferContracts: true },
    regional: { share: 0.2, minMargin: 0.05, maxRange: 3, preferContracts: true },
    longHaul: { share: 0.05, minMargin: 0.08, maxRange: 8, preferContracts: false },
  },
  npcLearning: {
    routeMemorySize: 8,
    epsilonExplore: 0.1,
    routeScoreDecay: 0.95,
    contractMarginBoost: 0.02,
  },
  npc: {
    startCredits: 5000,
    startCreditsRange: [4000, 8000],
    perSystem: 5,
    perMillionPop: 0.1,
    replacementEnabled: false,
    replacementIntervalTicks: 30,
    maxTotal: 1000,
    homeTradeHubShare: 0.4,
  },
  infoDecay: {
    infoHalfLifeMinutes: 15,
    infoRiskMultiplier: 0.5,
  },
  travelCost: {
    operatingCostPerMinute: 0.05,
    minutesPerJump: 5,
    fuelPerMinute: 0.2,
    fuelGoodId: "fuel",
  },
  trade: {
    bulkDiscountBuyFactor: 0.06,
    bulkDiscountSellFactor: 0.06,
    marketDepthBase: 200,
    tradeHubDepthMultiplier: 1.5,
    tradeHubInfoWeight: 0.5,
  },
  facility: {
    defaultLevel: 1.0,
    minLevel: 0.5,
    maxLevel: 1.5,
    evolutionRate: 0.01,
    roleTargetLevel: 1.2,
    decayRate: 0.005,
  },
  evolution: {
    roleShiftThreshold: 0.25,
    roleShiftTicks: 12,
    rolePressureWindowTicks: 24,
  },
  techProgression: {
    wealthFactor: 0.001,
    compFactor: 0.02,
    techThreshold: 10,
    windowTicks: 24,
    maxTechByRole: {
      agricultural: TechLevel.INDUSTRIAL,
      mining: TechLevel.INDUSTRIAL,
      industrial: TechLevel.POST_INDUSTRIAL,
      high_tech: TechLevel.HI_TECH,
      shipyard: TechLevel.HI_TECH,
      resort: TechLevel.RENAISSANCE,
      trade_hub: TechLevel.POST_INDUSTRIAL,
    },
  },
  blackMarket: {
    lawLevelRange: [0.0, 1.0],
    seizureFactor: 0.6,
    riskThreshold: 0.6,
    riskToleranceRange: [0.0, 1.0],
    reputationPenalty: 0.1,
  },
  factions: {
    enabled: false,
    baseTariffRate: 0.02,
    relationRange: [-1.0, 1.0],
    sanctionThreshold: -0.6,
  },
  players: {
    allowContracts: true,
    facilityUpgradeCost: 5000,
    facilityUpgradeStep: 0.05,
    startCredits: 10000,
    startShipType: "trader",
    bankruptcyEnabled: true,
  },
  ships: {
    types: {
      courier: { cargoMin: 40, cargoMax: 70, speedMultiplier: 0.8, fuelMultiplier: 0.9, operatingCostMultiplier: 0.8 },
      trader: { cargoMin: 80, cargoMax: 120, speedMultiplier: 1.0, fuelMultiplier: 1.0, operatingCostMultiplier: 1.0 },
      hauler: { cargoMin: 160, cargoMax: 240, speedMultiplier: 1.2, fuelMultiplier: 1.3, operatingCostMultiplier: 1.2 },
      freighter: { cargoMin: 300, cargoMax: 450, speedMultiplier: 1.4, fuelMultiplier: 1.6, operatingCostMultiplier: 1.4 },
    },
    archetypeWeights: {
      local: { courier: 0.5, trader: 0.5 },
      regional: { trader: 0.6, hauler: 0.4 },
      longHaul: { hauler: 0.5, freighter: 0.5 },
    },
    requirePartsForSpawn: false,
    spawnPartsCost: { goodId: "ship_parts", qty: 5 },
  },
  worldAttributes: {
    resourceRichnessRange: [0.5, 1.5],
    gravityRange: [0.7, 1.3],
    atmosphereRange: [0.8, 1.2],
    habitationQualityRange: [0.6, 1.4],
  },
  bankruptcy: {
    bankruptGraceTicks: 6,
    forcedLiquidationDiscount: 0.1,
  },
  events: {
    shockChancePerTick: 0.02,
    durationRangeTicks: [6, 24],
    severityRange: [0.2, 0.5],
  },
  health: {
    criticalRatio: 0.2,
    collapseTicks: 6,
    crisisMinMarginMultiplier: 0.5,
    crisisBonusMultiplier: 1.5,
    crisisMaxRangeBonus: 2,
    crisisDurationTicks: 6,
    crisisCooldownTicks: 12,
  },
  regions: {
    minSystems: 4,
    maxSystems: 10,
    shipPartsTarget: 0.25,
    shipPartsTargetStep: 0.02,
    maxTargetReductions: 5,
    allowSystemGrowth: false,
    minLinksPerSystem: 2,
    maxLinksPerSystem: 5,
    nearestNeighborCount: 3,
    roleBiasWeights: {
      agricultural: 1.0,
      mining: 0.9,
      industrial: 0.8,
      high_tech: 0.6,
      shipyard: 0.4,
      resort: 0.3,
      trade_hub: 0.3,
    },
  },
};
```

Notes:
- `baseProduction` and `baseConsumption` are per tick, per population unit, scaled by `techMult`.
- Shipyards rely on the ship_parts production multiplier and high input consumption to create demand.
- `roleBiasWeights` guide region generation (higher means more likely).
- `maxStockMult` and `spoilageRate` define storage caps and perishability.
- Fuel base consumption is minimal; most fuel demand is from ship travel.

**Implementation note**
This schema is the target design. Current `src/balance-config.ts` differs:
- It uses global price and volatility parameters (`priceElasticity`, `meanReversionStrength`, `marketDepthFactor`, etc).
- It uses a single `minProfitMargin` for NPC trading decisions.
- It has no per-good production/consumption or dependency inputs.
- It has no contract, storage, or perishability settings.
- It lacks NPC learning and info decay parameters.

**Migration strategy**
- Introduce the new balance schema alongside the existing one and gate with a feature flag.
- Map existing price parameters into per-good defaults (if needed) during a transition period.
- Add validation for parameter interactions (e.g., `minPriceMult <= maxPriceMult`, non-negative rates).
- Remove legacy config once the new pipeline is stable.

---

## 15) Implementation Checklist (Initial)

| Item | Status | Files |
| --- | --- | --- |
| Expand goods list (alloys, ship_parts, fertilizer, fuel) | not started | `src/goods.ts`, `src/types.ts`, `src/star-system.ts` |
| Dependency-driven production (inputs) | not started | `src/star-system.ts`, `src/types.ts` |
| Per-good baseProduction/baseConsumption | not started | `src/balance-config.ts`, `src/star-system.ts` |
| World role multipliers | not started | `src/star-system.ts`, `src/types.ts` |
| Inventory targets, storage caps, spoilage | not started | `src/star-system.ts` |
| Price smoothing (alpha) | not started | `src/star-system.ts`, `src/balance-config.ts` |
| System treasury + settlement | not started | `src/star-system.ts`, `src/types.ts` |
| Contracts (shortage/surplus + TTL) | not started | `src/star-system.ts`, `src/types.ts` |
| NPC archetypes + travel fuel | not started | `src/ship.ts`, `src/types.ts` |
| Ship types + capacity ranges | not started | `src/ship.ts`, `src/types.ts` |
| Info decay + learning | not started | `src/ship.ts`, `src/types.ts` |
| Bankruptcy handling | not started | `src/ship.ts`, `src/types.ts` |
| Regions + role biasing | not started | `src/local-server.ts`, `src/star-system.ts` |
| World attributes + facility levels | not started | `src/types.ts`, `src/star-system.ts` |
| World evolution + tech progression | not started | `src/star-system.ts` |
| Economic shocks | not started | `src/star-system.ts` |
| Black market rules | not started | `src/ship.ts`, `src/star-system.ts` |
| Factions + sanctions | not started | `src/types.ts`, `src/local-server.ts` |
| Player interaction + investments | not started | `src/local-server.ts`, `src/ship.ts`, `src/types.ts` |
| Metrics + health detection | not started | `src/logging.ts`, `src/local-server.ts` |
| Validation tests | not started | §15.1, `src/*.test.ts` |

---

## 15.1) Testing and Validation Guidance

Testing lives in `src/*.test.ts` and should target determinism, production/consumption order, pricing, contracts, treasury settlement, and NPC decisions.

**Commands**
- Run all tests: `npm test`
- Watch mode: `npm run test:watch`
- Coverage: `npm run test:coverage`

**Coverage goals**
- 80%+ line coverage for core economy logic.
- 100% coverage for critical paths (trade, pricing, contracts, treasury, determinism).

**Determinism**
- Use fixed seeds for RNG and isolate time-dependent logic with mocks.
- Avoid external I/O or network in tests; keep tests fully local.

---

## 16) Minimal Viable Rework Path

1. Add dependency table and input-limited production (no new goods).
2. Add contracts and NPC contract preference.
3. Introduce regions plus local/regional/long-haul archetypes.
4. Add new goods (alloys, ship_parts, fertilizer) and shipyard role.

---

## 17) Scaling and Performance

- Target scale: 20-100 systems and 100-1000 NPC ships in a single process.
- Time complexity per system tick: `O(systems * goods)`; per ship tick: `O(ships * candidateRoutes)`.
- Prefer batching ticks and minimizing per-tick market scans; cache market snapshots per system tick.
- If scaling beyond 1000 ships, partition updates by region and stagger ship ticks.
- Regional metrics should be computed on a slower cadence (e.g., every 10 system ticks).

---

## 18) Notes on Determinism

- All random choices must use deterministic RNG seeded per system or ship.
- Contract creation uses deterministic rules based on inventory and thresholds.
- NPC route decisions are deterministic from observed prices and ship seed.
- RNG advancement:
  - System RNG advances on each system tick (seeded by systemId + tick).
  - Ship RNG advances on each ship tick (seeded by shipId + tick).
