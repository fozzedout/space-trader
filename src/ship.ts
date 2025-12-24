/**
 * Ship simulation object
 * 
 * Represents an NPC trader ship that:
 * - Travels between star systems
 * - Buys and sells goods based on price differences
 * - Has deterministic behavior using RNG
 * - Maintains cargo and credits
 */

import { DeterministicRNG } from "./deterministic-rng";
import {
  ShipState,
  ShipPhase,
  ShipId,
  SystemId,
  GoodId,
  Timestamp,
  TradeEvent,
  ShipArrivalEvent,
  ShipArmaments,
  LaserType,
  LaserMount,
  TechLevel,
} from "./types";
import { getGoodDefinition, getAllGoodIds } from "./goods";
import { DO_INTERNAL } from "./durable-object-helpers";
import { shouldLogTradeNow, logTrade, shouldLogDecisions, logDecision } from "./trade-logging";
import { getMinProfitMargin, getTradeScoringWeights } from "./balance-config";
import { updateShipPresence, removeShipPresence } from "./local-ship-registry";
import { recordRemoval } from "./galaxy-health";
import { recordTick, recordTrade, recordFailedTrade, updateTraderCredits, recordTravel } from "./leaderboard";
import {
  ARMAMENT_PRICES,
  ARMAMENT_TECH_LEVEL,
  FUEL_PRICE_PER_LY,
  FUEL_TANK_RANGE_LY,
  MAX_MISSILES,
  canInstallLaser,
  getAvailableArmaments,
  getDefaultArmaments,
  getLaserPrice,
  getLaserOptions,
  isValidLaserMount,
} from "./armaments";
import { profiler } from "./profiler";
import { getCachedSnapshot } from "./snapshot-cache";
import { StarSystem } from "./star-system";

const HYPERSPACE_TRAVEL_TIME_MS = 0; // Instant - NPCs are transferred to another system processor (horizontal scaling)
const DEPARTURE_TIME_MS = 10000; // ~10 seconds to leave planet's influence
const ARRIVAL_TIME_MS = 60000; // ~60 seconds to fly from spawn point to station
const SPAWN_LEEWAY_MS = 5000; // Random leeway for spawning (0-5 seconds)
const REST_TIME_MIN_MS = 5 * 60 * 1000; // 5 minutes minimum rest
const REST_TIME_MAX_MS = 60 * 60 * 1000; // 60 minutes maximum rest
const SLEEP_TIME_MAX_MS = 12 * 60 * 60 * 1000; // 12 hours maximum sleep
const REST_CHANCE_AFTER_TRADE = 0.3; // 30% chance to rest after trading
const SLEEP_CHANCE_AFTER_TRADE = 0.05; // 5% chance to sleep after trading (long rest)
const MAX_CARGO_SPACE = 100;
const INITIAL_CREDITS = 500; // Increased from 100 to give NPCs enough capital for meaningful trades
const VERY_LOW_CREDITS_THRESHOLD = 50; // Trigger emergency selling behavior
const AIR_PURIFIER_TAX = 0.01; // 0.01 credits per tick for air purifier maintenance
const SALES_TAX_RATE = 0.03; // 3% tax on purchases only (no tax on sales) - must match star-system.ts
const HULL_MAX = 100;
const HULL_REPAIR_COST_PER_POINT = 10;
const MAX_TRAVEL_DISTANCE = 15; // Maximum distance ships can travel
const MIN_TRAVEL_FUEL_LY = 5; // Minimum fuel reserve to keep short hops possible

// NPC lifecycle culling thresholds
const IMMOBILE_TICKS_TO_CULL = 4; // Remove if insolvent and immobile for K ticks
const STAGNATION_DECISIONS_TO_CULL = 75; // Remove if no successful trade in N decisions
const DRAWDOWN_LIMIT = 0.05; // Remove if credits < startCredits * DRAWDOWN_LIMIT AND made at least 10 trades
const MIN_TRADES_FOR_DRAWDOWN = 10; // Minimum trades before drawdown check applies

// Calculate low credit threshold relative to starting cash and fuel economics
// Formula: max( (minFuelReserveCredits + taxBuffer + 1 full cargo unit), 50–150 )
// This threshold is used for RECOVERY behavior (selling to get funds)
function calculateLowCreditsThreshold(): number {
  // Cost to refuel minimum fuel reserve (5 LY) with tax
  const minFuelReserveCredits = Math.ceil(MIN_TRAVEL_FUEL_LY * FUEL_PRICE_PER_LY * (1 + SALES_TAX_RATE));
  
  // Cost of 1 full cargo unit (using conservative estimate: textiles base price 20 + tax)
  const oneCargoUnitCost = Math.ceil(20 * (1 + SALES_TAX_RATE)); // ~21 credits
  
  // Calculate base threshold
  const baseThreshold = minFuelReserveCredits + oneCargoUnitCost;
  
  // Ensure minimum floor between 50-150 (using 100 as reasonable middle)
  return Math.max(baseThreshold, 100);
}

const LOW_CREDITS_THRESHOLD = calculateLowCreditsThreshold(); // Recovery threshold: triggers selling to get funds

// Rest gating threshold: prevents NPCs from resting when they should be actively trading
// Lowered to allow NPCs to rest more easily and recover from low credit states
// Formula: 1.5x recovery threshold, or 30% of starting credits, whichever is higher
function calculateRestGatingThreshold(): number {
  const recoveryThreshold = LOW_CREDITS_THRESHOLD;
  const startingCreditsPercentage = INITIAL_CREDITS * 0.3; // 30% of starting credits (lowered from 50%)
  return Math.max(recoveryThreshold * 1.5, startingCreditsPercentage); // 1.5x instead of 2x
}

const REST_GATING_THRESHOLD = calculateRestGatingThreshold(); // Rest gating: prevents resting when credits are low
const AU_IN_KM = 149597870.7;
const SU_IN_KM = AU_IN_KM * 0.01;
const SPEED_OF_LIGHT_KM_S = 299792;
const MAX_SPEED_C = 3;
const MAX_SPEED_SU_S = (SPEED_OF_LIGHT_KM_S * MAX_SPEED_C) / SU_IN_KM;
const ARRIVAL_MIN_SU = 30;
const ARRIVAL_MAX_SU = 36;

interface ShipEnv {
  STAR_SYSTEM: DurableObjectNamespace;
  SHIP: DurableObjectNamespace;
}

export class Ship {
  private state: DurableObjectState;
  private env: ShipEnv;
  private shipState: ShipState | null = null;
  private dirty: boolean = false; // Track if state needs to be flushed to DB
  // purchasePrices is now stored in shipState.purchasePrices - accessed via getter for convenience
  private get purchasePrices(): Map<GoodId, number> {
    if (!this.shipState) {
      // Fallback for edge cases during initialization - return empty map
      // This should rarely happen as shipState should be initialized before use
      return new Map();
    }
    return this.shipState.purchasePrices;
  }

  constructor(state: DurableObjectState, env: ShipEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // For initialize, don't load state - handleInitialize will handle clearing/resetting
      // For all other paths, load state on first access
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
      } else if (path === "/armaments" && request.method === "GET") {
        return this.handleGetArmaments();
      } else if (path === "/armaments" && request.method === "POST") {
        return this.handlePurchaseArmament(request);
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
      id: ShipId;
      name: string;
      currentSystem: SystemId | null;
      destinationSystem: SystemId | null;
      phase?: ShipPhase;
      departureStartTime?: Timestamp | null;
      hyperspaceStartTime?: Timestamp | null;
      arrivalStartTime?: Timestamp | null;
      arrivalCompleteTime?: Timestamp | null;
      restStartTime?: Timestamp | null;
      restEndTime?: Timestamp | null;
      // Legacy fields for backward compatibility
      departureTime?: Timestamp | null;
      arrivalTime?: Timestamp | null;
      positionX?: number | null;
      positionY?: number | null;
      arrivalStartX?: number | null;
      arrivalStartY?: number | null;
      cargo: Array<[GoodId, number]>;
      credits: number;
      isNPC: boolean;
      seed: string;
      armaments?: ShipArmaments;
      fuelLy?: number;
      fuelCapacityLy?: number;
      hullIntegrity?: number;
      hullMax?: number;
      originSystem?: SystemId | null;
      originPriceInfo?: Array<[GoodId, number]> | null;
      chosenDestinationSystemId?: SystemId | null;
      expectedMarginAtChoiceTime?: number | null;
      purchasePrices?: Array<[GoodId, number]>;
      immobileTicks?: number;
      lastSuccessfulTradeTick?: number;
      decisionCount?: number;
      lastCargoPurchaseTick?: number | null;
    }>("state");
    
    if (stored) {
      // Convert cargo Map from stored format
      // Handle migration from old format to new phase-based format
      if (stored.phase === undefined) {
        // Migrate from old format
        if (stored.departureTime && stored.arrivalTime) {
          const now = Date.now();
          if (now < stored.departureTime + DEPARTURE_TIME_MS) {
            stored.phase = "departing";
            stored.departureStartTime = stored.departureTime;
          } else if (now < stored.arrivalTime) {
            stored.phase = "in_hyperspace";
            stored.hyperspaceStartTime = stored.departureTime + DEPARTURE_TIME_MS;
          } else {
            stored.phase = "arriving";
            stored.arrivalStartTime = stored.arrivalTime;
            stored.arrivalCompleteTime = stored.arrivalTime + ARRIVAL_TIME_MS;
          }
        } else {
          stored.phase = "at_station";
        }
      }
      
      const defaultArmaments = getDefaultArmaments();
      const storedArmaments = stored.armaments;
      const armaments = storedArmaments && storedArmaments.lasers
        ? storedArmaments
        : defaultArmaments;
      const hullMax = stored.hullMax ?? HULL_MAX;
      const hullIntegrity = stored.hullIntegrity ?? hullMax;

      const now = Date.now();
      this.shipState = {
        id: stored.id,
        name: stored.name,
        currentSystem: stored.currentSystem,
        destinationSystem: stored.destinationSystem,
        phase: stored.phase || "at_station",
        positionX: stored.positionX ?? 0,
        positionY: stored.positionY ?? 0,
        arrivalStartX: stored.arrivalStartX ?? null,
        arrivalStartY: stored.arrivalStartY ?? null,
        departureStartTime: stored.departureStartTime ?? null,
        hyperspaceStartTime: stored.hyperspaceStartTime ?? null,
        arrivalStartTime: stored.arrivalStartTime ?? null,
        arrivalCompleteTime: stored.arrivalCompleteTime ?? null,
        restStartTime: stored.restStartTime ?? null,
        restEndTime: stored.restEndTime ?? null,
        cargo: new Map(stored.cargo || []),
        credits: stored.credits,
        isNPC: stored.isNPC,
        seed: stored.seed,
        armaments,
        fuelLy: stored.fuelLy ?? FUEL_TANK_RANGE_LY,
        fuelCapacityLy: stored.fuelCapacityLy ?? FUEL_TANK_RANGE_LY,
        hullIntegrity,
        hullMax,
        originSystem: stored.originSystem ?? null,
        originPriceInfo: stored.originPriceInfo ?? null,
        chosenDestinationSystemId: stored.chosenDestinationSystemId ?? null,
        expectedMarginAtChoiceTime: stored.expectedMarginAtChoiceTime ?? null,
        purchasePrices: new Map(stored.purchasePrices || []),
        immobileTicks: stored.immobileTicks ?? 0,
        lastSuccessfulTradeTick: stored.lastSuccessfulTradeTick ?? now,
        decisionCount: stored.decisionCount ?? 0,
        lastCargoPurchaseTick: stored.lastCargoPurchaseTick ?? null,
      };
      // Restore purchasePrices Map from shipState
      // purchasePrices is now accessed via getter - no assignment needed
      
      // Safety check: If ship is in an invalid state (no current system) but has cargo,
      // clear the cargo to prevent issues. This can happen if state is loaded before
      // proper initialization or if initialization failed.
      if (this.shipState.isNPC && 
          (this.shipState.currentSystem === null || this.shipState.currentSystem === undefined) &&
          this.shipState.cargo.size > 0 &&
          Array.from(this.shipState.cargo.values()).some(qty => qty > 0)) {
        console.warn(
          `[Ship ${this.shipState.id}] Loaded state with cargo but invalid currentSystem, clearing cargo. ` +
          `Cargo: [${Array.from(this.shipState.cargo.entries()).map(([g, q]) => `${g}:${q}`).join(", ")}]`
        );
        this.shipState.cargo.clear();
        this.purchasePrices.clear();
        this.dirty = true;
      }
      
      this.updatePosition(Date.now());
    }
  }

  private ensureHullState(): void {
    if (!this.shipState) return;
    if (this.shipState.hullMax == null || this.shipState.hullMax <= 0) {
      this.shipState.hullMax = HULL_MAX;
    }
    if (this.shipState.hullIntegrity == null || this.shipState.hullIntegrity <= 0) {
      this.shipState.hullIntegrity = this.shipState.hullMax;
    }
  }

  /**
   * Mark state as dirty (needs saving to DB)
   * Actual DB write happens via flushState() or periodic flush
   */
  private async saveState(): Promise<void> {
    if (!this.shipState) return;
    this.dirty = true;
  }

  /**
   * Flush state to database (called periodically or on request)
   * This now just marks the data as ready for batch flush
   */
  async flushState(): Promise<void> {
    if (!this.dirty || !this.shipState) return;
    
    // Store data in storage for batch flush
    // Convert Maps to arrays for serialization
    await this.state.storage.put("state", {
      ...this.shipState,
      cargo: Array.from(this.shipState.cargo.entries()),
      purchasePrices: Array.from(this.shipState.purchasePrices.entries()),
    });
    
    // Mark as not dirty - actual DB write happens in batch flush
    this.dirty = false;
  }

  private async handleGetState(): Promise<Response> {
    if (!this.shipState) {
      return new Response(JSON.stringify({ error: "Ship not initialized" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = Date.now();
    this.updatePosition(now);

    // For player ships, immediately process phase transitions (lazy evaluation)
    // This ensures players get instant updates without waiting for ticks
    if (!this.shipState.isNPC) {
      await this.processShipPhasesImmediate(now);
    }

    return new Response(JSON.stringify(this.shipState, (key, value) => {
      if (value instanceof Map) {
        return Object.fromEntries(value);
      }
      return value;
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Immediate phase processing for player ships (lazy evaluation)
   * Processes time-based phase transitions without full tick logic
   */
  private async processShipPhasesImmediate(now: Timestamp): Promise<void> {
    if (!this.shipState) return;

    switch (this.shipState.phase) {
      case "departing":
        // Check if departure phase is complete
        if (
          this.shipState.departureStartTime !== null &&
          now >= this.shipState.departureStartTime + DEPARTURE_TIME_MS
        ) {
          // Get origin system prices before transitioning
          if (this.shipState.originSystem !== null) {
            try {
              const originSystemStub = this.env.STAR_SYSTEM.idFromName(
                `system-${this.shipState.originSystem}`
              );
              const originSystem = this.env.STAR_SYSTEM.get(originSystemStub) as { fetch: (request: Request | string) => Promise<Response> };
              const snapshotResponse = await originSystem.fetch(DO_INTERNAL("/snapshot"));
              if (snapshotResponse.ok) {
                const snapshotData = (await snapshotResponse.json()) as {
                  markets: Record<GoodId, { price: number }>;
                };
                const priceInfo: Array<[GoodId, number]> = [];
                for (const [goodId, market] of Object.entries(snapshotData.markets)) {
                  priceInfo.push([goodId as GoodId, market.price]);
                }
                this.shipState.originPriceInfo = priceInfo;
              }
            } catch (error) {
              // Continue even if we can't get prices
            }
          }
          
          // Consume fuel when entering hyperspace
          if (this.shipState.destinationSystem !== null && this.shipState.originSystem !== null) {
            const distance = await this.calculateSystemDistance(
              this.shipState.originSystem,
              this.shipState.destinationSystem
            );
            this.shipState.fuelLy = Math.max(0, this.shipState.fuelLy - distance);
            this.dirty = true;
          }
          
          // Transition to hyperspace
          this.shipState.phase = "in_hyperspace";
          this.shipState.hyperspaceStartTime = now;
          this.shipState.positionX = null;
          this.shipState.positionY = null;
          this.dirty = true;
          updateShipPresence(this.shipState);
          
          // Notify current system of departure
          if (this.shipState.currentSystem !== null) {
            const systemStub = this.env.STAR_SYSTEM.idFromName(
              `system-${this.shipState.currentSystem}`
            );
            const system = this.env.STAR_SYSTEM.get(systemStub) as { fetch: (request: Request | string) => Promise<Response> };
            await system.fetch(
              new Request(DO_INTERNAL("/departure"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ shipId: this.shipState.id }),
              })
            );
          }
        }
        break;

      case "in_hyperspace":
        // Hyperspace is instant - immediately transition to arrival phase
        if (this.shipState.destinationSystem !== null) {
          const rng = new DeterministicRNG(this.shipState.seed);
          const spawnLeeway = rng.randomInt(0, SPAWN_LEEWAY_MS);
          const spawnDistance = rng.randomFloat(ARRIVAL_MIN_SU, ARRIVAL_MAX_SU);
          const spawnAngle = rng.random() * Math.PI * 2;
          this.shipState.arrivalStartX = Math.cos(spawnAngle) * spawnDistance;
          this.shipState.arrivalStartY = Math.sin(spawnAngle) * spawnDistance;
          this.shipState.positionX = this.shipState.arrivalStartX;
          this.shipState.positionY = this.shipState.arrivalStartY;

          this.shipState.phase = "arriving";
          this.shipState.currentSystem = this.shipState.destinationSystem;
          this.shipState.arrivalStartTime = now + spawnLeeway;
          const travelTimeMs = Math.round((spawnDistance / MAX_SPEED_SU_S) * 1000);
          this.shipState.arrivalCompleteTime = this.shipState.arrivalStartTime + travelTimeMs;
          this.dirty = true;
          updateShipPresence(this.shipState);
        }
        break;

      case "arriving":
        // Check if arrival phase is complete
        if (
          this.shipState.arrivalCompleteTime !== null &&
          now >= this.shipState.arrivalCompleteTime
        ) {
          if (this.shipState.currentSystem === null && this.shipState.destinationSystem !== null) {
            this.shipState.currentSystem = this.shipState.destinationSystem;
          }
          
          // Ship has reached the station
          try {
            await this.handleArrival();
          } catch (error) {
            // Don't rethrow - allow ship to continue processing
          }
        }
        break;

      case "resting":
      case "sleeping":
        // Check if rest/sleep is complete
        if (
          this.shipState.restEndTime !== null &&
          now >= this.shipState.restEndTime
        ) {
          this.shipState.phase = "at_station";
          this.shipState.restStartTime = null;
          this.shipState.restEndTime = null;
          this.shipState.positionX = 0;
          this.shipState.positionY = 0;
          this.dirty = true;
          updateShipPresence(this.shipState);
        }
        break;
    }
  }

  private updatePosition(now: number): void {
    if (!this.shipState) return;

    if (this.shipState.phase === "in_hyperspace") {
      this.shipState.positionX = null;
      this.shipState.positionY = null;
      return;
    }

    if (this.shipState.phase === "arriving") {
      const startX = this.shipState.arrivalStartX;
      const startY = this.shipState.arrivalStartY;
      const startTime = this.shipState.arrivalStartTime;
      const endTime = this.shipState.arrivalCompleteTime;
      if (startX === null || startY === null || startTime === null || endTime === null || endTime <= startTime) {
        return;
      }
      const progress = Math.min(1, Math.max(0, (now - startTime) / (endTime - startTime)));
      this.shipState.positionX = startX * (1 - progress);
      this.shipState.positionY = startY * (1 - progress);
      return;
    }

    this.shipState.positionX = 0;
    this.shipState.positionY = 0;
  }

  private async handleGetArmaments(): Promise<Response> {
    if (!this.shipState) {
      return new Response(JSON.stringify({ error: "Ship not initialized" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    this.ensureHullState();

    const techLevel = await this.getCurrentTechLevel();
    const available = techLevel !== null
      ? getAvailableArmaments(techLevel, this.shipState.armaments)
      : null;

    return new Response(JSON.stringify({
      armaments: this.shipState.armaments,
      fuelLy: this.shipState.fuelLy,
      fuelCapacityLy: this.shipState.fuelCapacityLy,
      hullIntegrity: this.shipState.hullIntegrity,
      hullMax: this.shipState.hullMax,
      techLevel,
      available,
      repairPrices: {
        hull: HULL_REPAIR_COST_PER_POINT,
      },
      prices: {
        lasers: getLaserOptions(techLevel ?? TechLevel.AGRICULTURAL).reduce((acc, laserType) => {
          acc[laserType] = getLaserPrice(laserType);
          return acc;
        }, {} as Record<string, number>),
        missile: ARMAMENT_PRICES.missile,
        ecm: ARMAMENT_PRICES.ecm,
        energyBomb: ARMAMENT_PRICES.energyBomb,
        fuel: FUEL_PRICE_PER_LY,
      },
      limits: {
        missiles: MAX_MISSILES,
      },
      salesTaxRate: SALES_TAX_RATE,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handlePurchaseArmament(request: Request): Promise<Response> {
    if (!this.shipState) {
      return new Response(JSON.stringify({ error: "Ship not initialized" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    this.ensureHullState();
    const techLevel = await this.getCurrentTechLevel();
    if (techLevel === null) {
      return new Response(JSON.stringify({ error: "Ship is not docked at a system" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = (await request.json()) as {
      category: "laser" | "missile" | "ecm" | "energyBomb" | "fuel" | "repair";
      operation?: "buy" | "sell" | "repair";
      item?: "hull";
      mount?: string;
      laserType?: string;
      quantity?: number;
    };

    const operation = body.operation ?? "buy";
    const applyTax = (amount: number): number => Math.ceil(amount * (1 + SALES_TAX_RATE));
    const applySellTax = (amount: number): number => amount; // No tax on sales

    if (operation === "repair") {
      if (body.item !== "hull") {
        return new Response(JSON.stringify({ error: "Invalid repair item" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const missing = Math.max(0, this.shipState.hullMax - this.shipState.hullIntegrity);
      if (missing <= 0) {
        return new Response(JSON.stringify({ error: "Hull is already fully repaired" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const requested = Math.max(1, Math.floor(body.quantity ?? missing));
      const repairPoints = Math.min(requested, missing);
      const baseCost = repairPoints * HULL_REPAIR_COST_PER_POINT;
      const totalCost = applyTax(baseCost);
      if (this.shipState.credits < totalCost) {
        return new Response(JSON.stringify({ error: "Insufficient credits", cost: totalCost }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      this.shipState.credits -= totalCost;
      this.shipState.hullIntegrity += repairPoints;
      this.dirty = true; // Mark as dirty - will be flushed at end of tick
      return new Response(JSON.stringify({
        success: true,
        repaired: repairPoints,
        cost: totalCost,
        hullIntegrity: this.shipState.hullIntegrity,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (operation === "sell") {
      if (body.category === "fuel") {
        return new Response(JSON.stringify({ error: "Fuel cannot be sold" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (body.category === "laser") {
        if (!body.mount || !isValidLaserMount(body.mount)) {
          return new Response(JSON.stringify({ error: "Invalid laser mount" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const existing = this.shipState.armaments.lasers[body.mount as LaserMount];
        if (!existing) {
          return new Response(JSON.stringify({ error: "No laser installed on mount" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const baseValue = getLaserPrice(existing);
        const payout = applySellTax(baseValue);
        this.shipState.credits += payout;
        this.shipState.armaments.lasers[body.mount as LaserMount] = null;
        this.dirty = true; // Mark as dirty - will be flushed at end of tick
        return new Response(JSON.stringify({ success: true, payout, armaments: this.shipState.armaments }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (body.category === "missile") {
        const quantity = Math.max(1, Math.floor(body.quantity ?? 1));
        if (this.shipState.armaments.missiles <= 0) {
          return new Response(JSON.stringify({ error: "No missiles to sell" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const sellQty = Math.min(quantity, this.shipState.armaments.missiles);
        const baseValue = sellQty * ARMAMENT_PRICES.missile;
        const payout = applySellTax(baseValue);
        this.shipState.armaments.missiles -= sellQty;
        this.shipState.credits += payout;
        this.dirty = true; // Mark as dirty - will be flushed at end of tick
        return new Response(JSON.stringify({ success: true, payout, armaments: this.shipState.armaments }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (body.category === "ecm") {
        if (!this.shipState.armaments.ecm) {
          return new Response(JSON.stringify({ error: "ECM not installed" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const baseValue = ARMAMENT_PRICES.ecm;
        const payout = applySellTax(baseValue);
        this.shipState.armaments.ecm = false;
        this.shipState.credits += payout;
        this.dirty = true; // Mark as dirty - will be flushed at end of tick
        return new Response(JSON.stringify({ success: true, payout, armaments: this.shipState.armaments }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (body.category === "energyBomb") {
        if (!this.shipState.armaments.energyBomb) {
          return new Response(JSON.stringify({ error: "Energy bomb not installed" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const baseValue = ARMAMENT_PRICES.energyBomb;
        const payout = applySellTax(baseValue);
        this.shipState.armaments.energyBomb = false;
        this.shipState.credits += payout;
        this.dirty = true; // Mark as dirty - will be flushed at end of tick
        return new Response(JSON.stringify({ success: true, payout, armaments: this.shipState.armaments }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (operation !== "buy") {
      return new Response(JSON.stringify({ error: "Invalid armament operation" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.category === "fuel") {
      const missing = this.shipState.fuelCapacityLy - this.shipState.fuelLy;
      if (missing <= 0) {
        return new Response(JSON.stringify({ error: "Fuel tank already full" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      // Calculate full tank cost
      const fullBaseCost = missing * FUEL_PRICE_PER_LY;
      const fullCost = applyTax(fullBaseCost);
      
      const logDecisions = shouldLogDecisions(this.shipState.id);
      const creditsBefore = this.shipState.credits;
      let fuelToBuy: number;
      let cost: number;
      
      if (this.shipState.credits >= fullCost) {
        // Can afford full tank - buy it
        fuelToBuy = missing;
        cost = fullCost;
        this.shipState.fuelLy = this.shipState.fuelCapacityLy;
      } else {
        // Can't afford full tank - buy what we can afford
        // Calculate max fuel we can buy with available credits
        // Cost per LY = FUEL_PRICE_PER_LY * (1 + SALES_TAX_RATE)
        const costPerLy = FUEL_PRICE_PER_LY * (1 + SALES_TAX_RATE);
        const maxFuelAffordable = Math.floor((this.shipState.credits / costPerLy) * 10) / 10; // Round to 0.1 LY
        
        if (maxFuelAffordable <= 0) {
          return new Response(JSON.stringify({ error: "Insufficient credits for any fuel", cost: fullCost }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        
        fuelToBuy = Math.min(maxFuelAffordable, missing);
        const baseCost = fuelToBuy * FUEL_PRICE_PER_LY;
        cost = applyTax(baseCost);
        
        // Ensure we don't exceed available credits (rounding might cause slight overage)
        if (cost > this.shipState.credits) {
          // Adjust down slightly if needed
          fuelToBuy = Math.floor(((this.shipState.credits / (1 + SALES_TAX_RATE)) / FUEL_PRICE_PER_LY) * 10) / 10;
          const adjustedBaseCost = fuelToBuy * FUEL_PRICE_PER_LY;
          cost = applyTax(adjustedBaseCost);
        }
        
        this.shipState.fuelLy = Math.min(
          this.shipState.fuelCapacityLy,
          this.shipState.fuelLy + fuelToBuy
        );
      }
      
      this.shipState.credits -= cost;
      
      if (logDecisions) {
        logDecision(this.shipState.id, `  Fuel purchase: credits ${creditsBefore.toFixed(2)} -> ${this.shipState.credits.toFixed(2)} (cost: ${cost.toFixed(2)} cr, bought ${fuelToBuy.toFixed(1)} LY, fuel now ${this.shipState.fuelLy.toFixed(1)}/${this.shipState.fuelCapacityLy.toFixed(1)} LY)`);
      }
      this.dirty = true; // Mark as dirty - will be flushed at end of tick
      return new Response(JSON.stringify({ success: true, cost, fuelLy: this.shipState.fuelLy, fuelBought: fuelToBuy }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.category === "laser") {
      if (!body.mount || !isValidLaserMount(body.mount)) {
        return new Response(JSON.stringify({ error: "Invalid laser mount" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const laserType = body.laserType as LaserType;
      if (!laserType || !canInstallLaser(techLevel, laserType)) {
        return new Response(JSON.stringify({ error: "Laser not available at this tech level" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const baseCost = getLaserPrice(laserType);
      const cost = applyTax(baseCost);
      if (this.shipState.credits < cost) {
        return new Response(JSON.stringify({ error: "Insufficient credits", cost }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const logDecisions = shouldLogDecisions(this.shipState.id);
      const creditsBefore = this.shipState.credits;
      this.shipState.credits -= cost;
      this.shipState.armaments.lasers[body.mount as LaserMount] = laserType;
      
      if (logDecisions) {
        logDecision(this.shipState.id, `  Laser purchase: credits ${creditsBefore.toFixed(2)} -> ${this.shipState.credits.toFixed(2)} (cost: ${cost} cr, ${laserType} on ${body.mount})`);
      }
      this.dirty = true; // Mark as dirty - will be flushed at end of tick
      return new Response(JSON.stringify({ success: true, cost, armaments: this.shipState.armaments }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.category === "missile") {
      const quantity = Math.max(1, Math.min(body.quantity ?? 1, MAX_MISSILES));
      if (techLevel < ARMAMENT_TECH_LEVEL.missile) {
        return new Response(JSON.stringify({ error: "Missiles not available at this tech level" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (this.shipState.armaments.missiles >= MAX_MISSILES) {
        return new Response(JSON.stringify({ error: "Missile rack is full" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const purchasable = Math.min(quantity, MAX_MISSILES - this.shipState.armaments.missiles);
      const baseCost = purchasable * ARMAMENT_PRICES.missile;
      const cost = applyTax(baseCost);
      if (this.shipState.credits < cost) {
        return new Response(JSON.stringify({ error: "Insufficient credits", cost }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      this.shipState.credits -= cost;
      this.shipState.armaments.missiles += purchasable;
      this.dirty = true; // Mark as dirty - will be flushed at end of tick
      return new Response(JSON.stringify({ success: true, cost, armaments: this.shipState.armaments }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.category === "ecm") {
      if (techLevel < ARMAMENT_TECH_LEVEL.ecm) {
        return new Response(JSON.stringify({ error: "ECM not available at this tech level" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (this.shipState.armaments.ecm) {
        return new Response(JSON.stringify({ error: "ECM already installed" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const baseCost = ARMAMENT_PRICES.ecm;
      const cost = applyTax(baseCost);
      if (this.shipState.credits < cost) {
        return new Response(JSON.stringify({ error: "Insufficient credits", cost }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const logDecisions = shouldLogDecisions(this.shipState.id);
      const creditsBefore = this.shipState.credits;
      this.shipState.credits -= cost;
      this.shipState.armaments.ecm = true;
      
      if (logDecisions) {
        logDecision(this.shipState.id, `  ECM purchase: credits ${creditsBefore.toFixed(2)} -> ${this.shipState.credits.toFixed(2)} (cost: ${cost} cr)`);
      }
      this.dirty = true; // Mark as dirty - will be flushed at end of tick
      return new Response(JSON.stringify({ success: true, cost, armaments: this.shipState.armaments }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.category === "energyBomb") {
      if (techLevel < ARMAMENT_TECH_LEVEL.energyBomb) {
        return new Response(JSON.stringify({ error: "Energy bomb not available at this tech level" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (this.shipState.armaments.energyBomb) {
        return new Response(JSON.stringify({ error: "Energy bomb already installed" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const baseCost = ARMAMENT_PRICES.energyBomb;
      const cost = applyTax(baseCost);
      if (this.shipState.credits < cost) {
        return new Response(JSON.stringify({ error: "Insufficient credits", cost }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const logDecisions = shouldLogDecisions(this.shipState.id);
      const creditsBefore = this.shipState.credits;
      this.shipState.credits -= cost;
      this.shipState.armaments.energyBomb = true;
      
      if (logDecisions) {
        logDecision(this.shipState.id, `  Energy bomb purchase: credits ${creditsBefore.toFixed(2)} -> ${this.shipState.credits.toFixed(2)} (cost: ${cost} cr)`);
      }
      this.dirty = true; // Mark as dirty - will be flushed at end of tick
      return new Response(JSON.stringify({ success: true, cost, armaments: this.shipState.armaments }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Invalid armament purchase" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async getCurrentTechLevel(): Promise<number | null> {
    if (!this.shipState || this.shipState.currentSystem === null) {
      return null;
    }
    if (this.shipState.phase !== "at_station" && this.shipState.phase !== "resting" && this.shipState.phase !== "sleeping") {
      return null;
    }

    try {
      // Try cache first
      const cachedSnapshot = getCachedSnapshot(this.shipState.currentSystem);
      if (cachedSnapshot && cachedSnapshot.state && cachedSnapshot.state.techLevel !== undefined) {
        return cachedSnapshot.state.techLevel;
      }
      
      // Fallback to fetch if not in cache or techLevel missing
      const systemStub = this.env.STAR_SYSTEM.idFromName(
        `system-${this.shipState.currentSystem}`
      );
      const system = this.env.STAR_SYSTEM.get(systemStub) as { fetch: (request: Request | string) => Promise<Response> };
      const snapshotResponse = await system.fetch(DO_INTERNAL("/snapshot"));
      if (!snapshotResponse.ok) {
        return null;
      }
      const snapshot = (await snapshotResponse.json()) as { state: { techLevel: number } };
      return snapshot.state.techLevel;
    } catch (error) {
      return null;
    }
  }

  private async handleInitialize(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      id: ShipId;
      name: string;
      systemId: SystemId;
      seed: string;
      isNPC: boolean;
    };

    // Allow reinitialization - FORCE clear ALL existing state FIRST
    // This must happen before any state loading to prevent stale cargo from persisting
    // Clear in-memory state immediately
    this.shipState = null;
    this.purchasePrices.clear();
    this.dirty = true;
    
    // Explicitly delete state from Durable Object storage to ensure no stale cargo persists
    // This is critical when reinitializing the galaxy - old cargo from previous
    // initialization could cause sell failures if markets changed
    try {
      const state = this.state;
      if (state?.storage && state.storage.delete) {
        await state.storage.delete("state");
      }
    } catch (error) {
      // Ignore storage errors during reset
    }

    const now = Date.now();
    this.shipState = {
      id: body.id,
      name: body.name,
      currentSystem: body.systemId,
      destinationSystem: null,
      phase: "at_station",
      positionX: 0,
      positionY: 0,
      arrivalStartX: null,
      arrivalStartY: null,
      departureStartTime: null,
      hyperspaceStartTime: null,
      arrivalStartTime: null,
      arrivalCompleteTime: null,
      restStartTime: null,
      restEndTime: null,
      cargo: new Map(), // Always start with empty cargo
      purchasePrices: new Map(), // Always start with empty purchase prices
      credits: INITIAL_CREDITS,
      isNPC: body.isNPC,
      seed: body.seed,
      armaments: getDefaultArmaments(),
      fuelLy: FUEL_TANK_RANGE_LY,
      fuelCapacityLy: FUEL_TANK_RANGE_LY,
      hullIntegrity: HULL_MAX,
      hullMax: HULL_MAX,
      originSystem: null,
      originPriceInfo: null,
      chosenDestinationSystemId: null,
      expectedMarginAtChoiceTime: null,
      immobileTicks: 0,
      lastSuccessfulTradeTick: now,
      decisionCount: 0,
      lastCargoPurchaseTick: null,
    };

    this.dirty = true; // Mark as dirty - will be flushed at end of tick
    updateShipPresence(this.shipState);

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleTick(request: Request): Promise<Response> {
    if (!this.shipState) {
      return new Response(JSON.stringify({ error: "Ship not initialized" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = Date.now();
    const rng = new DeterministicRNG(this.shipState.seed);
    const isTravelingTick = request.headers.get("X-Traveling-Tick") === "true";

    // Apply air purifier tax to NPCs (1 credit per tick)
    // Air purifier tax only applies when NPC is at a station (not while traveling)
    if (this.shipState.isNPC && this.shipState.phase === "at_station") {
      const logDecisions = shouldLogDecisions(this.shipState.id);
      const creditsBefore = this.shipState.credits;
      const hasCargo = this.shipState.cargo.size > 0 &&
        Array.from(this.shipState.cargo.values()).some((qty) => qty > 0);
      if (creditsBefore < AIR_PURIFIER_TAX) {
        if (hasCargo) {
          if (logDecisions) {
            logDecision(this.shipState.id, `  Air purifier tax: credits ${creditsBefore.toFixed(2)} -> ${creditsBefore.toFixed(2)} (tax: ${AIR_PURIFIER_TAX} cr, skipped - low credits with cargo)`);
          }
        } else {
          if (logDecisions) {
            logDecision(this.shipState.id, `  Air purifier tax: credits ${creditsBefore.toFixed(2)} -> ${creditsBefore.toFixed(2)} (tax: ${AIR_PURIFIER_TAX} cr, insufficient funds)`);
          }
          const reason = `bankrupt (credits: ${creditsBefore.toFixed(2)}, cannot pay ${AIR_PURIFIER_TAX} cr tax)`;
          await this.removeNPC(reason);
          return new Response(JSON.stringify({ success: true, removed: true, reason: "bankrupt" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (creditsBefore >= AIR_PURIFIER_TAX) {
        this.shipState.credits = Math.max(0, creditsBefore - AIR_PURIFIER_TAX);
        this.dirty = true;
        
        if (logDecisions) {
          logDecision(this.shipState.id, `  Air purifier tax: credits ${creditsBefore.toFixed(2)} -> ${this.shipState.credits.toFixed(2)} (tax: ${AIR_PURIFIER_TAX} cr)`);
        }
        
        // If NPC can't pay the tax (credits <= 0), remove only when there's no cargo to sell
        if (this.shipState.credits <= 0 && !hasCargo) {
          const reason = `bankrupt (credits: ${this.shipState.credits.toFixed(2)}, cannot pay ${AIR_PURIFIER_TAX} cr tax)`;
          await this.removeNPC(reason);
          return new Response(JSON.stringify({ success: true, removed: true, reason: "bankrupt" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    // Process ship phases based on current state
    await profiler.timeAsync(`ship-${this.shipState.id}-processShipPhases`, () => 
      this.processShipPhases(now, rng)
    );

    // Skip processing if NPC is resting or sleeping (ignore pool)
    if (
      this.shipState &&
      this.shipState.isNPC &&
      (this.shipState.phase === "resting" || this.shipState.phase === "sleeping")
    ) {
      profiler.time("ship-updatePresence-resting", () => {
        if (this.shipState) updateShipPresence(this.shipState);
      });
      this.dirty = true; // Mark as dirty - will be flushed at end of tick
      return new Response(JSON.stringify({ success: true, skipped: true, reason: "resting" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Record tick for leaderboard
    try {
      if (this.shipState && this.shipState.isNPC) {
        profiler.time("ship-leaderboard-recordTick", () => {
          if (this.shipState) {
            recordTick(this.shipState.id, this.shipState.name);
            updateTraderCredits(this.shipState.id, this.shipState.name, this.shipState.credits);
          }
        });
      }
    } catch (error) {
      // Don't let leaderboard errors break ticks
    }

    // If ship is at station and is NPC, make trading decisions
    if (
      this.shipState &&
      this.shipState.phase === "at_station" &&
      this.shipState.currentSystem !== null &&
      this.shipState.isNPC &&
      !isTravelingTick
    ) {
      try {
        await profiler.timeAsync(`ship-${this.shipState.id}-makeNPCTradingDecision`, () => 
          this.makeNPCTradingDecision()
        );
      } catch (error) {
        console.error(`[Ship ${this.shipState.id}] Error in makeNPCTradingDecision:`, error);
      }
    }

    if (this.shipState) {
      const shipState = this.shipState; // Capture for closure
      profiler.time("ship-updatePresence", () => updateShipPresence(shipState));
    }
    
    // Mark as dirty during tick - will be flushed at end of galaxy tick
    this.dirty = true;

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async processShipPhases(now: Timestamp, rng: DeterministicRNG): Promise<void> {
    if (!this.shipState) return;

    switch (this.shipState.phase) {
      case "departing":
        // Check if departure phase is complete
        if (
          this.shipState.departureStartTime !== null &&
          now >= this.shipState.departureStartTime + DEPARTURE_TIME_MS
        ) {
          // Fix: Get origin system prices before transitioning
          // Store origin prices for arrival effects
          if (this.shipState.originSystem !== null) {
            try {
              const originSystemStub = this.env.STAR_SYSTEM.idFromName(
                `system-${this.shipState.originSystem}`
              );
              const originSystem = this.env.STAR_SYSTEM.get(originSystemStub) as { fetch: (request: Request | string) => Promise<Response> };
              const snapshotResponse = await originSystem.fetch(DO_INTERNAL("/snapshot"));
              if (snapshotResponse.ok) {
                const snapshotData = (await snapshotResponse.json()) as {
                  markets: Record<GoodId, { price: number }>;
                };
                const priceInfo: Array<[GoodId, number]> = [];
                for (const [goodId, market] of Object.entries(snapshotData.markets)) {
                  priceInfo.push([goodId as GoodId, market.price]);
                }
                this.shipState.originPriceInfo = priceInfo;
              }
            } catch (error) {
              console.error(`[Ship ${this.shipState.id}] Error getting origin prices:`, error);
              // Continue even if we can't get prices
            }
          }
          
          // Fix: Consume fuel when entering hyperspace
          if (this.shipState.destinationSystem !== null && this.shipState.originSystem !== null) {
            const distance = await this.calculateSystemDistance(
              this.shipState.originSystem,
              this.shipState.destinationSystem
            );
            this.shipState.fuelLy = Math.max(0, this.shipState.fuelLy - distance);
            this.dirty = true;
          }
          
          // Transition to hyperspace
          this.shipState.phase = "in_hyperspace";
          this.shipState.hyperspaceStartTime = now;
          this.shipState.positionX = null;
          this.shipState.positionY = null;
          this.dirty = true;
          updateShipPresence(this.shipState);
          
          // Notify current system of departure
          if (this.shipState.currentSystem !== null) {
            const systemStub = this.env.STAR_SYSTEM.idFromName(
              `system-${this.shipState.currentSystem}`
            );
            const system = this.env.STAR_SYSTEM.get(systemStub) as { fetch: (request: Request | string) => Promise<Response> };
            await system.fetch(
              new Request(DO_INTERNAL("/departure"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ shipId: this.shipState.id }),
              })
            );
          }
        }
        break;

      case "in_hyperspace":
        // Hyperspace is instant (0ms) - NPCs are transferred to another system processor
        // Immediately transition to arrival phase
        if (this.shipState.destinationSystem !== null) {
          this.shipState.phase = "arriving";
          this.shipState.currentSystem = this.shipState.destinationSystem;
          
          // Add random spawn leeway (0-5 seconds)
          const spawnLeeway = rng.randomInt(0, SPAWN_LEEWAY_MS);
          const spawnDistance = rng.randomFloat(ARRIVAL_MIN_SU, ARRIVAL_MAX_SU);
          const spawnAngle = rng.random() * Math.PI * 2;
          this.shipState.arrivalStartX = Math.cos(spawnAngle) * spawnDistance;
          this.shipState.arrivalStartY = Math.sin(spawnAngle) * spawnDistance;
          this.shipState.positionX = this.shipState.arrivalStartX;
          this.shipState.positionY = this.shipState.arrivalStartY;

          this.shipState.arrivalStartTime = now + spawnLeeway;
          const travelTimeMs = Math.round((spawnDistance / MAX_SPEED_SU_S) * 1000);
          this.shipState.arrivalCompleteTime = this.shipState.arrivalStartTime + travelTimeMs;
          updateShipPresence(this.shipState);
        }
        break;

      case "arriving":
        // Check if arrival phase is complete
        if (
          this.shipState.arrivalCompleteTime !== null &&
          now >= this.shipState.arrivalCompleteTime
        ) {
          // Ensure currentSystem is set (it should be set when transitioning from hyperspace)
          // If not, use destinationSystem as fallback
          if (this.shipState.currentSystem === null && this.shipState.destinationSystem !== null) {
            this.shipState.currentSystem = this.shipState.destinationSystem;
          }
          
          // Ship has reached the station
          try {
            await this.handleArrival();
          } catch (error) {
            console.error(`[Ship ${this.shipState.id}] Error in handleArrival:`, error);
            // Don't rethrow - allow ship to continue processing
          }
        } else {
          this.updatePosition(now);
        }
        break;

      case "at_station":
        // Ship is at station, no phase processing needed
        this.shipState.positionX = 0;
        this.shipState.positionY = 0;
        break;

      case "resting":
      case "sleeping":
        // Check if rest/sleep is complete
        if (
          this.shipState.restEndTime !== null &&
          now >= this.shipState.restEndTime
        ) {
          // Rest/sleep complete, return to active state
          this.shipState.phase = "at_station";
          this.shipState.restStartTime = null;
          this.shipState.restEndTime = null;
          this.shipState.positionX = 0;
          this.shipState.positionY = 0;
          updateShipPresence(this.shipState);
        } else {
          this.shipState.positionX = 0;
          this.shipState.positionY = 0;
        }
        break;
    }
  }

  private async handleArrival(): Promise<void> {
    if (!this.shipState) {
      console.warn(`[Ship] handleArrival called but shipState is null`);
      return;
    }
    
    const shipId = this.shipState.id;
    return await profiler.timeAsync(`ship-${shipId}-handleArrival`, async () => {
      if (!this.shipState) {
        console.warn(`[Ship] handleArrival called but shipState is null`);
        return;
      }

      // Get the system ID - use currentSystem if available, otherwise use destinationSystem
      // This handles cases where currentSystem might not be set yet
      const systemId = this.shipState.currentSystem ?? this.shipState.destinationSystem;
      if (systemId === null || systemId === undefined) {
        console.warn(`[Ship ${this.shipState.id}] handleArrival called but both currentSystem and destinationSystem are null`);
        return;
      }
      const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${systemId}`);
      const system = this.env.STAR_SYSTEM.get(systemStub) as StarSystem | { fetch: (request: Request | string) => Promise<Response> };

      try {
      // Fix: Use stored origin system and prices instead of destination system
      const fromSystem = this.shipState.originSystem;
      let priceInfo: Array<[GoodId, number]>;
      
      if (this.shipState.originPriceInfo && this.shipState.originPriceInfo.length > 0) {
        // Use stored origin prices
        priceInfo = this.shipState.originPriceInfo;
      } else {
        // Fallback: try to get prices from origin system if we have it (use cache if available)
        if (fromSystem !== null && fromSystem !== systemId) {
          try {
            const cachedOriginSnapshot = getCachedSnapshot(fromSystem);
            if (cachedOriginSnapshot && cachedOriginSnapshot.markets) {
              // Use cached snapshot
              priceInfo = [];
              for (const [goodId, market] of Object.entries(cachedOriginSnapshot.markets)) {
                priceInfo.push([goodId as GoodId, market.price]);
              }
            } else {
              // Fallback to fetch if not in cache
              const originSystemStub = this.env.STAR_SYSTEM.idFromName(`system-${fromSystem}`);
              const originSystem = this.env.STAR_SYSTEM.get(originSystemStub) as { fetch: (request: Request | string) => Promise<Response> };
              const snapshotResponse = await originSystem.fetch(DO_INTERNAL("/snapshot"));
              if (snapshotResponse.ok) {
                const snapshotData = (await snapshotResponse.json()) as {
                  markets: Record<GoodId, { price: number }>;
                };
                priceInfo = [];
                for (const [goodId, market] of Object.entries(snapshotData.markets)) {
                  priceInfo.push([goodId as GoodId, market.price]);
                }
              } else {
                priceInfo = [];
              }
            }
          } catch (error) {
            console.error(`[Ship ${this.shipState.id}] Error getting origin prices:`, error);
            priceInfo = [];
          }
        } else {
          priceInfo = [];
        }
      }

      // Notify destination system of arrival
      if (!this.shipState) {
        throw new Error("shipState is null");
      }
      const shipIdForArrival = this.shipState.id;
      const cargoForArrival = Array.from(this.shipState.cargo.entries());
      
      // For NPCs in local mode, call the function directly to bypass fetch overhead
      // In local mode, system.get() returns the actual StarSystem instance
      if (this.shipState.isNPC && system) {
        // Try direct function call first (local mode)
        // Build arrival event
        const arrivalEvent: ShipArrivalEvent = {
          timestamp: Date.now(),
          shipId: shipIdForArrival,
          fromSystem: fromSystem !== null ? fromSystem : systemId,
          toSystem: systemId,
          cargo: new Map(cargoForArrival),
          priceInfo: new Map(priceInfo),
        };
        
        // Try to call applyArrivalEffects directly
        // In local mode, system.get() returns the actual StarSystem instance
        let usedDirectCall = false;
        
        // Try to access the method directly - check both instance and prototype
        // TypeScript allows accessing the method even if it might not exist at runtime
        try {
          const systemAsStarSystem = system as StarSystem;
          // Try accessing the method - if it exists, call it
          if (systemAsStarSystem.applyArrivalEffects && typeof systemAsStarSystem.applyArrivalEffects === 'function') {
            await profiler.timeAsync(`ship-${shipIdForArrival}-handleArrival-direct-${systemId}`, async () => {
              await systemAsStarSystem.applyArrivalEffects(arrivalEvent);
            });
            usedDirectCall = true;
          } else {
            // Try prototype chain
            const proto = Object.getPrototypeOf(system);
            if (proto && proto.applyArrivalEffects && typeof proto.applyArrivalEffects === 'function') {
              await profiler.timeAsync(`ship-${shipIdForArrival}-handleArrival-direct-${systemId}`, async () => {
                await proto.applyArrivalEffects.call(systemAsStarSystem, arrivalEvent);
              });
              usedDirectCall = true;
            }
          }
        } catch (error) {
          // Method doesn't exist or call failed - will fall back to fetch
          // This is expected in Cloudflare Workers mode
        }
        
        // Fallback to fetch if direct call wasn't used
        if (!usedDirectCall) {
          const systemWithFetch = system as { fetch: (request: Request | string) => Promise<Response> };
          const arrivalResponse = await profiler.timeAsync(`ship-${shipIdForArrival}-handleArrival-notify-${systemId}`, async () => {
            return await systemWithFetch.fetch(
              new Request(DO_INTERNAL("/arrival"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  timestamp: Date.now(),
                  shipId: shipIdForArrival,
                  fromSystem: fromSystem !== null ? fromSystem : systemId,
                  toSystem: systemId,
                  cargo: cargoForArrival,
                  priceInfo: priceInfo,
                }),
              })
            );
          });
          if (!arrivalResponse.ok) {
            throw new Error(`Failed to notify arrival: ${arrivalResponse.status}`);
          }
        }
      } else {
        // Fallback to fetch for players or Cloudflare Workers
        const systemWithFetch = system as { fetch: (request: Request | string) => Promise<Response> };
        const arrivalResponse = await profiler.timeAsync(`ship-${shipIdForArrival}-handleArrival-notify-${systemId}`, async () => {
          return await systemWithFetch.fetch(
            new Request(DO_INTERNAL("/arrival"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                timestamp: Date.now(),
                shipId: shipIdForArrival,
                fromSystem: fromSystem !== null ? fromSystem : systemId, // Use stored origin system
                toSystem: systemId,
                cargo: cargoForArrival,
                priceInfo: priceInfo,
              }),
            })
          );
        });

        if (!arrivalResponse.ok) {
          throw new Error(`Failed to notify arrival: ${arrivalResponse.status}`);
        }
      }

      // Record travel route for leaderboard (before clearing destinationSystem)
      try {
        const fromSystem = this.shipState.originSystem; // Use stored origin system
        if (fromSystem !== null && fromSystem !== systemId && this.shipState.isNPC) {
          recordTravel(this.shipState.id, fromSystem, systemId);
        }
      } catch (error) {
        // Don't let leaderboard errors break arrival
      }
      
      // Update ship state - ship is now at station
      this.shipState.phase = "at_station";
      this.shipState.destinationSystem = null;
      this.shipState.originSystem = null; // Clear origin system
      this.shipState.originPriceInfo = null; // Clear origin prices
      this.shipState.departureStartTime = null;
      this.shipState.hyperspaceStartTime = null;
      this.shipState.arrivalStartTime = null;
      this.shipState.arrivalCompleteTime = null;
      this.shipState.restStartTime = null;
      this.shipState.restEndTime = null;
      this.shipState.positionX = 0;
      this.shipState.positionY = 0;
      this.shipState.arrivalStartX = null;
      this.shipState.arrivalStartY = null;
      updateShipPresence(this.shipState);
      } catch (error) {
        console.error(`[Ship ${this.shipState.id}] Error in handleArrival for system ${systemId}:`, error);
        throw error; // Re-throw so caller can handle it
      }
    });
  }

  private async makeNPCTradingDecision(): Promise<void> {
    if (!this.shipState || this.shipState.currentSystem === null || this.shipState.currentSystem === undefined) {
      return;
    }

    // If NPC is already resting or sleeping, don't make trading decisions
    // Rest/sleep periods are handled in processShipPhases
    if (this.shipState.phase === "resting" || this.shipState.phase === "sleeping") {
      return;
    }

    // Check if NPC should be culled
    const cullReason = await this.checkNPCCulling();
    if (cullReason) {
      await this.removeNPC(cullReason);
      return;
    }

    const logDecisions = shouldLogDecisions(this.shipState.id);
    if (logDecisions) {
      logDecision(this.shipState.id, `Starting trading decision - phase: ${this.shipState.phase}, system: ${this.shipState.currentSystem}, credits: ${this.shipState.credits.toFixed(2)}, cargo: ${Array.from(this.shipState.cargo.entries()).map(([g, q]) => `${g}:${q}`).join(", ") || "empty"}`);
    }

    // Increment decision count for lifecycle tracking
    this.shipState.decisionCount = (this.shipState.decisionCount || 0) + 1;
    this.dirty = true;

    const rng = new DeterministicRNG(this.shipState.seed);
    // Use a deterministic counter based on ship state, current system tick, and time
    // This ensures reproducible behavior while still having variation per decision
    // We use credits, cargo size, current system, and tick count to create variation
    // Add time component to ensure decisions change over time even if state is static
    const now = Date.now();
    const tickCount = Math.floor(now / 10000); // Rough tick count (10s intervals)
    const decisionCounter = 
      (this.shipState.credits % 1000) + 
      (this.shipState.cargo.size * 100) + 
      (this.shipState.currentSystem * 10) +
      (tickCount % 1000); // Add time-based variation
    const decisionRng = rng.derive(`decision-${decisionCounter}`);

    // Check if NPC has cargo - if so, prioritize trading over resting
    const hasCargo = this.shipState.cargo.size > 0 && 
                     Array.from(this.shipState.cargo.values()).some(qty => qty > 0);
    
    // NPCs that just arrived may rest before trading
    // Small chance to rest immediately after arrival (10%)
    // But only if they have enough credits (don't rest if broke)
    // AND only if they don't have cargo (cargo must be sold/traveled first)
    const restChance = decisionRng.random();
    if (logDecisions) {
      logDecision(this.shipState.id, `Rest chance check: roll=${restChance.toFixed(3)}, threshold=0.1, credits=${this.shipState.credits.toFixed(2)}, restGatingThreshold=${REST_GATING_THRESHOLD}, hasCargo=${hasCargo}`);
    }
    if (this.shipState.phase === "at_station" && 
        this.shipState.credits >= REST_GATING_THRESHOLD &&
        !hasCargo && // Don't rest if carrying cargo
        restChance < 0.1) {
      if (logDecisions) {
        logDecision(this.shipState.id, `DECISION: Starting rest (chance=${restChance.toFixed(3)})`);
      }
      await this.maybeStartRest(decisionRng);
      return; // Skip trading this tick if starting rest
    }

    // Get current system market snapshot (use cache if available)
    let snapshot: { markets: Record<GoodId, { price: number; inventory: number; production?: number; consumption?: number }> };
    try {
      const cachedSnapshot = getCachedSnapshot(this.shipState.currentSystem);
      if (cachedSnapshot) {
        // Use cached snapshot
        snapshot = { markets: cachedSnapshot.markets };
      } else {
        // Fallback to fetch if not in cache
        const systemStub = this.env.STAR_SYSTEM.idFromName(
          `system-${this.shipState.currentSystem}`
        );
        const system = this.env.STAR_SYSTEM.get(systemStub) as { fetch: (request: Request | string) => Promise<Response> };
        snapshot = await profiler.timeAsync(`ship-${this.shipState?.id || 'unknown'}-getSnapshot-system-${this.shipState?.currentSystem || 'unknown'}`, async () => {
          const snapshotResponse = await system.fetch(DO_INTERNAL("/snapshot"));
          if (!snapshotResponse.ok) {
            const shipId = this.shipState?.id || 'unknown';
            console.error(`[Ship ${shipId}] Failed to get snapshot: ${snapshotResponse.status}`);
            throw new Error(`Failed to get snapshot: ${snapshotResponse.status}`);
          }
          return (await snapshotResponse.json()) as {
            markets: Record<GoodId, { price: number; inventory: number; production?: number; consumption?: number }>;
          };
        });
      }
    } catch (error) {
      console.error(`[Ship ${this.shipState.id}] Error fetching snapshot:`, error);
      return;
    }

    // Strategic trading decision based on cargo state
    // (hasCargo already checked above for rest decision)
    const usedSpace = Array.from(this.shipState.cargo.values()).reduce((sum, qty) => sum + qty, 0);

    if (logDecisions) {
      logDecision(this.shipState.id, `Cargo state: hasCargo=${hasCargo}, usedSpace=${usedSpace}/${MAX_CARGO_SPACE}`);
    }

    try {
      if (hasCargo) {
        // Ship has cargo - check if we should sell here (only if profitable)
        // NPCs should: Buy → Travel → Sell (if profitable) → Refuel → Repeat
        const shouldSellHere = this.shouldSellAtCurrentSystem(snapshot.markets);
        
        if (logDecisions) {
          logDecision(this.shipState.id, `DECISION: Has cargo - shouldSellHere=${shouldSellHere}`);
        }
        
        let actionTaken = false;
        
        if (shouldSellHere) {
          // Try to sell (only if profitable)
          if (logDecisions) {
            logDecision(this.shipState.id, `ACTION: Attempting to sell goods (profitable)`);
          }
          const cargoBeforeSell = Array.from(this.shipState.cargo.entries()).filter(([_, qty]) => qty > 0).map(([g, q]) => `${g}:${q}`).join(", ") || "none";
          const creditsBeforeSell = this.shipState.credits;
          
          // Check if we can afford fuel - if not, this is an emergency
          const fuelReserveCredits = this.getFuelReserveCredits();
          const canAffordFuel = this.shipState.credits >= fuelReserveCredits;
          
          // Only allow relaxed/forced sell in true emergencies:
          // 1. Can't afford fuel - sell minimum to cover fuel cost
          // 2. Maintenance/debt is due this tick and credits insufficient
          const maintenanceDue = this.shipState.credits < AIR_PURIFIER_TAX;
          const emergencySell = !canAffordFuel || maintenanceDue;
          
          if (logDecisions && emergencySell) {
            logDecision(this.shipState.id, `  Emergency sell: canAffordFuel=${canAffordFuel}, maintenanceDue=${maintenanceDue}`);
          }
          const sold = await profiler.timeAsync(`ship-${this.shipState.id}-trySellGoods`, () => 
            this.trySellGoods(snapshot.markets, decisionRng, emergencySell)
          );
          actionTaken = sold;
          if (logDecisions) {
            const remainingCargo = Array.from(this.shipState.cargo.entries()).filter(([_, qty]) => qty > 0).map(([g, q]) => `${g}:${q}`).join(", ") || "none";
            logDecision(this.shipState.id, `RESULT: Sell attempt ${sold ? "SUCCESS" : "FAILED"} (cargo before: ${cargoBeforeSell}, after: ${remainingCargo}, credits: ${creditsBeforeSell.toFixed(2)} -> ${this.shipState.credits.toFixed(2)})`);
          }
          
          if (sold) {
            // Successfully sold - check if we should buy or travel now
            const stillHasCargo = this.shipState.cargo.size > 0 && 
                                  Array.from(this.shipState.cargo.values()).some(qty => qty > 0);
            if (!stillHasCargo) {
              // No cargo left - check if there are good buying opportunities at this system
              const usedSpace = Array.from(this.shipState.cargo.values()).reduce((sum, qty) => sum + qty, 0);
              const availableSpace = MAX_CARGO_SPACE - usedSpace;
              
              // Use dynamic tax buffer for low-credit NPCs
              const fuelReserveCredits = this.getFuelReserveCredits();
              const spendableCredits = Math.max(0, this.shipState.credits - fuelReserveCredits);
              if (availableSpace > 0 && spendableCredits > 0) {
                // Check if there are goods with good prices (price ratio < 0.8 = significantly below base)
                // Sales tax (5%) makes same-system buy-sell loops unprofitable, so NPCs will naturally travel
                let hasGoodBuyOpportunity = false;
                for (const [goodId, market] of Object.entries(snapshot.markets)) {
                  const good = getGoodDefinition(goodId as GoodId);
                  if (good && market.inventory > 0 && market.price > 0) {
                    const priceRatio = market.price / good.basePrice;
                    // Only consider buying if price is significantly below base (production world)
                    // AND we can afford it (including tax) AND there's space
                    const effectiveBuyPrice = market.price * (1 + SALES_TAX_RATE);
                    if (priceRatio < 0.8 && spendableCredits >= effectiveBuyPrice) {
                      hasGoodBuyOpportunity = true;
                      break;
                    }
                  }
                }
                
                if (hasGoodBuyOpportunity) {
                  // Good buying opportunity - try to buy
                  if (logDecisions) {
                    logDecision(this.shipState.id, `  After successful sell: good buy opportunity found, attempting to buy goods`);
                  }
                  const bought = await profiler.timeAsync(`ship-${this.shipState.id}-tryBuyGoods`, () => 
                    this.tryBuyGoods(snapshot.markets, decisionRng)
                  );
                  if (!bought) {
                    // Couldn't buy - travel to find goods
                    if (logDecisions) {
                      logDecision(this.shipState.id, `  Buy failed after sell, attempting travel`);
                    }
                    await profiler.timeAsync(`ship-${this.shipState.id}-tryTravel`, () => 
                      this.tryTravel(decisionRng)
                    );
                  }
                } else {
                  // No good buying opportunities - travel to find better markets
                  if (logDecisions) {
                    logDecision(this.shipState.id, `  After sell: no good buy opportunities at current system, traveling to find better markets`);
                  }
                  await this.tryTravel(decisionRng);
                }
              } else {
                // Not enough credits or space - travel to find better opportunities
                if (logDecisions) {
                  logDecision(this.shipState.id, `  After sell: traveling (credits=${this.shipState.credits.toFixed(2)}, space=${availableSpace})`);
                }
                await this.tryTravel(decisionRng);
              }
            }
          } else if (!sold) {
            // Selling failed - try to travel instead
            const cargoSummary = Array.from(this.shipState.cargo.entries())
              .filter(([_, qty]) => qty > 0)
              .map(([g, q]) => `${g}:${q}`)
              .join(", ") || "none";
            if (logDecisions) {
              logDecision(this.shipState.id, `FALLBACK: Sell failed, attempting travel (cargo: ${cargoSummary})`);
            }
            console.warn(
              `[Ship ${this.shipState.id}] Sell failed, trying to travel. ` +
              `Cargo: [${cargoSummary}], credits: ${this.shipState.credits.toFixed(2)}, ` +
              `current system: ${this.shipState.currentSystem}`
            );
            const travelStarted = await profiler.timeAsync(`ship-${this.shipState.id}-tryTravel`, () => 
            this.tryTravel(decisionRng)
          );
            actionTaken = travelStarted;
            if (travelStarted) {
              if (logDecisions) {
                logDecision(this.shipState.id, `Travel started successfully after sell failure`);
              }
            } else {
              console.warn(
                `[Ship ${this.shipState.id}] Travel also failed after sell failure. ` +
                `Cargo: [${cargoSummary}], credits: ${this.shipState.credits.toFixed(2)}`
              );
            }
            
            if (!travelStarted) {
              // Both sell and travel failed - clear cargo to avoid infinite loop
              console.warn(`[Ship ${this.shipState.id}] Both sell and travel failed, clearing cargo`);
              this.shipState.cargo.clear();
              this.purchasePrices.clear();
              this.shipState.chosenDestinationSystemId = null;
              this.shipState.expectedMarginAtChoiceTime = null;
              this.dirty = true;
              actionTaken = true; // Clearing cargo counts as action
            }
          }
        } else {
          // Try to travel first
          if (logDecisions) {
            logDecision(this.shipState.id, `ACTION: Attempting to travel (not selling here)`);
          }
          const travelStarted = await profiler.timeAsync(`ship-${this.shipState.id}-tryTravel`, () => 
            this.tryTravel(decisionRng)
          );
          actionTaken = travelStarted;
          
          // If travel failed and we have cargo, try to sell anyway (even at smaller profit)
          if (!travelStarted) {
            const stillHasCargo = this.shipState.cargo.size > 0 && 
                                  Array.from(this.shipState.cargo.values()).some(qty => qty > 0);
            if (stillHasCargo) {
              if (logDecisions) {
                logDecision(this.shipState.id, `FALLBACK: Travel failed with cargo, attempting to sell (may accept smaller profit)`);
              }
              // Check if this is a true emergency (maintenance due)
              const maintenanceDue = this.shipState.credits < AIR_PURIFIER_TAX;
              const emergencySell = maintenanceDue;
              
              // Only sell if emergency, otherwise let culling handle it
              const sold = emergencySell ? await this.trySellGoods(snapshot.markets, decisionRng, true) : false;
              actionTaken = sold;
              if (!sold) {
                // Still can't sell - clear cargo as last resort
                const cargoSummary = Array.from(this.shipState.cargo.entries())
                  .filter(([_, qty]) => qty > 0)
                  .map(([g, q]) => `${g}:${q}`)
                  .join(", ") || "none";
                console.warn(
                  `[Ship ${this.shipState.id}] Travel failed and can't sell cargo, clearing cargo. ` +
                  `Cargo: [${cargoSummary}], credits: ${this.shipState.credits.toFixed(2)}, ` +
                  `current system: ${this.shipState.currentSystem}, phase: ${this.shipState.phase}, ` +
                  `fuel: ${this.shipState.fuelLy.toFixed(2)}/${this.shipState.fuelCapacityLy.toFixed(2)} LY`
                );
                this.shipState.cargo.clear();
                this.purchasePrices.clear();
                this.shipState.chosenDestinationSystemId = null;
                this.shipState.expectedMarginAtChoiceTime = null;
                this.dirty = true;
                actionTaken = true;
              }
            }
          }
        }
        
        // Safety check: if we still have cargo and no action was taken, try emergency sell
        const stillHasCargo = this.shipState.cargo.size > 0 && 
                              Array.from(this.shipState.cargo.values()).some(qty => qty > 0);
        if (!actionTaken && stillHasCargo) {
          console.warn(`[Ship ${this.shipState.id}] CRITICAL: Has cargo but no action taken! Attempting emergency sell.`);
          // Last resort: only if true emergency, otherwise let culling handle it
          const maintenanceDue = this.shipState.credits < AIR_PURIFIER_TAX;
          const emergencySell = maintenanceDue;
          const sold = emergencySell ? await this.trySellGoods(snapshot.markets, decisionRng, true) : false;
          if (!sold) {
            console.error(`[Ship ${this.shipState.id}] Emergency sell also failed, clearing cargo.`);
            this.shipState.cargo.clear();
            this.purchasePrices.clear();
            this.shipState.chosenDestinationSystemId = null;
            this.shipState.expectedMarginAtChoiceTime = null;
            this.dirty = true;
          }
        }
      } else {
        // Ship has no cargo - try to buy or travel
        const action = decisionRng.random();
        if (logDecisions) {
          logDecision(this.shipState.id, `DECISION: No cargo - action roll=${action.toFixed(3)}, ${action < 0.9 ? "will try to buy (90% chance)" : "will travel (10% chance)"}`);
        }
        if (action < 0.9) {
          // 90% chance: Try to buy goods
          if (logDecisions) {
            logDecision(this.shipState.id, `ACTION: Attempting to buy goods`);
          }
          const bought = await this.tryBuyGoods(snapshot.markets, decisionRng);
          if (logDecisions) {
            logDecision(this.shipState.id, `RESULT: Buy attempt ${bought ? "SUCCESS" : "FAILED"}`);
          }
          // After buying, travel to another system to sell
          if (bought) {
          if (logDecisions) {
            logDecision(this.shipState.id, `ACTION: Traveling after successful buy`);
          }
          await this.tryTravel(decisionRng);
          } else {
            // If couldn't buy, try to travel to find better opportunities
          if (logDecisions) {
            logDecision(this.shipState.id, `ACTION: Traveling after failed buy`);
          }
          await this.tryTravel(decisionRng);
          }
        } else {
          // 10% chance: Travel to another system (maybe better prices)
          if (logDecisions) {
            logDecision(this.shipState.id, `ACTION: Traveling (random choice)`);
          }
          await this.tryTravel(decisionRng);
        }
        
        // After all actions, NPCs may rest (if they have enough credits)
        await this.maybeStartRest(decisionRng);
      }
    } catch (error) {
      console.error(`[Ship ${this.shipState.id}] Error in trading decision:`, error);
    }
  }

  private calculateDistance(x1: number, y1: number, x2: number, y2: number): number {
    // Calculate 2D Euclidean distance
    const dx = x1 - x2;
    const dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private async calculateSystemDistance(fromSystem: SystemId, toSystem: SystemId): Promise<number> {
    try {
      const fromStub = this.env.STAR_SYSTEM.idFromName(`system-${fromSystem}`);
      const toStub = this.env.STAR_SYSTEM.idFromName(`system-${toSystem}`);
      const fromSystemObj = this.env.STAR_SYSTEM.get(fromStub) as { fetch: (request: Request | string) => Promise<Response> };
      const toSystemObj = this.env.STAR_SYSTEM.get(toStub) as { fetch: (request: Request | string) => Promise<Response> };

      const [fromSnapshot, toSnapshot] = await Promise.all([
        fromSystemObj.fetch(DO_INTERNAL("/snapshot")),
        toSystemObj.fetch(DO_INTERNAL("/snapshot")),
      ]);

      if (fromSnapshot.ok && toSnapshot.ok) {
        const fromData = (await fromSnapshot.json()) as { state?: { x?: number; y?: number } | null };
        const toData = (await toSnapshot.json()) as { state?: { x?: number; y?: number } | null };
        if (fromData.state && toData.state) {
          const x1 = fromData.state.x ?? 0;
          const y1 = fromData.state.y ?? 0;
          const x2 = toData.state.x ?? 0;
          const y2 = toData.state.y ?? 0;
          return this.calculateDistance(x1, y1, x2, y2);
        }
      }
    } catch (error) {
      // Fall through to ID-based distance
    }

    return Math.abs(toSystem - fromSystem);
  }

  private calculateFuelCost(fuelLy: number): number {
    const baseCost = fuelLy * FUEL_PRICE_PER_LY;
    return Math.ceil(baseCost * (1 + SALES_TAX_RATE));
  }

  private getFuelReserveCredits(): number {
    if (!this.shipState) return 0;
    const missing = Math.max(0, MIN_TRAVEL_FUEL_LY - this.shipState.fuelLy);
    if (missing <= 0) return 0;
    return this.calculateFuelCost(missing);
  }

  /**
   * Calculate mobility reserve: minimum credits needed to ensure trader can always travel
   * Formula: 2 × fuelToNearestNeighbor + tax buffer + small safety margin
   */
  private getMobilityReserveCredits(): number {
    if (!this.shipState || this.shipState.currentSystem === null) return 0;
    
    // Estimate fuel cost for cheapest neighbor (typically 1 LY for adjacent systems)
    // Use 2 LY as a reasonable estimate (allows for systems that might be slightly further)
    // This is much more realistic than MAX_TRAVEL_DISTANCE which is the maximum, not typical
    const cheapestNeighborDistance = 2; // Adjacent systems are typically 1 LY, use 2 for safety
    const fuelReserve = this.calculateFuelCost(cheapestNeighborDistance);
    
    // Add small safety margin for tax and rounding
    return fuelReserve + 5; // 5 cr safety margin (was 20, but 2 LY * 2 cr/LY * 1.03 + 5 ≈ 9 cr total)
  }

  /**
   * Check if NPC should be culled based on lifecycle rules
   * Returns cull reason if NPC should be removed, null otherwise
   */
  private async checkNPCCulling(): Promise<string | null> {
    if (!this.shipState || !this.shipState.isNPC || this.shipState.currentSystem === null) {
      return null;
    }

    const now = Date.now();
    const tickCount = Math.floor(now / 10000); // Rough tick count (10s intervals)

    // Rule 1: Insolvent and immobile for K ticks
    // getMobilityReserveCredits() already calculates cost for one hop to cheapest neighbor
    const fuelCostToCheapestNeighbor = this.getMobilityReserveCredits();
    const isInsolvent = this.shipState.credits < fuelCostToCheapestNeighbor;
    
    if (isInsolvent) {
      this.shipState.immobileTicks = (this.shipState.immobileTicks || 0) + 1;
      if (this.shipState.immobileTicks >= IMMOBILE_TICKS_TO_CULL) {
        return `insolvent and immobile for ${this.shipState.immobileTicks} ticks (credits: ${this.shipState.credits.toFixed(2)}, need: ${fuelCostToCheapestNeighbor.toFixed(2)})`;
      }
    } else {
      // Reset immobile counter if not insolvent
      this.shipState.immobileTicks = 0;
    }

    // Rule 2: Stagnation - no successful trade in N decisions
    if (this.shipState.lastSuccessfulTradeTick) {
      const ticksSinceLastTrade = tickCount - this.shipState.lastSuccessfulTradeTick;
      if (ticksSinceLastTrade >= STAGNATION_DECISIONS_TO_CULL) {
        return `stagnation: no successful trade in ${ticksSinceLastTrade} decisions`;
      }
    } else if (this.shipState.decisionCount >= STAGNATION_DECISIONS_TO_CULL) {
      // If never had a successful trade and made many decisions, cull
      return `stagnation: no successful trade after ${this.shipState.decisionCount} decisions`;
    }

    // Rule 3: Drawdown limit - credits < 5% of start AND made at least 10 decisions
    const drawdownThreshold = INITIAL_CREDITS * DRAWDOWN_LIMIT;
    if (this.shipState.credits < drawdownThreshold && this.shipState.decisionCount >= MIN_TRADES_FOR_DRAWDOWN) {
      // Only cull if they're also immobile (can't recover)
      if (isInsolvent && this.shipState.immobileTicks >= 2) {
        return `drawdown: credits ${this.shipState.credits.toFixed(2)} < ${drawdownThreshold.toFixed(2)} (5% of start) after ${this.shipState.decisionCount} decisions`;
      }
    }

    return null;
  }

  private tryRefuelForTravel(distanceNeeded: number): boolean {
    if (!this.shipState) return false;
    if (this.shipState.phase !== "at_station") return false;

    const missing = Math.max(0, this.shipState.fuelCapacityLy - this.shipState.fuelLy);
    if (missing <= 0) {
      return this.shipState.fuelLy >= distanceNeeded;
    }

    const logDecisions = shouldLogDecisions(this.shipState.id);

    const fullCost = this.calculateFuelCost(missing);
    if (this.shipState.credits >= fullCost) {
      const creditsBefore = this.shipState.credits;
      this.shipState.credits -= fullCost;
      this.shipState.fuelLy = this.shipState.fuelCapacityLy;
      this.dirty = true;
      if (logDecisions) {
        logDecision(
          this.shipState.id,
          `  Refueled full tank: credits ${creditsBefore.toFixed(2)} -> ${this.shipState.credits.toFixed(2)} (cost: ${fullCost} cr)`
        );
      }
      return this.shipState.fuelLy >= distanceNeeded;
    }

    const fuelNeeded = Math.max(0, distanceNeeded - this.shipState.fuelLy);
    if (fuelNeeded <= 0) {
      return true;
    }

    let fuelToBuy = Math.min(fuelNeeded, missing);
    let cost = this.calculateFuelCost(fuelToBuy);

    if (cost > this.shipState.credits) {
      const maxFuelEstimate = Math.min(
        missing,
        this.shipState.credits / (FUEL_PRICE_PER_LY * (1 + SALES_TAX_RATE))
      );
      fuelToBuy = Math.floor(maxFuelEstimate * 10) / 10;
      while (fuelToBuy > 0) {
        cost = this.calculateFuelCost(fuelToBuy);
        if (cost <= this.shipState.credits) break;
        fuelToBuy = Math.floor((fuelToBuy - 0.1) * 10) / 10;
      }
    }

    if (fuelToBuy <= 0 || cost > this.shipState.credits) {
      if (logDecisions) {
        logDecision(
          this.shipState.id,
          `  Cannot refuel: insufficient credits (${this.shipState.credits.toFixed(2)} cr, need ${fuelNeeded.toFixed(2)} LY)`
        );
      }
      return false;
    }

    const creditsBefore = this.shipState.credits;
    this.shipState.credits -= cost;
    this.shipState.fuelLy = Math.min(
      this.shipState.fuelCapacityLy,
      this.shipState.fuelLy + fuelToBuy
    );
    this.dirty = true;

    if (logDecisions) {
      logDecision(
        this.shipState.id,
        `  Refueled ${fuelToBuy.toFixed(1)} LY: credits ${creditsBefore.toFixed(2)} -> ${this.shipState.credits.toFixed(2)} (cost: ${cost} cr)`
      );
    }

    return this.shipState.fuelLy >= distanceNeeded;
  }

  private shouldSellAtCurrentSystem(markets: Record<GoodId, { price: number; inventory: number }>): boolean {
    if (!this.shipState) return false;
    
    const logDecisions = shouldLogDecisions(this.shipState.id);
    const veryLowCredits = this.shipState.credits < VERY_LOW_CREDITS_THRESHOLD; // Very low - need to sell to avoid bankruptcy
    const lowCredits = this.shipState.credits < LOW_CREDITS_THRESHOLD;
    
    if (logDecisions) {
      logDecision(this.shipState.id, `Evaluating shouldSellAtCurrentSystem: credits=${this.shipState.credits.toFixed(2)}, veryLow=${veryLowCredits}, low=${lowCredits}`);
    }
    
    // Check for emergency conditions (maintenance due)
    const maintenanceDue = this.shipState.credits < AIR_PURIFIER_TAX;
    
    if (maintenanceDue) {
      if (logDecisions) {
        logDecision(this.shipState.id, `DECISION: Should sell - emergency (maintenanceDue=${maintenanceDue})`);
      }
      return true;
    }
    
    // Check if we can't afford fuel - must sell to get fuel
    const fuelReserveCredits = this.getFuelReserveCredits();
    const canAffordFuel = this.shipState.credits >= fuelReserveCredits;
    
    if (!canAffordFuel) {
      if (logDecisions) {
        logDecision(this.shipState.id, `DECISION: Should sell - can't afford fuel (credits=${this.shipState.credits.toFixed(2)}, need=${fuelReserveCredits.toFixed(2)})`);
      }
      return true; // Must sell to get fuel, even if unprofitable
    }
    
    // Only sell if profitable (no forced sells at loss unless emergency)
    // Check if we can make any profit
    for (const [goodId, qty] of this.shipState.cargo.entries()) {
      if (qty <= 0) continue;
      const purchasePrice = this.purchasePrices.get(goodId);
      const market = markets[goodId];
      if (!market) continue;
      
      // If we know purchase price, check for profit margin
      if (purchasePrice) {
        // Compare purchasePrice (includes buy tax) to net sell price (post-tax)
        const netSellPrice = market.price; // No tax on sales
        const profitMargin = (netSellPrice - purchasePrice) / purchasePrice;
        const minProfitMargin = getMinProfitMargin();
        
        if (logDecisions) {
          logDecision(this.shipState.id, `  ${goodId}: purchasePrice=${purchasePrice.toFixed(2)}, marketPrice=${market.price.toFixed(2)}, netSellPrice=${netSellPrice.toFixed(2)}, profitMargin=${(profitMargin * 100).toFixed(1)}%, minRequired=${(minProfitMargin * 100).toFixed(1)}%`);
        }
        
        // Simple check: sell if profit margin meets minimum threshold
        // This already prevents same-system losses (if price dropped, profit will be negative)
        if (profitMargin >= minProfitMargin) {
          if (logDecisions) {
            logDecision(this.shipState.id, `DECISION: Should sell ${goodId} - profitable (${(profitMargin * 100).toFixed(1)}% margin)`);
          }
          return true; // Can make profit, sell
        }
      } else {
        // Don't know purchase price, check if price is above base
          const good = getGoodDefinition(goodId);
          const minProfitMargin = getMinProfitMargin();
          if (good && (market.price >= good.basePrice * (1+minProfitMargin) || market.price - good.basePrice > 50)) {
            if (logDecisions) {
              logDecision(this.shipState.id, `DECISION: Should sell ${goodId} - price above base (${market.price.toFixed(2)} vs base ${good.basePrice})`);
            }
            return true; // Price is above base profit margin or more than 50 cr above base, likely profitable
          }
        }
    }
    
    // No profitable trades found
    if (logDecisions) {
      logDecision(this.shipState.id, `DECISION: Should not sell - no profitable opportunities found`);
    }
    return false;
  }

  /**
   * Calculate Smart Score for a trade candidate
   * Combines multiple factors: profit margin, efficiency, volume potential, and market need
   */
  private calculateTradeScore(
    candidate: { goodId: GoodId; price: number; good: ReturnType<typeof getGoodDefinition> },
    market: { price: number; inventory: number; production: number; consumption: number },
    purchasePrice: number,
    netSellPrice: number,
    affordableQuantity: number,
    availableSpace: number
  ): number {
    if (!candidate.good) return -Infinity;
    
    const weights = getTradeScoringWeights();
    const good = candidate.good;
    
    // 1. Total Profit - primary factor (formula: (SellPrice - BuyPrice) * Min(CargoSpace, Credits/BuyPrice))
    // This is the actual profit in credits, not percentage margin
    const profitPerUnit = netSellPrice - purchasePrice;
    const totalProfit = profitPerUnit * affordableQuantity;
    // Normalize to ~1000 cr scale for comparison across different trade sizes
    const totalProfitScore = (totalProfit / 1000) * weights.totalProfitPotential;
    
    // 2. Profit per cargo space - efficiency (secondary factor)
    // Rewards efficient use of cargo space (important when cargo is limited)
    const profitPerCargoSpace = profitPerUnit / good.weight;
    // Normalize by base price to make it comparable across goods
    const efficiencyScore = (profitPerCargoSpace / good.basePrice) * weights.profitPerCargoSpace;
    
    // 3. Inventory pressure - market need (tertiary factor)
    // LOW inventory = HIGH pressure to BUY (bring goods in)
    // HIGH inventory = LOW pressure to BUY (market is saturated)
    const expectedStock = Math.max(1, (market.production + market.consumption) * 10);
    const inventoryRatio = market.inventory / expectedStock;
    // Invert: low ratio (low inventory) = high multiplier (high pressure to buy)
    // Map from [0, 1] to [2.0, 0.2] where 0 = max pressure, 1 = min pressure
    const pressureMultiplier = 2.0 - (inventoryRatio * 1.8); // 2.0 when ratio=0, 0.2 when ratio=1
    const pressureScore = pressureMultiplier * weights.inventoryPressure;
    
    const totalScore = totalProfitScore + efficiencyScore + pressureScore;
    return totalScore;
  }

  private async tryBuyGoods(
    markets: Record<GoodId, { price: number; inventory: number; production?: number; consumption?: number }>,
    rng: DeterministicRNG
  ): Promise<boolean> {
    if (!this.shipState) return false;

    // Get full market data including production/consumption from current system snapshot
    const currentSystemId = this.shipState.currentSystem;
    let fullMarketData: Record<GoodId, { price: number; inventory: number; production: number; consumption: number }> = {};
    if (currentSystemId !== null) {
      try {
        const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${currentSystemId}`);
        const systemObj = this.env.STAR_SYSTEM.get(systemStub) as { fetch: (request: Request | string) => Promise<Response> };
        const snapshotResponse = await systemObj.fetch(DO_INTERNAL("/snapshot"));
        if (snapshotResponse.ok) {
          const snapshotData = (await snapshotResponse.json()) as {
            markets?: Record<GoodId, { price: number; inventory: number; production: number; consumption: number }>;
          };
          if (snapshotData.markets) {
            fullMarketData = snapshotData.markets;
          }
        }
      } catch (error) {
        // Fall back to markets parameter if snapshot fails
      }
    }
    
    // Merge markets parameter with full market data (prefer full data)
    const mergedMarkets: Record<GoodId, { price: number; inventory: number; production: number; consumption: number }> = {};
    for (const [goodId, market] of Object.entries(markets)) {
      const fullData = fullMarketData[goodId];
      mergedMarkets[goodId] = {
        price: market.price,
        inventory: market.inventory,
        production: fullData?.production ?? market.production ?? 0,
        consumption: fullData?.consumption ?? market.consumption ?? 0,
      };
    }

    const logDecisions = shouldLogDecisions(this.shipState.id);
    if (logDecisions) {
      logDecision(this.shipState.id, `tryBuyGoods: Starting buy evaluation`);
    }

    // Calculate available cargo space
    const usedSpace = Array.from(this.shipState.cargo.values()).reduce(
      (sum, qty) => sum + qty,
      0
    );
    const availableSpace = MAX_CARGO_SPACE - usedSpace;

    if (logDecisions) {
      logDecision(this.shipState.id, `  Available space: ${availableSpace}/${MAX_CARGO_SPACE}, credits: ${this.shipState.credits.toFixed(2)}`);
    }

    if (availableSpace <= 0) {
      if (logDecisions) {
        logDecision(this.shipState.id, `  RESULT: Cannot buy - no cargo space`);
      }
      return false;
    }

    // Allow NPCs to use 80% of credits for trading (reserve 20% for fuel/tax)
    // This is more aggressive than before to allow more trading opportunities
    const fuelReserveCredits = this.getFuelReserveCredits();
    const reservePercentage = 0.20; // Reserve 20% for fuel and taxes
    const spendableCredits = Math.max(0, this.shipState.credits * (1 - reservePercentage) - fuelReserveCredits);

    // Find goods the NPC can afford
    // Use Smart Scoring to evaluate all profitable candidates, not just cheapest ones
    const goodIds = getAllGoodIds();
    const candidates = goodIds
      .map((goodId) => {
        const good = getGoodDefinition(goodId);
        const market = mergedMarkets[goodId];
        if (!good || !market || market.inventory === 0) return null;

        // Check if NPC can afford at least 1 unit including tax
        if (!this.shipState) return null;
        const effectiveBuyPrice = market.price * (1 + SALES_TAX_RATE);
        const canAfford = spendableCredits >= effectiveBuyPrice;
        if (!canAfford) return null;

        return { goodId, price: market.price, good, market: mergedMarkets[goodId] };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length === 0) {
      if (logDecisions) {
        logDecision(this.shipState.id, `  RESULT: Cannot buy - no affordable goods (credits: ${this.shipState.credits.toFixed(2)})`);
      }
      return false;
    }

    const minProfitMargin = getMinProfitMargin();
    if (currentSystemId === null) {
      if (logDecisions) {
        logDecision(this.shipState.id, `  RESULT: Cannot buy - no current system`);
      }
      return false;
    }

    // Evaluate all candidates with Smart Scoring
    // For each candidate, find best destination and calculate score
    interface ScoredCandidate {
      candidate: typeof candidates[0];
      destinationSystemId: SystemId;
      profitMargin: number;
      score: number;
      purchasePrice: number;
      netSellPrice: number;
      affordableQuantity: number;
    }

    const scoredCandidates: ScoredCandidate[] = [];
    
    // Get list of reachable systems from current system
    let reachableSystems: Array<{ id: SystemId; distance: number }> = [];
    if (currentSystemId !== null) {
      try {
        const currentSystemStub = this.env.STAR_SYSTEM.idFromName(`system-${currentSystemId}`);
        const currentSystemObj = this.env.STAR_SYSTEM.get(currentSystemStub);
        
        // Try to call getReachableSystems directly
        let usedDirectCall = false;
        try {
          const systemAsStarSystem = currentSystemObj as StarSystem;
          if (systemAsStarSystem.getReachableSystems && typeof systemAsStarSystem.getReachableSystems === 'function') {
            reachableSystems = await systemAsStarSystem.getReachableSystems();
            usedDirectCall = true;
          } else {
            // Try prototype chain
            const proto = Object.getPrototypeOf(currentSystemObj);
            if (proto && proto.getReachableSystems && typeof proto.getReachableSystems === 'function') {
              reachableSystems = await proto.getReachableSystems.call(systemAsStarSystem);
              usedDirectCall = true;
            }
          }
        } catch (error) {
          // Method doesn't exist or call failed - will fall back to fetch
        }
        
        // Fallback to fetch if direct call wasn't used
        if (!usedDirectCall) {
          const systemAsFetch = currentSystemObj as { fetch: (request: Request | string) => Promise<Response> };
          const reachableResponse = await systemAsFetch.fetch(DO_INTERNAL("/reachable-systems"));
          if (reachableResponse.ok) {
            const reachableData = (await reachableResponse.json()) as { systems: Array<{ id: SystemId; distance: number }> };
            reachableSystems = reachableData.systems || [];
          }
        }
      } catch (error) {
        if (logDecisions) {
          logDecision(this.shipState.id, `  Error getting reachable systems: ${error}`);
        }
      }
    }

    for (const candidate of candidates) {
      const effectiveBuyPrice = candidate.price * (1 + SALES_TAX_RATE);
      const purchasePrice = effectiveBuyPrice;
      
      // Calculate affordable quantity
      const maxAffordable = Math.floor(spendableCredits / purchasePrice);
      const maxBySpace = Math.floor(availableSpace / candidate.good.weight);
      const affordableQuantity = Math.min(maxAffordable, maxBySpace);

      if (affordableQuantity <= 0) continue;

      let bestScore = -Infinity;
      let bestDestination: SystemId | null = null;
      let bestProfitMargin = -Infinity;
      let bestNetSellPrice = 0;

      // Check each reachable system for profitable sell opportunities
      for (const reachableSystem of reachableSystems) {
        const targetSystemId = reachableSystem.id;
        
        try {
          const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${targetSystemId}`);
          const systemObj = this.env.STAR_SYSTEM.get(systemStub) as { fetch: (request: Request | string) => Promise<Response> };
          const snapshot = await systemObj.fetch(DO_INTERNAL("/snapshot"));
          const data = (await snapshot.json()) as { 
            markets?: Record<GoodId, { price: number; production?: number; consumption?: number; inventory?: number }> 
          };

          if (data.markets && data.markets[candidate.goodId]) {
              const targetPrice = data.markets[candidate.goodId].price;
              const netSellPrice = targetPrice;
              const profitMargin = (netSellPrice - purchasePrice) / purchasePrice;

              // Only consider profitable destinations
              if (profitMargin >= minProfitMargin) {
                // Get market data for scoring (use current system's market for inventory/production/consumption)
                const marketData = {
                  price: candidate.price,
                  inventory: candidate.market.inventory,
                  production: candidate.market.production,
                  consumption: candidate.market.consumption,
                };

                // Calculate Smart Score
                const score = this.calculateTradeScore(
                  candidate,
                  marketData,
                  purchasePrice,
                  netSellPrice,
                  affordableQuantity,
                  availableSpace
                );

                if (score > bestScore) {
                  bestScore = score;
                  bestDestination = targetSystemId;
                  bestProfitMargin = profitMargin;
                  bestNetSellPrice = netSellPrice;
                }
              }
            }
          } catch (error) {
            continue;
          }
        }

      // Add to scored candidates if profitable destination found
      if (bestDestination !== null && bestScore > -Infinity) {
        scoredCandidates.push({
          candidate,
          destinationSystemId: bestDestination,
          profitMargin: bestProfitMargin,
          score: bestScore,
          purchasePrice,
          netSellPrice: bestNetSellPrice,
          affordableQuantity,
        });
      }
    }

    if (scoredCandidates.length === 0) {
      if (logDecisions) {
        logDecision(this.shipState.id, `  RESULT: Cannot buy - no profitable sell destinations found nearby for any affordable goods`);
      }
      return false;
    }

    // Sort by score (highest first) and select best
    scoredCandidates.sort((a, b) => b.score - a.score);
    const selected = scoredCandidates[0];

    if (logDecisions) {
      logDecision(
        this.shipState.id,
        `  Selected ${selected.candidate.goodId} with score ${selected.score.toFixed(3)} ` +
        `(margin: ${(selected.profitMargin * 100).toFixed(1)}%, destination: system ${selected.destinationSystemId})`
      );
    }

    // Store destination for travel
    this.shipState.chosenDestinationSystemId = selected.destinationSystemId;
    this.shipState.expectedMarginAtChoiceTime = selected.profitMargin;

    const effectiveBuyPrice = selected.purchasePrice;
    const quantity = selected.affordableQuantity;
    
    if (logDecisions) {
      const maxAffordable = Math.floor(spendableCredits / effectiveBuyPrice);
      const maxBySpace = Math.floor(availableSpace / selected.candidate.good.weight);
      logDecision(this.shipState.id, `  Buy calculation: credits=${this.shipState.credits.toFixed(2)}, fuelReserve=${fuelReserveCredits.toFixed(2)}, availableCredits=${spendableCredits.toFixed(2)}, price=${selected.candidate.price.toFixed(2)}, effectiveBuyPrice=${effectiveBuyPrice.toFixed(2)} (with tax), maxAffordable=${maxAffordable}, maxBySpace=${maxBySpace}, quantity=${quantity}`);
    }

    if (quantity <= 0) {
      if (logDecisions) {
        logDecision(this.shipState.id, `  RESULT: Cannot buy - quantity would be 0`);
      }
      return false;
    }

    // Execute trade
    try {
      const tradeResponse = await this.executeTrade(
        selected.candidate.goodId,
        quantity,
        "buy"
      );

      if (tradeResponse.ok) {
        const result = (await tradeResponse.json()) as {
          success: boolean;
          totalCost: number;
        };

        if (logDecisions) {
          logDecision(this.shipState.id, `  Trade response: success=${result.success}, totalCost=${result.totalCost.toFixed(2)}, expectedCost=${(effectiveBuyPrice * quantity).toFixed(2)}`);
        }

        if (result.success) {
          // Update cargo and credits
          const currentCargo = this.shipState.cargo.get(selected.candidate.goodId) || 0;
          const creditsBefore = this.shipState.credits;
          const cargoBefore = Array.from(this.shipState.cargo.entries()).filter(([_, qty]) => qty > 0).map(([g, q]) => `${g}:${q}`).join(", ") || "none";
          this.shipState.cargo.set(selected.candidate.goodId, currentCargo + quantity);
          this.shipState.credits -= result.totalCost;
          const cargoAfter = Array.from(this.shipState.cargo.entries()).filter(([_, qty]) => qty > 0).map(([g, q]) => `${g}:${q}`).join(", ") || "none";
          
          if (logDecisions) {
            logDecision(this.shipState.id, `  Buy update: credits ${creditsBefore.toFixed(2)} -> ${this.shipState.credits.toFixed(2)} (cost: ${result.totalCost.toFixed(2)}), cargo: ${cargoBefore} -> ${cargoAfter}`);
          }
          
          // Track purchase price (average if buying more of same good)
          if (!this.shipState) {
            console.error(`[Ship] Cannot set purchasePrice - shipState is null`);
          } else {
            const currentPurchasePrice = this.shipState.purchasePrices.get(selected.candidate.goodId);
            const purchasePrice = result.totalCost / quantity;
            let finalPurchasePrice: number;
            
            if (currentPurchasePrice && currentCargo > 0) {
              // Weighted average of existing and new purchase prices
              const totalCost = (currentPurchasePrice * currentCargo) + result.totalCost;
              const totalQuantity = currentCargo + quantity;
              finalPurchasePrice = totalCost / totalQuantity;
              this.shipState.purchasePrices.set(selected.candidate.goodId, finalPurchasePrice);
              if (logDecisions) {
                logDecision(this.shipState.id, `  Set purchasePrice for ${selected.candidate.goodId}: ${finalPurchasePrice.toFixed(2)} (weighted average of ${currentPurchasePrice.toFixed(2)} and ${purchasePrice.toFixed(2)})`);
              }
            } else {
              finalPurchasePrice = purchasePrice;
              this.shipState.purchasePrices.set(selected.candidate.goodId, finalPurchasePrice);
              if (logDecisions) {
                logDecision(this.shipState.id, `  Set purchasePrice for ${selected.candidate.goodId}: ${finalPurchasePrice.toFixed(2)}`);
              }
            }
            // Verify it was set correctly
            const verifyPrice = this.shipState.purchasePrices.get(selected.candidate.goodId);
            if (!verifyPrice || Math.abs(verifyPrice - finalPurchasePrice) > 0.01) {
              console.error(
                `[Ship ${this.shipState.id}] CRITICAL: purchasePrice not set correctly! ` +
                `Expected ${finalPurchasePrice.toFixed(2)} but got ${verifyPrice?.toFixed(2) || 'undefined'} for ${selected.candidate.goodId}`
              );
            }
            // Track when cargo was purchased for max hold time check
            const now = Date.now();
            const tickCount = Math.floor(now / 10000);
            this.shipState.lastCargoPurchaseTick = tickCount;
            
            // Log trade (with error handling to prevent blocking)
            try {
              if (shouldLogTradeNow(this.shipState.id)) {
                logTrade(`[Ship ${this.shipState.id}] Bought ${quantity} ${selected.candidate.goodId} for ${result.totalCost} cr (${finalPurchasePrice.toFixed(2)} cr/unit) in system ${this.shipState.currentSystem}`);
              }
            } catch (error) {
              // Ignore logging errors to prevent blocking trades
            }
            
            // Record trade for leaderboard
            try {
              const systemName = `System ${this.shipState.currentSystem}`;
              recordTrade(
                this.shipState.id,
                this.shipState.name,
                this.shipState.currentSystem!,
                systemName,
                selected.candidate.goodId,
                quantity,
                finalPurchasePrice,
                "buy"
              );
            } catch (error) {
              // Don't let leaderboard errors break trades
            }
          }
          
          // Don't rest after buying - should travel to sell
          return true; // Indicate successful purchase
        } else {
          // Trade failed (business logic failure - insufficient inventory, etc.)
          try {
            if (shouldLogTradeNow(this.shipState.id)) {
              let errorData: { error?: string };
              try {
                errorData = (await tradeResponse.json()) as { error?: string };
              } catch {
                errorData = { error: undefined };
              }
              const errorMsg = errorData.error || "Unknown error";
              logTrade(`[Ship ${this.shipState.id}] Buy trade failed: ${errorMsg} (tried to buy ${quantity} ${selected.candidate.goodId} in system ${this.shipState.currentSystem})`);
            }
          } catch (error) {
            // Ignore logging errors
          }
          
          // Record failed trade for leaderboard
          try {
            if (this.shipState.currentSystem !== null) {
              const systemName = `System ${this.shipState.currentSystem}`;
              recordFailedTrade(this.shipState.id, this.shipState.name, this.shipState.currentSystem, systemName);
            }
          } catch (error) {
            // Don't let leaderboard errors break trades
          }
        }
      } else {
        // HTTP error response
        try {
          const errorText = await tradeResponse.text();
          if (tradeResponse.status !== 400) {
            // Log non-400 errors (actual system errors)
            console.warn(`[Ship ${this.shipState.id}] Buy trade error (${tradeResponse.status}):`, errorText);
          }
          // Log 400 errors if trade logging is enabled
          if (shouldLogTradeNow(this.shipState.id)) {
            logTrade(`[Ship ${this.shipState.id}] Buy trade HTTP error (${tradeResponse.status}): ${errorText}`);
          }
        } catch (error) {
          // Ignore error handling errors
        }
      }
    } catch (error) {
      console.error(`[Ship ${this.shipState.id}] Error executing buy trade:`, error);
    }
    return false; // No purchase made
  }

  private async trySellGoods(
    markets: Record<GoodId, { price: number; inventory: number }>,
    rng: DeterministicRNG,
    relaxed: boolean = false // If true, allow smaller profit margins or break-even
  ): Promise<boolean> {
    if (!this.shipState) return false;

    const logDecisions = shouldLogDecisions(this.shipState.id);
    if (logDecisions) {
      logDecision(this.shipState.id, `trySellGoods: Starting sell evaluation`);
    }

    // Find goods we have in cargo
    const cargoGoods = Array.from(this.shipState.cargo.entries())
      .filter(([_, qty]) => qty > 0)
      .map(([goodId, qty]) => {
        const good = getGoodDefinition(goodId);
        const market = markets[goodId];
        if (!good || !market) {
        if (this.shipState && this.shipState.credits < VERY_LOW_CREDITS_THRESHOLD) {
          console.warn(`[Ship ${this.shipState.id}] Very low credits (${this.shipState.credits}), trying to sell ${goodId} but ${!good ? "good not found" : "market not found"}`);
        }
          return null;
        }

        // Price ratio (higher is better for selling)
        const priceRatio = market.price / good.basePrice;
        return { goodId, qty, priceRatio, price: market.price };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    if (logDecisions) {
      logDecision(this.shipState.id, `  Cargo goods with markets: ${cargoGoods.map(c => `${c.goodId}(${c.qty}@${c.price.toFixed(2)}, ratio=${c.priceRatio.toFixed(2)})`).join(", ") || "none"}`);
    }

    if (cargoGoods.length === 0) {
      // Can't sell any cargo - market doesn't have these goods
      // Clear cargo to avoid getting stuck
      if (logDecisions) {
        logDecision(this.shipState.id, `  RESULT: Cannot sell - no markets for cargo goods, clearing cargo`);
      }
      console.warn(`[Ship ${this.shipState.id}] Can't sell cargo (market doesn't have these goods), clearing cargo`);
      this.shipState.cargo.clear();
      this.purchasePrices.clear();
      this.shipState.chosenDestinationSystemId = null;
      this.shipState.expectedMarginAtChoiceTime = null;
      this.dirty = true;
      return false;
    }

    // Check if this is a forced sell due to very low credits
    const veryLowCredits = this.shipState.credits < VERY_LOW_CREDITS_THRESHOLD;
    
    // Filter out goods that would sell at a loss (unless relaxed mode)
    const profitableGoods = cargoGoods.filter(c => {
      const purchasePrice = this.purchasePrices.get(c.goodId);
      if (purchasePrice) {
        const netSellPrice = c.price; // No tax on sales
        const profitMargin = (netSellPrice - purchasePrice) / purchasePrice;
        const minProfitMargin = getMinProfitMargin();
        
        if (relaxed) {
          // In relaxed mode, allow break-even or small loss (up to 5% loss)
          const veryLowCredits = this.shipState && this.shipState.credits < VERY_LOW_CREDITS_THRESHOLD;
          if (veryLowCredits) {
            // Emergency: allow small loss to avoid bankruptcy
            return netSellPrice >= purchasePrice * 0.95;
          }
          // Not emergency: require profitable or break-even
          return profitMargin >= -0.05;
        }
        // Normal mode: must be profitable (meets minimum threshold)
        return profitMargin >= minProfitMargin;
      }
      // Don't know purchase price - check if price is above base price with margin
      const good = getGoodDefinition(c.goodId);
      if (good) {
        const minProfitMargin = getMinProfitMargin();
        return c.price >= good.basePrice * (1 + minProfitMargin);
      }
      return false;
    });
    
    // If no profitable goods and credits are very low, check if we should allow loss in relaxed mode
    if (profitableGoods.length === 0) {
      if (relaxed && veryLowCredits) {
        // In relaxed mode with very low credits, allow selling at small loss to avoid bankruptcy
        if (logDecisions) {
          logDecision(this.shipState.id, `  Relaxed mode: allowing small loss to avoid bankruptcy`);
        }
        // Use all goods (will sell at small loss)
      } else if (!relaxed) {
        const creditNote = veryLowCredits ? `, credits very low (${this.shipState.credits.toFixed(2)})` : "";
        if (logDecisions) {
          logDecision(this.shipState.id, `  RESULT: Cannot sell - all cargo would sell at a loss${creditNote}`);
        }
        // Don't sell at loss - let the ship try to travel or wait for better prices
        const cargoList = cargoGoods.map(c => `${c.goodId}(${c.qty})`).join(", ");
        console.warn(
          `[Ship ${this.shipState.id}] Cannot sell - all cargo would sell at a loss${creditNote}. ` +
          `Cargo: [${cargoList}], will try to travel to find better market`
        );
        return false;
      }
    }
    
    const goodsToChooseFrom = profitableGoods.length > 0 ? profitableGoods : (relaxed ? cargoGoods : []);
    
    // Pick a good to sell (prefer better deals, but if forced, prefer goods that minimize loss)
    const selected = rng.weightedChoice(
      goodsToChooseFrom.map((c) => {
        // If forced sell, prefer goods with higher price (minimize loss)
        // Otherwise, prefer better price ratios
        const weight = veryLowCredits ? c.price : c.priceRatio;
        return {
          item: c,
          weight: weight,
        };
      })
    );

    if (!selected) {
      if (logDecisions) {
        logDecision(this.shipState.id, `  RESULT: Cannot sell - no valid goods to sell`);
      }
      const cargoList = goodsToChooseFrom.length > 0 
        ? goodsToChooseFrom.map(c => `${c.goodId}(${c.qty})`).join(", ")
        : "none";
      console.warn(
        `[Ship ${this.shipState.id}] Cannot sell - no valid goods to sell after filtering. ` +
        `Available goods: [${cargoList}], will try to travel`
      );
      return false;
    }

    if (logDecisions) {
      logDecision(this.shipState.id, `  Selected good to sell: ${selected.goodId}, quantity: ${selected.qty}, price: ${selected.price.toFixed(2)}, priceRatio: ${selected.priceRatio.toFixed(2)}`);
    }

    // Calculate quantity to sell
    let quantity = selected.qty;
    
    // If in emergency (relaxed mode), calculate minimum needed
    if (relaxed) {
      // Check if we can't afford fuel - this is the primary emergency case
      const fuelReserveCredits = this.getFuelReserveCredits();
      const canAffordFuel = this.shipState.credits >= fuelReserveCredits;
      
      if (!canAffordFuel) {
        // Can't afford fuel - sell minimum to cover fuel cost
        const creditsNeeded = fuelReserveCredits - this.shipState.credits;
        const netSellPrice = selected.price; // No tax on sales
        const minUnitsNeeded = Math.ceil(creditsNeeded / netSellPrice);
        quantity = Math.min(minUnitsNeeded, selected.qty);
        
        if (logDecisions) {
          logDecision(this.shipState.id, `  Emergency sell (can't afford fuel): credits=${this.shipState.credits.toFixed(2)}, need ${creditsNeeded.toFixed(2)} cr for fuel, selling ${quantity}/${selected.qty} units`);
        }
      } else if (veryLowCredits) {
        // Can afford fuel but very low credits - calculate minimum for maintenance
        const maintenanceThreshold = AIR_PURIFIER_TAX;
        const targetCredits = maintenanceThreshold + 10; // Small buffer for trades
        const creditsNeeded = Math.max(0, targetCredits - this.shipState.credits);
        
        if (creditsNeeded > 0) {
          const netSellPrice = selected.price; // No tax on sales
          const minUnitsNeeded = Math.ceil(creditsNeeded / netSellPrice);
          quantity = Math.min(minUnitsNeeded, selected.qty);
          
          if (logDecisions) {
            logDecision(this.shipState.id, `  Emergency sell (low credits): credits=${this.shipState.credits.toFixed(2)}, need ${creditsNeeded.toFixed(2)} cr, selling ${quantity}/${selected.qty} units to reach ${targetCredits.toFixed(2)} cr`);
          }
        } else {
          // Already have enough credits, sell all cargo
          quantity = selected.qty;
        }
      } else {
        // Emergency but not low credits (e.g., cargo held too long) - sell all
        quantity = selected.qty;
      }
    }
    // Otherwise, sell all of it (normal profitable sell)

    // Execute trade
    try {
      if (logDecisions) {
        logDecision(this.shipState.id, `  Executing sell trade: ${quantity} ${selected.goodId} at price ${selected.price.toFixed(2)}`);
      }
      
      const tradeResponse = await this.executeTrade(selected.goodId, quantity, "sell");

      if (tradeResponse.ok) {
        const result = (await tradeResponse.json()) as {
          success: boolean;
          totalValue: number;
          quantity: number;
        };

        const expectedValue = selected.price * quantity;
        if (logDecisions) {
          logDecision(this.shipState.id, `  Trade response: success=${result.success}, quantity=${result.quantity}, totalValue=${result.totalValue.toFixed(2)}, expectedValue=${expectedValue.toFixed(2)}`);
        }

        if (result.success && result.quantity > 0) {
          // Update cargo and credits
          const currentCargo = this.shipState.cargo.get(selected.goodId) || 0;
          const creditsBefore = this.shipState.credits;
          
          // Capture state BEFORE deletion for diagnostics
          const purchasePriceBeforeDelete = this.shipState.purchasePrices.get(selected.goodId);
          const purchasePricesSizeBeforeDelete = this.shipState.purchasePrices.size;
          const cargoBeforeDelete = Array.from(this.shipState.cargo.entries()).map(([g, q]) => `${g}:${q}`).join(", ");
          const purchasePricesBeforeDelete = Array.from(this.shipState.purchasePrices.entries()).map(([g, p]) => `${g}:${p.toFixed(2)}`).join(", ");
          
          if (logDecisions) {
            logDecision(this.shipState.id, `  Before update: cargo=${currentCargo}, credits=${creditsBefore.toFixed(2)}`);
          }
          
          const newCargo = currentCargo - result.quantity;
          const hadCargoBefore = currentCargo > 0;
          if (newCargo > 0) {
            this.shipState.cargo.set(selected.goodId, newCargo);
            // Keep purchase price for remaining cargo (it's the same per-unit price)
          } else {
            this.shipState.cargo.delete(selected.goodId);
            this.shipState.purchasePrices.delete(selected.goodId); // Clear purchase price when all sold
            // Track successful trade when cargo is fully sold (complete buy+sell cycle)
            if (hadCargoBefore && purchasePriceBeforeDelete) {
              const now = Date.now();
              const tickCount = Math.floor(now / 10000);
              this.shipState.lastSuccessfulTradeTick = tickCount;
            }
          }
          this.shipState.credits += result.totalValue;
          this.dirty = true;
          
          if (logDecisions) {
            logDecision(this.shipState.id, `  Sell update: credits ${creditsBefore.toFixed(2)} -> ${this.shipState.credits.toFixed(2)} (received: ${result.totalValue.toFixed(2)})`);
          }
          
          // Calculate profit - use the price we captured BEFORE deletion
          let purchasePrice = purchasePriceBeforeDelete;
          
          // Diagnostic: Log purchasePrices map state if price is missing (using state BEFORE deletion)
          if (!purchasePrice) {
            console.warn(
              `[Ship ${this.shipState.id}] purchasePrice missing for ${selected.goodId} (sold ${result.quantity} units). ` +
              `BEFORE deletion: purchasePrices map had ${purchasePricesSizeBeforeDelete} entries: [${purchasePricesBeforeDelete}]. ` +
              `cargo had: [${cargoBeforeDelete}]. ` +
              `This suggests purchasePrice was never set when cargo was purchased, or was lost during persistence.`
            );
          }
          
          // Fallback: if purchasePrice is missing, try to estimate from good's base price
          // This handles cases where purchasePrices wasn't persisted or was lost
          if (!purchasePrice) {
            const good = getGoodDefinition(selected.goodId);
            if (good) {
              // Estimate purchase price as base price (conservative estimate)
              // This allows profit calculation even if purchasePrices was lost
              purchasePrice = good.basePrice;
              if (logDecisions) {
                logDecision(
                  this.shipState.id,
                  `  WARNING: purchasePrice missing for ${selected.goodId}, using base price ${good.basePrice} as fallback`
                );
              }
            }
          }
          
          const sellPrice = result.totalValue / result.quantity;
          let profitInfo = "";
          let realizedMargin: number | null = null;
          if (purchasePrice) {
            const profit = result.totalValue - (purchasePrice * result.quantity);
            realizedMargin = ((sellPrice - purchasePrice) / purchasePrice) * 100;
            profitInfo = ` (profit: ${profit.toFixed(0)} cr, ${realizedMargin.toFixed(1)}% margin)`;
          }
          
          // Log planned vs actual destination and margin
          const soldInSystemId = this.shipState.currentSystem;
          const chosenDestinationSystemId = this.shipState.chosenDestinationSystemId;
          const expectedMarginAtChoiceTime = this.shipState.expectedMarginAtChoiceTime;
          
          if (chosenDestinationSystemId !== null && expectedMarginAtChoiceTime !== null) {
            const reachedPlannedDestination = soldInSystemId === chosenDestinationSystemId;
            const marginDiff = realizedMargin !== null ? realizedMargin - expectedMarginAtChoiceTime : null;
            
            if (logDecisions) {
              logDecision(
                this.shipState.id,
                `PLANNED vs ACTUAL: chosenDestinationSystemId=${chosenDestinationSystemId}, expectedMarginAtChoiceTime=${expectedMarginAtChoiceTime.toFixed(1)}%, ` +
                `soldInSystemId=${soldInSystemId}, realizedMargin=${realizedMargin !== null ? realizedMargin.toFixed(1) : "N/A"}%, ` +
                `reachedPlannedDestination=${reachedPlannedDestination}, marginDiff=${marginDiff !== null ? marginDiff.toFixed(1) : "N/A"}%`
              );
            }
            
            // Also log to trade log
            try {
              if (shouldLogTradeNow(this.shipState.id)) {
                logTrade(
                  `[Ship ${this.shipState.id}] Planned vs Actual: ` +
                  `chosenDestinationSystemId=${chosenDestinationSystemId}, expectedMarginAtChoiceTime=${expectedMarginAtChoiceTime.toFixed(1)}%, ` +
                  `soldInSystemId=${soldInSystemId}, realizedMargin=${realizedMargin !== null ? realizedMargin.toFixed(1) : "N/A"}%, ` +
                  `reachedPlannedDestination=${reachedPlannedDestination}`
                );
              }
            } catch (error) {
              // Ignore logging errors
            }
            
            // Clear planned destination tracking after logging
            this.shipState.chosenDestinationSystemId = null;
            this.shipState.expectedMarginAtChoiceTime = null;
          }
          
          // Log trade (with error handling to prevent blocking)
          try {
            if (shouldLogTradeNow(this.shipState.id)) {
              logTrade(`[Ship ${this.shipState.id}] Sold ${result.quantity} ${selected.goodId} for ${result.totalValue} cr (${sellPrice.toFixed(2)} cr/unit)${profitInfo} in system ${this.shipState.currentSystem}`);
            }
          } catch (error) {
            // Ignore logging errors to prevent blocking trades
          }
          
          // Record trade for leaderboard
          try {
            const systemName = `System ${this.shipState.currentSystem}`;
            let profit: number | undefined = undefined;
            if (purchasePrice) {
              profit = result.totalValue - (purchasePrice * result.quantity);
            } else {
              // Purchase price missing even after fallback - this shouldn't happen
              const good = getGoodDefinition(selected.goodId);
              if (good) {
                // Use base price as last resort for profit calculation
                const estimatedPurchasePrice = good.basePrice;
                profit = result.totalValue - (estimatedPurchasePrice * result.quantity);
                console.warn(
                  `[Ship ${this.shipState.id}] Selling ${selected.goodId} but purchasePrice is missing. ` +
                  `Using base price ${estimatedPurchasePrice} as fallback for profit calculation. ` +
                  `This may indicate purchasePrices map was lost (not persisted).`
                );
              } else {
                console.warn(
                  `[Ship ${this.shipState.id}] Selling ${selected.goodId} but purchasePrice is missing and good definition not found. ` +
                  `Cannot calculate profit.`
                );
              }
            }
            recordTrade(
              this.shipState.id,
              this.shipState.name,
              this.shipState.currentSystem!,
              systemName,
              selected.goodId,
              result.quantity,
              sellPrice,
              "sell",
              profit
            );
          } catch (error) {
            // Don't let leaderboard errors break trades
          }
          
          // Log sell completion
          if (logDecisions) {
            const cargoAfterSell = Array.from(this.shipState.cargo.entries()).filter(([_, qty]) => qty > 0).map(([g, q]) => `${g}:${q}`).join(", ") || "none";
            logDecision(this.shipState.id, `  Sell completed: cargo now ${cargoAfterSell}, credits ${this.shipState.credits.toFixed(2)}`);
          }
          
          return true; // Successfully sold
        } else if (!result.success) {
          // Trade failed (business logic failure - station at capacity, etc.)
          if (logDecisions) {
            logDecision(this.shipState.id, `  RESULT: Trade failed - success=false`);
          }
          try {
            if (shouldLogTradeNow(this.shipState.id)) {
              let errorData: { error?: string };
              try {
                errorData = (await tradeResponse.json()) as { error?: string };
              } catch {
                errorData = { error: undefined };
              }
              const errorMsg = errorData.error || "Unknown error";
              logTrade(`[Ship ${this.shipState.id}] Sell trade failed: ${errorMsg} (tried to sell ${quantity} ${selected.goodId} in system ${this.shipState.currentSystem})`);
            }
          } catch (error) {
            // Ignore logging errors
          }
          
          // Record failed trade for leaderboard
          try {
            if (this.shipState.currentSystem !== null) {
              const systemName = `System ${this.shipState.currentSystem}`;
              recordFailedTrade(this.shipState.id, this.shipState.name, this.shipState.currentSystem, systemName);
            }
          } catch (error) {
            // Don't let leaderboard errors break trades
          }
        } else {
          // Trade returned success but quantity is 0 or negative - this shouldn't happen
          if (logDecisions) {
            logDecision(this.shipState.id, `  RESULT: Trade reported success but quantity=${result.quantity}, treating as failure`);
          }
          console.warn(`[Ship ${this.shipState.id}] Trade reported success but quantity=${result.quantity}, expected ${quantity}`);
        }
      } else {
        // HTTP error response
        try {
          const errorText = await tradeResponse.text();
          if (tradeResponse.status !== 400) {
            // Log non-400 errors (actual system errors)
            console.warn(`[Ship ${this.shipState.id}] Sell trade error (${tradeResponse.status}):`, errorText);
          }
          // Log 400 errors if trade logging is enabled
          if (shouldLogTradeNow(this.shipState.id)) {
            logTrade(`[Ship ${this.shipState.id}] Sell trade HTTP error (${tradeResponse.status}): ${errorText}`);
          }
        } catch (error) {
          // Ignore error handling errors
        }
      }
    } catch (error) {
      console.error(`[Ship ${this.shipState.id}] Error executing sell trade:`, error);
    }
    return false; // Trade failed or error occurred
  }

  private async tryTravel(rng: DeterministicRNG): Promise<boolean> {
    // Fix: Use explicit null check to allow system 0
    if (!this.shipState || this.shipState.currentSystem === null || this.shipState.currentSystem === undefined) return false;

    const logDecisions = shouldLogDecisions(this.shipState.id);
    if (logDecisions) {
      logDecision(this.shipState.id, `tryTravel: Starting travel evaluation from system ${this.shipState.currentSystem}`);
      logDecision(this.shipState.id, `ACTION: Attempting to travel`);
    }

    // Ship must be at station to start travel
    if (this.shipState.phase !== "at_station") {
      // Always log the specific reason (even if logDecisions is false) so parser can categorize failures
      logDecision(this.shipState.id, `RESULT: Travel failed - REASON: not at station`);
      if (logDecisions) {
        logDecision(this.shipState.id, `  RESULT: Cannot travel - not at station (phase: ${this.shipState.phase})`);
        logDecision(this.shipState.id, `RESULT: Travel attempt FAILED`);
      }
      return false;
    }

    const currentSystem = this.shipState.currentSystem;
    
    let destinationSystem: SystemId | null = null;
    let finalDistance: number | null = null;

    const maxAdditionalFuel = Math.min(
      this.shipState.fuelCapacityLy - this.shipState.fuelLy,
      this.shipState.credits / (FUEL_PRICE_PER_LY * (1 + SALES_TAX_RATE))
    );
    const maxReachableDistance = this.shipState.fuelLy + Math.max(0, maxAdditionalFuel);
    
    // Get current system coordinates first
    const currentSystemStub = this.env.STAR_SYSTEM.idFromName(`system-${currentSystem}`);
    const currentSystemObj = this.env.STAR_SYSTEM.get(currentSystemStub) as { fetch: (request: Request | string) => Promise<Response> };
    let currentCoords: { x: number; y: number } | null = null;
    try {
      currentCoords = await profiler.timeAsync(`ship-${this.shipState.id}-getCurrentCoords`, async () => {
        const currentSnapshot = await currentSystemObj.fetch(DO_INTERNAL("/snapshot"));
        const currentData = (await currentSnapshot.json()) as { state: { x?: number; y?: number } | null };
        if (currentData.state) {
          return { x: currentData.state.x ?? 0, y: currentData.state.y ?? 0 };
        }
        return null;
      });
    } catch (error) {
      console.warn(`[Ship ${this.shipState.id}] Failed to get current system coordinates:`, error);
    }

    // Check if NPC has cargo to sell
    const hasCargo = this.shipState.cargo.size > 0 && 
                     Array.from(this.shipState.cargo.values()).some(qty => qty > 0);
    
    // If ship has cargo and a stored destination (locked in before buying), use it
    if (hasCargo && this.shipState.chosenDestinationSystemId !== null && this.shipState.chosenDestinationSystemId !== undefined) {
      const storedDestination = this.shipState.chosenDestinationSystemId;
      if (logDecisions) {
        logDecision(this.shipState.id, `  Using stored destination: system ${storedDestination} (locked in before purchase)`);
      }
      
      // Verify the stored destination is reachable
      try {
        const targetSystemStub = this.env.STAR_SYSTEM.idFromName(`system-${storedDestination}`);
        const targetSystemObj = this.env.STAR_SYSTEM.get(targetSystemStub) as { fetch: (request: Request | string) => Promise<Response> };
        const targetSnapshot = await targetSystemObj.fetch(DO_INTERNAL("/snapshot"));
        const targetData = (await targetSnapshot.json()) as { 
          state: { x?: number; y?: number } | null;
        };
        
        let destinationDistance: number;
        if (currentCoords && targetData.state) {
          const targetX = targetData.state.x ?? 0;
          const targetY = targetData.state.y ?? 0;
          destinationDistance = this.calculateDistance(currentCoords.x, currentCoords.y, targetX, targetY);
        } else {
          // Fallback to simple distance
          destinationDistance = Math.abs(currentSystem - storedDestination);
        }
        
        // Check if destination is reachable
        if (destinationDistance <= MAX_TRAVEL_DISTANCE && destinationDistance <= maxReachableDistance + 0.001) {
          destinationSystem = storedDestination;
          finalDistance = destinationDistance;
          
          if (logDecisions) {
            logDecision(this.shipState.id, `  Using stored destination: system ${storedDestination} (distance: ${finalDistance.toFixed(2)} LY)`);
          }
        } else {
          // Stored destination is not reachable - clear it and recalculate
          const reason = destinationDistance > MAX_TRAVEL_DISTANCE 
            ? `beyond max travel distance (${destinationDistance.toFixed(2)} > ${MAX_TRAVEL_DISTANCE})`
            : `beyond reachable distance (${destinationDistance.toFixed(2)} > ${maxReachableDistance.toFixed(2)}, fuel: ${this.shipState.fuelLy.toFixed(2)}/${this.shipState.fuelCapacityLy.toFixed(2)}, credits: ${this.shipState.credits.toFixed(2)})`;
          console.warn(
            `[Ship ${this.shipState.id}] Stored destination ${storedDestination} is not reachable: ${reason}. ` +
            `Clearing stored destination and recalculating.`
          );
          if (logDecisions) {
            logDecision(this.shipState.id, `  Stored destination ${storedDestination} is not reachable (distance: ${destinationDistance.toFixed(2)} LY, max: ${maxReachableDistance.toFixed(2)} LY), recalculating`);
          }
          this.shipState.chosenDestinationSystemId = null;
          this.shipState.expectedMarginAtChoiceTime = null;
          // Fall through to normal destination selection
        }
      } catch (error) {
        // Error fetching destination - clear it and recalculate
        if (logDecisions) {
          logDecision(this.shipState.id, `  Error verifying stored destination ${storedDestination}, recalculating`);
        }
        this.shipState.chosenDestinationSystemId = null;
        this.shipState.expectedMarginAtChoiceTime = null;
        // Fall through to normal destination selection
      }
    }
    
    // Variables for destination search (used even if we have stored destination, for error reporting)
    let systemsInRangeButUnreachable = 0; // Track systems within MAX_TRAVEL_DISTANCE but beyond maxReachableDistance
    let totalReachableSystems = 0; // Track total systems within MAX_TRAVEL_DISTANCE (for error reporting)
    
    // Get current system markets for comparison (needed for scoring)
    let currentMarkets: Record<GoodId, { price: number; inventory: number }> | null = null;
    try {
      currentMarkets = await profiler.timeAsync(`ship-${this.shipState.id}-getCurrentMarkets`, async () => {
        const currentSnapshot = await currentSystemObj.fetch(DO_INTERNAL("/snapshot"));
        const currentSnapshotData = (await currentSnapshot.json()) as { markets?: Record<GoodId, { price: number; inventory: number }> };
        return currentSnapshotData.markets || null;
      });
    } catch (error) {
      // Ignore - will use fallback
    }
    
    // If we don't have a destination yet, get list of reachable systems from station
    if (destinationSystem === null) {
      const nearbySystems: Array<{ id: SystemId; distance: number; score: number; reason?: string }> = [];
      
      // Get list of reachable systems from current system
      let reachableSystems: Array<{ id: SystemId; distance: number }> = [];
      try {
        // Try to call getReachableSystems directly
        let usedDirectCall = false;
        try {
          const systemAsStarSystem = currentSystemObj as StarSystem;
          if (systemAsStarSystem.getReachableSystems && typeof systemAsStarSystem.getReachableSystems === 'function') {
            reachableSystems = await systemAsStarSystem.getReachableSystems();
            totalReachableSystems = reachableSystems.length;
            usedDirectCall = true;
          } else {
            // Try prototype chain
            const proto = Object.getPrototypeOf(currentSystemObj);
            if (proto && proto.getReachableSystems && typeof proto.getReachableSystems === 'function') {
              reachableSystems = await proto.getReachableSystems.call(systemAsStarSystem);
              totalReachableSystems = reachableSystems.length;
              usedDirectCall = true;
            }
          }
        } catch (error) {
          // Method doesn't exist or call failed - will fall back to fetch
        }
        
        // Fallback to fetch if direct call wasn't used
        if (!usedDirectCall) {
          const systemAsFetch = currentSystemObj as { fetch: (request: Request | string) => Promise<Response> };
          const reachableResponse = await systemAsFetch.fetch(DO_INTERNAL("/reachable-systems"));
          if (reachableResponse.ok) {
            const reachableData = (await reachableResponse.json()) as { systems: Array<{ id: SystemId; distance: number }> };
            reachableSystems = reachableData.systems || [];
            totalReachableSystems = reachableSystems.length;
          }
        }
      } catch (error) {
        if (logDecisions) {
          logDecision(this.shipState.id, `  Error getting reachable systems: ${error}`);
        }
      }
      
      if (logDecisions) {
        logDecision(this.shipState.id, `  Found ${reachableSystems.length} reachable systems (hasCargo=${hasCargo}, maxReachable=${maxReachableDistance.toFixed(2)} LY)`);
      }
      
      // Check each reachable system
      for (const reachableSystem of reachableSystems) {
        const systemId = reachableSystem.id;
        const distance = reachableSystem.distance;
        
        // Track systems that are in range but unreachable (beyond maxReachableDistance)
        if (distance <= MAX_TRAVEL_DISTANCE && distance > maxReachableDistance + 0.001) {
          systemsInRangeButUnreachable++;
        }
        
        // Only consider systems within reachable distance
        if (distance <= maxReachableDistance + 0.001) {
          // Get market data for this system
          let targetMarkets: Record<GoodId, { price: number; inventory: number }> | null = null;
          try {
            // Try to get cached snapshot first
            const cachedSnapshot = getCachedSnapshot(systemId);
            if (cachedSnapshot) {
              targetMarkets = cachedSnapshot.markets as Record<GoodId, { price: number; inventory: number }>;
            } else {
              // Fetch snapshot if not in cache
              const targetSystemStub = this.env.STAR_SYSTEM.idFromName(`system-${systemId}`);
              const targetSystemObj = this.env.STAR_SYSTEM.get(targetSystemStub) as { fetch: (request: Request | string) => Promise<Response> };
              const targetSnapshot = await targetSystemObj.fetch(DO_INTERNAL("/snapshot"));
              const targetData = (await targetSnapshot.json()) as { 
                markets?: Record<GoodId, { price: number; inventory: number }>;
              };
              targetMarkets = targetData.markets || null;
            }
          } catch (error) {
            // Skip this system if we can't get market data
            continue;
          }
          
          let score = 0;
          let reason = "";
          
          if (hasCargo && targetMarkets) {
            // Score based on potential profit from selling cargo
            let totalPotentialProfit = 0;
            let totalCargoValue = 0;
            
            for (const [goodId, quantity] of this.shipState.cargo.entries()) {
              if (quantity <= 0) continue;
              
              const purchasePrice = this.purchasePrices.get(goodId);
              const targetPrice = targetMarkets[goodId]?.price;
              
              if (purchasePrice && targetPrice) {
                // Fix: Use net sell price (post-tax) for profit calculation
                const netSellPrice = targetPrice; // No tax on sales
                const profitPerUnit = netSellPrice - purchasePrice;
                const profit = profitPerUnit * quantity;
                totalPotentialProfit += profit;
                totalCargoValue += purchasePrice * quantity;
              }
            }
            
            if (totalCargoValue > 0) {
              const profitMargin = (totalPotentialProfit / totalCargoValue) * 100;
              score = profitMargin; // Use profit margin as score
              reason = `profit: ${profitMargin.toFixed(1)}%`;
            } else {
              score = -100; // Penalize if we can't calculate profit
            }
          } else if (!hasCargo && targetMarkets && currentMarkets) {
            // Fix: Score based on buying opportunities accounting for tax
            // Compare effective buy prices (with tax) between systems
            let bestOpportunity = 0;
            
            for (const goodId of Object.keys(targetMarkets) as GoodId[]) {
              const targetPrice = targetMarkets[goodId]?.price;
              const currentPrice = currentMarkets[goodId]?.price;
              
              if (targetPrice && currentPrice && targetPrice > 0) {
                // Compare effective buy prices (price + tax)
                const targetEffectivePrice = targetPrice * (1 + SALES_TAX_RATE);
                const currentEffectivePrice = currentPrice * (1 + SALES_TAX_RATE);
                // Prefer systems where effective buy price is cheaper
                const priceRatio = currentEffectivePrice / targetEffectivePrice;
                if (priceRatio > 1.1) { // At least 10% cheaper after tax
                  bestOpportunity = Math.max(bestOpportunity, priceRatio - 1);
                }
              }
            }
            
            score = bestOpportunity * 100; // Convert to percentage score
            reason = `buy opportunity: ${(bestOpportunity * 100).toFixed(1)}%`;
          } else {
            // No market data - neutral score
            score = 0;
            reason = "no market data";
          }
          
          // Prefer closer systems (reduce score by distance)
          score -= distance * 0.5;
          
          nearbySystems.push({ id: systemId, distance, score, reason });
        }
      }
    
    if (nearbySystems.length > 0) {
      // Sort by score (highest first)
      nearbySystems.sort((a, b) => b.score - a.score);
      
      // Filter out negative scores (losses) - only consider profitable or neutral options
      const profitableCandidates = nearbySystems.filter(c => c.score >= 0);
      const candidatesToUse = profitableCandidates.length > 0 ? profitableCandidates : nearbySystems;
      const usingLossyCandidates = profitableCandidates.length === 0;
      
      // Pick from top 5 candidates with weighted randomness (top candidates more likely)
      const topCandidates = candidatesToUse.slice(0, Math.min(5, candidatesToUse.length));
      
      if (logDecisions && topCandidates.length > 0) {
        const top3 = topCandidates.slice(0, 3).map(c => `system ${c.id} (${c.reason}, score: ${c.score.toFixed(1)})`).join(", ");
        logDecision(this.shipState.id, `  Top candidates: ${top3}`);
      }
      
      // Weighted selection: use score-based weights (higher score = higher weight)
      // For positive scores, use score directly; for negative, use very low weight
      const weights = topCandidates.map(c => {
        if (c.score > 0) {
          return c.score; // Use score as weight for profitable options
        } else {
          return Math.max(0.1, c.score + 100); // Very low weight for losses, but still possible if no better options
        }
      });
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);
      
      let selected: { id: SystemId; distance: number; score: number; reason?: string };
      if (totalWeight > 0) {
        let randomValue = rng.random() * totalWeight;
        
        let selectedIndex = 0;
        for (let i = 0; i < weights.length; i++) {
          randomValue -= weights[i];
          if (randomValue <= 0) {
            selectedIndex = i;
            break;
          }
        }
        
        selected = topCandidates[selectedIndex];
        destinationSystem = selected.id;
        finalDistance = selected.distance;
      } else {
        // Fallback: pick first candidate if all weights are zero
        selected = topCandidates[0];
        destinationSystem = selected.id;
        finalDistance = selected.distance;
      }
      
      if (logDecisions) {
        if (usingLossyCandidates) {
          logDecision(this.shipState.id, `  WARNING: No non-negative destinations, selecting best available`);
        }
        logDecision(this.shipState.id, `  Selected destination: system ${destinationSystem} (${selected.reason}, distance: ${finalDistance.toFixed(2)})`);
      }
      
      // Store planned destination and expected margin if traveling with cargo
      // Only store if we don't already have one (from tryBuyGoods)
      if (hasCargo && this.shipState.chosenDestinationSystemId === null && selected.reason?.startsWith("profit:")) {
        // Extract expected margin from reason string (e.g., "profit: 51.7%")
        const marginMatch = selected.reason.match(/profit:\s*([\d.]+)%/);
        if (marginMatch) {
          const expectedMargin = parseFloat(marginMatch[1]);
          this.shipState.chosenDestinationSystemId = destinationSystem;
          this.shipState.expectedMarginAtChoiceTime = expectedMargin;
          if (logDecisions) {
            logDecision(this.shipState.id, `  Stored planned destination: system ${destinationSystem}, expected margin: ${expectedMargin.toFixed(1)}%`);
          }
        }
      }
    } else {
      // Always log the specific reason (even if logDecisions is false) so parser can categorize failures
      // Determine specific reason: check if it's out of range or insufficient credits for fuel
      const cargoSummary = hasCargo 
        ? Array.from(this.shipState.cargo.entries()).filter(([_, qty]) => qty > 0).map(([g, q]) => `${g}:${q}`).join(", ")
        : "none";
      
      if (systemsInRangeButUnreachable > 0) {
        // Systems exist within MAX_TRAVEL_DISTANCE but are beyond maxReachableDistance
        logDecision(this.shipState.id, `RESULT: Travel failed - REASON: insufficient credits for fuel purchase`);
        console.warn(
          `[Ship ${this.shipState.id}] Travel failed: ${systemsInRangeButUnreachable} systems in range but unreachable. ` +
          `Fuel: ${this.shipState.fuelLy.toFixed(2)}/${this.shipState.fuelCapacityLy.toFixed(2)} LY, ` +
          `Credits: ${this.shipState.credits.toFixed(2)}, ` +
          `Max reachable: ${maxReachableDistance.toFixed(2)} LY, ` +
          `Cargo: [${cargoSummary}], ` +
          `Current system: ${currentSystem}`
        );
      } else {
        // No systems found within MAX_TRAVEL_DISTANCE - out of range
        logDecision(this.shipState.id, `RESULT: Travel failed - REASON: out of range`);
        
        console.warn(
          `[Ship ${this.shipState.id}] Travel failed: No reachable destinations found. ` +
          `Fuel: ${this.shipState.fuelLy.toFixed(2)}/${this.shipState.fuelCapacityLy.toFixed(2)} LY, ` +
          `Credits: ${this.shipState.credits.toFixed(2)}, ` +
          `Max reachable: ${maxReachableDistance.toFixed(2)} LY, ` +
          `Total systems within ${MAX_TRAVEL_DISTANCE} LY: ${totalReachableSystems}, ` +
          `Systems in range but unreachable: ${systemsInRangeButUnreachable}, ` +
          `Cargo: [${cargoSummary}], ` +
          `Current system: ${currentSystem}, ` +
          `Stored destination: ${this.shipState.chosenDestinationSystemId ?? "none"}`
        );
        
        // CRITICAL: If no destinations found, the galaxy is broken
        // This means the system has no neighbors within 15 LY, which violates galaxy validation
        if (totalReachableSystems === 0) {
          const errorMsg = `[Ship ${this.shipState.id}] CRITICAL: No systems found within ${MAX_TRAVEL_DISTANCE} LY from system ${currentSystem}. ` +
            `Galaxy validation should have ensured at least 3 neighbors per system. This indicates a broken galaxy!`;
          console.error(errorMsg);
          // Don't throw - let the ship clear cargo and continue, but log the critical error
          // The galaxy validation should catch this during initialization
        }
      }
      if (logDecisions) {
        logDecision(this.shipState.id, `  RESULT: Cannot travel - no reachable destinations (fuel/credits)`);
        logDecision(this.shipState.id, `RESULT: Travel attempt FAILED`);
      }
      return false;
      }
    }

    if (logDecisions && finalDistance !== null) {
      logDecision(this.shipState.id, `  Selected destination: system ${destinationSystem} (distance: ${finalDistance.toFixed(2)})`);
    }

    // Fix: Check fuel before starting travel
    if (finalDistance === null) {
      if (logDecisions) {
        logDecision(this.shipState.id, `RESULT: Travel attempt FAILED - no destination selected`);
      }
      return false;
    }
    
    if (this.shipState.fuelLy < finalDistance) {
      if (this.shipState.isNPC) {
        const refueled = this.tryRefuelForTravel(finalDistance);
        if (refueled && this.shipState.fuelLy >= finalDistance) {
          if (logDecisions) {
            logDecision(this.shipState.id, `  Refuel successful: fuel ${this.shipState.fuelLy.toFixed(2)} LY`);
          }
        } else {
          // Always log the specific reason (even if logDecisions is false) so parser can categorize failures
          // Check if refuel failed due to insufficient credits
          const fuelNeeded = finalDistance - this.shipState.fuelLy;
          const fuelCost = Math.ceil(fuelNeeded * FUEL_PRICE_PER_LY * (1 + SALES_TAX_RATE));
          if (this.shipState.credits < fuelCost) {
            logDecision(this.shipState.id, `RESULT: Travel failed - REASON: insufficient credits for fuel purchase`);
          } else {
            logDecision(this.shipState.id, `RESULT: Travel failed - REASON: insufficient fuel in tank`);
          }
          if (logDecisions) {
            logDecision(this.shipState.id, `  Cannot travel: insufficient fuel (have ${this.shipState.fuelLy.toFixed(2)} LY, need ${finalDistance.toFixed(2)} LY)`);
            logDecision(this.shipState.id, `RESULT: Travel blocked - insufficient fuel after refuel attempt`);
            logDecision(this.shipState.id, `RESULT: Travel attempt FAILED`);
          }
          return false;
        }
      } else {
        // Always log the specific reason (even if logDecisions is false) so parser can categorize failures
        logDecision(this.shipState.id, `RESULT: Travel failed - REASON: insufficient fuel in tank`);
        if (logDecisions) {
          logDecision(this.shipState.id, `  Cannot travel: insufficient fuel (have ${this.shipState.fuelLy.toFixed(2)} LY, need ${finalDistance.toFixed(2)} LY)`);
          logDecision(this.shipState.id, `RESULT: Travel attempt FAILED`);
        }
        return false;
      }
    }

    // Fix: Store origin system before it changes
    const originSystem = this.shipState.currentSystem;

    // Start departure phase
    const now = Date.now();
    this.shipState.destinationSystem = destinationSystem;
    this.shipState.originSystem = originSystem; // Store origin for arrival metadata
    this.shipState.phase = "departing";
    this.shipState.departureStartTime = now;
    updateShipPresence(this.shipState);
    
    // Use the distance we already calculated
    const distance = finalDistance;
    
    // Log travel (with error handling to prevent blocking)
    try {
      if (shouldLogTradeNow(this.shipState.id)) {
        logTrade(`[Ship ${this.shipState.id}] Traveling from system ${currentSystem} to system ${destinationSystem} (distance: ${distance.toFixed(2)})`);
      }
    } catch (error) {
      // Ignore logging errors to prevent blocking travel
    }
    if (logDecisions) {
      logDecision(this.shipState.id, `RESULT: Travel attempt SUCCESS`);
    }
    // Note: System departure notification happens when departure phase completes
    return true; // Travel started successfully
  }

  private async executeTrade(
    goodId: GoodId,
    quantity: number,
    type: "buy" | "sell"
  ): Promise<Response> {
    if (!this.shipState || this.shipState.currentSystem === null || this.shipState.currentSystem === undefined) {
      return new Response(JSON.stringify({ error: "Ship not in system" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const systemStub = this.env.STAR_SYSTEM.idFromName(
      `system-${this.shipState.currentSystem}`
    );
            const system = this.env.STAR_SYSTEM.get(systemStub) as { fetch: (request: Request | string) => Promise<Response> };

    return await system.fetch(
      new Request(DO_INTERNAL("/trade"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipId: this.shipState.id,
          goodId,
          quantity,
          type,
        }),
      })
    );
  }

  private async handleTrade(request: Request): Promise<Response> {
    // This is for player trades (non-NPC)
    if (!this.shipState || this.shipState.isNPC) {
      return new Response(JSON.stringify({ error: "Invalid trade request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Fix: Gate player trades by phase - must be at station
    if (this.shipState.phase !== "at_station") {
      return new Response(JSON.stringify({ error: "Ship must be at station to trade" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Fix: Also check currentSystem is not null
    if (this.shipState.currentSystem === null || this.shipState.currentSystem === undefined) {
      return new Response(JSON.stringify({ error: "Ship must be in a system to trade" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = (await request.json()) as {
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

    const currentCargo = this.shipState.cargo.get(body.goodId) || 0;
    if (body.type === "sell" && currentCargo < body.quantity) {
      return new Response(JSON.stringify({ error: "Insufficient cargo" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const tradeResponse = await this.executeTrade(body.goodId, body.quantity, body.type);
    const tradeData = await tradeResponse.json();

    if (!tradeResponse.ok || !tradeData.success) {
      return new Response(JSON.stringify(tradeData), {
        status: tradeResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.type === "buy") {
      const totalCost = Number(tradeData.totalCost) || 0;
      const purchasePrice = totalCost / body.quantity; // Price per unit
      this.shipState.cargo.set(body.goodId, currentCargo + body.quantity);
      this.shipState.credits -= totalCost;
      
      // Track purchase price (weighted average if buying more of same good)
      const currentPurchasePrice = this.shipState.purchasePrices.get(body.goodId);
      if (currentPurchasePrice && currentCargo > 0) {
        // Weighted average for additional purchases
        const totalCostWithExisting = (currentPurchasePrice * currentCargo) + totalCost;
        const totalQuantity = currentCargo + body.quantity;
        this.shipState.purchasePrices.set(body.goodId, totalCostWithExisting / totalQuantity);
      } else {
        // First purchase of this good
        this.shipState.purchasePrices.set(body.goodId, purchasePrice);
      }
    } else {
      const soldQuantity = Number.isFinite(tradeData.quantity) ? tradeData.quantity : body.quantity;
      const totalValue = Number(tradeData.totalValue) || 0;
      this.shipState.cargo.set(body.goodId, Math.max(0, currentCargo - soldQuantity));
      this.shipState.credits += totalValue;
    }

    this.dirty = true;
    updateShipPresence(this.shipState);

    const shipSnapshot = JSON.parse(JSON.stringify(this.shipState, (key, value) => {
      if (value instanceof Map) {
        return Object.fromEntries(value);
      }
      return value;
    }));

    const responsePayload = {
      ...tradeData,
      ship: shipSnapshot,
    };

    return new Response(JSON.stringify(responsePayload), {
      status: tradeResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private async handleTravel(request: Request): Promise<Response> {
    // This is for player travel (non-NPC)
    if (!this.shipState || this.shipState.isNPC) {
      return new Response(JSON.stringify({ error: "Invalid travel request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Must be at station to travel
    if (this.shipState.phase !== "at_station") {
      return new Response(JSON.stringify({ error: "Ship must be at station to travel" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (this.shipState.currentSystem === null || this.shipState.currentSystem === undefined) {
      return new Response(JSON.stringify({ error: "Ship must be in a system to travel" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = (await request.json()) as {
      destinationSystem: SystemId;
      distanceLy?: number;
    };

    if (!Number.isFinite(body.destinationSystem) || body.destinationSystem < 0 || body.destinationSystem >= 256) {
      return new Response(JSON.stringify({ error: "Invalid destination system: must be 0-255" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (body.destinationSystem === this.shipState.currentSystem) {
      return new Response(JSON.stringify({ error: "Cannot travel to current system" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Check fuel
    let distance = await this.calculateSystemDistance(this.shipState.currentSystem, body.destinationSystem);
    if (Number.isFinite(body.distanceLy) && body.distanceLy !== undefined) {
      const providedDistance = Number(body.distanceLy);
      if (providedDistance >= 0 && providedDistance <= 1000) {
        distance = providedDistance;
      }
    }
    if (this.shipState.fuelLy < distance) {
      return new Response(JSON.stringify({ error: `Insufficient fuel: need ${distance} LY, have ${this.shipState.fuelLy.toFixed(2)} LY` }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Initiate travel
    const originSystem = this.shipState.currentSystem;
    const now = Date.now();
    this.shipState.destinationSystem = body.destinationSystem;
    this.shipState.originSystem = originSystem;
    this.shipState.phase = "departing";
    this.shipState.departureStartTime = now;
    this.dirty = true;

    // Store origin prices for arrival effects
    try {
      const originSystemStub = this.env.STAR_SYSTEM.idFromName(`system-${originSystem}`);
      const originSystemObj = this.env.STAR_SYSTEM.get(originSystemStub) as { fetch: (request: Request | string) => Promise<Response> };
      const snapshotResponse = await originSystemObj.fetch(DO_INTERNAL("/snapshot"));
      if (snapshotResponse.ok) {
        const snapshotData = (await snapshotResponse.json()) as {
          markets: Record<GoodId, { price: number }>;
        };
        const priceInfo: Array<[GoodId, number]> = [];
        for (const [goodId, market] of Object.entries(snapshotData.markets)) {
          priceInfo.push([goodId as GoodId, market.price]);
        }
        this.shipState.originPriceInfo = priceInfo;
      }
    } catch (error) {
      console.error(`[Ship ${this.shipState.id}] Error getting origin prices:`, error);
    }

    this.dirty = true; // Mark as dirty - will be flushed at end of tick
    updateShipPresence(this.shipState);

    return new Response(JSON.stringify({
      success: true,
      message: `Travel initiated to system ${body.destinationSystem}`,
      destinationSystem: body.destinationSystem,
      distance: distance,
      fuelRemaining: this.shipState.fuelLy,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * NPCs may decide to rest or sleep after trading
   * Rest: 5-60 minutes (30% chance after trade)
   * Sleep: up to 12 hours (5% chance after trade)
   */
  private async maybeStartRest(rng: DeterministicRNG): Promise<void> {
    if (!this.shipState || !this.shipState.isNPC || this.shipState.phase !== "at_station") {
      return;
    }

    // Don't rest if credits are below rest gating threshold - NPCs need to keep trading when finances are tight
    // This is separate from recovery threshold to ensure NPCs only rest when financially comfortable
    if (this.shipState.credits < REST_GATING_THRESHOLD) {
      const logDecisions = shouldLogDecisions(this.shipState.id);
      if (logDecisions) {
        logDecision(this.shipState.id, `  Skipping rest - credits (${this.shipState.credits.toFixed(2)}) below rest gating threshold (${REST_GATING_THRESHOLD})`);
      }
      return;
    }

    const now = Date.now();
    const restRoll = rng.random();

    if (restRoll < SLEEP_CHANCE_AFTER_TRADE) {
      // Sleep: up to 12 hours
      const sleepDuration = rng.randomInt(1 * 60 * 60 * 1000, SLEEP_TIME_MAX_MS); // 1-12 hours
      this.shipState.phase = "sleeping";
      this.shipState.restStartTime = now;
      this.shipState.restEndTime = now + sleepDuration;
      updateShipPresence(this.shipState);
    } else if (restRoll < SLEEP_CHANCE_AFTER_TRADE + REST_CHANCE_AFTER_TRADE) {
      // Rest: 5-60 minutes
      const restDuration = rng.randomInt(REST_TIME_MIN_MS, REST_TIME_MAX_MS);
      this.shipState.phase = "resting";
      this.shipState.restStartTime = now;
      this.shipState.restEndTime = now + restDuration;
      updateShipPresence(this.shipState);
    }
  }

  /**
   * Remove an NPC that has gone bankrupt (credits <= 0)
   * Removes them from their current system and clears their state
   */
  private async removeNPC(reason: string = "unknown"): Promise<void> {
    if (!this.shipState || !this.shipState.isNPC) return;

    const logDecisions = shouldLogDecisions(this.shipState.id);
    const currentSystem = this.shipState.currentSystem;
    const credits = this.shipState.credits;
    
    if (logDecisions) {
      logDecision(this.shipState.id, `NPC REMOVED: ${reason} (was in system ${currentSystem}, credits: ${credits.toFixed(2)})`);
    }
    // NPC removed silently (no logging)

    // Remove from current system if present
    if (this.shipState.currentSystem !== null) {
      try {
        const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${this.shipState.currentSystem}`);
        const system = this.env.STAR_SYSTEM.get(systemStub) as { fetch: (request: Request | string) => Promise<Response> };
        await system.fetch(
          new Request(DO_INTERNAL("/departure"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shipId: this.shipState.id }),
          })
        );
      } catch (error) {
        console.error(`[Ship ${this.shipState.id}] Error removing from system:`, error);
      }
    }

    // Clear ship state - mark as removed
    this.shipState.currentSystem = null;
    this.shipState.destinationSystem = null;
    this.shipState.phase = "at_station"; // Keep phase for cleanup, but system is null
    this.shipState.cargo.clear();
    this.purchasePrices.clear();
    this.shipState.chosenDestinationSystemId = null;
    this.shipState.expectedMarginAtChoiceTime = null;
    this.dirty = true;

    // Remove from presence registry
    removeShipPresence(this.shipState.id);
    
    // Record removal for health tracking
    try {
      recordRemoval(this.shipState.id, currentSystem, reason, credits);
    } catch (error) {
      // Don't let health tracking errors break removal
      console.error(`[Ship ${this.shipState.id}] Error recording removal:`, error);
    }
    
    this.dirty = true; // Mark as dirty - will be flushed at end of tick
  }
}
