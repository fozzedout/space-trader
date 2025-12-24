/**
 * Local Node.js HTTP server for development
 * Runs the simulation logic without external platform dependencies
 */

import http from "http";
import { URL } from "url";
import * as fs from "fs";
import * as pathModule from "path";
import os from "os";
import { StarSystem } from "./star-system";
import { Ship } from "./ship";
import { SystemId, ShipId, TechLevel, GovernmentType, WorldType, GoodId } from "./types";
import { DeterministicRNG } from "./deterministic-rng";
import { LocalDurableObjectState, closeDatabase, getPlayerByName, hasInitializedGalaxy, LocalStorage, upsertPlayer } from "./local-storage";
import { getCategoryDocsHtml } from "./api-docs";
import { setTradeLoggingMode, getTradeLoggingMode, shouldTickTraders, getTradeLogs, clearTradeLogs } from "./trade-logging";
import { resetZeroInventoryMonitoring } from "./star-system";
import { collectGalaxyMetrics, getMonitoringData, clearMonitoringData, analyzeAndRecommend, collectShipMetrics, collectSystemMetrics } from "./monitoring";
import { clearShipPresence, getPresenceBySystem, listShipsInSystem, updateShipPresence } from "./local-ship-registry";
import { recordSpawn, getGalaxyHealth, clearHealthData } from "./galaxy-health";
import { getLeaderboard, getTraderDetails, getSystemDetails, clearLeaderboard } from "./leaderboard";
import { FUEL_PRICE_PER_LY } from "./armaments";
import { getAllGoodIds, getGoodDefinition } from "./goods";
import { getMinProfitMargin } from "./balance-config";
import { profiler } from "./profiler";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const GALAXY_SIZE = parseInt(process.env.GALAXY_SIZE || "256", 10);
const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS || "29000", 10); // 29 seconds - for systems and station ships (prime)
const TRAVELING_TICK_INTERVAL_MS = parseInt(process.env.TRAVELING_TICK_INTERVAL_MS || "11000", 10); // 11 seconds - for traveling ships (departing, in_hyperspace, arriving) (prime)
const TOTAL_NPCS = parseInt(process.env.TOTAL_NPCS || "8000", 10);
const AUTO_TICK = process.env.AUTO_TICK !== "false"; // Enable auto-ticking by default (set AUTO_TICK=false to disable)
const RESET_INTERVAL_MS = parseInt(process.env.RESET_INTERVAL_MS || `${5 * 60 * 1000}`, 10); // 5 minutes (was 30 minutes)
const SALES_TAX_RATE = 0.03; // 3% tax on purchases only (no tax on sales) - must match star-system.ts and ship.ts

// Track server start time for health calculations
const SERVER_START_TIME = Date.now();

// Calculate low credit threshold relative to starting cash and fuel economics
// Formula: max( (minFuelReserveCredits + taxBuffer + 1 full cargo unit), 50–150 )
// This matches the calculation in ship.ts
function calculateLowCreditThreshold(): number {
  const MIN_TRAVEL_FUEL_LY = 5;
  const TAX_BUFFER = 50;
  
  // Cost to refuel minimum fuel reserve (5 LY) with tax
  const minFuelReserveCredits = Math.ceil(MIN_TRAVEL_FUEL_LY * FUEL_PRICE_PER_LY * (1 + SALES_TAX_RATE));
  
  // Cost of 1 full cargo unit (using conservative estimate: textiles base price 20 + tax)
  const oneCargoUnitCost = Math.ceil(20 * (1 + SALES_TAX_RATE)); // ~21 credits
  
  // Calculate base threshold
  const baseThreshold = minFuelReserveCredits + TAX_BUFFER + oneCargoUnitCost;
  
  // Ensure minimum floor between 50-150 (using 100 as reasonable middle)
  return Math.max(baseThreshold, 100);
}

const LOW_CREDIT_THRESHOLD = process.env.LOW_CREDIT_THRESHOLD 
  ? parseFloat(process.env.LOW_CREDIT_THRESHOLD) 
  : calculateLowCreditThreshold();
const CYCLE_LOG_PATH = process.env.CYCLE_LOG_PATH || pathModule.join(process.cwd(), "logs", "cycle-log.json");
let loggingPaused = false; // Set to true when code change is needed, stops logging until restart

// Runtime auto-tick control
let autoTickEnabled = AUTO_TICK;
let autoTickInterval: NodeJS.Timeout | null = null;

// Health check interval control
let healthCheckInterval: NodeJS.Timeout | null = null;

/**
 * Ship processing queue system
 * Processes ships gradually in the background to avoid blocking
 */
interface QueuedShip {
  shipId: ShipId;
  tickId: string; // Unique ID for this tick cycle
}

// Separate queues for traveling ships (fast tick) and station ships (normal tick)
let travelingShipQueue: QueuedShip[] = [];
let stationShipQueue: QueuedShip[] = [];
let queuedTravelingShipIds = new Set<ShipId>(); // Track which traveling ships are already queued
let queuedStationShipIds = new Set<ShipId>(); // Track which station ships are already queued
let isProcessingTravelingQueue = false;
let isProcessingStationQueue = false;
let isSystemTickInProgress = false;
let currentTickId: string | null = null;
let shipsProcessedLastTick = 0; // Track ships processed in the last completed tick

function resetShipQueue(): void {
  travelingShipQueue = [];
  stationShipQueue = [];
  queuedTravelingShipIds.clear();
  queuedStationShipIds.clear();
  isProcessingTravelingQueue = false;
  isProcessingStationQueue = false;
  currentTickId = null;
  shipsProcessedLastTick = 0;
}

const SYSTEM_NAMES = [
  "Sol", "Alpha Centauri", "Barnard's Star", "Wolf 359", "Lalande 21185",
  "Sirius", "Vega", "Arcturus", "Capella", "Rigel",
  "Procyon", "Achernar", "Betelgeuse", "Altair", "Aldebaran",
  "Spica", "Antares", "Pollux", "Fomalhaut", "Deneb",
];

const GOVERNMENT_TYPES = [
  GovernmentType.ANARCHY,
  GovernmentType.CORPORATE,
  GovernmentType.DEMOCRACY,
  GovernmentType.DICTATORSHIP,
  GovernmentType.FEUDAL,
  GovernmentType.MULTI_GOVERNMENT,
];

// In-memory storage for systems and ships
const systems = new Map<SystemId, StarSystem>();
const ships = new Map<ShipId, Ship>();

// Local environment for simulation objects (Node.js equivalent of Durable Object namespaces)
// Provides the same interface as the simulation runtime with STAR_SYSTEM and SHIP namespaces
const localEnv: any = {
  STAR_SYSTEM: {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString(): string }) => {
      const systemId = parseInt(id.toString().replace("system-", ""), 10) as SystemId;
      if (!systems.has(systemId)) {
        const state = new LocalDurableObjectState(`system-${systemId}`);
        const system = new StarSystem(state as any, localEnv);
        systems.set(systemId, system);
      }
      return systems.get(systemId)!;
    },
  },
  SHIP: {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString(): string }) => {
      const shipId = id.toString() as ShipId;
      if (!ships.has(shipId)) {
        const state = new LocalDurableObjectState(shipId);
        const ship = new Ship(state as any, localEnv);
        ships.set(shipId, ship);
      }
      return ships.get(shipId)!;
    },
  },
};

type LowCreditNpcEntry = {
  shipId: ShipId;
  credits: number;
  systemId: SystemId | null;
  phase: string | null;
};

let cycleStartTime = Date.now();
let cycleIndex = 0;
let isCycleResetting = false;

async function collectLowCreditNpcs(): Promise<LowCreditNpcEntry[]> {
  const entries: LowCreditNpcEntry[] = [];
  for (let i = 0; i < TOTAL_NPCS; i++) {
    const shipId = `npc-${i}` as ShipId;
    try {
      const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      if (!stateResponse.ok) continue;
      const state = await stateResponse.json();
      if (typeof state.credits === "number" && state.credits < LOW_CREDIT_THRESHOLD) {
        entries.push({
          shipId,
          credits: state.credits,
          systemId: state.currentSystem ?? null,
          phase: state.phase ?? null,
        });
      }
    } catch (error) {
      // Skip ships that can't be loaded
    }
  }
  return entries;
}

async function collectLowCreditSnapshot(cycleEndTime: number): Promise<{
  cycleIndex: number;
  cycleStartTime: number;
  cycleEndTime: number;
  threshold: number;
  totalNpcs: number;
  lowCreditNpcs: LowCreditNpcEntry[];
}> {
  const lowCreditNpcs = await collectLowCreditNpcs();
  return {
    cycleIndex,
    cycleStartTime,
    cycleEndTime,
    threshold: LOW_CREDIT_THRESHOLD,
    totalNpcs: TOTAL_NPCS,
    lowCreditNpcs,
  };
}

function collectTradeLogSnapshot(cycleEndTime: number): {
  cycleIndex: number;
  cycleStartTime: number;
  cycleEndTime: number;
  totalNpcs: number;
  tradeLogs: Array<{ timestamp: number; message: string }>;
} {
  const tradeLogs = getTradeLogs();
  return {
    cycleIndex,
    cycleStartTime,
    cycleEndTime,
    totalNpcs: TOTAL_NPCS,
    tradeLogs,
  };
}

function collectGalaxyHealthSnapshot(cycleEndTime: number): {
  cycleIndex: number;
  cycleStartTime: number;
  cycleEndTime: number;
  health: ReturnType<typeof getGalaxyHealth> & { logging?: { paused: boolean; needsCodeChange: boolean; message?: string } };
} {
  const presenceBySystem = getPresenceBySystem();
  let activeCount = 0;
  for (const entries of Object.values(presenceBySystem)) {
    activeCount += entries.length;
  }

  const tradeLogs = getTradeLogs();
  const health = getGalaxyHealth(
    activeCount,
    TOTAL_NPCS,
    activeCount,
    tradeLogs,
    SERVER_START_TIME
  );

  // Add logging status
  const healthWithLogging = {
    ...health,
    logging: {
      paused: loggingPaused,
      needsCodeChange: loggingPaused,
      message: loggingPaused 
        ? "Logging paused - code change required. Check cycle-log.json for details. Restart server to resume logging."
        : undefined,
    },
  };

  return {
    cycleIndex,
    cycleStartTime,
    cycleEndTime,
    health: healthWithLogging,
  };
}

type DecisionCounters = {
  buyAttempt: number;
  buySuccess: number;
  buyFailed: number;
  sellAttempt: number;
  sellSuccess: number;
  sellFailed: number;
  travelAttempt: number;
  travelSuccess: number;
  travelFailed: number;
  noProfitableDestinations: number;
  noAffordableGoods: number;
  noCargoSpace: number;
  buyQuantityZero: number;
  noMarketsForCargo: number;
  noValidGoodsToSell: number;
  travelNotAtStation: number;
  travelInsufficientFuel: number;
  travelBlockedAfterRefuel: number;
  travelOutOfRange: number;
  travelDestinationInvalid: number;
  travelInsufficientCreditsForFuel: number;
  refuelInsufficientCredits: number;
  airPurifierTaxSkipped: number;
  travelSelectedLoss: number;
  restStarted: number;
  restSkippedLowCredits: number;
  relaxedModeSell: number;
  forcedSell: number;
};

type TradeAggregateEntry = {
  buyCount: number;
  sellCount: number;
  buyUnits: number;
  sellUnits: number;
  profit: number;
  loss: number;
  unprofitableSellCount: number;
};

type TradeAggregates = {
  byGood: Record<string, TradeAggregateEntry>;
  bySystem: Record<string, TradeAggregateEntry>;
};

type DecisionAnalysis = {
  perNpc: Record<string, DecisionCounters>;
  totals: DecisionCounters;
  phaseCounts: Record<string, Record<string, number>>;
  failureReasons: Record<string, number>;
  lastLogs: Record<string, { timestamp: number; message: string }>;
  visitedSystems: Set<SystemId>;
  tradeAggregates: TradeAggregates;
};

function createDecisionCounters(): DecisionCounters {
  return {
    buyAttempt: 0,
    buySuccess: 0,
    buyFailed: 0,
    sellAttempt: 0,
    sellSuccess: 0,
    sellFailed: 0,
    travelAttempt: 0,
    travelSuccess: 0,
    travelFailed: 0,
    noProfitableDestinations: 0,
    noAffordableGoods: 0,
    noCargoSpace: 0,
    buyQuantityZero: 0,
    noMarketsForCargo: 0,
    noValidGoodsToSell: 0,
    travelNotAtStation: 0,
    travelInsufficientFuel: 0,
    travelBlockedAfterRefuel: 0,
    travelOutOfRange: 0,
    travelDestinationInvalid: 0,
    travelInsufficientCreditsForFuel: 0,
    refuelInsufficientCredits: 0,
    airPurifierTaxSkipped: 0,
    travelSelectedLoss: 0,
    restStarted: 0,
    restSkippedLowCredits: 0,
    relaxedModeSell: 0,
    forcedSell: 0,
  };
}

function extractShipIdFromLog(message: string): string | null {
  const decisionMatch = message.match(/^\[DECISION ([^\]]+)\]/);
  if (decisionMatch) return decisionMatch[1];
  const shipMatch = message.match(/^\[Ship ([^\]]+)\]/);
  if (shipMatch) return shipMatch[1];
  return null;
}

function bumpCounter(
  counters: DecisionCounters,
  totals: DecisionCounters,
  field: keyof DecisionCounters
): void {
  counters[field] += 1;
  totals[field] += 1;
}

function analyzeTradeLogs(tradeLogs: Array<{ timestamp: number; message: string }>): DecisionAnalysis {
  const perNpc: Record<string, DecisionCounters> = {};
  const totals = createDecisionCounters();
  const phaseCounts: Record<string, Record<string, number>> = {};
  const failureReasons: Record<string, number> = {};
  const lastLogs: Record<string, { timestamp: number; message: string }> = {};
  const visitedSystems = new Set<SystemId>();
  const tradeAggregates: TradeAggregates = { byGood: {}, bySystem: {} };

  for (const entry of tradeLogs) {
    const message = entry.message;
    const shipId = extractShipIdFromLog(message);
    if (shipId) {
      if (!perNpc[shipId]) perNpc[shipId] = createDecisionCounters();
      if (!phaseCounts[shipId]) phaseCounts[shipId] = {};
      lastLogs[shipId] = { timestamp: entry.timestamp, message };
    }

    const travelMatch = message.match(/Traveling from system (\d+) to system (\d+)/);
    if (travelMatch) {
      visitedSystems.add(parseInt(travelMatch[1], 10) as SystemId);
      visitedSystems.add(parseInt(travelMatch[2], 10) as SystemId);
    }

    const tradeSystemMatch = message.match(/in system (\d+)/);
    if (tradeSystemMatch) {
      visitedSystems.add(parseInt(tradeSystemMatch[1], 10) as SystemId);
    }

    if (!shipId) continue;
    const counters = perNpc[shipId];

    if (message.includes("ACTION: Attempting to buy goods")) {
      bumpCounter(counters, totals, "buyAttempt");
    } else if (message.includes("RESULT: Buy attempt SUCCESS")) {
      bumpCounter(counters, totals, "buySuccess");
    } else if (message.includes("RESULT: Buy attempt FAILED")) {
      bumpCounter(counters, totals, "buyFailed");
    } else if (message.includes("ACTION: Attempting to sell goods")) {
      bumpCounter(counters, totals, "sellAttempt");
    } else if (message.includes("RESULT: Sell attempt SUCCESS")) {
      bumpCounter(counters, totals, "sellSuccess");
    } else if (message.includes("RESULT: Sell attempt FAILED")) {
      bumpCounter(counters, totals, "sellFailed");
    } else if (message.includes("tryTravel: Starting travel evaluation")) {
      bumpCounter(counters, totals, "travelAttempt");
    } else if (message.includes("RESULT: Travel attempt SUCCESS")) {
      bumpCounter(counters, totals, "travelSuccess");
    } else if (message.includes("RESULT: Travel failed - REASON: not at station")) {
      bumpCounter(counters, totals, "travelNotAtStation");
      // Also increment travelFailed for backward compatibility
      bumpCounter(counters, totals, "travelFailed");
    } else if (message.includes("RESULT: Travel failed - REASON: insufficient fuel in tank")) {
      bumpCounter(counters, totals, "travelInsufficientFuel");
      bumpCounter(counters, totals, "travelFailed");
    } else if (message.includes("RESULT: Travel failed - REASON: insufficient credits for fuel purchase")) {
      bumpCounter(counters, totals, "travelInsufficientCreditsForFuel");
      bumpCounter(counters, totals, "travelFailed");
    } else if (message.includes("RESULT: Travel failed - REASON: out of range")) {
      bumpCounter(counters, totals, "travelOutOfRange");
      bumpCounter(counters, totals, "travelFailed");
    } else if (message.includes("RESULT: Travel failed - REASON: destination invalid")) {
      bumpCounter(counters, totals, "travelDestinationInvalid");
      bumpCounter(counters, totals, "travelFailed");
    } else if (message.includes("RESULT: Travel attempt FAILED")) {
      // Only increment if no specific reason was found (shouldn't happen with proper instrumentation)
      console.warn(`[Log Parser] Travel failed without specific reason: ${message.substring(0, 200)}`);
      bumpCounter(counters, totals, "travelFailed");
    } else if (message.includes("RESULT: Cannot buy - no profitable sell destinations")) {
      bumpCounter(counters, totals, "noProfitableDestinations");
    } else if (message.includes("RESULT: Cannot buy - no affordable goods")) {
      bumpCounter(counters, totals, "noAffordableGoods");
    } else if (message.includes("RESULT: Cannot buy - no cargo space")) {
      bumpCounter(counters, totals, "noCargoSpace");
    } else if (message.includes("RESULT: Cannot buy - quantity would be 0")) {
      bumpCounter(counters, totals, "buyQuantityZero");
    } else if (message.includes("RESULT: Cannot sell - no markets for cargo goods")) {
      bumpCounter(counters, totals, "noMarketsForCargo");
    } else if (message.includes("RESULT: Cannot sell - no valid goods to sell")) {
      bumpCounter(counters, totals, "noValidGoodsToSell");
    } else if (message.includes("RESULT: Cannot travel - not at station")) {
      // Legacy format - also check for new format above
      bumpCounter(counters, totals, "travelNotAtStation");
    } else if (message.includes("Cannot travel: insufficient fuel") && !message.includes("REASON:")) {
      // Legacy format - also check for new format above
      bumpCounter(counters, totals, "travelInsufficientFuel");
    } else if (message.includes("RESULT: Travel blocked - insufficient fuel after refuel attempt")) {
      bumpCounter(counters, totals, "travelBlockedAfterRefuel");
      // This should have a specific reason logged before it, but if not, treat as insufficient fuel
      if (!message.includes("REASON:")) {
        bumpCounter(counters, totals, "travelInsufficientFuel");
        bumpCounter(counters, totals, "travelFailed");
      }
    } else if (message.includes("Cannot refuel: insufficient credits")) {
      bumpCounter(counters, totals, "refuelInsufficientCredits");
    } else if (message.includes("Air purifier tax:") && message.includes("insufficient funds")) {
      bumpCounter(counters, totals, "airPurifierTaxSkipped");
    } else if (message.includes("WARNING: No non-negative destinations, selecting best available")) {
      bumpCounter(counters, totals, "travelSelectedLoss");
    } else if (message.includes("DECISION: Starting rest")) {
      bumpCounter(counters, totals, "restStarted");
    } else if (message.includes("Skipping rest - credits")) {
      bumpCounter(counters, totals, "restSkippedLowCredits");
    } else if (message.includes("Relaxed mode: allowing small loss")) {
      bumpCounter(counters, totals, "relaxedModeSell");
    } else if (message.includes("Forced sell:")) {
      bumpCounter(counters, totals, "forcedSell");
    }

    const phaseMatch = message.match(/Starting trading decision - phase: ([^,]+)/);
    if (phaseMatch) {
      const phase = phaseMatch[1];
      phaseCounts[shipId][phase] = (phaseCounts[shipId][phase] || 0) + 1;
    }

    const buyFailMatch = message.match(/Buy trade failed: ([^\\n]+)/);
    if (buyFailMatch) {
      const reason = `buy_failed:${buyFailMatch[1].trim()}`;
      failureReasons[reason] = (failureReasons[reason] || 0) + 1;
    }
    const sellFailMatch = message.match(/Sell trade failed: ([^\\n]+)/);
    if (sellFailMatch) {
      const reason = `sell_failed:${sellFailMatch[1].trim()}`;
      failureReasons[reason] = (failureReasons[reason] || 0) + 1;
    }
    if (message.includes("Buy trade HTTP error")) {
      failureReasons.buy_http_error = (failureReasons.buy_http_error || 0) + 1;
    }
    if (message.includes("Sell trade HTTP error")) {
      failureReasons.sell_http_error = (failureReasons.sell_http_error || 0) + 1;
    }
    if (message.includes("Trade reported success but quantity")) {
      failureReasons.trade_quantity_mismatch = (failureReasons.trade_quantity_mismatch || 0) + 1;
    }
    if (message.includes("Trade failed - success=false")) {
      failureReasons.trade_success_false = (failureReasons.trade_success_false || 0) + 1;
    }
    if (message.includes("Error executing buy trade")) {
      failureReasons.buy_exception = (failureReasons.buy_exception || 0) + 1;
    }
    if (message.includes("Error executing sell trade")) {
      failureReasons.sell_exception = (failureReasons.sell_exception || 0) + 1;
    }

    const buyMatch = message.match(/^\[Ship [^\]]+\] Bought (\d+) ([\w-]+) for ([\d.]+) cr .* in system (\d+)/);
    if (buyMatch) {
      const units = Number(buyMatch[1]);
      const goodId = buyMatch[2];
      const systemId = buyMatch[4];
      const byGood = tradeAggregates.byGood[goodId] || {
        buyCount: 0,
        sellCount: 0,
        buyUnits: 0,
        sellUnits: 0,
        profit: 0,
        loss: 0,
        unprofitableSellCount: 0,
      };
      byGood.buyCount += 1;
      byGood.buyUnits += units;
      tradeAggregates.byGood[goodId] = byGood;

      const bySystem = tradeAggregates.bySystem[systemId] || {
        buyCount: 0,
        sellCount: 0,
        buyUnits: 0,
        sellUnits: 0,
        profit: 0,
        loss: 0,
        unprofitableSellCount: 0,
      };
      bySystem.buyCount += 1;
      bySystem.buyUnits += units;
      tradeAggregates.bySystem[systemId] = bySystem;
    }

    const sellMatch = message.match(/^\[Ship [^\]]+\] Sold (\d+) ([\w-]+) for ([\d.]+) cr .* in system (\d+)/);
    if (sellMatch) {
      const units = Number(sellMatch[1]);
      const goodId = sellMatch[2];
      const systemId = sellMatch[4];
      const profitMatch = message.match(/\(profit: (-?[\d.]+) cr/);
      const profitValue = profitMatch ? Number(profitMatch[1]) : null;

      const byGood = tradeAggregates.byGood[goodId] || {
        buyCount: 0,
        sellCount: 0,
        buyUnits: 0,
        sellUnits: 0,
        profit: 0,
        loss: 0,
        unprofitableSellCount: 0,
      };
      byGood.sellCount += 1;
      byGood.sellUnits += units;
      if (profitValue !== null) {
        if (profitValue >= 0) {
          byGood.profit += profitValue;
        } else {
          byGood.loss += Math.abs(profitValue);
          byGood.unprofitableSellCount += 1;
        }
      }
      tradeAggregates.byGood[goodId] = byGood;

      const bySystem = tradeAggregates.bySystem[systemId] || {
        buyCount: 0,
        sellCount: 0,
        buyUnits: 0,
        sellUnits: 0,
        profit: 0,
        loss: 0,
        unprofitableSellCount: 0,
      };
      bySystem.sellCount += 1;
      bySystem.sellUnits += units;
      if (profitValue !== null) {
        if (profitValue >= 0) {
          bySystem.profit += profitValue;
        } else {
          bySystem.loss += Math.abs(profitValue);
          bySystem.unprofitableSellCount += 1;
        }
      }
      tradeAggregates.bySystem[systemId] = bySystem;
    }
  }

  return {
    perNpc,
    totals,
    phaseCounts,
    failureReasons,
    lastLogs,
    visitedSystems,
    tradeAggregates,
  };
}

function summarizeCargo(cargo: Record<string, number> | null | undefined): {
  totalUnits: number;
  uniqueGoods: number;
  goods: Record<string, number>;
} {
  if (!cargo) {
    return { totalUnits: 0, uniqueGoods: 0, goods: {} };
  }
  const entries = Object.entries(cargo).filter(([, qty]) => Number(qty) > 0);
  const totalUnits = entries.reduce((sum, [, qty]) => sum + Number(qty), 0);
  const goods: Record<string, number> = {};
  for (const [goodId, qty] of entries) {
    goods[goodId] = Number(qty);
  }
  return { totalUnits, uniqueGoods: entries.length, goods };
}

type CycleSummary = {
  cycleIndex: number;
  cycleStartTime: number;
  cycleEndTime: number;
  totalNpcs: number;
  tradeLogCount: number;
  npcStates: Array<unknown>;
  npcStats: Array<unknown>;
  decisionCounts: {
    perNpc: Record<string, DecisionCounters>;
    totals: DecisionCounters;
  };
  phaseCounts: Record<string, Record<string, number>>;
  failureReasons: Record<string, number>;
  lastLogs: Record<string, { timestamp: number; message: string }>;
  tradeAggregates: TradeAggregates;
  visitedSystems: Array<number>;
  systemSnapshots: Array<unknown>;
};

async function buildCycleSummary(cycleEndTime: number): Promise<CycleSummary> {
  const tradeLogs = getTradeLogs();
  const analysis = analyzeTradeLogs(tradeLogs);

  const npcStates: Array<unknown> = [];
  const npcStats: Array<unknown> = [];
  const visitedSystems = new Set<SystemId>(analysis.visitedSystems);

  for (let i = 0; i < TOTAL_NPCS; i++) {
    const shipId = `npc-${i}` as ShipId;
    try {
      const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      if (!stateResponse.ok) {
        npcStates.push({ shipId, status: "missing" });
        continue;
      }
      const state = await stateResponse.json();
      const cargoSummary = summarizeCargo(state.cargo || {});
      npcStates.push({
        shipId,
        name: state.name ?? null,
        credits: state.credits ?? null,
        systemId: state.currentSystem ?? null,
        phase: state.phase ?? null,
        fuelLy: state.fuelLy ?? null,
        fuelCapacityLy: state.fuelCapacityLy ?? null,
        hullIntegrity: state.hullIntegrity ?? null,
        destinationSystem: state.destinationSystem ?? null,
        originSystem: state.originSystem ?? null,
        cargo: cargoSummary,
      });

      if (typeof state.currentSystem === "number") {
        visitedSystems.add(state.currentSystem as SystemId);
      }
    } catch (error) {
      npcStates.push({ shipId, status: "error" });
    }

    const details = getTraderDetails(shipId);
    if (details) {
      const avgProfitPerTrade = details.successfulTrades > 0
        ? details.totalProfit / details.successfulTrades
        : 0;
      const avgMargin = details.totalVolume > 0
        ? details.totalProfit / details.totalVolume
        : 0;
      npcStats.push({
        shipId,
        name: details.name,
        totalTicks: details.totalTicks,
        totalTrades: details.totalTrades,
        successfulTrades: details.successfulTrades,
        totalProfit: details.totalProfit,
        totalVolume: details.totalVolume,
        avgProfitPerTrade,
        avgMargin,
        currentCredits: details.currentCredits,
        peakCredits: details.peakCredits,
        systemsVisited: Array.from(details.systemsVisited.values()),
      });
      for (const systemId of details.systemsVisited.values()) {
        visitedSystems.add(systemId);
      }
    } else {
      npcStats.push({
        shipId,
        name: null,
        totalTicks: 0,
        totalTrades: 0,
        successfulTrades: 0,
        totalProfit: 0,
        totalVolume: 0,
        avgProfitPerTrade: 0,
        avgMargin: 0,
        currentCredits: null,
        peakCredits: null,
        systemsVisited: [],
      });
    }
  }

  const systemSnapshots: Array<unknown> = [];
  for (const systemId of Array.from(visitedSystems.values())) {
    try {
      const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
      const snapshotResponse = await system.fetch(new Request("https://dummy/snapshot"));
      if (!snapshotResponse.ok) continue;
      const snapshot = await snapshotResponse.json();
      systemSnapshots.push({
        systemId,
        name: snapshot.state?.name ?? null,
        markets: snapshot.markets ?? {},
        shipsInSystem: snapshot.shipsInSystem ?? [],
      });
    } catch (error) {
      // Skip systems that can't be loaded
    }
  }

  return {
    cycleIndex,
    cycleStartTime,
    cycleEndTime,
    totalNpcs: TOTAL_NPCS,
    tradeLogCount: tradeLogs.length,
    npcStates,
    npcStats,
    decisionCounts: {
      perNpc: analysis.perNpc,
      totals: analysis.totals,
    },
    phaseCounts: analysis.phaseCounts,
    failureReasons: analysis.failureReasons,
    lastLogs: analysis.lastLogs,
    tradeAggregates: analysis.tradeAggregates,
    visitedSystems: Array.from(visitedSystems.values()),
    systemSnapshots,
  };
}

/**
 * Evaluate if immediate code change is needed based on cycle data
 * Returns true if intervention is required, false if things might recover
 */
function evaluateNeedsCodeChange(
  summary: Awaited<ReturnType<typeof buildCycleSummary>>,
  galaxyHealthSnapshot: ReturnType<typeof collectGalaxyHealthSnapshot>
): { needsChange: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let needsChange = false;

  // Check buy success rate
  const buyAttempts = summary.decisionCounts?.totals?.buyAttempt || 0;
  const buySuccess = summary.decisionCounts?.totals?.buySuccess || 0;
  if (buyAttempts > 0) {
    const buySuccessRate = buySuccess / buyAttempts;
    if (buySuccessRate < 0.1) { // Less than 10% success
      needsChange = true;
      reasons.push(`Buy success rate critically low: ${(buySuccessRate * 100).toFixed(1)}% (${buySuccess}/${buyAttempts})`);
    } else if (buySuccessRate < 0.2) {
      reasons.push(`Buy success rate low: ${(buySuccessRate * 100).toFixed(1)}% (${buySuccess}/${buyAttempts})`);
    }
  }

  // Check travel success rate
  const travelAttempts = summary.decisionCounts?.totals?.travelAttempt || 0;
  const travelSuccess = summary.decisionCounts?.totals?.travelSuccess || 0;
  if (travelAttempts > 0) {
    const travelSuccessRate = travelSuccess / travelAttempts;
    if (travelSuccessRate < 0.15) { // Less than 15% success
      needsChange = true;
      reasons.push(`Travel success rate critically low: ${(travelSuccessRate * 100).toFixed(1)}% (${travelSuccess}/${travelAttempts})`);
    } else if (travelSuccessRate < 0.25) {
      reasons.push(`Travel success rate low: ${(travelSuccessRate * 100).toFixed(1)}% (${travelSuccess}/${travelAttempts})`);
    }
  }

  // Check for excessive "no affordable goods" failures
  const noAffordableGoods = summary.decisionCounts?.totals?.noAffordableGoods || 0;
  if (noAffordableGoods > buyAttempts * 0.8) { // More than 80% of buy attempts fail due to affordability
    needsChange = true;
    reasons.push(`Too many "no affordable goods" failures: ${noAffordableGoods} (${((noAffordableGoods / buyAttempts) * 100).toFixed(1)}% of buy attempts)`);
  }

  // Check galactic health status
  if (galaxyHealthSnapshot.health.health.status === "critical") {
    needsChange = true;
    reasons.push(`Galactic health is critical: ${galaxyHealthSnapshot.health.health.issues.join(", ")}`);
  }

  // Check if population is critically low
  const populationRatio = galaxyHealthSnapshot.health.population.current / galaxyHealthSnapshot.health.population.target;
  if (populationRatio < 0.5) {
    needsChange = true;
    reasons.push(`Population critically low: ${galaxyHealthSnapshot.health.population.current}/${galaxyHealthSnapshot.health.population.target} (${(populationRatio * 100).toFixed(1)}%)`);
  }

  // Check removal rate vs spawn rate
  const removalRate = galaxyHealthSnapshot.health.ships.removalsSinceStart / Math.max(galaxyHealthSnapshot.health.ships.spawnsSinceStart, 1);
  if (removalRate > 3.0) {
    needsChange = true;
    reasons.push(`Removal rate extremely high: ${removalRate.toFixed(1)}x spawn rate`);
  }

  // If we have multiple warning signs but not critical, might recover
  // But if we have 3+ warning signs, likely needs intervention
  if (!needsChange && reasons.length >= 3) {
    needsChange = true;
    reasons.push(`Multiple warning signs detected (${reasons.length} issues)`);
  }

  return { needsChange, reasons };
}

async function writeCycleSummary(
  cycleEndTime: number,
  lowCreditSnapshot: Awaited<ReturnType<typeof collectLowCreditSnapshot>>,
  tradeLogSnapshot: ReturnType<typeof collectTradeLogSnapshot>,
  galaxyHealthSnapshot: ReturnType<typeof collectGalaxyHealthSnapshot>
): Promise<void> {
  // Cycle-log writing disabled - only zero-inventory logging is active
  return;
}

/**
 * Manually trigger galactic health check and evaluation
 * Returns evaluation results without resetting the galaxy
 */
async function checkGalaxyHealth(): Promise<{
  evaluation: { needsChange: boolean; reasons: string[] };
  galaxyHealthSnapshot: ReturnType<typeof collectGalaxyHealthSnapshot>;
  timestamp: number;
}> {
  const cycleEndTime = Date.now();
  const lowCreditSnapshot = await collectLowCreditSnapshot(cycleEndTime);
  const tradeLogSnapshot = collectTradeLogSnapshot(cycleEndTime);
  const galaxyHealthSnapshot = collectGalaxyHealthSnapshot(cycleEndTime);
  
  // Build summary for evaluation
  const summary = await buildCycleSummary(cycleEndTime);
  
  // Evaluate if code change is needed
  const evaluation = evaluateNeedsCodeChange(summary, galaxyHealthSnapshot);
  
  return {
    evaluation,
    galaxyHealthSnapshot,
    timestamp: cycleEndTime,
  };
}

/**
 * Write log and stop logging (without any health checks)
 * Used by manual endpoint
 */
async function checkHealthAndWriteLog(): Promise<{
  timestamp: number;
  logWritten: boolean;
  loggingPaused: boolean;
  evaluation: { needsChange: boolean; reasons: string[] };
  galaxyHealthSnapshot: ReturnType<typeof collectGalaxyHealthSnapshot>;
}> {
  const cycleEndTime = Date.now();
  const galaxyHealthSnapshot = collectGalaxyHealthSnapshot(cycleEndTime);
  
  // Cycle-log writing disabled - only zero-inventory logging is active
  return {
    timestamp: cycleEndTime,
    logWritten: false,
    loggingPaused: false,
    evaluation: {
      needsChange: false,
      reasons: ["Cycle-log writing is disabled"],
    },
    galaxyHealthSnapshot,
  };
}

/**
 * Automatic health check - evaluates health and conditionally writes log and stops logging
 * Used by the 5-minute automatic interval
 */
async function autoHealthCheckAndLog(): Promise<void> {
  // Cycle-log writing disabled - only zero-inventory logging is active
  return;
}

async function resetGalaxyCycle(): Promise<void> {
  if (isCycleResetting) return;
  isCycleResetting = true;
  const cycleEndTime = Date.now();
  console.log(`[Galaxy Cycle] Ending cycle ${cycleIndex} at ${new Date(cycleEndTime).toISOString()}`);

  // Cycle-log writing disabled - only zero-inventory logging is active
  
  const seed = cycleEndTime.toString();
  await handleGalaxyInitialize({ seed }, {});

  cycleIndex += 1;
  cycleStartTime = Date.now();
  isCycleResetting = false;
  console.log(`[Galaxy Cycle] Started cycle ${cycleIndex} at ${new Date(cycleStartTime).toISOString()}`);
}

function jsonResponse(data: any, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

function extractSystemId(path: string): SystemId | null {
  const match = path.match(/\/api\/system\/(\d+)/);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  if (isNaN(id) || id < 0 || id >= 256) return null;
  return id as SystemId;
}

function extractShipId(path: string): string | null {
  const match = path.match(/\/api\/ship\/([^\/]+)/);
  return match ? match[1] : null;
}

function normalizePlayerName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function makePlayerShipId(name: string): ShipId {
  return `player-${encodeURIComponent(name)}` as ShipId;
}

async function handleSystemRequest(
  url: URL,
  method: string,
  systemId: SystemId,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
  const action = url.searchParams.get("action") || "snapshot";

  if (action === "snapshot") {
    const response = await system.fetch(new Request("https://dummy/snapshot"));
    const data = await response.json();
    return jsonResponse(data, 200, corsHeaders);
  } else {
    return jsonResponse({ error: "Invalid action. Only 'snapshot' is supported." }, 400, corsHeaders);
  }
}

/**
 * Calculate 2D Euclidean distance between two points
 */
function calculateDistance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Get system coordinates from snapshot
 */
async function getSystemCoords(systemId: SystemId): Promise<{ x: number; y: number } | null> {
  try {
    const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
    const snapshotResponse = await system.fetch(new Request("https://dummy/snapshot"));
    const snapshot = await snapshotResponse.json() as { state: { x?: number; y?: number } | null };
    if (!snapshot.state) {
      return null;
    }
    return {
      x: snapshot.state.x ?? 0,
      y: snapshot.state.y ?? 0,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Create a new system with given coordinates
 */
async function createSystem(
  systemId: SystemId,
  x: number,
  y: number,
  rng: DeterministicRNG
): Promise<void> {
  const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
  const systemRng = rng.derive(`system-${systemId}`);
  const name = SYSTEM_NAMES[systemId % SYSTEM_NAMES.length] || `System ${systemId}`;
  const population = systemRng.randomFloat(0.1, 100);
  // Minimum tech level is 1 (AGRICULTURAL) - no PRE_AGRICULTURAL for inhabited systems
  const techLevel = systemRng.randomInt(1, 7) as TechLevel;
  const government = systemRng.randomChoice(GOVERNMENT_TYPES);
  const seed = systemRng.derive(`seed`).random().toString();
  
  // Determine world type with minimum tech level constraints (Section 11)
  // AGRICULTURAL: TL1+, MINING: TL2+, RESORT: TL3+, TRADE_HUB: TL3+, INDUSTRIAL: TL4+, HIGH_TECH: TL6+
  const worldTypeRng = systemRng.derive(`worldType`);
  const worldTypeRoll = worldTypeRng.randomFloat(0, 1);
  let worldType: WorldType;
  
  if (techLevel === TechLevel.AGRICULTURAL) {
    // TL1: Only AGRICULTURAL allowed
    worldType = WorldType.AGRICULTURAL;
  } else if (techLevel === TechLevel.MEDIEVAL) {
    // TL2: AGRICULTURAL, MINING
    worldType = worldTypeRoll < 0.5 ? WorldType.AGRICULTURAL : WorldType.MINING;
  } else if (techLevel === TechLevel.RENAISSANCE) {
    // TL3: All except INDUSTRIAL and HIGH_TECH
    if (worldTypeRoll < 0.3) worldType = WorldType.AGRICULTURAL;
    else if (worldTypeRoll < 0.6) worldType = WorldType.MINING;
    else if (worldTypeRoll < 0.8) worldType = WorldType.TRADE_HUB;
    else worldType = WorldType.RESORT;
  } else if (techLevel === TechLevel.EARLY_INDUSTRIAL) {
    // TL4: INDUSTRIAL allowed, HIGH_TECH not yet
    if (worldTypeRoll < 0.4) worldType = WorldType.INDUSTRIAL;
    else if (worldTypeRoll < 0.6) worldType = WorldType.MINING;
    else if (worldTypeRoll < 0.8) worldType = WorldType.TRADE_HUB;
    else worldType = WorldType.RESORT;
  } else if (techLevel === TechLevel.INDUSTRIAL) {
    // TL5: INDUSTRIAL, but HIGH_TECH still not allowed
    if (worldTypeRoll < 0.4) worldType = WorldType.INDUSTRIAL;
    else if (worldTypeRoll < 0.6) worldType = WorldType.MINING;
    else if (worldTypeRoll < 0.8) worldType = WorldType.TRADE_HUB;
    else worldType = WorldType.RESORT;
  } else if (techLevel === TechLevel.POST_INDUSTRIAL) {
    // TL6: HIGH_TECH allowed
    if (worldTypeRoll < 0.3) worldType = WorldType.HIGH_TECH;
    else if (worldTypeRoll < 0.5) worldType = WorldType.INDUSTRIAL;
    else if (worldTypeRoll < 0.7) worldType = WorldType.TRADE_HUB;
    else worldType = WorldType.RESORT;
  } else {
    // TL7: All types allowed
    if (worldTypeRoll < 0.3) worldType = WorldType.HIGH_TECH;
    else if (worldTypeRoll < 0.5) worldType = WorldType.INDUSTRIAL;
    else if (worldTypeRoll < 0.7) worldType = WorldType.TRADE_HUB;
    else worldType = WorldType.RESORT;
  }
  
  await system.fetch(
    new Request("https://dummy/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: systemId,
        name,
        population,
        techLevel,
        worldType,
        government,
        seed,
        x,
        y,
      }),
    })
  );
}

/**
 * Delete a system from storage
 */
async function deleteSystem(systemId: SystemId): Promise<void> {
  const storage = new LocalStorage(`system-${systemId}`);
  await storage.deleteAll();
  systems.delete(systemId);
}

/**
 * Route coverage audit: Check if each system has at least M=3 profitable goods within radius 15
 * Returns per-system report with profitableGoodsCount, which goods, best destination and after-tax margin
 */
interface RouteCoverageEntry {
  systemId: SystemId;
  profitableGoodsCount: number;
  profitableGoods: Array<{
    goodId: GoodId;
    bestDestinationSystemId: SystemId;
    bestMargin: number; // After-tax margin as percentage
  }>;
  failures: Array<{
    goodId: GoodId;
    reason: string;
  }>;
}

async function auditRouteCoverage(): Promise<RouteCoverageEntry[]> {
  const results: RouteCoverageEntry[] = [];
  const checkRange = 15; // Same as NPC look-ahead radius
  const minProfitMargin = getMinProfitMargin();
  const REQUIRED_PROFITABLE_GOODS = 3; // M=3 from spec

  // Get all system IDs that exist
  const systemIds: SystemId[] = [];
  for (let i = 0; i < GALAXY_SIZE; i++) {
    const systemId = i as SystemId;
    try {
      const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
      const snapshotResponse = await system.fetch(new Request("https://dummy/snapshot"));
      if (snapshotResponse.ok) {
        systemIds.push(systemId);
      }
    } catch {
      // Skip systems that don't exist
      continue;
    }
  }

  // For each system, check all goods
  for (const systemId of systemIds) {
    try {
      const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
      const snapshotResponse = await system.fetch(new Request("https://dummy/snapshot"));
      if (!snapshotResponse.ok) continue;
      
      const snapshot = await snapshotResponse.json() as {
        state: { x?: number; y?: number } | null;
        markets?: Record<GoodId, { price: number; inventory: number }>;
      };

      if (!snapshot.markets) continue;

      const currentCoords = snapshot.state ? { x: snapshot.state.x ?? 0, y: snapshot.state.y ?? 0 } : null;
      const profitableGoods: RouteCoverageEntry["profitableGoods"] = [];
      const failures: RouteCoverageEntry["failures"] = [];

      // Check each good
      for (const goodId of getAllGoodIds()) {
        const good = getGoodDefinition(goodId);
        if (!good) continue;

        const market = snapshot.markets[goodId];
        if (!market || market.price <= 0) {
          failures.push({ goodId, reason: "not available in market" });
          continue;
        }

        // Calculate effective buy price (with tax)
        const effectiveBuyPrice = market.price * (1 + SALES_TAX_RATE);
        let bestDestinationSystemId: SystemId | null = null;
        let bestMargin = -Infinity;

        // Check all systems within range
        for (let i = Math.max(0, systemId - checkRange); i <= Math.min(GALAXY_SIZE - 1, systemId + checkRange); i++) {
          if (i === systemId) continue;

          const targetSystemId = i as SystemId;
          
          // Check distance if we have coordinates
          if (currentCoords) {
            try {
              const targetCoords = await getSystemCoords(targetSystemId);
              if (targetCoords) {
                const distance = calculateDistance(currentCoords.x, currentCoords.y, targetCoords.x, targetCoords.y);
                if (distance > 15.0) continue; // Beyond max travel distance
              }
            } catch {
              // If we can't get coords, use simple distance check
              if (Math.abs(systemId - targetSystemId) > checkRange) continue;
            }
          } else {
            // Fallback to simple distance check
            if (Math.abs(systemId - targetSystemId) > checkRange) continue;
          }

          try {
            const targetSystem = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${targetSystemId}`));
            const targetSnapshotResponse = await targetSystem.fetch(new Request("https://dummy/snapshot"));
            if (!targetSnapshotResponse.ok) continue;

            const targetSnapshot = await targetSnapshotResponse.json() as {
              markets?: Record<GoodId, { price: number }>;
            };

            if (targetSnapshot.markets && targetSnapshot.markets[goodId]) {
              const targetPrice = targetSnapshot.markets[goodId].price;
              const netSellPrice = targetPrice; // No tax on sales
              const profitMargin = (netSellPrice - effectiveBuyPrice) / effectiveBuyPrice;

              if (profitMargin > bestMargin) {
                bestMargin = profitMargin;
                bestDestinationSystemId = targetSystemId;
              }
            }
          } catch {
            // Skip systems that can't be checked
            continue;
          }
        }

        // Check if this good has a profitable destination
        if (bestDestinationSystemId !== null && bestMargin >= minProfitMargin) {
          profitableGoods.push({
            goodId,
            bestDestinationSystemId,
            bestMargin: bestMargin * 100, // Convert to percentage
          });
        } else {
          failures.push({
            goodId,
            reason: bestDestinationSystemId === null 
              ? "no destination found within range" 
              : `best margin ${(bestMargin * 100).toFixed(2)}% below minimum ${(minProfitMargin * 100).toFixed(2)}%`,
          });
        }
      }

      results.push({
        systemId,
        profitableGoodsCount: profitableGoods.length,
        profitableGoods,
        failures,
      });
    } catch (error) {
      // Skip systems that can't be audited
      console.warn(`[Route Coverage Audit] Failed to audit system ${systemId}:`, error);
    }
  }

  return results;
}

/**
 * Validate and adjust galaxy layout to meet distance requirements
 */
async function validateAndAdjustGalaxy(
  rng: DeterministicRNG
): Promise<SystemId[]> {
  const MIN_DISTANCE_LY = 1.0;
  const MAX_TRAVEL_DISTANCE_LY = 15.0;
  const MIN_NEIGHBORS = 3;
  const MAX_ITERATIONS = 50;
  const TARGET_NEIGHBOR_DISTANCE = 6.0;
  
  // Systems should already be initialized with deterministic coordinates
  // Just verify they exist and get their coordinates
  console.log(`[Galaxy Validation] Using existing system coordinates, starting validation...`);
  
  // Perform validation sweeps
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Get all system coordinates
    const systemCoords = new Map<SystemId, { x: number; y: number }>();
    for (let i = 0; i < GALAXY_SIZE; i++) {
      const systemId = i as SystemId;
      const coords = await getSystemCoords(systemId);
      if (coords) {
        systemCoords.set(systemId, coords);
      }
    }
    
    // Sweep 1: Remove systems that are too close (< 1 LY)
    const systemsToRemove = new Set<SystemId>();
    for (const [id1, coords1] of systemCoords.entries()) {
      for (const [id2, coords2] of systemCoords.entries()) {
        if (id1 >= id2) continue;
        const distance = calculateDistance(coords1.x, coords1.y, coords2.x, coords2.y);
        if (distance < MIN_DISTANCE_LY) {
          // Remove the system with higher ID (keep lower ID)
          systemsToRemove.add(id1 > id2 ? id1 : id2);
        }
      }
    }
    
    // Delete systems that are too close
    for (const systemId of systemsToRemove) {
      await deleteSystem(systemId);
      systemCoords.delete(systemId);
    }
    
    if (systemsToRemove.size > 0) {
      console.log(`[Galaxy Validation] Iteration ${iteration + 1}: Removed ${systemsToRemove.size} systems too close to neighbors`);
    }
    
    // Sweep 2: Check each system has at least 3 neighbors within 15 LY
    const systemsNeedingNeighbors: Array<{ id: SystemId; coords: { x: number; y: number }; currentNeighbors: number }> = [];
    for (const [systemId, coords] of systemCoords.entries()) {
      let neighborCount = 0;
      for (const [otherId, otherCoords] of systemCoords.entries()) {
        if (systemId === otherId) continue;
        const distance = calculateDistance(coords.x, coords.y, otherCoords.x, otherCoords.y);
        if (distance <= MAX_TRAVEL_DISTANCE_LY) {
          neighborCount++;
        }
      }
      
      if (neighborCount < MIN_NEIGHBORS) {
        systemsNeedingNeighbors.push({
          id: systemId,
          coords,
          currentNeighbors: neighborCount
        });
      }
    }
    
    // If no systems need neighbors, we're done
    if (systemsNeedingNeighbors.length === 0) {
      console.log(`[Galaxy Validation] All systems have sufficient neighbors after ${iteration + 1} iterations`);
      break;
    }
    
    // Add missing neighbors for systems that need them
    const adjustRng = rng.derive(`adjust-${iteration}`);
    let neighborsAdded = 0;
    
    for (const systemInfo of systemsNeedingNeighbors) {
      const systemId = systemInfo.id;
      const coords = systemInfo.coords;
      const needed = MIN_NEIGHBORS - systemInfo.currentNeighbors;
      
      // Try to add neighbors at optimal distances (around 3-12 LY)
      const optimalDistances = [3, 5, 7, 9, 11];
      
      for (let n = 0; n < needed && neighborsAdded < 20; n++) {
        let attempts = 0;
        let added = false;
        
        while (attempts < 100 && !added) {
          const angle = adjustRng.derive(`angle-${systemId}-${n}-${attempts}`).random() * Math.PI * 2;
          const distance = optimalDistances[attempts % optimalDistances.length];
          const newX = coords.x + Math.cos(angle) * distance;
          const newY = coords.y + Math.sin(angle) * distance;
          
          // Check if position is valid (at least 1 LY from all existing systems)
          let validPosition = true;
          for (const [_, otherCoords] of systemCoords.entries()) {
            const dist = calculateDistance(newX, newY, otherCoords.x, otherCoords.y);
            if (dist < MIN_DISTANCE_LY) {
              validPosition = false;
              break;
            }
          }
          
          if (validPosition) {
            // Find next available system ID
            let newSystemId: SystemId | null = null;
            for (let j = 0; j < GALAXY_SIZE; j++) {
              const candidateId = j as SystemId;
              if (!systemCoords.has(candidateId)) {
                newSystemId = candidateId;
                break;
              }
            }
            
            if (newSystemId !== null) {
              await createSystem(newSystemId, newX, newY, rng);
              systemCoords.set(newSystemId, { x: newX, y: newY });
              neighborsAdded++;
              added = true;
            }
          }
          attempts++;
        }
      }
    }
    
    if (neighborsAdded > 0) {
      console.log(`[Galaxy Validation] Iteration ${iteration + 1}: Added ${neighborsAdded} systems to improve connectivity`);
    }
    
    // If no changes were made, break early
    if (systemsToRemove.size === 0 && neighborsAdded === 0) {
      console.log(`[Galaxy Validation] No changes in iteration ${iteration + 1}, stopping`);
      break;
    }
  }
  
  // Final sweep: Move systems that still don't meet criteria to 6 LY from nearest neighbor
  const finalCoords = new Map<SystemId, { x: number; y: number }>();
  for (let i = 0; i < GALAXY_SIZE; i++) {
    const systemId = i as SystemId;
    const coords = await getSystemCoords(systemId);
    if (coords) {
      finalCoords.set(systemId, coords);
    }
  }
  
  const systemsToMove: Array<{ id: SystemId; coords: { x: number; y: number }; nearestNeighbor: { id: SystemId; coords: { x: number; y: number }; distance: number } }> = [];
  
  for (const [systemId, coords] of finalCoords.entries()) {
    // Check if system has enough neighbors
    let neighborCount = 0;
    let nearestDistance = Infinity;
    let nearestNeighbor: { id: SystemId; coords: { x: number; y: number }; distance: number } | null = null;
    
    for (const [otherId, otherCoords] of finalCoords.entries()) {
      if (systemId === otherId) continue;
      const distance = calculateDistance(coords.x, coords.y, otherCoords.x, otherCoords.y);
      if (distance <= MAX_TRAVEL_DISTANCE_LY) {
        neighborCount++;
      }
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestNeighbor = { id: otherId, coords: otherCoords, distance };
      }
    }
    
    // If system doesn't have enough neighbors and has a nearest neighbor, mark for moving
    if (neighborCount < MIN_NEIGHBORS && nearestNeighbor) {
      systemsToMove.push({
        id: systemId,
        coords,
        nearestNeighbor
      });
    }
  }
  
  // Move systems to 6 LY from their nearest neighbor
  if (systemsToMove.length > 0) {
    console.log(`[Galaxy Validation] Moving ${systemsToMove.length} systems to 6 LY from nearest neighbor`);
    const finalRng = rng.derive(`final-move`);
    let systemsMoved = 0;
    
    for (const systemInfo of systemsToMove) {
      const targetDistance = TARGET_NEIGHBOR_DISTANCE;
      const angle = Math.atan2(systemInfo.nearestNeighbor.coords.y - systemInfo.coords.y, systemInfo.nearestNeighbor.coords.x - systemInfo.coords.x);
      const newX = systemInfo.nearestNeighbor.coords.x - Math.cos(angle) * targetDistance;
      const newY = systemInfo.nearestNeighbor.coords.y - Math.sin(angle) * targetDistance;
      
      // Check if this new position is valid (at least 1 LY from all other systems)
      let validPosition = true;
      for (const [otherId, otherCoords] of finalCoords.entries()) {
        if (otherId === systemInfo.id) continue;
        const dist = calculateDistance(newX, newY, otherCoords.x, otherCoords.y);
        if (dist < MIN_DISTANCE_LY) {
          validPosition = false;
          break;
        }
      }
      
      if (validPosition) {
        // Update the system's coordinates
        const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemInfo.id}`));
        const snapshotResponse = await system.fetch(new Request("https://dummy/snapshot"));
        const snapshot = await snapshotResponse.json() as { state: any };
        
        // Re-initialize with new coordinates
        await system.fetch(
          new Request("https://dummy/initialize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...snapshot.state,
              x: newX,
              y: newY,
            }),
          })
        );
        
        finalCoords.set(systemInfo.id, { x: newX, y: newY });
        systemsMoved++;
      }
    }
    
    if (systemsMoved > 0) {
      console.log(`[Galaxy Validation] Moved ${systemsMoved} systems to 6 LY from nearest neighbor`);
    }
  }
  
  // Return all valid systems
  const validSystems: SystemId[] = [];
  for (let i = 0; i < GALAXY_SIZE; i++) {
    const systemId = i as SystemId;
    const coords = await getSystemCoords(systemId);
    if (coords) {
      validSystems.push(systemId);
    }
  }
  
  // Final validation: Ensure every system has at least one reachable neighbor
  const validationCoords = new Map<SystemId, { x: number; y: number }>();
  for (const systemId of validSystems) {
    const coords = await getSystemCoords(systemId);
    if (coords) {
      validationCoords.set(systemId, coords);
    }
  }
  
  const isolatedSystems: SystemId[] = [];
  for (const [systemId, coords] of validationCoords.entries()) {
    let neighborCount = 0;
    for (const [otherId, otherCoords] of validationCoords.entries()) {
      if (systemId === otherId) continue;
      const distance = calculateDistance(coords.x, coords.y, otherCoords.x, otherCoords.y);
      if (distance <= MAX_TRAVEL_DISTANCE_LY) {
        neighborCount++;
      }
    }
    if (neighborCount === 0) {
      isolatedSystems.push(systemId);
    }
  }
  
  if (isolatedSystems.length > 0) {
    const errorMsg = `[Galaxy Validation] CRITICAL: ${isolatedSystems.length} systems have no reachable neighbors within ${MAX_TRAVEL_DISTANCE_LY} LY. Galaxy is broken! Isolated systems: ${isolatedSystems.join(", ")}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }
  
  // Ensure we have exactly GALAXY_SIZE systems
  if (validSystems.length < GALAXY_SIZE) {
    const needed = GALAXY_SIZE - validSystems.length;
    console.log(`[Galaxy Validation] Need to add ${needed} systems to reach target of ${GALAXY_SIZE}`);
    
    const fillRng = rng.derive(`fill-systems`);
    const existingCoords = new Map<SystemId, { x: number; y: number }>();
    for (const systemId of validSystems) {
      const coords = await getSystemCoords(systemId);
      if (coords) {
        existingCoords.set(systemId, coords);
      }
    }
    
    // Find available system IDs
    const availableIds: SystemId[] = [];
    for (let i = 0; i < GALAXY_SIZE; i++) {
      const systemId = i as SystemId;
      if (!existingCoords.has(systemId)) {
        availableIds.push(systemId);
      }
    }
    
    let systemsAdded = 0;
    const optimalDistances = [4, 6, 8, 10, 12];
    
    // Try to place new systems near existing ones to maintain connectivity
    for (let attempt = 0; attempt < needed * 200 && systemsAdded < needed && availableIds.length > 0; attempt++) {
      // Pick a random existing system to place near
      const existingSystems = Array.from(existingCoords.entries());
      if (existingSystems.length === 0) break;
      
      const [anchorId, anchorCoords] = existingSystems[fillRng.derive(`anchor-${attempt}`).randomInt(0, existingSystems.length - 1)];
      const angle = fillRng.derive(`angle-${attempt}`).random() * Math.PI * 2;
      const distance = optimalDistances[attempt % optimalDistances.length];
      const newX = anchorCoords.x + Math.cos(angle) * distance;
      const newY = anchorCoords.y + Math.sin(angle) * distance;
      
      // Check if position is valid (at least 1 LY from all existing systems)
      let validPosition = true;
      for (const [_, otherCoords] of existingCoords.entries()) {
        const dist = calculateDistance(newX, newY, otherCoords.x, otherCoords.y);
        if (dist < MIN_DISTANCE_LY) {
          validPosition = false;
          break;
        }
      }
      
      if (validPosition) {
        const newSystemId = availableIds.shift()!;
        await createSystem(newSystemId, newX, newY, rng);
        existingCoords.set(newSystemId, { x: newX, y: newY });
        validSystems.push(newSystemId);
        systemsAdded++;
      }
    }
    
    if (systemsAdded > 0) {
      console.log(`[Galaxy Validation] Added ${systemsAdded} systems to reach target count`);
    }
    
    // If we still don't have enough, place remaining systems randomly in valid positions
    if (validSystems.length < GALAXY_SIZE && availableIds.length > 0) {
      const remaining = GALAXY_SIZE - validSystems.length;
      const randomRng = rng.derive(`random-fill`);
      
      for (let i = 0; i < remaining && availableIds.length > 0; i++) {
        let placed = false;
        for (let attempt = 0; attempt < 1000 && !placed; attempt++) {
          const x = randomRng.derive(`x-${i}-${attempt}`).randomFloat(-64, 64);
          const y = randomRng.derive(`y-${i}-${attempt}`).randomFloat(-64, 64);
          
          // Check if position is valid
          let validPosition = true;
          for (const [_, otherCoords] of existingCoords.entries()) {
            const dist = calculateDistance(x, y, otherCoords.x, otherCoords.y);
            if (dist < MIN_DISTANCE_LY) {
              validPosition = false;
              break;
            }
          }
          
          if (validPosition) {
            const newSystemId = availableIds.shift()!;
            await createSystem(newSystemId, x, y, rng);
            existingCoords.set(newSystemId, { x, y });
            validSystems.push(newSystemId);
            placed = true;
          }
        }
      }
      
      if (validSystems.length < GALAXY_SIZE) {
        console.warn(`[Galaxy Validation] Warning: Could only create ${validSystems.length} systems out of ${GALAXY_SIZE} target`);
      }
    }
  } else if (validSystems.length > GALAXY_SIZE) {
    // This shouldn't happen, but handle it just in case
    console.warn(`[Galaxy Validation] Warning: Have ${validSystems.length} systems, expected ${GALAXY_SIZE}`);
    validSystems.sort((a, b) => a - b);
    validSystems.splice(GALAXY_SIZE);
  }
  
  // Final sweep: Check average distance and relocate systems that are too close
  const finalCoordsMap = new Map<SystemId, { x: number; y: number }>();
  for (const systemId of validSystems) {
    const coords = await getSystemCoords(systemId);
    if (coords) {
      finalCoordsMap.set(systemId, coords);
    }
  }
  
  // Calculate average distance between all systems
  let totalDistance = 0;
  let pairCount = 0;
  for (const [id1, coords1] of finalCoordsMap.entries()) {
    for (const [id2, coords2] of finalCoordsMap.entries()) {
      if (id1 < id2) {
        const distance = calculateDistance(coords1.x, coords1.y, coords2.x, coords2.y);
        totalDistance += distance;
        pairCount++;
      }
    }
  }
  
  const averageDistance = pairCount > 0 ? totalDistance / pairCount : 0;
  console.log(`[Galaxy Validation] Average distance between systems: ${averageDistance.toFixed(2)} LY`);
  
  if (averageDistance < 5.0) {
    console.log(`[Galaxy Validation] Average distance ${averageDistance.toFixed(2)} LY is below 5 LY threshold, relocating systems with closest neighbors`);
    
    // Find systems with closest neighbors
    const systemNearestDistances: Array<{ id: SystemId; coords: { x: number; y: number }; nearestDistance: number }> = [];
    for (const [systemId, coords] of finalCoordsMap.entries()) {
      let nearestDistance = Infinity;
      for (const [otherId, otherCoords] of finalCoordsMap.entries()) {
        if (systemId === otherId) continue;
        const distance = calculateDistance(coords.x, coords.y, otherCoords.x, otherCoords.y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
        }
      }
      systemNearestDistances.push({ id: systemId, coords, nearestDistance });
    }
    
    // Sort by nearest distance (closest first) and take the ones that need relocation
    systemNearestDistances.sort((a, b) => a.nearestDistance - b.nearestDistance);
    const systemsToRelocate = systemNearestDistances.slice(0, Math.min(20, Math.floor(validSystems.length * 0.1)));
    
    const relocateRng = rng.derive(`relocate-average`);
    let systemsRelocated = 0;
    
    for (const systemInfo of systemsToRelocate) {
      // Find an empty area (far from other systems)
      let bestPosition: { x: number; y: number } | null = null;
      let bestMinDistance = 0;
      
      for (let attempt = 0; attempt < 500; attempt++) {
        const x = relocateRng.derive(`x-${systemInfo.id}-${attempt}`).randomFloat(-64, 64);
        const y = relocateRng.derive(`y-${systemInfo.id}-${attempt}`).randomFloat(-64, 64);
        
        // Find minimum distance to any existing system
        let minDistance = Infinity;
        for (const [otherId, otherCoords] of finalCoordsMap.entries()) {
          if (otherId === systemInfo.id) continue;
          const distance = calculateDistance(x, y, otherCoords.x, otherCoords.y);
          if (distance < minDistance) {
            minDistance = distance;
          }
        }
        
        // Prefer positions that are at least 5 LY from nearest neighbor and maximize minimum distance
        if (minDistance >= MIN_DISTANCE_LY && minDistance > bestMinDistance) {
          bestMinDistance = minDistance;
          bestPosition = { x, y };
        }
      }
      
      if (bestPosition) {
        // Update the system's coordinates
        const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemInfo.id}`));
        const snapshotResponse = await system.fetch(new Request("https://dummy/snapshot"));
        const snapshot = await snapshotResponse.json() as { state: any };
        
        // Re-initialize with new coordinates
        await system.fetch(
          new Request("https://dummy/initialize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...snapshot.state,
              x: bestPosition.x,
              y: bestPosition.y,
            }),
          })
        );
        
        finalCoordsMap.set(systemInfo.id, bestPosition);
        systemsRelocated++;
      }
    }
    
    if (systemsRelocated > 0) {
      console.log(`[Galaxy Validation] Relocated ${systemsRelocated} systems to improve average distance`);
      
      // Recalculate average distance
      totalDistance = 0;
      pairCount = 0;
      for (const [id1, coords1] of finalCoordsMap.entries()) {
        for (const [id2, coords2] of finalCoordsMap.entries()) {
          if (id1 < id2) {
            const distance = calculateDistance(coords1.x, coords1.y, coords2.x, coords2.y);
            totalDistance += distance;
            pairCount++;
          }
        }
      }
      const newAverageDistance = pairCount > 0 ? totalDistance / pairCount : 0;
      console.log(`[Galaxy Validation] New average distance: ${newAverageDistance.toFixed(2)} LY`);
    }
  }
  
  console.log(`[Galaxy Validation] Complete: ${validSystems.length} systems, all have reachable neighbors`);
  return validSystems.sort((a, b) => a - b);
}

async function handleGalaxyInitialize(
  body: { seed?: string },
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Disable auto-tick during initialization to prevent interference
  const wasAutoTickEnabled = (global as any).getAutoTickStatus?.()?.enabled || false;
  if (wasAutoTickEnabled) {
    (global as any).stopAutoTick?.();
    console.log(`[Galaxy Initialize] Auto-tick temporarily disabled during initialization`);
  }
  
  // Reset in-memory telemetry/logging for a clean reinitialize
  clearTradeLogs();
  setTradeLoggingMode("all");
  clearHealthData();
  clearLeaderboard();
  clearMonitoringData();
  clearShipPresence();
  resetShipQueue();

  // Clear in-memory maps to allow reinitialization
  systems.clear();
  ships.clear();
  
  const galaxySeed = body.seed || "1";
  console.log(`🌌 [Galaxy Initialize] Starting galaxy initialization${body.seed ? ' (reinitialization)' : ''} with seed: ${galaxySeed}`);
  const rng = new DeterministicRNG(galaxySeed);
  const initialized: SystemId[] = [];

  // Initialize all systems with initial coordinates
  for (let i = 0; i < GALAXY_SIZE; i++) {
    const systemId = i as SystemId;
    const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));

    const systemRng = rng.derive(`system-${systemId}`);
    const name = SYSTEM_NAMES[systemId % SYSTEM_NAMES.length] || `System ${systemId}`;
    const population = systemRng.randomFloat(0.1, 100);
    // Minimum tech level is 1 (AGRICULTURAL) - no PRE_AGRICULTURAL for inhabited systems
  const techLevel = systemRng.randomInt(1, 7) as TechLevel;
    const government = systemRng.randomChoice(GOVERNMENT_TYPES);
    const seed = systemRng.derive(`seed`).random().toString();
    
    // Determine world type with minimum tech level constraints (Section 11)
    // AGRICULTURAL: TL1+, MINING: TL2+, RESORT: TL3+, TRADE_HUB: TL3+, INDUSTRIAL: TL4+, HIGH_TECH: TL6+
    const worldTypeRng = systemRng.derive(`worldType`);
    let worldType: WorldType;
    const worldTypeRoll = worldTypeRng.randomFloat(0, 1);
    
    if (techLevel === TechLevel.AGRICULTURAL) {
      // TL1: Only AGRICULTURAL allowed
      worldType = WorldType.AGRICULTURAL;
    } else if (techLevel === TechLevel.MEDIEVAL) {
      // TL2: AGRICULTURAL, MINING
      worldType = worldTypeRoll < 0.5 ? WorldType.AGRICULTURAL : WorldType.MINING;
    } else if (techLevel === TechLevel.RENAISSANCE) {
      // TL3: All except INDUSTRIAL and HIGH_TECH
      if (worldTypeRoll < 0.3) worldType = WorldType.AGRICULTURAL;
      else if (worldTypeRoll < 0.6) worldType = WorldType.MINING;
      else if (worldTypeRoll < 0.8) worldType = WorldType.TRADE_HUB;
      else worldType = WorldType.RESORT;
    } else if (techLevel === TechLevel.EARLY_INDUSTRIAL) {
      // TL4: INDUSTRIAL allowed, HIGH_TECH not yet
      if (worldTypeRoll < 0.4) worldType = WorldType.INDUSTRIAL;
      else if (worldTypeRoll < 0.6) worldType = WorldType.MINING;
      else if (worldTypeRoll < 0.8) worldType = WorldType.TRADE_HUB;
      else worldType = WorldType.RESORT;
    } else if (techLevel === TechLevel.INDUSTRIAL) {
      // TL5: INDUSTRIAL, but HIGH_TECH still not allowed
      if (worldTypeRoll < 0.4) worldType = WorldType.INDUSTRIAL;
      else if (worldTypeRoll < 0.6) worldType = WorldType.MINING;
      else if (worldTypeRoll < 0.8) worldType = WorldType.TRADE_HUB;
      else worldType = WorldType.RESORT;
    } else if (techLevel === TechLevel.POST_INDUSTRIAL) {
      // TL6: HIGH_TECH allowed
      if (worldTypeRoll < 0.3) worldType = WorldType.HIGH_TECH;
      else if (worldTypeRoll < 0.5) worldType = WorldType.INDUSTRIAL;
      else if (worldTypeRoll < 0.7) worldType = WorldType.TRADE_HUB;
      else worldType = WorldType.RESORT;
    } else {
      // TL7: All types allowed
      if (worldTypeRoll < 0.3) worldType = WorldType.HIGH_TECH;
      else if (worldTypeRoll < 0.5) worldType = WorldType.INDUSTRIAL;
      else if (worldTypeRoll < 0.7) worldType = WorldType.TRADE_HUB;
      else worldType = WorldType.RESORT;
    }
    
    // Generate deterministic 2D coordinates
    // Spread systems in a 2D space (roughly 256x256 grid, but with some randomness)
    const coordRng = systemRng.derive(`coords`);
    const x = coordRng.randomFloat(-64, 64);
    const y = coordRng.randomFloat(-64, 64);

    await system.fetch(
      new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: systemId,
          name,
          population,
          techLevel,
          worldType,
          government,
          seed,
          x,
          y,
        }),
      })
    );

    initialized.push(systemId);
  }
  
  // Place systems randomly
  console.log("[Galaxy Initialize] Placing systems randomly...");
  const validSystems = await validateAndAdjustGalaxy(rng);
  console.log(`[Galaxy Initialize] Placed ${validSystems.length} systems`);
  
  // Remove systems that didn't make the cut (they should already be deleted from storage by validateAndAdjustGalaxy)
  for (let i = 0; i < GALAXY_SIZE; i++) {
    const systemId = i as SystemId;
    if (!validSystems.includes(systemId)) {
      // System was removed - clear it from memory
      systems.delete(systemId);
    }
  }

  // Create initial NPC traders
  const totalNPCs = TOTAL_NPCS;
  const npcRng = rng.derive("npc-generation");

  for (let i = 0; i < totalNPCs; i++) {
    const shipId = `npc-${i}` as ShipId;
    const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));

    const shipRng = npcRng.derive(`ship-${i}`);
    // Use valid systems only for NPC placement
    const homeSystemIndex = shipRng.randomInt(0, validSystems.length - 1);
    const homeSystem = validSystems[homeSystemIndex];

    // Explicitly clear SQLite cargo before initialization to prevent stale cargo
    // This ensures that even if the ship was loaded from database before, cargo is cleared
    const shipStorage = new LocalStorage(shipId);
    await shipStorage.delete("state");

    await ship.fetch(
      new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: shipId,
          name: `Trader ${i}`,
          systemId: homeSystem,
          seed: shipRng.random().toString(),
          isNPC: true,
        }),
      })
    );

    // Register ship with its home system (so system knows NPCs are present)
    const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${homeSystem}`));
    await system.fetch(
      new Request("https://dummy/arrival", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timestamp: Date.now(),
          shipId: shipId,
          fromSystem: homeSystem,
          toSystem: homeSystem,
          cargo: [],
          priceInfo: [],
        }),
      })
    );
    
    // Record spawn for health tracking
    try {
      recordSpawn(shipId, homeSystem, "initialization");
    } catch (error) {
      // Don't let health tracking errors break initialization
      console.error(`[Galaxy Initialize] Error recording spawn for ${shipId}:`, error);
    }
  }

  console.log(`✅ [Galaxy Initialize] Galaxy initialization complete: ${validSystems.length} systems, ${totalNPCs} NPCs`);
  
  // Re-enable auto-tick if it was enabled before initialization
  if (wasAutoTickEnabled) {
    (global as any).startAutoTick?.();
    console.log(`[Galaxy Initialize] Auto-tick re-enabled`);
  }
  
  return jsonResponse(
    {
      success: true,
      systemsInitialized: validSystems.length,
      npcsCreated: totalNPCs,
    },
    200,
    corsHeaders
  );
}

async function handleTravelingTick(): Promise<void> {
  const tickStartTime = Date.now();
  const newTickId = `traveling-tick-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Queue only traveling ships (departing, in_hyperspace, arriving)
  const totalNPCs = TOTAL_NPCS;
  const now = Date.now();
  let queuedCount = 0;
  let skippedCount = 0;
  
  for (let i = 0; i < totalNPCs; i++) {
    const shipId = `npc-${i}` as ShipId;
    // Check if ship is already in traveling queue
    const alreadyInQueue = queuedTravelingShipIds.has(shipId) || 
      travelingShipQueue.some(q => q.shipId === shipId);
    if (!alreadyInQueue) {
      try {
        const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
        const stateResponse = await ship.fetch(new Request("https://dummy/state"));
        
        if (stateResponse.ok) {
          const state = await stateResponse.json();
          
          // Only queue traveling ships
          if (state.phase === "departing" || state.phase === "in_hyperspace" || state.phase === "arriving") {
            // Check if phase transition is due
            if (state.phase === "departing") {
              if (state.departureStartTime && now < state.departureStartTime) {
                skippedCount++;
                continue; // Not due yet
              }
            } else if (state.phase === "arriving") {
              if (state.arrivalCompleteTime && now < state.arrivalCompleteTime) {
                skippedCount++;
                continue; // Not due yet
              }
            }
            // Queue traveling ship
            travelingShipQueue.push({
              shipId,
              tickId: newTickId,
            });
            queuedTravelingShipIds.add(shipId);
            queuedCount++;
          } else {
            skippedCount++;
          }
        }
      } catch (error) {
        // Skip on error
        skippedCount++;
      }
    }
  }
  
  // Start processing traveling queue if not already running
  if (!isProcessingTravelingQueue && travelingShipQueue.length > 0) {
    processTravelingShipQueue(tickStartTime).catch((error) => {
      console.error("[Traveling Tick] Error in traveling ship queue processing:", error);
    });
  }
}

async function processTravelingShipQueue(tickStartTime: number): Promise<void> {
  if (isProcessingTravelingQueue) {
    return; // Already processing
  }
  
  isProcessingTravelingQueue = true;
  let shipsTicked = 0;
  let shipsSkipped = 0;
  let processedCount = 0;
  const processingStartTime = Date.now();
  
  const shipTimings: number[] = [];
  const stateCheckTimings: number[] = [];
  const tickTimings: number[] = [];
  const yieldTimings: number[] = [];
  let slowShips: Array<{ shipId: ShipId; duration: number; fetchDuration?: number; jsonDuration?: number; phase?: string; system?: number | null }> = [];
  
  try {
    let shipsSinceLastYield = 0;
    const YIELD_INTERVAL = 10; // Yield every 10 ships instead of every ship to reduce overhead
    
    while (travelingShipQueue.length > 0) {
      const shipStartTime = Date.now();
      const queuedShip = travelingShipQueue.shift();
      if (!queuedShip) {
        break;
      }
      
      queuedTravelingShipIds.delete(queuedShip.shipId);
      
      try {
        const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(queuedShip.shipId));
        
        // Quick state check with timing
        const stateCheckStart = Date.now();
        const stateResponse = await ship.fetch(new Request("https://dummy/state"));
        const state = await stateResponse.json();
        const stateCheckEnd = Date.now();
        const stateCheckDuration = stateCheckEnd - stateCheckStart;
        stateCheckTimings.push(stateCheckDuration);
        
        // Skip if no longer traveling
        if (state.phase !== "departing" && state.phase !== "in_hyperspace" && state.phase !== "arriving") {
          shipsSkipped++;
          processedCount++;
          shipsSinceLastYield++;
          // Only yield periodically, not after every skipped ship
          if (shipsSinceLastYield >= YIELD_INTERVAL) {
            const yieldStart = Date.now();
            await new Promise(resolve => setImmediate(resolve));
            const yieldEnd = Date.now();
            yieldTimings.push(yieldEnd - yieldStart);
            shipsSinceLastYield = 0;
          }
          continue;
        }
        
        // Process tick with detailed timing
        const tickStart = Date.now();
        const fetchStart = Date.now();
        const response = await ship.fetch(new Request("https://dummy/tick", {
          method: "POST",
          headers: { "X-Traveling-Tick": "true" },
        }));
        const fetchEnd = Date.now();
        const jsonStart = Date.now();
        const result = await response.json();
        const jsonEnd = Date.now();
        const tickEnd = Date.now();
        const tickDuration = tickEnd - tickStart;
        const fetchDuration = fetchEnd - fetchStart;
        const jsonDuration = jsonEnd - jsonStart;
        tickTimings.push(tickDuration);
        
        // Track slow operations (>10ms threshold)
        if (tickDuration > 10) {
          slowShips.push({
            shipId: queuedShip.shipId,
            duration: tickDuration,
            fetchDuration,
            jsonDuration,
            phase: state?.phase || 'unknown',
            system: state?.currentSystem ?? null,
          });
          
          // Log very slow ships (>20ms) immediately
          if (tickDuration > 20) {
            console.log(`[Slow Traveling Ship] ${queuedShip.shipId}: ${tickDuration}ms (fetch: ${fetchDuration}ms, json: ${jsonDuration}ms, phase: ${state?.phase || 'unknown'}, system: ${state?.currentSystem ?? 'null'})`);
          }
        }
        
        if (result.skipped) {
          shipsSkipped++;
        } else {
          shipsTicked++;
        }
        processedCount++;
        shipsSinceLastYield++;
        
        const shipEndTime = Date.now();
        const shipDuration = shipEndTime - shipStartTime;
        shipTimings.push(shipDuration);
      } catch (error) {
        console.error(`Error ticking traveling ship ${queuedShip.shipId}:`, error);
        processedCount++;
        shipsSinceLastYield++;
      }
      
      // Yield to event loop periodically (every YIELD_INTERVAL ships) instead of every ship
      if (shipsSinceLastYield >= YIELD_INTERVAL) {
        const yieldStart = Date.now();
        await new Promise(resolve => setImmediate(resolve));
        const yieldEnd = Date.now();
        yieldTimings.push(yieldEnd - yieldStart);
        shipsSinceLastYield = 0;
      }
    }
  } finally {
    isProcessingTravelingQueue = false;
  }
  
  const processingEndTime = Date.now();
  const processingDuration = processingEndTime - processingStartTime;
  
  // Calculate statistics
  const calculateStats = (timings: number[]) => {
    if (timings.length === 0) return { total: 0, count: 0, min: 0, max: 0, avg: 0, median: 0, p95: 0, p99: 0 };
    const sorted = [...timings].sort((a, b) => a - b);
    return {
      total: timings.reduce((a, b) => a + b, 0),
      count: timings.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: timings.reduce((a, b) => a + b, 0) / timings.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  };
  
  const shipStats = calculateStats(shipTimings);
  const stateCheckStats = calculateStats(stateCheckTimings);
  const tickStats = calculateStats(tickTimings);
  const yieldStats = calculateStats(yieldTimings);
  
  // Analyze slow ships by phase
  if (slowShips.length > 0) {
    const slowByPhase = new Map<string, { count: number; totalTime: number; avgTime: number }>();
    const slowBySystem = new Map<number, number>();
    
    for (const ship of slowShips) {
      const phase = ship.phase || 'unknown';
      const existing = slowByPhase.get(phase) || { count: 0, totalTime: 0, avgTime: 0 };
      existing.count++;
      existing.totalTime += ship.duration;
      existing.avgTime = existing.totalTime / existing.count;
      slowByPhase.set(phase, existing);
      
      if (ship.system !== null && ship.system !== undefined) {
        slowBySystem.set(ship.system, (slowBySystem.get(ship.system) || 0) + 1);
      }
    }
    
    console.log(`[Traveling Tick] ${slowShips.length} slow ships (>10ms) analysis:`);
    console.log(`  By phase: ${Array.from(slowByPhase.entries())
      .sort((a, b) => b[1].totalTime - a[1].totalTime)
      .map(([p, d]) => `${p}: ${d.count} ships, ${d.totalTime.toFixed(0)}ms total, ${d.avgTime.toFixed(1)}ms avg`)
      .join('; ')}`);
    
    if (slowBySystem.size > 0) {
      const topSystems = Array.from(slowBySystem.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`  Top systems: ${topSystems.map(([s, c]) => `system-${s}:${c} ships`).join(', ')}`);
    }
    
    // Show very slow ships
    const verySlow = slowShips.filter(s => s.duration > 20).slice(0, 10);
    if (verySlow.length > 0) {
      console.log(`  Very slow (>20ms): ${verySlow.map(s => `${s.shipId}:${s.duration}ms (${s.phase})`).join(', ')}`);
    }
  }
  
  // Performance analysis
  const slowTickThreshold = Math.max(10, tickStats.avg * 1.5);
  const slowTicks = tickTimings.filter(t => t > slowTickThreshold);
  const fastTicks = tickTimings.filter(t => t <= slowTickThreshold);
  
  console.log(`[Traveling Tick] Processed ${processedCount} traveling ships (${shipsTicked} ticked, ${shipsSkipped} skipped) in ${processingDuration}ms`);
  console.log(`[Traveling Tick] Ship stats: total=${shipStats.total}ms, avg=${shipStats.avg.toFixed(2)}ms, median=${shipStats.median.toFixed(2)}ms, p95=${shipStats.p95.toFixed(2)}ms, p99=${shipStats.p99.toFixed(2)}ms`);
  console.log(`[Traveling Tick] State check stats: total=${stateCheckStats.total}ms, avg=${stateCheckStats.avg.toFixed(2)}ms, count=${stateCheckStats.count}`);
  console.log(`[Traveling Tick] Tick stats: total=${tickStats.total}ms, avg=${tickStats.avg.toFixed(2)}ms, count=${tickStats.count}`);
  console.log(`[Traveling Tick] Yield stats: total=${yieldStats.total}ms, avg=${yieldStats.avg.toFixed(2)}ms, count=${yieldStats.count}`);
  
  if (slowTicks.length > 0 && fastTicks.length > 0) {
    const slowAvg = slowTicks.reduce((a, b) => a + b, 0) / slowTicks.length;
    const fastAvg = fastTicks.reduce((a, b) => a + b, 0) / fastTicks.length;
    const slowTotal = slowTicks.reduce((a, b) => a + b, 0);
    console.log(`[Traveling Tick] Performance split: ${slowTicks.length} slow ticks (>${slowTickThreshold.toFixed(0)}ms, avg ${slowAvg.toFixed(2)}ms) vs ${fastTicks.length} fast ticks (avg ${fastAvg.toFixed(2)}ms)`);
    console.log(`[Traveling Tick] Slow ticks: ${slowTotal.toFixed(0)}ms total (${((slowTotal / tickStats.total) * 100).toFixed(1)}% of time) from ${slowTicks.length} ships`);
    
    // Auto-enable profiler if average tick time is high
    if (tickStats.avg > 8) {
      console.log(`[Traveling Tick] WARNING: High average (${tickStats.avg.toFixed(2)}ms). Enable profiler with ENABLE_PROFILER=true to identify bottlenecks.`);
    }
  }
  
  // Print profiler stats to identify bottlenecks (with timeout protection)
  // Disable profiler output by default to prevent CPU issues - enable via ENABLE_PROFILER=true
  const enableProfiler = process.env.ENABLE_PROFILER === "true";
  if (enableProfiler) {
    try {
      const profilerStats = profiler.getAllStats();
      if (profilerStats.length > 0 && profilerStats.length < 100000) { // Limit to prevent blocking
        // Aggregate stats by operation type (remove ship-specific IDs)
        const aggregated: Map<string, { count: number; totalTime: number; minTime: number; maxTime: number }> = new Map();
        
        // Limit processing to first 10000 entries to prevent blocking
        const statsToProcess = profilerStats.slice(0, 10000);
        for (const stat of statsToProcess) {
          // Extract operation type by removing ship IDs
          let opType = stat.name;
          
          // Remove ship-specific prefixes
          opType = opType.replace(/^(ship-[^-]+-|ship-unknown-|\d+-)/, '');
          
          // Remove system-specific suffixes for arrival operations
          opType = opType.replace(/-handleArrival-notify-\d+$/, '-handleArrival-notify');
          opType = opType.replace(/-handleArrival$/, '-handleArrival');
          
          const existing = aggregated.get(opType) || { count: 0, totalTime: 0, minTime: Infinity, maxTime: 0 };
          existing.count += stat.count;
          existing.totalTime += stat.totalTime;
          existing.minTime = Math.min(existing.minTime, stat.minTime);
          existing.maxTime = Math.max(existing.maxTime, stat.maxTime);
          aggregated.set(opType, existing);
        }
        
        // Convert to array and sort by total time
        const aggregatedStats = Array.from(aggregated.entries())
          .map(([name, data]) => ({
            name,
            count: data.count,
            totalTime: data.totalTime,
            avgTime: data.totalTime / data.count,
            minTime: data.minTime,
            maxTime: data.maxTime,
          }))
          .sort((a, b) => b.totalTime - a.totalTime);
        
        // Calculate total profiled time
        const totalProfiledTime = aggregatedStats.reduce((sum, s) => sum + s.totalTime, 0);
        const unaccountedTime = processingDuration - totalProfiledTime;
        const accountedPercentage = (totalProfiledTime / processingDuration * 100).toFixed(1);
        
        console.log(`\n[Traveling Tick Profiler] Time accounting: ${totalProfiledTime.toFixed(0)}ms profiled (${accountedPercentage}%), ${unaccountedTime.toFixed(0)}ms unaccounted`);
        console.log(`[Traveling Tick Profiler] Aggregated operations by total time:`);
        const topStats = aggregatedStats.slice(0, 20);
        for (const stat of topStats) {
          const percentage = (stat.totalTime / processingDuration * 100).toFixed(1);
          console.log(`  ${stat.name.padEnd(40)} ${stat.totalTime.toFixed(0).padStart(8)}ms (${stat.count.toString().padStart(6)} calls, ${stat.avgTime.toFixed(2).padStart(6)}ms avg, ${percentage.padStart(5)}% of total)`);
        }
        
        // Show arrival-specific operations
        const arrivalOps = aggregatedStats.filter(s => s.name.includes('handleArrival'));
        if (arrivalOps.length > 0) {
          const totalArrivalTime = arrivalOps.reduce((sum, s) => sum + s.totalTime, 0);
          const totalArrivalCalls = arrivalOps.reduce((sum, s) => sum + s.count, 0);
          console.log(`\n[Traveling Tick Profiler] Arrival operations: ${totalArrivalCalls} calls, ${totalArrivalTime.toFixed(0)}ms total, ${(totalArrivalTime / totalArrivalCalls).toFixed(2)}ms avg`);
        }
        
        // Show slow operations (high average time)
        const slowOps = aggregatedStats.filter(s => s.avgTime > 5).sort((a, b) => b.avgTime - a.avgTime).slice(0, 10);
        if (slowOps.length > 0) {
          console.log(`\n[Traveling Tick Profiler] Slow operations (>5ms avg):`);
          for (const stat of slowOps) {
            console.log(`  ${stat.name.padEnd(40)} ${stat.avgTime.toFixed(2).padStart(6)}ms avg (${stat.count} calls, ${stat.totalTime.toFixed(0)}ms total)`);
          }
        }
      }
    } catch (error) {
      console.error(`[Traveling Tick Profiler] Error processing profiler stats:`, error);
    }
  } else {
    // Reset profiler periodically to prevent memory buildup
    if (processedCount % 10000 === 0) {
      profiler.reset();
    }
  }
  
  // Continue processing if more ships queued
  if (travelingShipQueue.length > 0) {
    setImmediate(() => {
      processTravelingShipQueue(tickStartTime).catch((error) => {
        console.error("[Traveling Tick] Error in continued traveling ship queue processing:", error);
      });
    });
  }
}

async function handleGalaxyTick(corsHeaders: Record<string, string>): Promise<Response> {
  const tickStartTime = Date.now();
  
  const ticked: SystemId[] = [];
  let totalArrivalsProcessed = 0;
  let totalPendingArrivals = 0;
  let totalMarketsUpdated = 0;
  let totalSystemTicksProcessed = 0;
  let systemsWithWork = 0;

  // Tick all systems sequentially (single-threaded processing)
  const systemsStartTime = Date.now();
  isSystemTickInProgress = true;
  try {
    for (let i = 0; i < GALAXY_SIZE; i++) {
      const systemId = i as SystemId;
      const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
      const response = await system.fetch(new Request("https://dummy/tick", { method: "POST" }));
      if (response.ok) {
        try {
          const result = await response.json() as {
            processed?: number;
            arrivalsProcessed?: number;
            pendingArrivals?: number;
            marketsUpdated?: number;
          };
          const processed = typeof result.processed === "number" ? result.processed : 0;
          if (processed > 0) {
            systemsWithWork += 1;
          }
          totalSystemTicksProcessed += processed;
          if (typeof result.arrivalsProcessed === "number") {
            totalArrivalsProcessed += result.arrivalsProcessed;
          }
          if (typeof result.pendingArrivals === "number") {
            totalPendingArrivals += result.pendingArrivals;
          }
          if (typeof result.marketsUpdated === "number") {
            totalMarketsUpdated += result.marketsUpdated;
          }
        } catch (error) {
          // Ignore stats parse errors for individual systems
        }
      }
      ticked.push(systemId);
    }
  } finally {
    isSystemTickInProgress = false;
  }
  
  const systemsEndTime = Date.now();
  const systemsDuration = systemsEndTime - systemsStartTime;
  console.log(
    `[System Tick] Ticked ${ticked.length} systems in ${systemsDuration}ms ` +
    `(systemsWithWork=${systemsWithWork}, ticks=${totalSystemTicksProcessed}, ` +
    `arrivals=${totalArrivalsProcessed}, markets=${totalMarketsUpdated}, pendingArrivals=${totalPendingArrivals})`
  );

  // Queue all NPC ships for asynchronous processing

  const totalNPCs = TOTAL_NPCS;
  const newTickId = `tick-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const oldTickId = currentTickId;
  
  // Track stats silently (no logging)
  
  // Don't clear the queue - let old ships continue processing
  // Just add new ships that aren't already queued
  currentTickId = newTickId;
  shipsProcessedLastTick = 0; // Reset counter for this tick
  
  // Check queue size - if it's too large, skip adding ships to prevent backlog
  const QUEUE_BACKLOG_THRESHOLD = totalNPCs * 2; // Allow up to 2x total NPCs in queue
  const totalQueueSize = stationShipQueue.length + travelingShipQueue.length;
  if (totalQueueSize > QUEUE_BACKLOG_THRESHOLD) {
    console.warn(
      `[Galaxy Tick] Queue backlog detected: ${totalQueueSize} ships queued ` +
      `(threshold: ${QUEUE_BACKLOG_THRESHOLD}). Skipping this tick to allow queue to drain.`
    );
    return jsonResponse(
      {
        success: true,
        systemsTicked: ticked.length,
        shipsTicked: 0,
        totalNPCs,
        message: "Tick skipped due to queue backlog - processing previous tick's ships",
        queueSize: totalQueueSize,
      },
      200,
      corsHeaders
    );
  }
  
  // Add only STATION ships to queue (traveling ships are handled by fast tick)
  // Station ships (at_station) can take their time - no urgency
  for (let i = 0; i < totalNPCs; i++) {
    const shipId = `npc-${i}` as ShipId;
    // Check if ship is already in station queue
    const alreadyInQueue = queuedStationShipIds.has(shipId) || 
      stationShipQueue.some(q => q.shipId === shipId);
    if (!alreadyInQueue) {
      try {
        const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
        const stateResponse = await ship.fetch(new Request("https://dummy/state"));
        
        if (stateResponse.ok) {
          const state = await stateResponse.json();
          
          // Only queue at_station ships here (traveling ships handled by fast tick)
          // Skip resting/sleeping NPCs - they're inactive
          if (state.phase === "resting" || state.phase === "sleeping") {
            continue;
          }
          
          // Only queue at_station ships - traveling ships are handled separately
          if (state.phase === "at_station") {
            stationShipQueue.push({
              shipId,
              tickId: newTickId,
            });
            queuedStationShipIds.add(shipId);
          }
        }
      } catch (error) {
        // If we can't check state, skip it (better to be conservative)
        continue;
      }
    }
  }
  
  // Start processing station queue if not already running
  if (!isProcessingStationQueue) {
    processStationShipQueue(tickStartTime, systemsDuration).catch((error) => {
      console.error("[Galaxy Tick] Error in station ship queue processing:", error);
    });
  }
  
  // Collect monitoring data asynchronously (don't block tick response)
  collectMonitoringData().catch((error) => {
    console.error("[Galaxy Tick] Error collecting monitoring data:", error);
  });
  
  // Maintain NPC population - spawn new traders if population is low
  maintainNPCPopulation().catch((error) => {
    console.error("[Galaxy Tick] Error maintaining NPC population:", error);
  });
  
  // Return immediately - ships will be processed gradually in background
  const tickEndTime = Date.now();

  return jsonResponse(
    {
      success: true,
      systemsTicked: ticked.length,
      shipsTicked: 0, // Will be updated asynchronously
      totalNPCs,
      message: "Ships are queued for gradual processing",
    },
    200,
    corsHeaders
  );
}

/**
 * Reset zero inventory monitoring state
 * Clears zero inventory detection flags and trade logs to restart monitoring
 * Also resets all systems' stock levels and prices, and all NPCs to base with 500cr and no cargo
 */
async function handleResetZeroInventoryMonitoring(
  corsHeaders: Record<string, string>
): Promise<Response> {
  resetZeroInventoryMonitoring();
  clearTradeLogs();
  
  // Reset all systems' markets (inventory to 2000, price to basePrice)
  for (let i = 0; i < GALAXY_SIZE; i++) {
    const systemId = i as SystemId;
    try {
      const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
      await system.fetch(new Request("https://dummy/reset-markets", { method: "POST" }));
    } catch (error) {
      // Skip systems that can't be loaded
      console.error(`[Reset] Error resetting system ${systemId}:`, error);
    }
  }
  
  // Reset all NPCs to be at_station with 500cr and no cargo
  for (let i = 0; i < TOTAL_NPCS; i++) {
    const shipId = `npc-${i}` as ShipId;
    try {
      const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
      
      // Get current state to determine which system to reset to
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      let targetSystem: SystemId = 0; // Default to system 0
      
      if (stateResponse.ok) {
        const state = await stateResponse.json();
        // Use current system if available, otherwise default to 0
        if (typeof state.currentSystem === "number") {
          targetSystem = state.currentSystem as SystemId;
        }
      }
      
      // Reinitialize the ship at the target system
      const shipRng = new DeterministicRNG(`reset-${shipId}-${Date.now()}`);
      await ship.fetch(
        new Request("https://dummy/initialize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: shipId,
            name: `Trader ${i}`,
            systemId: targetSystem,
            seed: shipRng.random().toString(),
            isNPC: true,
          }),
        })
      );
      
      // Register with the system
      const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${targetSystem}`));
      await system.fetch(
        new Request("https://dummy/arrival", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            timestamp: Date.now(),
            shipId: shipId,
            fromSystem: targetSystem,
            toSystem: targetSystem,
            cargo: [],
            priceInfo: [],
          }),
        })
      );
    } catch (error) {
      // Skip NPCs that can't be loaded
      console.error(`[Reset] Error resetting NPC ${shipId}:`, error);
    }
  }
  
  return jsonResponse(
    {
      success: true,
      message: "Zero inventory monitoring reset. Trade logs cleared. All systems and NPCs reset.",
      zeroInventoryDetected: false,
      zeroInventorySystem: null,
      zeroInventoryGood: null,
    },
    200,
    corsHeaders
  );
}

/**
 * Maintain NPC population by respawning inactive traders
 * Checks if population is below target and spawns new traders randomly in the galaxy
 */
async function maintainNPCPopulation(): Promise<void> {
  const expectedTotal = TOTAL_NPCS;
  const presenceBySystem = getPresenceBySystem();
  
  // Count active NPCs (those present in any system)
  let activeCount = 0;
  for (const entries of Object.values(presenceBySystem)) {
    activeCount += entries.length;
  }
  
  // Check how many NPCs are inactive (currentSystem === null)
  const inactiveNPCs: ShipId[] = [];
  for (let i = 0; i < expectedTotal; i++) {
    const shipId = `npc-${i}` as ShipId;
    try {
      const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      if (state.currentSystem === null || state.currentSystem === undefined) {
        inactiveNPCs.push(shipId);
      }
    } catch (error) {
      // Ship doesn't exist or failed to load - treat as inactive slot
      inactiveNPCs.push(shipId);
    }
  }
  
  // If population is below target, respawn inactive NPCs
  const needed = expectedTotal - activeCount;
  if (needed > 0 && inactiveNPCs.length > 0) {
    const toRespawn = Math.min(needed, inactiveNPCs.length);
    const rng = new DeterministicRNG(`population-maintenance-${Date.now()}`);
    
    for (let i = 0; i < toRespawn; i++) {
      const shipId = inactiveNPCs[i];
      const spawnRng = rng.derive(`spawn-${shipId}-${i}`);
      const randomSystem = spawnRng.randomInt(0, GALAXY_SIZE - 1) as SystemId;
      
      try {
        const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
        
        // Reinitialize the ship
        const shipRng = spawnRng.derive(`ship-init`);
        await ship.fetch(
          new Request("https://dummy/initialize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: shipId,
              name: `Trader ${shipId.replace("npc-", "")}`,
              systemId: randomSystem,
              seed: shipRng.random().toString(),
              isNPC: true,
            }),
          })
        );
        
        // Register with the system
        const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${randomSystem}`));
        await system.fetch(
          new Request("https://dummy/arrival", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              timestamp: Date.now(),
              shipId: shipId,
              fromSystem: randomSystem,
              toSystem: randomSystem,
              cargo: [],
              priceInfo: [],
            }),
          })
        );
        
        // Log respawn if this NPC is being monitored
        const { shouldLogDecisions, logDecision } = await import("./trade-logging");
        if (shouldLogDecisions(shipId)) {
          logDecision(shipId, `NPC RESPAWNED: Replaced removed NPC, spawned in system ${randomSystem} with 500 credits`);
        }
        console.log(`[Galaxy Tick] Respawned ${shipId} in system ${randomSystem}`);
        
        // Record spawn for health tracking
        try {
          recordSpawn(shipId, randomSystem, "respawn");
        } catch (error) {
          // Don't let health tracking errors break respawn
          console.error(`[Population Maintenance] Error recording spawn for ${shipId}:`, error);
        }
      } catch (error) {
        console.error(`[Population Maintenance] Error respawning ${shipId}:`, error);
      }
    }
    
    if (toRespawn > 0) {
      console.log(`[Population Maintenance] Respawned ${toRespawn} NPC traders`);
    }
  }
}

/**
 * Process ships from the queue gradually
 * Processes ships in small batches with delays, allowing other operations to proceed
 * This ensures the server remains responsive while processing thousands of ships
 */
async function processStationShipQueue(
  tickStartTime: number,
  systemsDuration: number
): Promise<void> {
  if (isProcessingStationQueue) {
    return; // Already processing
  }
  
  isProcessingStationQueue = true;
  const shipsStartTime = Date.now();
  let shipsTicked = 0;
  let shipsSkipped = 0;
  let shipsArrivingBefore = 0;
  let shipsArrivingAfter = 0;
  let shipsAtStation = 0;
  let processedCount = 0;
  let systemPauseTime = 0;
  let systemPauseCount = 0;
  let travelingPauseTime = 0;
  let travelingPauseCount = 0;
  
  try {
    while (stationShipQueue.length > 0) {
      if (isSystemTickInProgress) {
        const pauseStart = Date.now();
        systemPauseCount++;
        await new Promise(resolve => setTimeout(resolve, 25));
        systemPauseTime += Date.now() - pauseStart;
        continue;
      }
      if (isProcessingTravelingQueue) {
        const pauseStart = Date.now();
        travelingPauseCount++;
        await new Promise(resolve => setTimeout(resolve, 10));
        travelingPauseTime += Date.now() - pauseStart;
        continue;
      }

      // Process one ship at a time (no batching for station ships)
      const queuedShip = stationShipQueue.shift();
      if (!queuedShip) {
        break;
      }
      
      // Check if this ship was already processed in a newer tick
      if (queuedShip.tickId !== currentTickId && currentTickId !== null) {
        // Ship from old tick - skip it
        shipsSkipped++;
        processedCount++;
        continue;
      }
      
      queuedStationShipIds.delete(queuedShip.shipId); // Remove from tracking set
      
      // Process single ship
      const batch: QueuedShip[] = [queuedShip];
      
      // Process the batch in parallel for better performance
      await Promise.all(batch.map(async ({ shipId }) => {
        try {
          const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
          // Check state before tick
          const stateBeforeResponse = await ship.fetch(new Request("https://dummy/state"));
          const stateBefore = await stateBeforeResponse.json();
          const wasArriving = stateBefore.phase === "arriving";
          const wasAtStation = stateBefore.phase === "at_station";
          if (wasArriving) {
            shipsArrivingBefore++;
            const now = Date.now();
            if (stateBefore.arrivalCompleteTime && now >= stateBefore.arrivalCompleteTime) {
              const overdue = Math.floor((now - stateBefore.arrivalCompleteTime) / 1000);
              // Track overdue ships silently (no logging)
            }
          }
          if (wasAtStation && stateBefore.isNPC) {
            shipsAtStation++;
          }
          
          const response = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
          const result = await response.json();
          // Ship's handleTick skips resting/sleeping NPCs, but we still count the tick attempt
          if (result.skipped) {
            shipsSkipped++;
          } else {
            shipsTicked++;
            // Only check state after tick if we need to track arriving status
            if (wasArriving) {
              const stateAfterResponse = await ship.fetch(new Request("https://dummy/state"));
              const stateAfter = await stateAfterResponse.json();
              if (stateAfter.phase === "arriving") {
                shipsArrivingAfter++;
              }
            }
          }
          processedCount++;
          shipsProcessedLastTick++; // Increment counter for ships processed in this tick
        } catch (error) {
          console.error(`Error ticking ship ${shipId}:`, error);
        }
      }));
      
      // Yield to event loop after each ship
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally {
    isProcessingStationQueue = false;
  }
  
  const shipsEndTime = Date.now();
  const shipsDuration = shipsEndTime - shipsStartTime;
  console.log(
    `[Trading Tick] Processed ${processedCount} station ships (${shipsTicked} ticked, ${shipsSkipped} skipped) ` +
    `in ${shipsDuration}ms (paused system=${systemPauseTime}ms/${systemPauseCount} waits, ` +
    `traveling=${travelingPauseTime}ms/${travelingPauseCount} waits)`
  );
  
  // If there are still ships in the queue (from a new tick), continue processing
  if (stationShipQueue.length > 0 && currentTickId) {
    setImmediate(() => {
      processStationShipQueue(tickStartTime, systemsDuration).catch((error) => {
        console.error("[Galaxy Tick] Error in continued station ship queue processing:", error);
      });
    });
  }
}

async function handleShipRequest(
  url: URL,
  method: string,
  shipId: ShipId,
  body: any,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));

  if (method === "GET") {
    const action = url.searchParams.get("action");
    if (action === "tick") {
      const response = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
      const data = await response.json();
      return jsonResponse(data, response.status, corsHeaders);
    } else if (action === "armaments") {
      const response = await ship.fetch(new Request("https://dummy/armaments"));
      const data = await response.json();
      return jsonResponse(data, response.status, corsHeaders);
    } else {
      const response = await ship.fetch(new Request("https://dummy/state"));
      const data = await response.json();
      return jsonResponse(data, response.status, corsHeaders);
    }
  } else if (method === "POST") {
    const action = body?.action || url.searchParams.get("action");
    if (action === "tick") {
      const response = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
      const data = await response.json();
      return jsonResponse(data, response.status, corsHeaders);
    } else if (action === "armaments") {
      const response = await ship.fetch(new Request("https://dummy/armaments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }));
      const data = await response.json();
      return jsonResponse(data, response.status, corsHeaders);
    } else if (action === "initialize" || body?.id) {
      // Handle ship initialization
      const response = await ship.fetch(new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }));
      const data = await response.json();
      return jsonResponse(data, response.status, corsHeaders);
    }
  }

  return jsonResponse({ error: "Invalid request" }, 400, corsHeaders);
}

/**
 * Collect monitoring data for all ships and systems
 */
async function collectMonitoringData(): Promise<void> {
  try {
    const totalNPCs = TOTAL_NPCS;
    const ships: Array<{
      credits: number;
      cargo: Map<string, number> | Record<string, number>;
      phase: string;
      currentSystem: number | null;
    }> = [];
    
    const allSystemMarkets: Record<number, Record<string, { price: number; basePrice: number }>> = {};
    const previousPrices: Record<number, Record<string, number>> = {};
    
    // Sample ships for monitoring (check first 1000 to avoid performance issues)
    const sampleSize = Math.min(1000, totalNPCs);
    for (let i = 0; i < sampleSize; i++) {
      try {
        const shipId = `npc-${i}` as ShipId;
        const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
        const stateResponse = await ship.fetch(new Request("https://dummy/state"));
        const shipState = await stateResponse.json();
        
        if (shipState.isNPC) {
          ships.push({
            credits: shipState.credits,
            cargo: shipState.cargo || {},
            phase: shipState.phase,
            currentSystem: shipState.currentSystem,
          });
        }
      } catch (error) {
        // Skip ships that can't be loaded
      }
    }
    
    // Collect system market data (sample first 50 systems)
    for (let i = 0; i < Math.min(50, GALAXY_SIZE); i++) {
      try {
        const systemId = i as SystemId;
        const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
        const snapshotResponse = await system.fetch(new Request("https://dummy/snapshot"));
        const snapshot = await snapshotResponse.json() as { markets?: Record<string, { price: number; inventory: number; basePrice?: number }> };
        
        if (snapshot.markets) {
          allSystemMarkets[systemId] = {};
          previousPrices[systemId] = {};
          
          for (const [goodId, market] of Object.entries(snapshot.markets)) {
            allSystemMarkets[systemId][goodId] = {
              price: market.price,
              basePrice: market.basePrice || market.price,
            };
            previousPrices[systemId][goodId] = market.price;
          }
          
          // Count ships at station
          const shipsAtStation = ships.filter(s => s.currentSystem === systemId && s.phase === "at_station").length;
          
          collectSystemMetrics(systemId, snapshot.markets, shipsAtStation, previousPrices[systemId]);
        }
      } catch (error) {
        // Skip systems that can't be loaded
      }
    }
    
    // Collect galaxy-wide metrics
    collectGalaxyMetrics(ships, allSystemMarkets);
  } catch (error) {
    console.error("[Monitoring] Error collecting data:", error);
  }
}

async function handleGalaxyShips(
  corsHeaders: Record<string, string>
): Promise<Response> {
  const warmRegistryFromScan = async () => {
    const totalNPCs = TOTAL_NPCS;
    for (let i = 0; i < totalNPCs; i++) {
      const shipId = `npc-${i}` as ShipId;
      try {
        const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
        const shipStateResponse = await ship.fetch(new Request("https://dummy/state"));
        const shipState = await shipStateResponse.json();
        updateShipPresence(shipState);
      } catch (error) {
        // Skip ships that can't be loaded
      }
    }
  };

  let presenceBySystem = getPresenceBySystem();
  if (Object.keys(presenceBySystem).length === 0) {
    await warmRegistryFromScan();
    presenceBySystem = getPresenceBySystem();
  }

  const dockedPhases = new Set(["at_station", "resting", "sleeping"]);
  const shipsBySystem: Record<number, Array<{
    id: string;
    name: string;
    currentSystem: number | null;
    destinationSystem: number | null;
    phase: string;
    credits: number;
    isNPC: boolean;
  }>> = {};

  let totalShips = 0;
  const ships: Array<{
    id: string;
    name: string;
    currentSystem: number | null;
    destinationSystem: number | null;
    phase: string;
    credits: number;
    isNPC: boolean;
  }> = [];

  Object.entries(presenceBySystem).forEach(([systemId, entries]) => {
    const systemKey = parseInt(systemId, 10);
    const shipsForSystem = entries
      .filter(entry => dockedPhases.has(entry.phase))
      .map(entry => ({
      id: entry.shipId,
      name: entry.shipId,
      currentSystem: systemKey,
      destinationSystem: null,
      phase: entry.phase,
      credits: 0,
      isNPC: true,
      }));
    if (shipsForSystem.length > 0) {
      shipsBySystem[systemKey] = shipsForSystem;
      ships.push(...shipsForSystem);
      totalShips += shipsForSystem.length;
    }
  });

  return jsonResponse({
    ships,
    shipsBySystem,
    totalShips,
    timestamp: Date.now(),
  }, 200, corsHeaders);
}

async function handleGalaxyMap(
  corsHeaders: Record<string, string>
): Promise<Response> {
  const allSystems: Array<{ id: SystemId; x: number; y: number; techLevel?: number; worldType?: string }> = [];
  
  for (let i = 0; i < GALAXY_SIZE; i++) {
    const systemId = i as SystemId;
    try {
      const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
      const snapshotResponse = await system.fetch(new Request("https://dummy/snapshot"));
      const snapshot = await snapshotResponse.json() as { state: { x?: number; y?: number; techLevel?: number; worldType?: string } | null };
      
      if (!snapshot.state) {
        continue; // Skip systems that aren't initialized
      }
      
      const x = snapshot.state.x ?? 0;
      const y = snapshot.state.y ?? 0;
      
      allSystems.push({
        id: systemId,
        x,
        y,
        techLevel: snapshot.state.techLevel,
        worldType: snapshot.state.worldType
      });
    } catch (error) {
      // Skip systems that can't be loaded
    }
  }
  
  return jsonResponse({
    systems: allSystems,
    timestamp: Date.now(),
  }, 200, corsHeaders);
}

async function handleSystemMonitor(
  systemId: SystemId,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const system = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
  
  // Get system snapshot
  const snapshotResponse = await system.fetch(new Request("https://dummy/snapshot"));
  const snapshot = await snapshotResponse.json() as {
    state: any;
    markets: Record<string, any>;
    shipsInSystem: string[];
  };

  const ships = [];
  const now = Date.now();
  const shipIds = new Set<string>([...snapshot.shipsInSystem, ...listShipsInSystem(systemId)]);

  for (const shipId of shipIds) {
    try {
      const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
      const shipStateResponse = await ship.fetch(new Request("https://dummy/state"));
      let shipState = await shipStateResponse.json();

      if (shipState.phase === "arriving" &&
          shipState.arrivalCompleteTime !== null &&
          now >= shipState.arrivalCompleteTime) {
        try {
          await ship.fetch(new Request("https://dummy/tick"), { method: "POST" });
          const updatedStateResponse = await ship.fetch(new Request("https://dummy/state"));
          shipState = await updatedStateResponse.json();
        } catch (error) {
          // If tick fails, continue with original state
        }
      }

      const isLocal = shipState.currentSystem === systemId && shipState.phase !== "in_hyperspace";
      if (!isLocal) {
        continue;
      }

      ships.push({
        id: shipState.id,
        name: shipState.name,
        credits: shipState.credits,
        phase: shipState.phase,
        currentSystem: shipState.currentSystem,
        destinationSystem: shipState.destinationSystem,
        cargo: shipState.cargo || {},
        isNPC: shipState.isNPC,
        armaments: shipState.armaments,
        fuelLy: shipState.fuelLy,
        fuelCapacityLy: shipState.fuelCapacityLy,
        positionX: shipState.positionX,
        positionY: shipState.positionY,
        arrivalStartX: shipState.arrivalStartX,
        arrivalStartY: shipState.arrivalStartY,
        departureStartTime: shipState.departureStartTime,
        hyperspaceStartTime: shipState.hyperspaceStartTime,
        arrivalStartTime: shipState.arrivalStartTime,
        arrivalCompleteTime: shipState.arrivalCompleteTime,
        restStartTime: shipState.restStartTime,
        restEndTime: shipState.restEndTime,
      });
    } catch (error) {
      // Skip ships that can't be loaded
      console.warn(`Failed to load ship ${shipId}:`, error);
    }
  }

  // Calculate nearby systems (within distance 50) using 2D coordinates
  const currentSystemData = snapshot.state;
  const currentX = currentSystemData.x ?? 0;
  const currentY = currentSystemData.y ?? 0;
  
  const nearbySystems: Array<{ id: SystemId; distance: number; x: number; y: number; techLevel?: number; worldType?: string }> = [];
  for (let i = 0; i < GALAXY_SIZE; i++) {
    const otherSystemId = i as SystemId;
    if (otherSystemId === systemId) continue;
    
    // Get other system's coordinates
    try {
      const otherSystem = localEnv.STAR_SYSTEM.get(localEnv.STAR_SYSTEM.idFromName(`system-${otherSystemId}`));
      const otherSnapshotResponse = await otherSystem.fetch(new Request("https://dummy/snapshot"));
      const otherSnapshot = await otherSnapshotResponse.json() as { state: { x?: number; y?: number; techLevel?: number; worldType?: string } | null };
      
      if (!otherSnapshot.state) {
        continue; // Skip systems that aren't initialized
      }
      
      const otherX = otherSnapshot.state.x ?? 0;
      const otherY = otherSnapshot.state.y ?? 0;
      
      // Calculate 2D Euclidean distance
      const dx = currentX - otherX;
      const dy = currentY - otherY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance <= 30) {
        nearbySystems.push({ 
          id: otherSystemId, 
          distance, 
          x: otherX, 
          y: otherY,
          techLevel: otherSnapshot.state.techLevel,
          worldType: otherSnapshot.state.worldType
        });
      }
    } catch (error) {
      // Fallback to simple distance if system not available
      const distance = Math.abs(systemId - otherSystemId);
      if (distance <= 30) {
        // Estimate coordinates for fallback
        const angle = (otherSystemId % 360) * (Math.PI / 180);
        const estimatedX = currentX + distance * Math.cos(angle);
        const estimatedY = currentY + distance * Math.sin(angle);
        nearbySystems.push({ id: otherSystemId, distance, x: estimatedX, y: estimatedY });
      }
    }
  }
  nearbySystems.sort((a, b) => a.distance - b.distance);

  return jsonResponse({
    system: snapshot.state,
    markets: snapshot.markets,
    ships,
    nearbySystems,
    timestamp: Date.now(),
  }, 200, corsHeaders);
}


async function serveMonitorInterface(): Promise<Response> {
  const monitorHtml = await fs.promises.readFile(
    pathModule.join(process.cwd(), "public", "monitor.html"),
    "utf-8"
  ).catch(() => null);

  if (monitorHtml) {
    return new Response(monitorHtml, {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Fallback: return embedded HTML
  return new Response("Monitor interface not found", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

async function servePlayerInterface(): Promise<Response> {
  const playerHtml = await fs.promises.readFile(
    pathModule.join(process.cwd(), "public", "player.html"),
    "utf-8"
  ).catch(() => null);

  if (playerHtml) {
    return new Response(playerHtml, {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Fallback: return error if file not found
  return new Response("Player interface not found", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

async function serveLeaderboardInterface(): Promise<Response> {
  const leaderboardHtml = await fs.promises.readFile(
    pathModule.join(process.cwd(), "public", "leaderboard.html"),
    "utf-8"
  ).catch(() => null);

  if (leaderboardHtml) {
    return new Response(leaderboardHtml, {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Fallback: return error if file not found
  return new Response("Leaderboard interface not found", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}

async function serveDevInterface(): Promise<Response> {
  // Read from file and inject API documentation
  let devHtml = await fs.promises.readFile(
    pathModule.join(process.cwd(), "public", "dev.html"),
    "utf-8"
  ).catch(() => null);

  if (devHtml) {
    // Inject API documentation and server info
    const galaxyDocs = getCategoryDocsHtml("Galaxy Operations");
    const systemDocs = getCategoryDocsHtml("System Operations");
    const shipDocs = getCategoryDocsHtml("Ship Operations");
    
    // Replace placeholder divs with actual documentation
    devHtml = devHtml.replace('<div id="galaxyDocs" style="display: none;"></div>', `<div id="galaxyDocs" style="display: none;">${galaxyDocs}</div>`);
    devHtml = devHtml.replace('<div id="systemDocs" style="display: none;"></div>', `<div id="systemDocs" style="display: none;">${systemDocs}</div>`);
    devHtml = devHtml.replace('<div id="shipDocs" style="display: none;"></div>', `<div id="shipDocs" style="display: none;">${shipDocs}</div>`);
    
    // Replace server info placeholder
    devHtml = devHtml.replace('<p id="serverInfo" style="color: #6bcf7f; margin-bottom: 20px;">Running on Local Node.js Server</p>', `<p id="serverInfo" style="color: #6bcf7f; margin-bottom: 20px;">Running on Local Node.js Server (Port ${PORT})</p>`);
    
    return new Response(devHtml, {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Fallback: return error if file not found
  return new Response("Dev interface not found", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}
/**
 * Flush all systems and ships to database using batched transactions
 */
async function flushAllState(): Promise<void> {
  console.log("💾 Flushing all state to database...");
  const startTime = Date.now();
  
  // Collect all dirty systems and ships
  const systemsToFlush: Array<{ objectId: string; data: any }> = [];
  const shipsToFlush: Array<{ objectId: string; data: any }> = [];
  
  for (const [systemId, system] of systems.entries()) {
    if ((system as any).dirty && (system as any).systemState) {
      // Get the storage instance to access pending data
      const state = (system as any).state;
      if (state && state.storage) {
        // Trigger the flush to collect data
        await system.flushState();
        const storage = state.storage as any;
        const pendingData = storage.getPendingSystemData();
        if (pendingData) {
          systemsToFlush.push({
            objectId: `system-${systemId}`,
            data: pendingData,
          });
        }
      }
    }
  }
  
  for (const [shipId, ship] of ships.entries()) {
    if ((ship as any).dirty && (ship as any).shipState) {
      const state = (ship as any).state;
      if (state && state.storage) {
        await ship.flushState();
        const storage = state.storage as any;
        const pendingData = storage.getPendingShipData();
        if (pendingData) {
          shipsToFlush.push({
            objectId: shipId,
            data: pendingData,
          });
        }
      }
    }
  }
  
  // Batch flush systems
  if (systemsToFlush.length > 0) {
    const { LocalStorage } = await import("./local-storage");
    await LocalStorage.flushAllSystems(systemsToFlush);
    
    // Clear pending data
    for (const system of systems.values()) {
      const state = (system as any).state;
      if (state && state.storage) {
        (state.storage as any).clearPendingData();
      }
    }
  }
  
  // Batch flush ships
  if (shipsToFlush.length > 0) {
    const { LocalStorage } = await import("./local-storage");
    await LocalStorage.flushAllShips(shipsToFlush);
    
    // Clear pending data
    for (const ship of ships.values()) {
      const state = (ship as any).state;
      if (state && state.storage) {
        (state.storage as any).clearPendingData();
      }
    }
  }
  
  const duration = Date.now() - startTime;
  console.log(`✅ Flushed ${systemsToFlush.length} systems and ${shipsToFlush.length} ships in ${duration}ms`);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

type PlayerLogEntry = {
  timestamp: number;
  shipId: string;
  method: string;
  path: string;
  request?: any;
  status?: number;
  response?: any;
  source?: "server" | "client";
};

const MAX_PLAYER_LOGS = 200;
const playerLogs: PlayerLogEntry[] = [];

function logPlayerEvent(entry: PlayerLogEntry): void {
  playerLogs.push({
    ...entry,
    shipId: entry.shipId || "unknown",
    timestamp: entry.timestamp || Date.now(),
  });
  if (playerLogs.length > MAX_PLAYER_LOGS) {
    playerLogs.splice(0, playerLogs.length - MAX_PLAYER_LOGS);
  }
}

function getPlayerLogs(): PlayerLogEntry[] {
  return playerLogs.slice();
}

function clearPlayerLogs(): void {
  playerLogs.length = 0;
}

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, corsHeaders);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method || "GET";

    // Read request body if present
    let body: any = null;
    if (method === "POST" || method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const bodyStr = Buffer.concat(chunks).toString();
      if (bodyStr) {
        try {
          body = JSON.parse(bodyStr);
        } catch {
          body = bodyStr;
        }
      }
    }

    let response: Response;

    // Route handling
    if (path === "/api" || path === "/api/") {
      response = jsonResponse(
        {
          status: "ok",
          message: "Space Trader API is running (Local Node.js Server)",
          endpoints: [
            "GET /api/health",
            "GET /dev",
            "POST /api/galaxy/initialize",
            "GET /api/system/{id}?action=snapshot",
          ],
        },
        200,
        corsHeaders
      );
    } else if (path === "/api/galaxy/ships" && method === "GET") {
      response = await handleGalaxyShips(corsHeaders);
    } else if (path.startsWith("/api/system/") && path.endsWith("/monitor") && method === "GET") {
      const systemId = extractSystemId(path.replace("/monitor", ""));
      if (systemId === null) {
        response = jsonResponse({ error: "Invalid system ID" }, 400, corsHeaders);
      } else {
        response = await handleSystemMonitor(systemId, corsHeaders);
      }
    } else if (path.startsWith("/api/system/")) {
      const systemId = extractSystemId(path);
      if (systemId === null) {
        response = jsonResponse({ error: "Invalid system ID", path }, 400, corsHeaders);
      } else {
        response = await handleSystemRequest(url, method, systemId, corsHeaders);
      }
    } else if (path === "/api/galaxy/initialize" && method === "POST") {
      response = await handleGalaxyInitialize(body || {}, corsHeaders);
    } else if (path === "/api/galaxy/tick" && method === "POST") {
      response = await handleGalaxyTick(corsHeaders);
    } else if (path === "/api/galaxy/reset-zero-inventory-monitoring" && method === "POST") {
      response = await handleResetZeroInventoryMonitoring(corsHeaders);
    } else if (path === "/api/galaxy/map" && method === "GET") {
      response = await handleGalaxyMap(corsHeaders);
    } else if (path === "/api/player" && method === "GET") {
      const rawName = url.searchParams.get("name") || "";
      const name = normalizePlayerName(rawName);
      if (!name) {
        response = jsonResponse({ error: "Missing player name" }, 400, corsHeaders);
      } else {
        const player = getPlayerByName(name);
        if (!player) {
          response = jsonResponse({ error: "Player not found" }, 404, corsHeaders);
        } else {
          response = jsonResponse({ player }, 200, corsHeaders);
        }
      }
    } else if (path === "/api/player" && method === "POST") {
      const rawName = body?.name || "";
      const name = normalizePlayerName(String(rawName));
      if (!name) {
        response = jsonResponse({ error: "Missing player name" }, 400, corsHeaders);
      } else {
        const existing = getPlayerByName(name);
        const shipId = existing?.shipId || makePlayerShipId(name);
        const player = upsertPlayer(name, shipId, Date.now());
        response = jsonResponse({ player, created: !existing }, 200, corsHeaders);
      }
    } else if (path.startsWith("/api/ship/")) {
      const shipId = extractShipId(path);
      if (!shipId) {
        response = jsonResponse({ error: "Invalid ship ID", path }, 400, corsHeaders);
      } else {
        // Check if this is a trade request
        if (path.endsWith("/trade") && method === "POST") {
          const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId as ShipId));
          const tradeResponse = await ship.fetch(new Request("https://dummy/trade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {}),
          }));
          const tradeData = await tradeResponse.json();
          response = jsonResponse(tradeData, tradeResponse.status, corsHeaders);
          if (shipId.startsWith("player-")) {
            logPlayerEvent({
              timestamp: Date.now(),
              shipId,
              method,
              path,
              request: body || {},
              status: tradeResponse.status,
              response: tradeData,
              source: "server",
            });
          }
        } else if (path.endsWith("/travel") && method === "POST") {
          const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId as ShipId));
          const travelResponse = await ship.fetch(new Request("https://dummy/travel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {}),
          }));
          const travelData = await travelResponse.json();
          response = jsonResponse(travelData, travelResponse.status, corsHeaders);
          if (shipId.startsWith("player-")) {
            logPlayerEvent({
              timestamp: Date.now(),
              shipId,
              method,
              path,
              request: body || {},
              status: travelResponse.status,
              response: travelData,
              source: "server",
            });
          }
        } else if (path.endsWith("/initialize") && method === "POST") {
          const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId as ShipId));
          const initResponse = await ship.fetch(new Request("https://dummy/initialize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body || {}),
          }));
          const initData = await initResponse.json();
          response = jsonResponse(initData, initResponse.status, corsHeaders);
          if (shipId.startsWith("player-")) {
            logPlayerEvent({
              timestamp: Date.now(),
              shipId,
              method,
              path,
              request: body || {},
              status: initResponse.status,
              response: initData,
              source: "server",
            });
          }
        } else {
          response = await handleShipRequest(url, method, shipId as ShipId, body, corsHeaders);
          if (shipId.startsWith("player-")) {
            try {
              const responseClone = response.clone();
              const responseData = await responseClone.json();
              logPlayerEvent({
                timestamp: Date.now(),
                shipId,
                method,
                path,
                request: body || {},
                status: response.status,
                response: responseData,
                source: "server",
              });
            } catch {
              logPlayerEvent({
                timestamp: Date.now(),
                shipId,
                method,
                path,
                request: body || {},
                status: response.status,
                source: "server",
              });
            }
          }
        }
      }
    } else if (path === "/api/player-logs" && method === "GET") {
      response = jsonResponse({ success: true, logs: getPlayerLogs() }, 200, corsHeaders);
    } else if (path === "/api/player-logs" && method === "POST") {
      const entry = body || {};
      logPlayerEvent({
        timestamp: entry.timestamp || Date.now(),
        shipId: entry.shipId || "unknown",
        method: entry.method || "UNKNOWN",
        path: entry.path || "",
        request: entry.request,
        status: entry.status,
        response: entry.response,
        source: "client",
      });
      response = jsonResponse({ success: true }, 200, corsHeaders);
    } else if (path === "/api/player-logs" && method === "DELETE") {
      clearPlayerLogs();
      response = jsonResponse({ success: true, message: "Player logs cleared" }, 200, corsHeaders);
    } else if (path === "/api/health" && method === "GET") {
      response = jsonResponse({ status: "ok" }, 200, corsHeaders);
    } else if (path === "/api/trade-logging" && method === "GET") {
      response = jsonResponse({ mode: getTradeLoggingMode() }, 200, corsHeaders);
    } else if (path === "/api/trade-logging" && method === "POST") {
      const mode = body?.mode || "all";
      if (mode !== "all" && mode !== "none" && !mode.startsWith("npc-")) {
        response = jsonResponse({ error: "Invalid mode. Use 'all', 'none', or a ship ID like 'npc-123'" }, 400, corsHeaders);
      } else {
        try {
          console.log(`[Trade Logging] Setting mode to: ${mode}`);
          setTradeLoggingMode(mode);
          const currentMode = getTradeLoggingMode();
          console.log(`[Trade Logging] Mode set successfully to: ${currentMode}`);
          response = jsonResponse({ success: true, mode: currentMode }, 200, corsHeaders);
        } catch (error) {
          console.error("[Trade Logging] Error setting mode:", error);
          response = jsonResponse({ error: "Failed to set logging mode", details: error instanceof Error ? error.message : String(error) }, 500, corsHeaders);
        }
      }
    } else if (path === "/api/auto-tick" && method === "GET") {
      const status = (global as any).getAutoTickStatus();
      response = jsonResponse(status, 200, corsHeaders);
    } else if (path === "/api/auto-tick" && method === "POST") {
      const enabled = body?.enabled;
      if (typeof enabled !== "boolean") {
        response = jsonResponse({ error: "Invalid request. Expected { enabled: boolean }" }, 400, corsHeaders);
      } else {
        try {
          if (enabled) {
            (global as any).startAutoTick();
            console.log(`[Auto-Tick] Enabled via API`);
          } else {
            (global as any).stopAutoTick();
            console.log(`[Auto-Tick] Disabled via API`);
          }
          const status = (global as any).getAutoTickStatus();
          response = jsonResponse({ success: true, ...status }, 200, corsHeaders);
        } catch (error) {
          console.error(`[Auto-Tick] Error toggling:`, error);
          response = jsonResponse({ error: "Failed to toggle auto-tick" }, 500, corsHeaders);
        }
      }
    } else if (path === "/api/trade-logs" && method === "GET") {
      try {
        const logs = getTradeLogs();
        response = jsonResponse({ logs }, 200, corsHeaders);
      } catch (error) {
        response = jsonResponse({ error: "Failed to get trade logs", logs: [] }, 500, corsHeaders);
      }
    } else if (path === "/api/trade-logs" && method === "DELETE") {
      clearTradeLogs();
      response = jsonResponse({ success: true, message: "Trade logs cleared" }, 200, corsHeaders);
    } else if (path === "/api/flush" && method === "POST") {
      await flushAllState();
      response = jsonResponse({ success: true, message: "State flushed to database" }, 200, corsHeaders);
    } else if (path === "/api/monitoring/data" && method === "GET") {
      const data = getMonitoringData();
      response = jsonResponse({ success: true, data }, 200, corsHeaders);
    } else if (path === "/api/monitoring/analyze" && method === "GET") {
      const analysis = analyzeAndRecommend();
      response = jsonResponse({ success: true, analysis }, 200, corsHeaders);
    } else if (path === "/api/monitoring/clear" && method === "POST") {
      clearMonitoringData();
      response = jsonResponse({ success: true, message: "Monitoring data cleared" }, 200, corsHeaders);
    } else if (path === "/api/monitoring/collect" && method === "POST") {
      await collectMonitoringData();
      response = jsonResponse({ success: true, message: "Data collection triggered" }, 200, corsHeaders);
    } else if (path === "/api/galaxy-health" && method === "GET") {
      try {
        // Get current population stats by counting all ships directly
        const expectedTotal = TOTAL_NPCS;
        let totalCount = 0;
        let activeCount = 0;
        
        // Count all ships by querying each one
        for (let i = 0; i < expectedTotal; i++) {
          const shipId = `npc-${i}` as ShipId;
          try {
            const ship = localEnv.SHIP.get(localEnv.SHIP.idFromName(shipId));
            const stateResponse = await ship.fetch(new Request("https://dummy/state"));
            if (stateResponse.ok) {
              const state = await stateResponse.json();
              totalCount++;
              // Count as active if ship has a current system (not null/undefined)
              if (state.currentSystem !== null && state.currentSystem !== undefined) {
                activeCount++;
              }
            }
          } catch (error) {
            // Ship doesn't exist or failed to load - skip
          }
        }
        
        // Get trade logs for analysis
        const tradeLogs = getTradeLogs();
        
        // Get health metrics
        // Use totalCount as current population (all ships that exist)
        const health = getGalaxyHealth(
          totalCount,     // current population (all existing ships)
          expectedTotal,  // target population
          activeCount,    // active ships (those in a system)
          tradeLogs,
          SERVER_START_TIME
        );
        
        // Add logging status
        const healthWithLogging = {
          ...health,
          logging: {
            paused: loggingPaused,
            needsCodeChange: loggingPaused,
            message: loggingPaused 
              ? "Logging paused - code change required. Check cycle-log.json for details. Restart server to resume logging."
              : undefined,
          },
        };
        
        response = jsonResponse({ success: true, health: healthWithLogging }, 200, corsHeaders);
      } catch (error) {
        response = jsonResponse({ 
          error: "Failed to get galaxy health", 
          details: error instanceof Error ? error.message : String(error) 
        }, 500, corsHeaders);
      }
    } else if (path === "/api/galaxy/check-and-log" && method === "POST") {
      try {
        const result = await checkHealthAndWriteLog();
        response = jsonResponse({
          success: true,
          evaluation: {
            needsCodeChange: result.evaluation.needsChange,
            reasons: result.evaluation.reasons,
          },
          health: result.galaxyHealthSnapshot.health,
          logWritten: result.logWritten,
          loggingPaused: result.loggingPaused,
          timestamp: result.timestamp,
          message: result.loggingPaused 
            ? "Code change required. Log written and logging paused. Restart server to resume."
            : "Health check completed. Log written.",
        }, 200, corsHeaders);
      } catch (error) {
        response = jsonResponse({
          error: "Failed to check health and write log",
          details: error instanceof Error ? error.message : String(error)
        }, 500, corsHeaders);
      }
    } else if (path === "/api/leaderboard" && method === "GET") {
      try {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? parseInt(limitParam, 10) : 100;
        const leaderboard = getLeaderboard(Math.min(limit, 1000)); // Cap at 1000
        response = jsonResponse({ success: true, leaderboard }, 200, corsHeaders);
      } catch (error) {
        response = jsonResponse({ 
          error: "Failed to get leaderboard", 
          details: error instanceof Error ? error.message : String(error) 
        }, 500, corsHeaders);
      }
    } else if (path.startsWith("/api/leaderboard/trader/") && method === "GET") {
      try {
        const shipId = path.replace("/api/leaderboard/trader/", "") as ShipId;
        const details = getTraderDetails(shipId);
        if (details) {
          response = jsonResponse({ 
            success: true, 
            trader: {
              ...details,
              systemsVisited: Array.from(details.systemsVisited),
            }
          }, 200, corsHeaders);
        } else {
          response = jsonResponse({ error: "Trader not found" }, 404, corsHeaders);
        }
      } catch (error) {
        response = jsonResponse({ 
          error: "Failed to get trader details", 
          details: error instanceof Error ? error.message : String(error) 
        }, 500, corsHeaders);
      }
    } else if (path.startsWith("/api/leaderboard/system/") && method === "GET") {
      try {
        const systemIdStr = path.replace("/api/leaderboard/system/", "");
        const systemId = parseInt(systemIdStr, 10) as SystemId;
        if (isNaN(systemId)) {
          response = jsonResponse({ error: "Invalid system ID" }, 400, corsHeaders);
        } else {
          const details = getSystemDetails(systemId);
          if (details) {
            response = jsonResponse({ 
              success: true, 
              system: {
                ...details,
                uniqueTraders: Array.from(details.uniqueTraders),
              }
            }, 200, corsHeaders);
          } else {
            response = jsonResponse({ error: "System not found" }, 404, corsHeaders);
          }
        }
      } catch (error) {
        response = jsonResponse({ 
          error: "Failed to get system details", 
          details: error instanceof Error ? error.message : String(error) 
        }, 500, corsHeaders);
      }
    } else if (path === "/api/leaderboard/clear" && method === "POST") {
      clearLeaderboard();
      response = jsonResponse({ success: true, message: "Leaderboard data cleared" }, 200, corsHeaders);
    } else if (path === "/" || path === "/player" || path === "/player.html") {
      response = await servePlayerInterface();
    } else if (path === "/dev" || path === "/dev.html") {
      response = await serveDevInterface();
    } else if (path === "/monitor" || path === "/monitor.html") {
      response = await serveMonitorInterface();
    } else if (path === "/leaderboard" || path === "/leaderboard.html") {
      response = await serveLeaderboardInterface();
    } else {
      response = jsonResponse({ error: "Not found" }, 404, corsHeaders);
    }

    // Send response
    const responseBody = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, {
      ...headers,
      ...corsHeaders,
    });
    res.end(responseBody);
  } catch (error) {
    console.error("Unhandled error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.writeHead(500, {
      "Content-Type": "application/json",
      ...corsHeaders,
    });
    res.end(
      JSON.stringify({
        error: errorMessage,
        path: req.url,
        method: req.method,
      })
    );
  }
}

const server = http.createServer(handleRequest);

server.listen(PORT, async () => {
  console.log(`🚀 Space Trader Local Server running on http://localhost:${PORT}`);
  console.log(`   Galaxy Size: ${GALAXY_SIZE}`);
  console.log(`   Tick Interval: ${TICK_INTERVAL_MS}ms`);
  console.log(`   Total NPCs: ${TOTAL_NPCS}`);
  console.log(`   Storage: SQLite database at .local-storage/durable-objects.db`);
  console.log(`   Write Mode: In-memory with periodic flush (every hour)`);
  console.log(`\n   Try: curl http://localhost:${PORT}/api/health`);
  
  // Check if galaxy needs initialization
  if (!hasInitializedGalaxy()) {
    console.log(`\n🌌 No existing galaxy found - auto-initializing...`);
    try {
      const seed = "1";
      await handleGalaxyInitialize({ seed }, {});
      console.log(`✅ Galaxy auto-initialized with seed: ${seed}`);
    } catch (error) {
      console.error(`❌ Failed to auto-initialize galaxy:`, error);
    }
  } else {
    console.log(`✅ Existing galaxy found in database`);
  }

  cycleStartTime = Date.now();
  cycleIndex = 0;
  clearTradeLogs();
  setTradeLoggingMode("all");

  // Automatic simulation ticking every TICK_INTERVAL_MS (10 seconds)
  let travelingTickInterval: NodeJS.Timeout | null = null;
  
  function startAutoTick(): void {
    if (autoTickInterval) {
      clearInterval(autoTickInterval);
    }
    if (travelingTickInterval) {
      clearInterval(travelingTickInterval);
    }
    
    // Normal tick for systems and station ships (30 seconds)
    autoTickInterval = setInterval(async () => {
      try {
        await handleGalaxyTick({}); // Empty CORS headers for internal calls
      } catch (error) {
        console.error("Error in auto-tick:", error);
      }
    }, TICK_INTERVAL_MS);
    
    // Fast tick for traveling ships (10 seconds)
    travelingTickInterval = setInterval(async () => {
      try {
        await handleTravelingTick();
      } catch (error) {
        console.error("Error in traveling-tick:", error);
      }
    }, TRAVELING_TICK_INTERVAL_MS);
    
    autoTickEnabled = true;
    console.log(`   Auto-tick enabled: systems/station ships every ${TICK_INTERVAL_MS / 1000} seconds, traveling ships every ${TRAVELING_TICK_INTERVAL_MS / 1000} seconds`);
  }
  
  function stopAutoTick(): void {
    if (autoTickInterval) {
      clearInterval(autoTickInterval);
      autoTickInterval = null;
    }
    if (travelingTickInterval) {
      clearInterval(travelingTickInterval);
      travelingTickInterval = null;
    }
    autoTickEnabled = false;
    console.log(`   Auto-tick disabled`);
  }
  
  function getAutoTickStatus(): { enabled: boolean; interval: number } {
    return { enabled: autoTickEnabled, interval: TICK_INTERVAL_MS };
  }
  
  // Make functions available globally for API access
  (global as any).startAutoTick = startAutoTick;
  (global as any).stopAutoTick = stopAutoTick;
  (global as any).getAutoTickStatus = getAutoTickStatus;
  
  if (AUTO_TICK) {
    startAutoTick();
  } else {
    console.log(`   Auto-tick disabled (set AUTO_TICK=false to disable)`);
  }

  // Only start health check interval if logging is not paused
  if (!loggingPaused) {
    healthCheckInterval = setInterval(() => {
      // Check again if logging is paused before running (in case it was paused manually)
      if (loggingPaused) {
        if (healthCheckInterval) {
          clearInterval(healthCheckInterval);
          healthCheckInterval = null;
        }
        return;
      }
      autoHealthCheckAndLog().catch((error) => {
        console.error("[Galaxy Cycle] Auto health check and log write failed:", error);
      });
    }, RESET_INTERVAL_MS);
    console.log(`   Auto health check and log write scheduled: every ${RESET_INTERVAL_MS / 1000 / 60} minutes`);
  } else {
    console.log(`   Auto health check disabled (logging already paused)`);
  }
  
  
  // Periodic flush every hour
  const FLUSH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  setInterval(async () => {
    await flushAllState();
  }, FLUSH_INTERVAL_MS);
  
  console.log(`   Auto-flush scheduled: every ${FLUSH_INTERVAL_MS / 1000 / 60} minutes`);
});

// Graceful shutdown - flush state and close SQLite database
async function shutdown(): Promise<void> {
  console.log("\n🛑 Shutting down server...");
  console.log("💾 Flushing state to database...");
  await flushAllState();
  closeDatabase();
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  shutdown().catch(console.error);
});

process.on("SIGTERM", () => {
  shutdown().catch(console.error);
});
