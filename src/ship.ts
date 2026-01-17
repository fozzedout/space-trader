/**
 * Ship simulation object - NPC trader that travels between systems and trades goods
 */

import { DeterministicRNG } from "./deterministic-rng";
import {
  ShipState,
  ShipPhase,
  ShipId,
  SystemId,
  GoodId,
  Timestamp,
} from "./types";
import { getGoodDefinition } from "./goods";
import { getMinProfitMargin } from "./balance-config";
import { StarSystem } from "./star-system";

const TRAVEL_TIME_MS = 5 * 60 * 1000;
const MAX_CARGO_SPACE = 100;
const INITIAL_CREDITS = 500;
const SALES_TAX_RATE = 0.03;
const MAX_TRAVEL_DISTANCE = 15;

type MarketSnapshot = {
  price: number;
  inventory: number;
  production?: number;
  consumption?: number;
};

import type { DurableObjectNamespace, DurableObjectState, DurableObjectStorage } from "./durable-object-types";

interface ShipEnv {
  STAR_SYSTEM: DurableObjectNamespace;
  SHIP: DurableObjectNamespace;
}

export class Ship {
  private storage: DurableObjectStorage;
  private env: ShipEnv;
  private shipState: ShipState | null = null;
  private dirty: boolean = false;

  constructor(stateOrStorage: DurableObjectState | DurableObjectStorage, env: ShipEnv, _id?: string) {
    // Support both old (DurableObjectState) and new (DurableObjectStorage + id) signatures
    // Note: id parameter kept for API compatibility but not stored (Ship uses shipState.id instead)
    if ('storage' in stateOrStorage && 'id' in stateOrStorage) {
      // Old signature: DurableObjectState
      this.storage = stateOrStorage.storage;
    } else {
      // New signature: DurableObjectStorage + id
      this.storage = stateOrStorage as DurableObjectStorage;
    }
    this.env = env;
    void _id; // Suppress unused parameter warning
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path !== "/initialize" && !this.shipState) {
        await this.loadState();
      }

      if (path === "/state" && request.method === "GET") {
        return this.handleGetState();
      } else if (path === "/initialize" && request.method === "POST") {
        return this.handleInitialize(request);
      } else if (path === "/tick" && request.method === "POST") {
        return this.handleTick(request);
      } else if (path === "/trade" && request.method === "POST") {
        return this.handleTrade(request);
      } else if (path === "/travel" && request.method === "POST") {
        return this.handleTravel(request);
      } else {
        return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async loadState(): Promise<void> {
    const stored = await this.storage.get<{
      id: ShipId;
      name: string;
      currentSystem: SystemId | null;
      destinationSystem: SystemId | null;
      phase?: ShipPhase;
      cargo: Array<[GoodId, number]>;
      purchasePrices?: Array<[GoodId, number]>;
      credits: number;
      isNPC: boolean;
      seed: string;
      travelStartTime?: Timestamp | null;
      lastTradeTick?: number;
      departureTime?: Timestamp | null;
    }>("state");
    
    if (!stored) return;
    const travelPhases = ["departing", "in_hyperspace", "inter_system_jump", "traveling"];
    const phase = travelPhases.includes(stored.phase as string) ? "traveling" : (stored.phase || "at_station");
    const travelStartTime: Timestamp | null = stored.travelStartTime ?? (phase === "traveling" ? (stored.departureTime ?? null) : null);
    this.shipState = {
      id: stored.id, name: stored.name, currentSystem: stored.currentSystem, destinationSystem: stored.destinationSystem,
      phase: phase as ShipPhase, cargo: new Map(stored.cargo || []), purchasePrices: new Map(stored.purchasePrices || []),
      credits: stored.credits, isNPC: stored.isNPC, seed: stored.seed, travelStartTime, lastTradeTick: stored.lastTradeTick ?? 0,
    };
    if (this.shipState.isNPC && !this.shipState.currentSystem && this.shipState.cargo.size > 0) {
      this.shipState.cargo.clear();
      this.shipState.purchasePrices.clear();
      this.dirty = true;
    }
  }

  async flushState(): Promise<void> {
    if (!this.dirty || !this.shipState) return;
    const s = this.shipState;
    await this.storage.put("state", {
      id: s.id, name: s.name, currentSystem: s.currentSystem, destinationSystem: s.destinationSystem,
      phase: s.phase, cargo: Array.from(s.cargo.entries()), purchasePrices: Array.from(s.purchasePrices.entries()),
      credits: s.credits, isNPC: s.isNPC, seed: s.seed, travelStartTime: s.travelStartTime, lastTradeTick: s.lastTradeTick,
    });
    this.dirty = false;
  }

  /**
   * Get the current ship state
   * @returns Ship state or null if not initialized
   */
  async getState(): Promise<ShipState | null> {
    if (!this.shipState) await this.loadState();
    if (!this.shipState) return null;
    if (!this.shipState.isNPC) await this.processShipPhasesImmediate(Date.now());
    return this.shipState;
  }

  private async handleGetState(): Promise<Response> {
    const state = await this.getState();
    if (!state) {
      return new Response(JSON.stringify({ error: "Ship not initialized" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const serialize = (_key: string, value: unknown) => {
      if (value instanceof Map) return Object.fromEntries(value);
      if (value instanceof Set) return Array.from(value);
      return value;
    };
    return new Response(JSON.stringify(this.shipState, serialize), { headers: { "Content-Type": "application/json" } });
  }

  private async processShipPhasesImmediate(now: Timestamp): Promise<void> {
    if (!this.shipState) return;
    this.normalizePhase();
    if (this.shipState.phase === "traveling" && 
        this.shipState.travelStartTime !== null &&
        this.shipState.destinationSystem !== null &&
        now - this.shipState.travelStartTime >= TRAVEL_TIME_MS) {
      if (!this.shipState.currentSystem) {
        this.shipState.currentSystem = this.shipState.destinationSystem;
      }
      try { await this.handleArrival(); } catch {}
    }
  }

  private normalizePhase(): void {
    if (!this.shipState || (this.shipState.phase === "at_station" || this.shipState.phase === "traveling")) return;
    this.shipState.phase = "at_station";
    this.dirty = true;
  }

  /**
   * Initialize the ship with given parameters
   * @param params - Ship initialization parameters
   * @param params.id - Ship ID
   * @param params.name - Ship name
   * @param params.systemId - Starting system ID
   * @param params.seed - RNG seed for deterministic behavior
   * @param params.isNPC - Whether this is an NPC ship
   */
  async initialize(params: { id: ShipId; name: string; systemId: SystemId; seed: string; isNPC: boolean }): Promise<void> {
    this.shipState = null;
    this.dirty = true;
    try {
      if (this.storage?.delete) await this.storage.delete("state");
    } catch {}
    this.shipState = {
      id: params.id, name: params.name, currentSystem: params.systemId, destinationSystem: null, phase: "at_station",
      cargo: new Map(), purchasePrices: new Map(), credits: INITIAL_CREDITS, isNPC: params.isNPC,
      seed: params.seed, travelStartTime: null, lastTradeTick: 0,
    };
    this.dirty = true;
  }

  private async handleInitialize(request: Request): Promise<Response> {
    const body = (await request.json()) as { id: ShipId; name: string; systemId: SystemId; seed: string; isNPC: boolean };
    await this.initialize(body);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Process ship tick - update phase, make trading decisions (NPCs only)
   * @param isTravelingTick - Whether this is a traveling tick (optional)
   * @returns Tick result with skipped flag
   */
  async tick(isTravelingTick = false): Promise<{ skipped?: boolean }> {
    if (!this.shipState) return { skipped: true };
    const rng = new DeterministicRNG(this.shipState.seed);
    await this.processShipPhases(Date.now(), rng);
    if (this.shipState.phase === "at_station" && this.shipState.currentSystem !== null && this.shipState.isNPC && !isTravelingTick) {
      try {
        await this.makeNPCTradingDecision();
      } catch (error) {
        console.error(`[Ship ${this.shipState.id}] Error in makeNPCTradingDecision:`, error);
      }
    }
    this.dirty = true;
    return { skipped: false };
  }

  private async handleTick(request: Request): Promise<Response> {
    const isTravelingTick = request.headers.get("X-Traveling-Tick") === "true";
    const result = await this.tick(isTravelingTick);
    return new Response(JSON.stringify(result.skipped ? { error: "Ship not initialized" } : { success: true }), {
      status: result.skipped ? 400 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async processShipPhases(now: Timestamp, _rng: DeterministicRNG): Promise<void> {
    if (!this.shipState) return;
    this.normalizePhase();
    if (this.shipState.phase === "traveling" && this.shipState.travelStartTime !== null &&
        this.shipState.destinationSystem !== null && now - this.shipState.travelStartTime >= TRAVEL_TIME_MS) {
      if (!this.shipState.currentSystem) this.shipState.currentSystem = this.shipState.destinationSystem;
      try { await this.handleArrival(); } catch (error) {
        console.error(`[Ship ${this.shipState.id}] Error in handleArrival:`, error);
      }
    }
  }

  private async handleArrival(): Promise<void> {
    if (!this.shipState) return;
    const systemId = this.shipState.currentSystem ?? this.shipState.destinationSystem;
    if (systemId === null) return;
    try {
      const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${systemId}`);
      const system = this.env.STAR_SYSTEM.get(systemStub) as StarSystem;
      await system.shipArrival({
        timestamp: Date.now(),
        shipId: this.shipState.id,
        fromSystem: systemId,
        toSystem: systemId,
        cargo: this.shipState.cargo,
        priceInfo: new Map(),
      });
      this.shipState.phase = "at_station";
      this.shipState.destinationSystem = null;
      this.shipState.travelStartTime = null;
      this.dirty = true;
    } catch (error) {
      console.error(`[Ship ${this.shipState.id}] Error in handleArrival:`, error);
      throw error;
    }
  }

  private async makeNPCTradingDecision(): Promise<void> {
    if (!this.shipState?.currentSystem) return;
    const rng = new DeterministicRNG(this.shipState.seed);
    const decisionCounter = (this.shipState.credits % 1000) + (this.shipState.cargo.size * 100) + 
                           (this.shipState.currentSystem * 10) + (Math.floor(Date.now() / 10000) % 1000);
    const decisionRng = rng.derive(`decision-${decisionCounter}`);
    let snapshot: { markets: Record<GoodId, MarketSnapshot> };
    try {
      const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${this.shipState.currentSystem}`);
      const system = this.env.STAR_SYSTEM.get(systemStub) as StarSystem;
      const systemSnapshot = await system.getSnapshot();
      snapshot = {
        markets: Object.fromEntries(Array.from(systemSnapshot.markets.entries()).map(([goodId, market]) => [
          goodId,
          { price: market.price, inventory: market.inventory, production: market.production, consumption: market.consumption }
        ])) as Record<GoodId, MarketSnapshot>
      };
    } catch (error) {
      console.error(`[Ship ${this.shipState.id}] Error fetching snapshot:`, error);
      return;
    }

    const hasCargo = Array.from(this.shipState.cargo.values()).some(qty => qty > 0);
    if (hasCargo && !(await this.trySellGoods(snapshot.markets, decisionRng))) {
      await this.tryTravel(decisionRng);
    } else if (!hasCargo || !Array.from(this.shipState.cargo.values()).some(qty => qty > 0)) {
      if (!(await this.tryBuyGoods(snapshot.markets, decisionRng))) await this.tryTravel(decisionRng);
    }
  }

  private async tryBuyGoods(markets: Record<GoodId, MarketSnapshot>, _rng: DeterministicRNG): Promise<boolean> {
    if (!this.shipState) return false;
    const usedSpace = Array.from(this.shipState.cargo.values()).reduce((sum, qty) => sum + qty, 0);
    const availableSpace = MAX_CARGO_SPACE - usedSpace;
    if (availableSpace <= 0 || this.shipState.credits <= 0) return false;

    const minProfitMargin = getMinProfitMargin();
    const candidates: Array<{ goodId: GoodId; profitMargin: number; price: number; quantity: number }> = [];

    for (const [goodId, market] of Object.entries(markets)) {
      if (!market.inventory || market.inventory <= 0 || !market.price || market.price <= 0) continue;
      const good = getGoodDefinition(goodId as GoodId);
      if (!good) continue;
      const buyPrice = market.price * (1 + SALES_TAX_RATE);
      const profitMargin = ((good.basePrice * 1.1 - buyPrice) / buyPrice);
      if (profitMargin < minProfitMargin) continue;
      const quantity = Math.min(
        Math.floor(this.shipState.credits / buyPrice),
        Math.floor(availableSpace / good.weight),
        market.inventory
      );
      if (quantity > 0) {
        candidates.push({ goodId: goodId as GoodId, profitMargin, price: buyPrice, quantity });
      }
    }

    if (candidates.length === 0) return false;
    candidates.sort((a, b) => b.profitMargin - a.profitMargin);
    const selected = candidates[0];

    try {
      const result = await this.executeTrade(selected.goodId, selected.quantity, "buy");
      if (!result.success || !result.totalCost) return false;
      const currentCargo = this.shipState.cargo.get(selected.goodId) || 0;
      this.shipState.cargo.set(selected.goodId, currentCargo + selected.quantity);
      this.shipState.credits -= result.totalCost;
      const purchasePrice = result.totalCost / selected.quantity;
      const currentPurchasePrice = this.shipState.purchasePrices.get(selected.goodId);
      if (currentCargo > 0 && currentPurchasePrice) {
        this.shipState.purchasePrices.set(selected.goodId, ((currentPurchasePrice * currentCargo) + result.totalCost) / (currentCargo + selected.quantity));
      } else {
        this.shipState.purchasePrices.set(selected.goodId, purchasePrice);
      }
      this.dirty = true;
      return true;
    } catch (error) {
      console.error(`[Ship ${this.shipState.id}] Error executing buy trade:`, error);
      return false;
    }
  }

  private async trySellGoods(markets: Record<GoodId, MarketSnapshot>, _rng: DeterministicRNG): Promise<boolean> {
    if (!this.shipState) return false;
    const candidates: Array<{ goodId: GoodId; qty: number; profitMargin: number; price: number }> = [];
    const minProfitMargin = getMinProfitMargin();
    for (const [goodId, qty] of this.shipState.cargo.entries()) {
      if (qty <= 0) continue;
      const good = getGoodDefinition(goodId);
      const market = markets[goodId];
      if (!good || !market?.price || market.price <= 0) continue;
      const purchasePrice = this.shipState.purchasePrices.get(goodId);
      if (purchasePrice) {
        const profitMargin = (market.price - purchasePrice) / purchasePrice;
        if (profitMargin >= minProfitMargin) candidates.push({ goodId, qty, profitMargin, price: market.price });
      } else if (market.price >= good.basePrice * (1 + minProfitMargin)) {
        candidates.push({ goodId, qty, profitMargin: minProfitMargin, price: market.price });
      }
    }
    if (candidates.length === 0) return false;
    candidates.sort((a, b) => b.profitMargin - a.profitMargin);
    const selected = candidates[0];
    const quantity = selected.qty;

    try {
      const result = await this.executeTrade(selected.goodId, quantity, "sell");
      if (result.success && result.quantity && result.totalValue) {
        const currentCargo = this.shipState.cargo.get(selected.goodId) || 0;
        const newCargo = currentCargo - result.quantity;
        if (newCargo > 0) this.shipState.cargo.set(selected.goodId, newCargo);
        else {
          this.shipState.cargo.delete(selected.goodId);
          this.shipState.purchasePrices.delete(selected.goodId);
        }
        this.shipState.credits += result.totalValue;
        this.dirty = true;
        return true;
      }
    } catch (error) {
      console.error(`[Ship ${this.shipState.id}] Error executing sell trade:`, error);
    }
    return false;
  }

  private async tryTravel(rng: DeterministicRNG): Promise<boolean> {
    if (!this.shipState?.currentSystem || this.shipState.phase !== "at_station") return false;
    const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${this.shipState.currentSystem}`);
    const system = this.env.STAR_SYSTEM.get(systemStub) as { fetch: (request: Request | string) => Promise<Response> };
    let reachableSystems: Array<{ id: SystemId; distance: number }> = [];
    try {
      const systemObj = system as StarSystem;
      reachableSystems = await systemObj.getReachableSystems();
    } catch (error) {
      console.error(`[Ship ${this.shipState.id}] Error getting reachable systems:`, error);
      return false;
    }
    const validSystems = reachableSystems.filter(s => s.distance <= MAX_TRAVEL_DISTANCE);
    if (validSystems.length === 0) return false;
    const selected = rng.randomChoice(validSystems);
    this.shipState.destinationSystem = selected.id;
    this.shipState.phase = "traveling";
    this.shipState.travelStartTime = Date.now();
    const systemObj = system as StarSystem;
    await systemObj.shipDeparture(this.shipState.id);
    this.dirty = true;
    return true;
  }

  private async executeTrade(goodId: GoodId, quantity: number, type: "buy" | "sell"): Promise<{ success: boolean; error?: string; price?: number; totalCost?: number; totalValue?: number; tax?: number; quantity?: number; newInventory?: number }> {
    if (!this.shipState?.currentSystem) {
      return { success: false, error: "Ship not in system" };
    }
    const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${this.shipState.currentSystem}`);
    const system = this.env.STAR_SYSTEM.get(systemStub) as StarSystem;
    return await system.trade({ shipId: this.shipState.id, goodId, quantity, type });
  }

  /**
   * Execute a trade (buy or sell goods)
   * @param params - Trade parameters
   * @param params.goodId - Good ID to trade
   * @param params.quantity - Quantity to trade
   * @param params.type - "buy" or "sell"
   * @returns Trade result with success status, costs, and updated ship state
   */
  async trade(params: { goodId: GoodId; quantity: number; type: "buy" | "sell" }): Promise<{ success: boolean; error?: string; totalCost?: number; totalValue?: number; quantity?: number; ship?: ShipState }> {
    if (!this.shipState || this.shipState.isNPC || this.shipState.phase !== "at_station" || !this.shipState.currentSystem) {
      return { success: false, error: "Invalid trade request" };
    }
    if (!Number.isFinite(params.quantity) || params.quantity <= 0 || !Number.isInteger(params.quantity)) {
      return { success: false, error: "Invalid quantity" };
    }
    const currentCargo = this.shipState.cargo.get(params.goodId) || 0;
    if (params.type === "sell" && currentCargo < params.quantity) {
      return { success: false, error: "Insufficient cargo" };
    }
    const tradeData = await this.executeTrade(params.goodId, params.quantity, params.type);
    if (!tradeData.success) {
      return tradeData;
    }
    if (params.type === "buy") {
      const totalCost = Number(tradeData.totalCost) || 0;
      this.shipState.cargo.set(params.goodId, currentCargo + params.quantity);
      this.shipState.credits -= totalCost;
      const purchasePrice = totalCost / params.quantity;
      const currentPurchasePrice = this.shipState.purchasePrices.get(params.goodId);
      if (currentPurchasePrice && currentCargo > 0) {
        const totalCostWithExisting = (currentPurchasePrice * currentCargo) + totalCost;
        this.shipState.purchasePrices.set(params.goodId, totalCostWithExisting / (currentCargo + params.quantity));
      } else {
        this.shipState.purchasePrices.set(params.goodId, purchasePrice);
      }
    } else {
      const soldQuantity = Number.isFinite(tradeData.quantity) ? (tradeData.quantity ?? params.quantity) : params.quantity;
      this.shipState.cargo.set(params.goodId, Math.max(0, currentCargo - soldQuantity));
      this.shipState.credits += Number(tradeData.totalValue) || 0;
    }
    this.dirty = true;
    const serialize = (_key: string, value: unknown) => value instanceof Map ? Object.fromEntries(value) : value;
    const shipSnapshot = JSON.parse(JSON.stringify(this.shipState, serialize)) as ShipState;
    return { ...tradeData, ship: shipSnapshot };
  }

  private async handleTrade(request: Request): Promise<Response> {
    const body = (await request.json()) as { goodId: GoodId; quantity: number; type: "buy" | "sell" };
    const result = await this.trade(body);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Start travel to a destination system
   * @param params - Travel parameters
   * @param params.destinationSystem - Target system ID
   * @returns Travel result with success status and updated phase
   */
  async travel(params: { destinationSystem: SystemId }): Promise<{ success: boolean; error?: string; destinationSystem?: SystemId; phase?: ShipPhase }> {
    if (!this.shipState || this.shipState.isNPC || this.shipState.phase !== "at_station" || !this.shipState.currentSystem) {
      return { success: false, error: "Invalid travel request" };
    }
    if (!Number.isFinite(params.destinationSystem) || params.destinationSystem < 0 || params.destinationSystem >= 20 ||
        params.destinationSystem === this.shipState.currentSystem) {
      return { success: false, error: "Invalid destination system" };
    }
    this.shipState.destinationSystem = params.destinationSystem;
    this.shipState.phase = "traveling";
    this.shipState.travelStartTime = Date.now();
    this.dirty = true;
    return { success: true, destinationSystem: params.destinationSystem, phase: this.shipState.phase };
  }

  private async handleTravel(request: Request): Promise<Response> {
    const body = (await request.json()) as { destinationSystem: SystemId; distanceLy?: number };
    const result = await this.travel(body);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}
