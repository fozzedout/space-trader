/**
 * StarSystem simulation object
 * 
 * Each star system is an economic island with:
 * - Deterministic economy simulation
 * - Independent RNG seed
 * - Tick-based market updates
 * - Ship arrival/departure handling
 */

import { DeterministicRNG } from "./deterministic-rng";
import {
  SystemState,
  SystemId,
  MarketState,
  ShipId,
  GoodId,
  Timestamp,
  ShipArrivalEvent,
  TradeEvent,
  SystemSnapshot,
  TechLevel,
  GovernmentType,
  WorldType,
} from "./types";
import { getGoodDefinition, getAllGoodIds, isSpecializedGood } from "./goods";
import { getPriceMultiplier } from "./economy-roles";
import { 
  getPriceElasticity, 
  getMaxPriceChangePerTick, 
  getMaxPriceMultiplier, 
  getMinPriceMultiplier,
  getMeanReversionStrength,
  getMarketDepthFactor,
  getInventoryDampingThreshold,
  getSigmoidSteepness,
  getTransactionImpactMultiplier
} from "./balance-config";
import { logTrade, getTradeLogs } from "./trade-logging";
import { DO_INTERNAL } from "./durable-object-helpers";
import * as fs from "fs";
import * as path from "path";

const TICK_INTERVAL_MS = 30000; // 30 seconds per tick (increased to allow time for processing all ships between ticks)
const STATION_CAPACITY = 10000; // max inventory per good
const SALES_TAX_RATE = 0.03; // 3% tax on purchases only (no tax on sales)

// Track if we've detected zero inventory and stopped logging
let zeroInventoryDetected = false;
let zeroInventorySystem: SystemId | null = null;
let zeroInventoryGood: GoodId | null = null;

/**
 * Reset zero inventory monitoring state
 * Exported for use by API endpoints
 */
export function resetZeroInventoryMonitoring(): void {
  zeroInventoryDetected = false;
  zeroInventorySystem = null;
  zeroInventoryGood = null;
}

interface StarSystemEnv {
  STAR_SYSTEM: DurableObjectNamespace;
  SHIP: DurableObjectNamespace;
}

export class StarSystem {
  private state: DurableObjectState;
  private env: StarSystemEnv;
  private systemState: SystemState | null = null;
  private markets: Map<GoodId, MarketState> = new Map();
  private shipsInSystem: Set<ShipId> = new Set();
  private pendingArrivals: ShipArrivalEvent[] = [];
  private dirty: boolean = false; // Track if state needs to be flushed to DB

  constructor(state: DurableObjectState, env: StarSystemEnv) {
    this.state = state;
    this.env = env;
  }

  getCoordinates(): { x: number; y: number } | null {
    if (!this.systemState) {
      return null;
    }
    return {
      x: this.systemState.x ?? 0,
      y: this.systemState.y ?? 0,
    };
  }

  async fetch(request: Request | string): Promise<Response> {
    // Handle both Request objects and string URLs
    const requestObj = typeof request === "string" ? new Request(request) : request;
    const url = new URL(requestObj.url);
    const path = url.pathname;

    try {
      // Load state on first access
      if (!this.systemState) {
        await this.loadState();
      }

      if (path === "/state" && requestObj.method === "GET") {
        return this.handleGetState();
      } else if (path === "/snapshot" && requestObj.method === "GET") {
        return this.handleGetSnapshot();
      } else if (path === "/reachable-systems" && requestObj.method === "GET") {
        return this.handleGetReachableSystems();
      } else if (path === "/tick" && requestObj.method === "POST") {
        return this.handleTick();
      } else if (path === "/arrival" && requestObj.method === "POST") {
        return this.handleShipArrival(requestObj);
      } else if (path === "/departure" && requestObj.method === "POST") {
        return this.handleShipDeparture(requestObj);
      } else if (path === "/trade" && requestObj.method === "POST") {
        return this.handleTrade(requestObj);
      } else if (path === "/initialize" && requestObj.method === "POST") {
        return this.handleInitialize(requestObj);
      } else if (path === "/reset-markets" && requestObj.method === "POST") {
        return this.handleResetMarkets();
      } else if (path === "/flush" && requestObj.method === "POST") {
        await this.flushState();
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } else {
        return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  private async loadState(): Promise<void> {
    const stored = await this.state.storage.get<{
      systemState: SystemState;
      markets: Array<[GoodId, MarketState]>;
      shipsInSystem: ShipId[];
      pendingArrivals?: Array<ShipArrivalEvent>;
    }>("state");

    if (stored) {
      this.systemState = stored.systemState;
      this.markets = new Map(stored.markets || []);
      this.shipsInSystem = new Set(stored.shipsInSystem || []);
      // Convert pending arrivals from array format to ShipArrivalEvent format
      if (stored.pendingArrivals) {
        this.pendingArrivals = stored.pendingArrivals.map(arr => ({
          timestamp: arr.timestamp,
          shipId: arr.shipId,
          fromSystem: arr.fromSystem,
          toSystem: arr.toSystem,
          cargo: new Map(arr.cargo || []),
          priceInfo: new Map(arr.priceInfo || []),
        }));
      }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.systemState) {
      await this.loadState();
    }
  }

  /**
   * Mark state as dirty (needs saving to DB)
   * Actual DB write happens via flushState() or periodic flush
   */
  private async saveState(): Promise<void> {
    this.dirty = true;
  }

  /**
   * Flush state to database (called periodically or on request)
   * This now just marks the data as ready for batch flush
   */
  async flushState(): Promise<void> {
    if (!this.dirty || !this.systemState) return;
    
    // Store data in storage for batch flush
    await this.state.storage.put("state", {
      systemState: this.systemState!,
      markets: Array.from(this.markets.entries()),
      shipsInSystem: Array.from(this.shipsInSystem),
      pendingArrivals: this.pendingArrivals.map(arr => ({
        timestamp: arr.timestamp,
        shipId: arr.shipId,
        fromSystem: arr.fromSystem,
        toSystem: arr.toSystem,
        cargo: Array.from(arr.cargo.entries()),
        priceInfo: Array.from(arr.priceInfo.entries()),
      })),
    });
    
    // Mark as not dirty - actual DB write happens in batch flush
    this.dirty = false;
  }

  private async handleInitialize(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      id: SystemId;
      name: string;
      population: number;
      techLevel: TechLevel;
      worldType: WorldType;
      government: GovernmentType;
      seed: string;
      x?: number;
      y?: number;
    };

    // Allow reinitialization - clear existing state if present
    if (this.systemState) {
      this.systemState = null;
      this.markets.clear();
      this.shipsInSystem.clear();
      this.pendingArrivals = [];
      this.dirty = true;
    }
    
    // Reset zero inventory detection on initialization
    zeroInventoryDetected = false;
    zeroInventorySystem = null;
    zeroInventoryGood = null;

    this.systemState = {
      id: body.id,
      name: body.name,
      population: body.population,
      techLevel: body.techLevel,
      worldType: body.worldType,
      government: body.government,
      seed: body.seed,
      lastTickTime: Date.now(),
      currentTick: 0,
      x: body.x ?? 0,
      y: body.y ?? 0,
    };

    // Initialize markets for all goods - all systems can buy/sell everything
    // Systems that can't consume a good will have very low prices (not worth selling to)
    const rng = new DeterministicRNG(body.seed);
    
    for (const goodId of getAllGoodIds()) {
      const good = getGoodDefinition(goodId);
      if (!good) continue;

      // Check if system can produce/consume this good
      const canProduce = this.systemState.techLevel >= good.productionTech;
      const canConsume = this.systemState.techLevel >= good.consumptionTech;
      
      // All goods get markets - even if system can't produce or consume
      // If can't consume, price will be very low (not worth selling to)
      // If can't produce, price will be higher (worth selling to)

      // Base production/consumption based on population and tech level
      // Balanced to ensure galaxy-wide production slightly exceeds consumption
      // World type specialization: specialized goods get production bonus
      const isSpecialized = isSpecializedGood(goodId, this.systemState.worldType);
      const specializationBonus = isSpecialized ? 1.5 : 1.0; // 50% bonus for specialized goods
      
      // Resort worlds: high consumption of everything except luxuries
      const isResort = this.systemState.worldType === WorldType.RESORT;
      const isLuxury = goodId === "luxuries";
      const resortConsumptionMultiplier = isResort && !isLuxury ? 2.0 : 1.0; // 2x consumption for non-luxury goods
      
      // Production multiplier: 16 (increased from 10) to ensure slight surplus
      // Specialized production: 16 * 1.5 = 24
      // Consumption multiplier: 14 (decreased from 15) to reduce deficit
      // Resort consumption: 14 * 2 = 28
      // Net effect: average production ~16-20, average consumption ~14-18 (slight surplus)
      const baseProduction = canProduce
        ? (this.systemState.population * (this.systemState.techLevel + 1) * 16 * specializationBonus) / 1000
        : 0;
      const baseConsumption = canConsume
        ? (this.systemState.population * (this.systemState.techLevel + 1) * 14 * resortConsumptionMultiplier) / 1000
        : 0;

      // Add some randomness but keep it deterministic
      const productionRng = rng.derive(`production-${goodId}`);
      const consumptionRng = rng.derive(`consumption-${goodId}`);
      
      const production = baseProduction * productionRng.randomFloat(0.8, 1.2);
      const consumption = baseConsumption * consumptionRng.randomFloat(0.8, 1.2);

      // Initial inventory: fixed at 2000 units for all goods at all stations
      const initialInventory = 2000;

      // Use role-based pricing system from ECONOMY_EXPECTATIONS.md
      // This implements the full price generation model (Section 7)
      const priceRng = rng.derive(`price-${goodId}`);
      const priceMultiplier = getPriceMultiplier(
        this.systemState.worldType,
        this.systemState.techLevel,
        goodId,
        priceRng
      );
      const basePrice = good.basePrice * priceMultiplier;

      this.markets.set(goodId, {
        goodId,
        basePrice,
        supply: production,
        demand: consumption,
        production,
        consumption,
        price: basePrice,
        inventory: initialInventory,
      });

    }

    this.dirty = true; // Mark as dirty - will be flushed at end of tick

    // Process any pending arrivals that were queued before initialization
    const now = Date.now();
    for (const arrival of this.pendingArrivals) {
      if (arrival.timestamp <= now) {
        await this.applyArrivalEffects(arrival);
      }
    }
    // Remove processed arrivals
    this.pendingArrivals = this.pendingArrivals.filter(a => a.timestamp > now);

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleResetMarkets(): Promise<Response> {
    if (!this.systemState) {
      return new Response(JSON.stringify({ error: "System not initialized" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Reset all markets: inventory to 2000, price to basePrice
    for (const [goodId, market] of this.markets.entries()) {
      market.inventory = 2000;
      market.price = market.basePrice;
    }

    this.dirty = true; // Mark as dirty - will be flushed at end of tick

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGetState(): Promise<Response> {
    return new Response(JSON.stringify(this.systemState), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleGetSnapshot(): Promise<Response> {
    const snapshot: SystemSnapshot = {
      state: this.systemState!,
      markets: new Map(this.markets),
      shipsInSystem: Array.from(this.shipsInSystem),
    };

    return new Response(JSON.stringify(snapshot, (key, value) => {
      if (value instanceof Map) {
        return Object.fromEntries(value);
      }
      return value;
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async getOtherSystemCoords(otherSystemId: SystemId): Promise<{ x: number; y: number } | null> {
    try {
      const otherSystemStub = this.env.STAR_SYSTEM.idFromName(`system-${otherSystemId}`);
      const otherSystemObj = this.env.STAR_SYSTEM.get(otherSystemStub);
      
      // Try to call getCoordinates directly (works in local mode)
      let usedDirectCall = false;
      try {
        const systemAsStarSystem = otherSystemObj as StarSystem;
        if (systemAsStarSystem.getCoordinates && typeof systemAsStarSystem.getCoordinates === 'function') {
          const coords = systemAsStarSystem.getCoordinates();
          if (coords) {
            return coords;
          }
          usedDirectCall = true;
        } else {
          // Try prototype chain
          const proto = Object.getPrototypeOf(otherSystemObj);
          if (proto && proto.getCoordinates && typeof proto.getCoordinates === 'function') {
            const coords = proto.getCoordinates.call(systemAsStarSystem);
            if (coords) {
              return coords;
            }
            usedDirectCall = true;
          }
        }
      } catch (error) {
        // Method doesn't exist or call failed - will fall back to fetch
      }
      
      // Fallback to fetch if direct call wasn't used or returned null
      const systemAsFetch = otherSystemObj as { fetch: (request: Request | string) => Promise<Response> };
      const otherSnapshot = await systemAsFetch.fetch(DO_INTERNAL("/snapshot"));
      const otherData = (await otherSnapshot.json()) as { state: { x?: number; y?: number } | null };
      
      if (!otherData.state) return null;
      
      return {
        x: otherData.state.x ?? 0,
        y: otherData.state.y ?? 0,
      };
    } catch (error) {
      return null;
    }
  }

  async getReachableSystems(): Promise<Array<{ id: SystemId; distance: number }>> {
    if (!this.systemState) {
      console.warn(`[StarSystem] getReachableSystems called but systemState is null`);
      return [];
    }

    const MAX_TRAVEL_DISTANCE = 15; // Maximum distance ships can travel
    const GALAXY_SIZE = 256; // Total number of systems
    
    const currentX = this.systemState.x ?? 0;
    const currentY = this.systemState.y ?? 0;
    const currentId = this.systemState.id;
    
    const reachableSystems: Array<{ id: SystemId; distance: number }> = [];
    let systemsChecked = 0;
    let systemsFailed = 0;
    let systemsUninitialized = 0;
    
    // Check all systems to find those within MAX_TRAVEL_DISTANCE
    for (let i = 0; i < GALAXY_SIZE; i++) {
      const otherSystemId = i as SystemId;
      if (otherSystemId === currentId) continue;
      
      systemsChecked++;
      const otherCoords = await this.getOtherSystemCoords(otherSystemId);
      if (!otherCoords) {
        systemsFailed++;
        continue; // Skip systems that can't be accessed or aren't initialized
      }
      
      // Calculate 2D Euclidean distance
      const dx = currentX - otherCoords.x;
      const dy = currentY - otherCoords.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance <= MAX_TRAVEL_DISTANCE) {
        reachableSystems.push({ id: otherSystemId, distance });
      }
    }
    
    // Sort by distance (closest first)
    reachableSystems.sort((a, b) => a.distance - b.distance);
    
    // Log warning if no reachable systems found (this should not happen after validation)
    if (reachableSystems.length === 0 && systemsChecked > 0) {
      console.warn(
        `[StarSystem ${currentId}] getReachableSystems: No systems found within ${MAX_TRAVEL_DISTANCE} LY. ` +
        `Checked ${systemsChecked} systems, ${systemsFailed} failed/uninitialized. ` +
        `Current coords: (${currentX.toFixed(2)}, ${currentY.toFixed(2)})`
      );
    }
    
    return reachableSystems;
  }

  private async handleGetReachableSystems(): Promise<Response> {
    const reachableSystems = await this.getReachableSystems();
    return new Response(JSON.stringify({ systems: reachableSystems }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleTick(): Promise<Response> {
    if (!this.systemState) {
      return new Response(JSON.stringify({ error: "System not initialized" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = Date.now();
    const ticksToProcess = Math.floor((now - this.systemState.lastTickTime) / TICK_INTERVAL_MS);

    if (ticksToProcess === 0) {
      return new Response(JSON.stringify({
        tick: this.systemState.currentTick,
        processed: 0,
        arrivalsProcessed: 0,
        pendingArrivals: this.pendingArrivals.length,
        marketsUpdated: 0,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const rng = new DeterministicRNG(this.systemState.seed);

    let totalArrivalsProcessed = 0;
    // Process each tick deterministically
    for (let i = 0; i < ticksToProcess; i++) {
      this.systemState.currentTick++;
      const tickRng = rng.derive(`tick-${this.systemState.currentTick}`);
      const tickTime = this.systemState.lastTickTime + (i + 1) * TICK_INTERVAL_MS;

      // Process ship arrivals for this tick
      totalArrivalsProcessed += await this.processArrivals(tickTime);

      // Count all active traders (NPCs and players) in this system for market volatility scaling
      const traderCount = this.shipsInSystem.size;

      // Update markets
      for (const [goodId, market] of this.markets.entries()) {
        await this.updateMarket(goodId, market, this.systemState.currentTick, tickRng, traderCount);
      }
    }

    this.systemState.lastTickTime = now;
    this.dirty = true; // Mark as dirty during tick
    
    // Flush state once at the end of tick
    await this.flushState();

    const marketsUpdated = ticksToProcess * this.markets.size;
    return new Response(
      JSON.stringify({
        tick: this.systemState.currentTick,
        processed: ticksToProcess,
        arrivalsProcessed: totalArrivalsProcessed,
        pendingArrivals: this.pendingArrivals.length,
        marketsUpdated,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  private async updateMarket(
    goodId: GoodId,
    market: MarketState,
    tick: number,
    rng: DeterministicRNG,
    traderCount: number
  ): Promise<void> {
    const inventoryBefore = market.inventory;
    
    // Production adds to inventory
    // No capacity limit - planet backs the station with unlimited storage
    market.inventory += market.production;
    // Only cap at extremely high values to prevent overflow (1 billion units)
    market.inventory = Math.min(market.inventory, 1_000_000_000);

    // Log production
    if (market.production > 0 && !zeroInventoryDetected) {
      logTrade(
        `[System ${this.systemState.id}] PRODUCTION: ${market.production.toFixed(4)} ${goodId} ` +
        `(inventory: ${inventoryBefore.toFixed(2)} -> ${market.inventory.toFixed(2)})`
      );
    }

    // Consumption removes from inventory
    const consumed = Math.min(market.consumption, market.inventory);
    market.inventory -= consumed;
    
    // Log consumption
    if (consumed > 0 && !zeroInventoryDetected) {
      logTrade(
        `[System ${this.systemState.id}] CONSUMPTION: ${consumed.toFixed(4)} ${goodId} ` +
        `(inventory: ${(market.inventory + consumed).toFixed(2)} -> ${market.inventory.toFixed(2)})`
      );
    }
    
    // Check for zero inventory and stop logging
    if (market.inventory <= 0 && !zeroInventoryDetected) {
      zeroInventoryDetected = true;
      zeroInventorySystem = this.systemState.id;
      zeroInventoryGood = goodId;
      
      logTrade(
        `[System ${this.systemState.id}] ZERO INVENTORY DETECTED: ${goodId} ` +
        `(inventory: ${market.inventory.toFixed(2)}, production: ${market.production.toFixed(4)}, ` +
        `consumption: ${market.consumption.toFixed(4)})`
      );
      
      // Write logs to file
      this.writeLogsToFile();
    }

    // Space Elevator: Small but frequent stock adjustments based on tech level and government
    this.applySpaceElevator(goodId, market, tick, rng);

    // Improved economic model with non-linear response, mean reversion, and market depth
    
    // 1. Calculate expected stock based on natural equilibrium to prevent first-tick price spikes
    // Expected stock should match what inventory "should be" given production/consumption rates
    const baselineStock = 2000; // Initial inventory level
    // Calculate expected stock based on production/consumption equilibrium (same as space elevator target)
    const productionConsumptionRate = market.production + market.consumption;
    const equilibriumStock = Math.max(1, productionConsumptionRate * 10); // 10 ticks worth of activity
    const targetInventory = equilibriumStock * 0.5; // Space elevator target (50% of equilibrium)
    
    // Use baselineStock as expectedStock, but add damping for small deviations to prevent first-tick spikes
    // The damping threshold (15%) creates a "neutral zone" where price changes are reduced
    // This prevents immediate price spikes when inventory drifts slightly from baseline
    const expectedStock = baselineStock;
    
    // Calculate inventory ratio with damping zone around baseline to prevent first-tick spikes
    const inventoryRatio = market.inventory / expectedStock;
    // Add damping: if ratio is within 15% of 1.0, reduce the effective deviation
    const dampingZone = 0.15; // 15% neutral zone
    let effectiveRatio = inventoryRatio;
    if (Math.abs(inventoryRatio - 1.0) < dampingZone) {
      // Within damping zone: scale deviation toward 1.0 to reduce price impact
      const deviation = inventoryRatio - 1.0;
      effectiveRatio = 1.0 + deviation * 0.3; // Reduce deviation by 70%
    }
    
    // Use effectiveRatio (with damping) for price calculation
    // When inventory = expectedStock, ratio = 1.0, imbalance should be near 0 (neutral)
    // When inventory < expectedStock, ratio < 1.0, imbalance should be positive (price goes up)
    // When inventory > expectedStock, ratio > 1.0, imbalance should be negative (price goes down)
    // Normalize: map inventory ratio to [-1, 1] where 1.0 ratio = 0 imbalance (neutral point)
    // Use a sigmoid-like mapping: ratio 0.5 → -1, ratio 1.0 → 0, ratio 1.5 → +1
    // Use effectiveRatio (with damping) to prevent first-tick price spikes
    const normalizedInventory = (effectiveRatio - 1.0) * 2; // Maps 1.0 to 0, 0.5 to -1, 1.5 to +1
    const sigmoidSteepness = getSigmoidSteepness();
    const imbalance = -Math.tanh(normalizedInventory * sigmoidSteepness); // Smooth S-curve, clamped to [-1, 1]
    
    // 2. Apply market depth based on trader capacity vs planet economic activity
    // Market stability = how much traders can move vs planet's natural economic flow
    const MAX_CARGO_PER_TRADER = 100; // Maximum cargo space per trader
    const TRADER_ACTIVITY_FACTOR = 0.1; // Estimate: traders move ~10% of their capacity per tick on average
    const estimatedTraderCapacity = traderCount * MAX_CARGO_PER_TRADER * TRADER_ACTIVITY_FACTOR;
    const planetEconomicActivity = market.production + market.consumption;
    
    // Market depth: if planet activity >> trader capacity, market is very stable
    // If traders can significantly impact the market, it's more volatile
    const traderImpactRatio = planetEconomicActivity > 0 
      ? estimatedTraderCapacity / planetEconomicActivity 
      : 1.0; // If no planet activity, assume high volatility
    // Convert to stability: low trader impact = high stability
    // Saturate quickly: once planet activity is 10x trader capacity, market is very stable
    // Above that threshold, there's barely any difference in volatility
    const stabilityThreshold = 0.1; // 10x planet activity = 0.1 trader impact ratio
    let marketStability: number;
    if (traderImpactRatio <= stabilityThreshold) {
      // Planet activity >> trader capacity: saturate at 0.98 for minimal differences
      marketStability = 0.98; // Fixed high stability when traders can't significantly impact market
    } else {
      // Traders can impact market: stability decreases as trader impact increases
      // Map from [stabilityThreshold, 1.0] to [0.98, 0.2]
      const normalizedImpact = (traderImpactRatio - stabilityThreshold) / (1.0 - stabilityThreshold);
      marketStability = 0.98 - 0.78 * Math.pow(normalizedImpact, 0.5); // 0.98 to 0.2
    }
    
    const marketDepthFactor = getMarketDepthFactor();
    const effectiveElasticity = getPriceElasticity() * (0.3 + 0.7 * marketStability * marketDepthFactor);
    
    // 3. Calculate supply/demand price change (percentage-based, not absolute)
    const supplyDemandChange = imbalance * effectiveElasticity * market.price;
    
    // 4. Calculate trader activity scaling (square root scaling, base 0.1% for 5 traders)
    const baseTraderCount = 5;
    const traderScale = Math.max(1, Math.sqrt(traderCount / baseTraderCount));
    // Use configured mean reversion strength (default 2% per tick)
    const baseMeanReversion = getMeanReversionStrength();
    const scaledMeanReversion = baseMeanReversion * traderScale;

    // 5. Calculate mean reversion (pulls price back toward base price)
    const priceDeviation = (market.price - market.basePrice) / market.basePrice;
    const reversionChange = -priceDeviation * scaledMeanReversion * market.price;
    
    // 6. Apply damping for extreme inventory levels (buffer zones)
    const inventoryDampingThreshold = getInventoryDampingThreshold();
    let dampingFactor = 1.0;
    if (inventoryRatio < inventoryDampingThreshold) {
      // Very low inventory - reduce price increase rate
      dampingFactor = 0.5 + (inventoryRatio / inventoryDampingThreshold) * 0.5; // 0.5 to 1.0
    } else if (inventoryRatio > (1 - inventoryDampingThreshold)) {
      // Very high inventory - reduce price decrease rate
      dampingFactor = 0.5 + ((1 - inventoryRatio) / inventoryDampingThreshold) * 0.5; // 0.5 to 1.0
    }
    
    // 7. Add volatility (random noise) - scaled by trader activity AND market stability
    // Volatility should add small random noise, not multiply the entire change
    const volatilityRng = rng.derive(`volatility-${goodId}-${tick}`);
    const good = getGoodDefinition(goodId);
    const baseVolatility = good ? good.volatility : 0.2;
    // Scale volatility: base volatility * trader scale * (inverse of market stability)
    // High planet activity relative to traders = high stability = low volatility multiplier
    // marketStability ranges from 0.2 to 0.98, so volatility multiplier ranges from 0.2 to 1.0
    const volatilityMultiplier = 0.2 + 0.8 * (1 - marketStability); // Invert: high stability = low volatility
    const scaledVolatility = baseVolatility * traderScale * volatilityMultiplier;
    // Apply volatility as a small random change, not a multiplier
    const volatilityChange = volatilityRng.randomFloat(-scaledVolatility, scaledVolatility) * market.price;
    
    // 8. Combine all price changes (volatility adds noise, doesn't multiply)
    const totalChange = (supplyDemandChange + reversionChange) * dampingFactor + volatilityChange;
    
    // 9. Apply caps and limits - scale max change by market stability
    // Markets with high planet activity relative to traders should have smaller max price changes
    const baseMaxChange = getMaxPriceChangePerTick();
    const stabilityAdjustedMaxChange = baseMaxChange * (0.3 + 0.7 * marketStability); // 30% to 100% of base max change
    const cappedChange = Math.max(
      -stabilityAdjustedMaxChange * market.price,
      Math.min(stabilityAdjustedMaxChange * market.price, totalChange)
    );
    const newPrice = market.price + cappedChange;
    
    // 10. Enforce min/max multipliers
    const maxMultiplier = getMaxPriceMultiplier();
    const minMultiplier = getMinPriceMultiplier();
    market.price = Math.max(
      market.basePrice * minMultiplier,
      Math.min(market.basePrice * maxMultiplier, newPrice)
    );
  }

  /**
   * Space Elevator: Small but frequent stock adjustments every 10 seconds
   * Replenishes or removes stock based on demand/production imbalance,
   * tech level (higher = more efficient), and government type (affects trade policies)
   */
  private applySpaceElevator(
    goodId: GoodId,
    market: MarketState,
    tick: number,
    rng: DeterministicRNG
  ): void {
    if (!this.systemState) return;

    // Target inventory based on expected stock levels (not fixed capacity)
    // Ideal inventory = enough to cover consumption for ~10 ticks
    const expectedStock = Math.max(1, (market.production + market.consumption) * 10);
    const targetInventory = expectedStock * 0.5; // ideal inventory level
    const inventoryImbalance = market.inventory - targetInventory;
    const productionConsumptionDiff = market.production - market.consumption;

    // Base elevator efficiency based on tech level (0-6)
    // Higher tech = more efficient elevator = larger adjustments
    const techEfficiency = 0.1 + (this.systemState.techLevel * 0.05); // 0.1 to 0.4

    // Government type affects trade policies and elevator behavior
    let governmentMultiplier = 1.0;
    switch (this.systemState.government) {
      case "corporate":
        // Corporate: Aggressive trading, faster adjustments, favors high-demand goods
        governmentMultiplier = 1.3;
        break;
      case "democracy":
        // Democracy: Balanced approach, moderate adjustments
        governmentMultiplier = 1.0;
        break;
      case "dictatorship":
        // Dictatorship: Controlled economy, slower but more predictable
        governmentMultiplier = 0.7;
        break;
      case "anarchy":
        // Anarchy: Unpredictable, highly variable adjustments
        governmentMultiplier = 0.8;
        break;
      case "feudal":
        // Feudal: Conservative, minimal adjustments
        governmentMultiplier = 0.6;
        break;
      case "multi_government":
        // Multi-government: Moderate, balanced
        governmentMultiplier = 0.9;
        break;
      default:
        governmentMultiplier = 1.0;
    }

    // Calculate adjustment based on:
    // 1. Inventory imbalance (how far from target)
    // 2. Production/consumption difference (net supply)
    // 3. Tech level efficiency
    // 4. Government multiplier
    const elevatorRng = rng.derive(`elevator-${goodId}-${tick}`);
    const randomFactor = elevatorRng.randomFloat(0.9, 1.1); // Small randomness
    
    // Base adjustment: try to correct inventory imbalance
    const imbalanceAdjustment = -inventoryImbalance * 0.02; // Small correction (2% of imbalance)
    
    // Production/consumption adjustment: only add stock when production exceeds consumption
    // When consumption > production, don't remove stock (natural consumption already handles the deficit)
    // This prevents the Space Elevator from making deficits worse
    const productionAdjustment = productionConsumptionDiff > 0 
      ? productionConsumptionDiff * 0.1  // 10% of net production surplus
      : 0; // Don't remove stock when consumption exceeds production
    
    // Combine adjustments
    const baseAdjustment = (imbalanceAdjustment + productionAdjustment) * techEfficiency * governmentMultiplier * randomFactor;
    
    // Cap the adjustment to prevent wild swings (max 5% of expected stock per tick)
    const maxAdjustment = expectedStock * 0.05;
    const adjustment = Math.max(-maxAdjustment, Math.min(maxAdjustment, baseAdjustment));
    
    // Apply adjustment (no upper limit, but prevent negative)
    market.inventory += adjustment;
    market.inventory = Math.max(0, market.inventory);
  }

  // Public method for direct NPC arrival notification (bypasses fetch overhead)
  public async applyArrivalEffects(arrival: ShipArrivalEvent): Promise<void> {
    await this.ensureLoaded();
    if (!this.systemState) {
      // Queue arrival for processing after initialization
      this.pendingArrivals.push(arrival);
      this.dirty = true;
      return;
    }
    this.shipsInSystem.add(arrival.shipId);

    // Update price info from origin system (rumors spread)
    for (const [goodId, originPrice] of arrival.priceInfo.entries()) {
      const market = this.markets.get(goodId);
      if (market) {
        // Slight price adjustment based on external information
        const priceDiff = (originPrice - market.price) / market.price;
        if (Math.abs(priceDiff) > 0.1) {
          // Significant price difference - adjust slightly
          market.price = market.price * (1 + priceDiff * 0.05);
        }
      }
    }
    
    // Mark as dirty - will be saved at end of tick
    this.dirty = true;
  }

  private async processArrivals(tickTime: number): Promise<number> {
    let processedCount = 0;
    // Process pending arrivals
    for (const arrival of this.pendingArrivals) {
      if (arrival.timestamp <= tickTime) {
        await this.applyArrivalEffects(arrival);
        processedCount += 1;
        // Remove from pending
        this.pendingArrivals = this.pendingArrivals.filter(a => a.shipId !== arrival.shipId);
      }
    }
    return processedCount;
  }

  private async handleShipArrival(request: Request): Promise<Response> {
    // Fast path: just parse JSON and mark dirty, no processing
    const body = (await request.json()) as ShipArrivalEvent;
    const arrival: ShipArrivalEvent = {
      ...body,
      cargo: new Map((body.cargo as unknown as Array<[GoodId, number]>) || []),
      priceInfo: new Map((body.priceInfo as unknown as Array<[GoodId, number]>) || []),
    };
    
    // Add to pending arrivals if not yet arrived
    if (arrival.timestamp > Date.now()) {
      this.pendingArrivals.push(arrival);
    } else {
      await this.applyArrivalEffects(arrival);
    }

    // Mark as dirty - will be saved at end of tick
    this.dirty = true;

    // Return immediately without JSON.stringify overhead - just return success
    return new Response("{\"success\":true}", {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleShipDeparture(request: Request): Promise<Response> {
    const body = (await request.json()) as { shipId: ShipId };
    
    this.shipsInSystem.delete(body.shipId);
    // Mark as dirty - will be saved at end of tick
    this.dirty = true;

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleTrade(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      shipId: ShipId;
      goodId: GoodId;
      quantity: number;
      type: "buy" | "sell";
    };

    if (!Number.isFinite(body.quantity) || body.quantity <= 0 || !Number.isInteger(body.quantity)) {
      return new Response(JSON.stringify({ error: "Invalid quantity: must be a positive integer" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Auto-register ships that aren't in the list but are trying to trade
    // This handles NPCs that were initialized at a system but never went through arrival
    if (!this.shipsInSystem.has(body.shipId)) {
      this.shipsInSystem.add(body.shipId);
      this.dirty = true; // Mark state as dirty so it gets saved
    }

    const market = this.markets.get(body.goodId);
    if (!market) {
      return new Response(JSON.stringify({ error: "Good not found" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.type === "buy") {
      // Ship buying from station
      if (market.inventory < body.quantity) {
        return new Response(JSON.stringify({ error: "Insufficient inventory" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Calculate cost at current price (before adjustment)
      const currentPrice = market.price;
      const baseCost = currentPrice * body.quantity;
      const inventoryBefore = market.inventory;
      
      // Update inventory
      market.inventory -= body.quantity;
      
      // Log trade
      if (!zeroInventoryDetected) {
        logTrade(
          `[System ${this.systemState.id}] TRADE BUY: ${body.shipId} bought ${body.quantity} ${body.goodId} ` +
          `at ${currentPrice.toFixed(2)} cr (inventory: ${inventoryBefore.toFixed(2)} -> ${market.inventory.toFixed(2)})`
        );
      }
      
      // Check for zero inventory after trade
      if (market.inventory <= 0 && !zeroInventoryDetected) {
        zeroInventoryDetected = true;
        zeroInventorySystem = this.systemState.id;
        zeroInventoryGood = body.goodId;
        
        logTrade(
          `[System ${this.systemState.id}] ZERO INVENTORY DETECTED: ${body.goodId} after trade ` +
          `(inventory: ${market.inventory.toFixed(2)}, production: ${market.production.toFixed(4)}, ` +
          `consumption: ${market.consumption.toFixed(4)})`
        );
        
        // Write logs to file
        this.writeLogsToFile();
      }
      
      // Immediate price adjustment: buying reduces inventory, increases price
      // Impact based on trade size relative to expected stock levels
      const expectedStock = Math.max(1, (market.production + market.consumption) * 10);
      const tradeImpact = (body.quantity / expectedStock) * getTransactionImpactMultiplier();
      const priceAdjustment = tradeImpact * currentPrice; // Buy increases price
      const newPrice = currentPrice + priceAdjustment;
      const maxMultiplier = getMaxPriceMultiplier();
      const minMultiplier = getMinPriceMultiplier();
      market.price = Math.max(
        market.basePrice * minMultiplier,
        Math.min(market.basePrice * maxMultiplier, newPrice)
      );
      const tax = baseCost * SALES_TAX_RATE;
      const totalCost = baseCost + tax; // Buyer pays price + tax
      this.dirty = true; // Mark state as dirty since inventory changed

      return new Response(
        JSON.stringify({
          success: true,
          price: market.price,
          totalCost,
          tax,
          newInventory: market.inventory,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    } else {
      // Ship selling to station
      // No capacity limit - planet backs the station, but cap at very high values to prevent overflow
      const actualQuantity = Math.min(body.quantity, 1_000_000_000 - market.inventory);

      if (actualQuantity === 0) {
        return new Response(JSON.stringify({ error: "Station inventory at maximum" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Calculate value at current price (before adjustment)
      const currentPrice = market.price;
      const inventoryBefore = market.inventory;
      
      // Update inventory
      market.inventory += actualQuantity;
      
      // Log trade
      if (!zeroInventoryDetected) {
        logTrade(
          `[System ${this.systemState.id}] TRADE SELL: ${body.shipId} sold ${actualQuantity} ${body.goodId} ` +
          `at ${currentPrice.toFixed(2)} cr (inventory: ${inventoryBefore.toFixed(2)} -> ${market.inventory.toFixed(2)})`
        );
      }
      
      // Immediate price adjustment: selling increases inventory, decreases price
      // Impact based on trade size relative to expected stock levels
      const expectedStock = Math.max(1, (market.production + market.consumption) * 10);
      const tradeImpact = (actualQuantity / expectedStock) * getTransactionImpactMultiplier();
      const priceAdjustment = -tradeImpact * currentPrice; // Sell decreases price
      const newPrice = currentPrice + priceAdjustment;
      const maxMultiplier = getMaxPriceMultiplier();
      const minMultiplier = getMinPriceMultiplier();
      market.price = Math.max(
        market.basePrice * minMultiplier,
        Math.min(market.basePrice * maxMultiplier, newPrice)
      );
      
      const baseValue = currentPrice * actualQuantity;
      const tax = 0; // No tax on sales
      const totalValue = baseValue; // Seller receives full price (no tax)
      this.dirty = true; // Mark state as dirty since inventory changed

      return new Response(
        JSON.stringify({
          success: true,
          price: market.price,
          totalValue,
          tax,
          quantity: actualQuantity,
          newInventory: market.inventory,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
  }

  /**
   * Write trade logs to file when zero inventory is detected
   */
  private writeLogsToFile(): void {
    try {
      const logs = getTradeLogs();
      const logDir = path.join(process.cwd(), "logs");
      
      // Ensure logs directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `zero-inventory-${zeroInventorySystem}-${zeroInventoryGood}-${timestamp}.log`;
      const filepath = path.join(logDir, filename);
      
      const logContent = logs.map(entry => {
        const date = new Date(entry.timestamp).toISOString();
        return `[${date}] ${entry.message}`;
      }).join("\n");
      
      fs.writeFileSync(filepath, logContent, "utf8");
      
      console.error(
        `[System ${zeroInventorySystem}] Zero inventory detected for ${zeroInventoryGood}. ` +
        `Logs written to: ${filepath} (${logs.length} entries)`
      );
    } catch (error) {
      console.error(`[System ${this.systemState.id}] Error writing logs to file:`, error);
    }
  }
}
