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
  ShipArrivalEvent,
  SystemSnapshot,
  TechLevel,
  WorldType,
} from "./types";
import { getTickIntervalMs } from "./simulation-config";
import { getGoodDefinition, getAllGoodIds, isSpecializedGood } from "./goods";
import { getPriceMultiplier } from "./economy-roles";
import { 
  getMaxPriceMultiplier, 
  getMinPriceMultiplier,
  getGoodProductionMultiplier,
} from "./balance-config";
import type { DurableObjectNamespace, DurableObjectState, DurableObjectStorage } from "./durable-object-types";

const TICK_INTERVAL_MS = getTickIntervalMs();
const SALES_TAX_RATE = 0.03;

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
  private storage: DurableObjectStorage;
  private id: string;
  private env: StarSystemEnv;
  private systemState: SystemState | null = null;
  private markets: Map<GoodId, MarketState> = new Map();
  private shipsInSystem: Set<ShipId> = new Set();
  private pendingArrivals: ShipArrivalEvent[] = [];
  private dirty: boolean = false; // Track if state needs to be flushed to DB

  constructor(stateOrStorage: DurableObjectState | DurableObjectStorage, env: StarSystemEnv, id?: string) {
    // Support both old (DurableObjectState) and new (DurableObjectStorage + id) signatures
    if ('storage' in stateOrStorage && 'id' in stateOrStorage) {
      // Old signature: DurableObjectState
      this.storage = stateOrStorage.storage;
      this.id = stateOrStorage.id.toString();
    } else {
      // New signature: DurableObjectStorage + id
      this.storage = stateOrStorage as DurableObjectStorage;
      this.id = id || 'unknown';
    }
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
        return new Response(JSON.stringify(await this.getState()), { headers: { "Content-Type": "application/json" } });
      } else if (path === "/snapshot" && requestObj.method === "GET") {
        const snapshot = await this.getSnapshot();
        return new Response(JSON.stringify(snapshot, (key, value) => {
          void key;
          if (value instanceof Map) return Object.fromEntries(value);
          return value;
        }), { headers: { "Content-Type": "application/json" } });
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
    const stored = await this.storage.get<{
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
        this.pendingArrivals = stored.pendingArrivals.map((arr: { timestamp: number; shipId: string; fromSystem: number; toSystem: number; cargo?: Array<[string, number]> | Map<string, number>; priceInfo?: Array<[string, number]> | Map<string, number> }) => ({
          timestamp: arr.timestamp,
          shipId: arr.shipId,
          fromSystem: arr.fromSystem,
          toSystem: arr.toSystem,
          cargo: arr.cargo instanceof Map ? arr.cargo : new Map(arr.cargo || []),
          priceInfo: arr.priceInfo instanceof Map ? arr.priceInfo : new Map(arr.priceInfo || []),
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
   * Flush state to database (called periodically or on request)
   * This now just marks the data as ready for batch flush
   */
  async flushState(): Promise<void> {
    if (!this.dirty || !this.systemState) return;
    
    // Store data in storage for batch flush
    await this.storage.put("state", {
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

  /**
   * Initialize the star system with given parameters
   * @param params - System initialization parameters
   * @param params.id - System ID
   * @param params.name - System name
   * @param params.population - Population in millions
   * @param params.techLevel - Technology level
   * @param params.worldType - World type (affects production/consumption)
   * @param params.seed - RNG seed for deterministic simulation
   * @param params.x - X coordinate (optional)
   * @param params.y - Y coordinate (optional)
   */
  async initialize(params: {
    id: SystemId;
    name: string;
    population: number;
    techLevel: TechLevel;
    worldType: WorldType;
    seed: string;
    x?: number;
    y?: number;
  }): Promise<void> {

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
      id: params.id,
      name: params.name,
      population: params.population,
      techLevel: params.techLevel,
      worldType: params.worldType,
      seed: params.seed,
      lastTickTime: Date.now(),
      currentTick: 0,
      x: params.x ?? 0,
      y: params.y ?? 0,
    };

    // Initialize markets for all goods - all systems can buy/sell everything
    // Systems that can't consume a good will have very low prices (not worth selling to)
    const rng = new DeterministicRNG(params.seed);
    
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
      // Keep food, textiles, metals, luxuries, electronics, computers, medicines, weapons slightly surplus; luxuries −5%.
      const goodProductionMultiplier = getGoodProductionMultiplier(goodId);
      const baseProduction = canProduce
        ? (this.systemState.population
            * (this.systemState.techLevel + 1)
            * 16
            * specializationBonus
            * goodProductionMultiplier
          ) / 1000
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
  }

  private async handleInitialize(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      id: SystemId;
      name: string;
      population: number;
      techLevel: TechLevel;
      worldType: WorldType;
      seed: string;
      x?: number;
      y?: number;
    };
    await this.initialize(body);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Reset all markets to initial state (inventory: 2000, price: basePrice)
   */
  async resetMarkets(): Promise<void> {
    if (!this.systemState) throw new Error("System not initialized");
    for (const [, market] of this.markets.entries()) {
      market.inventory = 2000;
      market.price = market.basePrice;
    }
    this.dirty = true;
  }

  private async handleResetMarkets(): Promise<Response> {
    if (!this.systemState) {
      return new Response(JSON.stringify({ error: "System not initialized" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Reset all markets: inventory to 2000, price to basePrice
    for (const [, market] of this.markets.entries()) {
      market.inventory = 2000;
      market.price = market.basePrice;
    }

    this.dirty = true; // Mark as dirty - will be flushed at end of tick

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Get the current system state
   * @returns System state or null if not initialized
   */
  async getState(): Promise<SystemState | null> {
    if (!this.systemState) await this.loadState();
    return this.systemState;
  }

  /**
   * Get a complete snapshot of the system including state, markets, and ships
   * @returns System snapshot with all current data
   */
  async getSnapshot(): Promise<SystemSnapshot> {
    if (!this.systemState) await this.loadState();
    return {
      state: this.systemState!,
      markets: this.markets,
      shipsInSystem: Array.from(this.shipsInSystem),
    };
  }

  private async getOtherSystemCoords(otherSystemId: SystemId): Promise<{ x: number; y: number } | null> {
    try {
      const otherSystemStub = this.env.STAR_SYSTEM.idFromName(`system-${otherSystemId}`);
      const otherSystemObj = this.env.STAR_SYSTEM.get(otherSystemStub);
      
      // Try to call getCoordinates directly (works in local mode)
      try {
        const systemAsStarSystem = otherSystemObj as StarSystem;
        if (systemAsStarSystem.getCoordinates && typeof systemAsStarSystem.getCoordinates === 'function') {
          const coords = systemAsStarSystem.getCoordinates();
          if (coords) {
            return coords;
          }
        } else {
          // Try prototype chain
          const proto = Object.getPrototypeOf(otherSystemObj);
          if (proto && proto.getCoordinates && typeof proto.getCoordinates === 'function') {
            const coords = proto.getCoordinates.call(systemAsStarSystem);
            if (coords) {
              return coords;
            }
          }
        }
      } catch (error) {
        // Method doesn't exist or call failed - will fall back to fetch
      }
      
      // Fallback to getSnapshot if direct call returned null
      const systemAsStarSystem = otherSystemObj as StarSystem;
      const otherSnapshot = await systemAsStarSystem.getSnapshot();
      if (!otherSnapshot.state) return null;
      return {
        x: otherSnapshot.state.x ?? 0,
        y: otherSnapshot.state.y ?? 0,
      };
    } catch (error) {
      return null;
    }
  }

  async getReachableSystems(): Promise<Array<{ id: SystemId; distance: number }>> {
    // Ensure state is loaded before accessing it
    await this.ensureLoaded();
    
    const systemState = this.systemState;
    if (!systemState) {
      const systemId = this.id || 'unknown';
      console.warn(`[StarSystem ${systemId}] getReachableSystems called but systemState is null after load attempt. System may not be initialized.`);
      return [];
    }

    const MAX_TRAVEL_DISTANCE = 15; // Maximum distance ships can travel
    const GALAXY_SIZE = 20; // Total number of systems (configurable via env)
    
    const currentX = systemState.x ?? 0;
    const currentY = systemState.y ?? 0;
    const currentId = systemState.id;
    
    const reachableSystems: Array<{ id: SystemId; distance: number }> = [];
    let systemsChecked = 0;
    let systemsFailed = 0;
    
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
    
    // Filter out any invalid entries (defensive - should never be needed)
    const validReachableSystems = reachableSystems.filter(
      (sys): sys is { id: SystemId; distance: number } =>
        sys !== undefined && sys !== null &&
        typeof sys.distance === 'number' &&
        typeof sys.id === 'number' &&
        !isNaN(sys.distance) &&
        !isNaN(sys.id) &&
        sys.distance >= 0
    );
    
    // Sort by distance (closest first)
    validReachableSystems.sort((a, b) => a.distance - b.distance);
    
    // Log warning if no reachable systems found (this should not happen after validation)
    if (validReachableSystems.length === 0 && systemsChecked > 0) {
      console.warn(
        `[StarSystem ${currentId}] getReachableSystems: No systems found within ${MAX_TRAVEL_DISTANCE} LY. ` +
        `Checked ${systemsChecked} systems, ${systemsFailed} failed/uninitialized. ` +
        `Current coords: (${currentX.toFixed(2)}, ${currentY.toFixed(2)})`
      );
    }
    
    // Log error if we filtered out invalid entries (indicates a bug)
    if (validReachableSystems.length < reachableSystems.length) {
      console.error(
        `[StarSystem ${currentId}] getReachableSystems: CRITICAL - Filtered out ${reachableSystems.length - validReachableSystems.length} invalid entries from reachable systems array. ` +
        `This indicates a bug in getReachableSystems().`
      );
    }
    
    return validReachableSystems;
  }

  private async handleGetReachableSystems(): Promise<Response> {
    const reachableSystems = await this.getReachableSystems();
    return new Response(JSON.stringify({ systems: reachableSystems }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Process system tick - update markets and process ship arrivals
   * @returns Tick processing results
   */
  async tick(): Promise<{ tick: number; processed: number; arrivalsProcessed: number; pendingArrivals: number; marketsUpdated: number }> {
    if (!this.systemState) throw new Error("System not initialized");
    const now = Date.now();
    const ticksToProcess = Math.floor((now - this.systemState.lastTickTime) / TICK_INTERVAL_MS);
    if (ticksToProcess === 0) {
      return {
        tick: this.systemState.currentTick,
        processed: 0,
        arrivalsProcessed: 0,
        pendingArrivals: this.pendingArrivals.length,
        marketsUpdated: 0,
      };
    }
    const rng = new DeterministicRNG(this.systemState.seed);
    let totalArrivalsProcessed = 0;
    for (let i = 0; i < ticksToProcess; i++) {
      this.systemState.currentTick++;
      const tickRng = rng.derive(`tick-${this.systemState.currentTick}`);
      const tickTime = this.systemState.lastTickTime + (i + 1) * TICK_INTERVAL_MS;
      totalArrivalsProcessed += await this.processArrivals(tickTime);
      for (const [goodId, market] of this.markets.entries()) {
        await this.updateMarket(goodId, market, this.systemState.currentTick, tickRng);
      }
    }
    this.systemState.lastTickTime = now;
    this.dirty = true;
    await this.flushState();
    return {
      tick: this.systemState.currentTick,
      processed: ticksToProcess,
      arrivalsProcessed: totalArrivalsProcessed,
      pendingArrivals: this.pendingArrivals.length,
      marketsUpdated: ticksToProcess * this.markets.size,
    };
  }

  private async handleTick(): Promise<Response> {
    try {
      const result = await this.tick();
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    } catch (error) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async updateMarket(
    goodId: GoodId,
    market: MarketState,
    tick: number,
    rng: DeterministicRNG
  ): Promise<void> {
    const systemState = this.systemState;
    if (!systemState) return;

    // Removed inventoryBefore tracking - simplified
    
    market.inventory += market.production;
    market.inventory = Math.min(market.inventory, 1_000_000_000);

    // Consumption removes from inventory
    const consumed = Math.min(market.consumption, market.inventory);
    market.inventory -= consumed;
    
    // Removed logTrade - simplified
    if (consumed > 0 && !zeroInventoryDetected) {
      // logTrade removed - simplified
    }
    
    // Check for zero inventory and stop logging
    if (market.inventory <= 0 && !zeroInventoryDetected) {
      zeroInventoryDetected = true;
      zeroInventorySystem = systemState.id;
      zeroInventoryGood = goodId;
      
      // logTrade removed - simplified
      
      // Write logs to file
      this.writeLogsToFile();
    }

    this.applySpaceElevator(goodId, market, tick, rng);

    const expectedStock = Math.max(1, (market.production + market.consumption) * 10);
    const inventoryRatio = market.inventory / expectedStock;
    const priceAdjustment = (inventoryRatio - 1.0) * 0.5;
    const maxMultiplier = getMaxPriceMultiplier();
    const minMultiplier = getMinPriceMultiplier();
    const newPrice = market.basePrice * Math.max(minMultiplier, Math.min(maxMultiplier, 1.0 + priceAdjustment));
    market.price = Math.max(
      market.basePrice * minMultiplier,
      Math.min(market.basePrice * maxMultiplier, newPrice)
    );
  }


  private applySpaceElevator(goodId: GoodId, market: MarketState, tick: number, rng: DeterministicRNG): void {
    if (!this.systemState) return;
    const expectedStock = Math.max(1, (market.production + market.consumption) * 10);
    const targetInventory = expectedStock * 0.5;
    const inventoryImbalance = market.inventory - targetInventory;
    const productionConsumptionDiff = market.production - market.consumption;
    const techEfficiency = 0.1 + (this.systemState.techLevel * 0.05);
    const elevatorRng = rng.derive(`elevator-${goodId}-${tick}`);
    const randomFactor = elevatorRng.randomFloat(0.9, 1.1);
    const imbalanceAdjustment = -inventoryImbalance * 0.02;
    const productionAdjustment = productionConsumptionDiff > 0 ? productionConsumptionDiff * 0.1 : 0;
    const baseAdjustment = (imbalanceAdjustment + productionAdjustment) * techEfficiency * randomFactor;
    
    // Cap the adjustment to prevent wild swings (max 5% of expected stock per tick)
    const maxAdjustment = expectedStock * 0.05;
    const adjustment = Math.max(-maxAdjustment, Math.min(maxAdjustment, baseAdjustment));
    
    // Apply adjustment (no upper limit, but prevent negative)
    market.inventory += adjustment;
    market.inventory = Math.max(0, market.inventory);
  }

  /**
   * Register a ship arrival at this system
   * @param arrival - Ship arrival event with timestamp, ship ID, cargo, etc.
   */
  async shipArrival(arrival: ShipArrivalEvent): Promise<void> {
    if (arrival.timestamp > Date.now()) {
      this.pendingArrivals.push(arrival);
    } else {
      await this.applyArrivalEffects(arrival);
    }
    this.dirty = true;
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

    // Price updates are inventory-driven; arrival price rumors are ignored.
    
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
    const body = (await request.json()) as ShipArrivalEvent;
    const arrival: ShipArrivalEvent = {
      ...body,
      cargo: new Map((body.cargo as unknown as Array<[GoodId, number]>) || []),
      priceInfo: new Map((body.priceInfo as unknown as Array<[GoodId, number]>) || []),
    };
    await this.shipArrival(arrival);
    return new Response("{\"success\":true}", {
      headers: { "Content-Type": "application/json" },
    });
  }

  async shipDeparture(shipId: ShipId): Promise<void> {
    this.shipsInSystem.delete(shipId);
    this.dirty = true;
  }

  private async handleShipDeparture(request: Request): Promise<Response> {
    const body = (await request.json()) as { shipId: ShipId };
    await this.shipDeparture(body.shipId);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async trade(params: { shipId: ShipId; goodId: GoodId; quantity: number; type: "buy" | "sell" }): Promise<{ success: boolean; error?: string; price?: number; totalCost?: number; totalValue?: number; tax?: number; quantity?: number; newInventory?: number }> {
    if (!Number.isFinite(params.quantity) || params.quantity <= 0 || !Number.isInteger(params.quantity)) {
      return { success: false, error: "Invalid quantity: must be a positive integer" };
    }
    if (!this.systemState) {
      return { success: false, error: "System not initialized" };
    }
    const systemId = this.systemState.id;

    if (!this.shipsInSystem.has(params.shipId)) {
      this.shipsInSystem.add(params.shipId);
      this.dirty = true;
    }
    const market = this.markets.get(params.goodId);
    if (!market) {
      return { success: false, error: "Good not found" };
    }
    if (params.type === "buy") {
      if (market.inventory < params.quantity) {
        return { success: false, error: "Insufficient inventory" };
      }
      const currentPrice = market.price;
      const baseCost = currentPrice * params.quantity;
      const inventoryBefore = market.inventory;
      market.inventory -= params.quantity;
      if (!zeroInventoryDetected) {
        console.log(`[System ${systemId}] TRADE BUY: ${params.shipId} bought ${params.quantity} ${params.goodId} at ${currentPrice.toFixed(2)} cr (inventory: ${inventoryBefore.toFixed(2)} -> ${market.inventory.toFixed(2)})`);
      }
      if (market.inventory <= 0 && !zeroInventoryDetected) {
        zeroInventoryDetected = true;
        zeroInventorySystem = systemId;
        zeroInventoryGood = params.goodId;
        console.log(`[System ${systemId}] ZERO INVENTORY DETECTED: ${params.goodId} after trade (inventory: ${market.inventory.toFixed(2)}, production: ${market.production.toFixed(4)}, consumption: ${market.consumption.toFixed(4)})`);
        this.writeLogsToFile();
      }
      const tax = baseCost * SALES_TAX_RATE;
      const totalCost = baseCost + tax;
      this.dirty = true;
      return { success: true, price: market.price, totalCost, tax, newInventory: market.inventory };
    } else {
      const actualQuantity = Math.min(params.quantity, 1_000_000_000 - market.inventory);
      if (actualQuantity === 0) {
        return { success: false, error: "Station inventory at maximum" };
      }
      const currentPrice = market.price;
      const inventoryBefore = market.inventory;
      market.inventory += actualQuantity;
      if (!zeroInventoryDetected) {
        console.log(`[System ${systemId}] TRADE SELL: ${params.shipId} sold ${actualQuantity} ${params.goodId} at ${currentPrice.toFixed(2)} cr (inventory: ${inventoryBefore.toFixed(2)} -> ${market.inventory.toFixed(2)})`);
      }
      const totalValue = currentPrice * actualQuantity;
      this.dirty = true;
      return { success: true, price: market.price, totalValue, quantity: actualQuantity, newInventory: market.inventory };
    }
  }

  private async handleTrade(request: Request): Promise<Response> {
    const body = (await request.json()) as { shipId: ShipId; goodId: GoodId; quantity: number; type: "buy" | "sell" };
    const result = await this.trade(body);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Write trade logs to file when zero inventory is detected
   * Only works in Node.js environment (skip in non-Node runtimes)
   */
  private writeLogsToFile(): void {
    try {
      // Check if we're in a Node.js environment
      if (typeof process === "undefined" || !process.cwd) {
        // Non-Node runtime - skip file writing
        return;
      }
      
      // Dynamic import for Node.js modules (only available in Node.js)
      const fs = require("fs");
      const path = require("path");
      
      // Removed getTradeLogs - simplified
      const logs: Array<{ timestamp: number; message: string }> = [];
      const logDir = path.join(process.cwd(), "logs");
      
      // Ensure logs directory exists
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `zero-inventory-${zeroInventorySystem}-${zeroInventoryGood}-${timestamp}.log`;
      const filepath = path.join(logDir, filename);
      
      const logContent = logs.map((entry: { timestamp: number; message: string }) => {
        const date = new Date(entry.timestamp).toISOString();
        return `[${date}] ${entry.message}`;
      }).join("\n");
      
      fs.writeFileSync(filepath, logContent, "utf8");
      
      console.error(
        `[System ${zeroInventorySystem}] Zero inventory detected for ${zeroInventoryGood}. ` +
        `Logs written to: ${filepath} (${logs.length} entries)`
      );
    } catch (error) {
      const systemId = this.systemState?.id ?? "unknown";
      console.error(`[System ${systemId}] Error writing logs to file:`, error);
    }
  }

}
