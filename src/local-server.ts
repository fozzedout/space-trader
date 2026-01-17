/**
 * Local Node.js HTTP server for development
 * Runs the simulation logic without external platform dependencies
 */

import http from "http";
import { URL } from "url";
import * as fs from "fs";
import * as pathModule from "path";
import { StarSystem } from "./star-system";
import { Ship } from "./ship";
import { SystemId, ShipId, TechLevel, WorldType, GoodId, SystemState, ShipState, MarketState, ShipPhase, SystemSnapshot } from "./types";
import type { DurableObjectNamespace, DurableObjectState } from "./durable-object-types";

// Types for accessing private properties of StarSystem and Ship
type StarSystemWithState = StarSystem & {
  dirty?: boolean;
  systemState?: SystemState | null;
  state?: DurableObjectState & {
    storage?: {
      getPendingSystemData(): {
        systemState: SystemState;
        markets: Array<[GoodId, MarketState]>;
        shipsInSystem: ShipId[];
        pendingArrivals?: Array<{ timestamp: number; shipId: string; fromSystem: number; toSystem: number; cargo: Array<[string, number]>; priceInfo: Array<[string, number]> }>;
      } | null;
      clearPendingData(): void;
    };
  };
};

type ShipWithState = Ship & {
  dirty?: boolean;
  shipState?: ShipState | null;
  state?: DurableObjectState & {
    storage?: {
      getPendingShipData(): ShipState | null;
      clearPendingData(): void;
    };
  };
}

type SystemFlushData = {
  systemState: SystemState;
  markets: Array<[GoodId, MarketState]>;
  shipsInSystem: ShipId[];
  pendingArrivals?: Array<{ timestamp: number; shipId: string; fromSystem: number; toSystem: number; cargo: Array<[string, number]>; priceInfo: Array<[string, number]> }>;
};

type SystemFlushEntry = {
  objectId: string;
  data: SystemFlushData;
};

type ShipFlushEntry = {
  objectId: string;
  data: ShipState;
};

import { DeterministicRNG } from "./deterministic-rng";
import { LocalDurableObjectState, closeDatabase, getPlayerByName, hasInitializedGalaxy, LocalStorage, upsertPlayer, resetDatabase } from "./local-storage";
import { getCategoryDocsHtml } from "./api-docs";
import { resetZeroInventoryMonitoring } from "./star-system";
import { getTickIntervalMs } from "./simulation-config";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const GALAXY_SIZE = parseInt(process.env.GALAXY_SIZE || "20", 10);
const TICK_INTERVAL_MS = getTickIntervalMs();
const TRAVELING_TICK_INTERVAL_MS = parseInt(process.env.TRAVELING_TICK_INTERVAL_MS || "11000", 10); // 11 seconds - for traveling ships (inter_system_jump, docking, in_system_exploring, encounter_active, microgame_active)
const TRAVELING_PHASES = new Set<ShipPhase>([
  "traveling",
]);
const TOTAL_NPCS = parseInt(process.env.TOTAL_NPCS || "100", 10);
const AUTO_TICK = process.env.AUTO_TICK !== "false"; // Enable auto-ticking by default (set AUTO_TICK=false to disable)

async function yieldToEventLoop(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}




// Removed logging config functions - simplified

// Runtime auto-tick control
let autoTickEnabled = AUTO_TICK;
let autoTickInterval: NodeJS.Timeout | null = null;


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
let isGalaxyTickInProgress = false;
let currentTickId: string | null = null;
let shipsProcessedLastTick = 0; // Track ships processed in the last completed tick

type GalaxyTickStatus = {
  tickId: string;
  startedAt: number;
  completedAt?: number;
  message?: string;
  skipped?: boolean;
  queueSize?: number;
  systemsTicked?: number;
  totalNPCs?: number;
};

let lastGalaxyTickStatus: GalaxyTickStatus | null = null;

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


// In-memory storage for systems and ships
const systems = new Map<SystemId, StarSystem>();
const ships = new Map<ShipId, Ship>();

// Local environment for simulation objects (Node.js equivalent of Durable Object namespaces)
// Provides the same interface as the simulation runtime with STAR_SYSTEM and SHIP namespaces
interface LocalSimulationEnv {
  STAR_SYSTEM: DurableObjectNamespace;
  SHIP: DurableObjectNamespace;
}

const localEnv: LocalSimulationEnv = {
  STAR_SYSTEM: {
    idFromName: (name: string) => ({ toString: () => name }),
    get: <T = unknown>(id: { toString(): string }): T => {
      const systemId = parseInt(id.toString().replace("system-", ""), 10) as SystemId;
      if (!systems.has(systemId)) {
        const state = new LocalDurableObjectState(`system-${systemId}`);
        const system = new StarSystem(state.storage, localEnv, state.id.toString());
        systems.set(systemId, system);
      }
      return systems.get(systemId)! as T;
    },
  },
  SHIP: {
    idFromName: (name: string) => ({ toString: () => name }),
    get: <T = unknown>(id: { toString(): string }): T => {
      const shipId = id.toString() as ShipId;
      if (!ships.has(shipId)) {
        const state = new LocalDurableObjectState(shipId);
        const ship = new Ship(state.storage, localEnv, state.id.toString());
        ships.set(shipId, ship);
      }
      return ships.get(shipId)! as T;
    },
  },
};



function jsonResponse(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

function serializeSystemSnapshot(snapshot: SystemSnapshot): Omit<SystemSnapshot, "markets"> & { markets: Record<GoodId, MarketState> } {
  return {
    ...snapshot,
    markets: Object.fromEntries(snapshot.markets.entries()) as Record<GoodId, MarketState>,
  };
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



/**
 * Get system coordinates from snapshot
 */
async function getSystemCoords(systemId: SystemId): Promise<{ x: number; y: number } | null> {
  try {
    const system = localEnv.STAR_SYSTEM.get<StarSystem>(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
    const snapshot = await system.getSnapshot();
    if (!snapshot.state) return null;
    return { x: snapshot.state.x ?? 0, y: snapshot.state.y ?? 0 };
  } catch {
    return null;
  }
}

function determineWorldType(techLevel: TechLevel, roll: number): WorldType {
  if (techLevel === TechLevel.AGRICULTURAL) return WorldType.AGRICULTURAL;
  if (techLevel === TechLevel.MEDIEVAL) return roll < 0.5 ? WorldType.AGRICULTURAL : WorldType.MINING;
  if (techLevel === TechLevel.RENAISSANCE) {
    if (roll < 0.3) return WorldType.AGRICULTURAL;
    if (roll < 0.6) return WorldType.MINING;
    if (roll < 0.8) return WorldType.TRADE_HUB;
    return WorldType.RESORT;
  }
  if (techLevel === TechLevel.EARLY_INDUSTRIAL || techLevel === TechLevel.INDUSTRIAL) {
    if (roll < 0.4) return WorldType.INDUSTRIAL;
    if (roll < 0.6) return WorldType.MINING;
    if (roll < 0.8) return WorldType.TRADE_HUB;
    return WorldType.RESORT;
  }
  if (roll < 0.3) return WorldType.HIGH_TECH;
  if (roll < 0.5) return WorldType.INDUSTRIAL;
  if (roll < 0.7) return WorldType.TRADE_HUB;
  return WorldType.RESORT;
}


async function validateAndAdjustGalaxy(_rng: DeterministicRNG): Promise<SystemId[]> {
  const validSystems: SystemId[] = [];
  for (let i = 0; i < GALAXY_SIZE; i++) {
    const systemId = i as SystemId;
    const coords = await getSystemCoords(systemId);
    if (coords) validSystems.push(systemId);
  }
  return validSystems.sort((a, b) => a - b);
}

async function handleGalaxyInitialize(
  body: { seed?: string },
  corsHeaders: Record<string, string>
): Promise<Response> {
  // Disable auto-tick during initialization to prevent interference
  interface GlobalWithAutoTick {
    getAutoTickStatus?: () => { enabled: boolean; interval: number };
    stopAutoTick?: () => void;
    startAutoTick?: () => void;
  }
  const globalWithAutoTick = global as unknown as GlobalWithAutoTick;
  const wasAutoTickEnabled = globalWithAutoTick.getAutoTickStatus?.()?.enabled || false;
  if (wasAutoTickEnabled) {
    globalWithAutoTick.stopAutoTick?.();
    console.log(`[Galaxy Initialize] Auto-tick temporarily disabled during initialization`);
  }
  
  // Reset in-memory telemetry/logging for a clean reinitialize
  // Removed all cleanup functions - simplified
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
    const system = localEnv.STAR_SYSTEM.get<StarSystem>(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));

    const systemRng = rng.derive(`system-${systemId}`);
    const name = SYSTEM_NAMES[systemId % SYSTEM_NAMES.length] || `System ${systemId}`;
    const population = systemRng.randomFloat(0.1, 100);
    const techLevel = systemRng.randomInt(1, 7) as TechLevel;
    const seed = systemRng.derive(`seed`).random().toString();
    
    const worldType = determineWorldType(techLevel, systemRng.derive(`worldType`).randomFloat(0, 1));
    
    const coordRng = systemRng.derive(`coords`);
    const x = coordRng.randomFloat(-64, 64);
    const y = coordRng.randomFloat(-64, 64);

    await system.initialize({ id: systemId, name, population, techLevel, worldType, seed, x, y });

    initialized.push(systemId);
  }
  
  const validSystems = await validateAndAdjustGalaxy(rng);
  
  for (let i = 0; i < GALAXY_SIZE; i++) {
    const systemId = i as SystemId;
    if (!validSystems.includes(systemId)) systems.delete(systemId);
  }

  // Create initial NPC traders
  const totalNPCs = TOTAL_NPCS;
  const npcRng = rng.derive("npc-generation");

  for (let i = 0; i < totalNPCs; i++) {
    const shipId = `npc-${i}` as ShipId;
    const ship = localEnv.SHIP.get<Ship>(localEnv.SHIP.idFromName(shipId));

    const shipRng = npcRng.derive(`ship-${i}`);
    // Use valid systems only for NPC placement
    const homeSystemIndex = shipRng.randomInt(0, validSystems.length - 1);
    const homeSystem = validSystems[homeSystemIndex];

    await new LocalStorage(shipId).delete("state");

    await ship.initialize({
      id: shipId,
      name: `Trader ${i}`,
      systemId: homeSystem,
      seed: shipRng.random().toString(),
      isNPC: true,
    });

    // Register ship with its home system (so system knows NPCs are present)
    const system = localEnv.STAR_SYSTEM.get<StarSystem>(localEnv.STAR_SYSTEM.idFromName(`system-${homeSystem}`));
    await system.shipArrival({
      timestamp: Date.now(),
      shipId: shipId,
      fromSystem: homeSystem,
      toSystem: homeSystem,
      cargo: new Map(),
      priceInfo: new Map(),
    });
    
  }

  console.log(`✅ [Galaxy Initialize] Galaxy initialization complete: ${validSystems.length} systems, ${totalNPCs} NPCs`);
  
  // Re-enable auto-tick if it was enabled before initialization
  if (wasAutoTickEnabled) {
    globalWithAutoTick.startAutoTick?.();
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
  const newTickId = `traveling-tick-${Date.now()}`;
  for (let i = 0; i < TOTAL_NPCS; i++) {
    const shipId = `npc-${i}` as ShipId;
    if (queuedTravelingShipIds.has(shipId) || travelingShipQueue.some(q => q.shipId === shipId)) continue;
    try {
      const ship = localEnv.SHIP.get<Ship>(localEnv.SHIP.idFromName(shipId));
      const state = await ship.getState();
      if (!state || !TRAVELING_PHASES.has(state.phase)) continue;
      travelingShipQueue.push({ shipId, tickId: newTickId });
      queuedTravelingShipIds.add(shipId);
    } catch {}
  }
  if (!isProcessingTravelingQueue && travelingShipQueue.length > 0) {
    processTravelingShipQueue(Date.now()).catch(console.error);
  }
}

async function processTravelingShipQueue(_tickStartTime: number): Promise<void> {
  if (isProcessingTravelingQueue) return;
  isProcessingTravelingQueue = true;
  try {
    while (travelingShipQueue.length > 0) {
      const queuedShip = travelingShipQueue.shift();
      if (!queuedShip) break;
      queuedTravelingShipIds.delete(queuedShip.shipId);
      try {
        const ship = localEnv.SHIP.get<Ship>(localEnv.SHIP.idFromName(queuedShip.shipId));
        const state = await ship.getState();
        if (!state || !TRAVELING_PHASES.has(state.phase)) continue;
        await ship.tick();
      } catch (error) {
        console.error(`Error ticking traveling ship ${queuedShip.shipId}:`, error);
      }
      if (travelingShipQueue.length % 10 === 0) await yieldToEventLoop();
    }
  } finally {
    isProcessingTravelingQueue = false;
  }
  if (travelingShipQueue.length > 0) {
    setImmediate(() => processTravelingShipQueue(_tickStartTime).catch(console.error));
  }
}

async function runGalaxyTick(status: GalaxyTickStatus): Promise<void> {
  const tickStartTime = status.startedAt;
  const ticked: SystemId[] = [];

  try {
    const systemsStartTime = Date.now();
    isSystemTickInProgress = true;
    try {
      for (let i = 0; i < GALAXY_SIZE; i++) {
        if (i % 10 === 0) await yieldToEventLoop();
        const systemId = i as SystemId;
        await localEnv.STAR_SYSTEM.get<StarSystem>(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`)).tick();
        ticked.push(systemId);
      }
    } finally {
      isSystemTickInProgress = false;
    }
    const systemsDuration = Date.now() - systemsStartTime;
    console.log(`[System Tick] Ticked ${ticked.length} systems in ${systemsDuration}ms`);

    const totalNPCs = TOTAL_NPCS;
    currentTickId = status.tickId;
    shipsProcessedLastTick = 0;
    for (let i = 0; i < totalNPCs; i++) {
      if (i % 100 === 0) await yieldToEventLoop();
      const shipId = `npc-${i}` as ShipId;
      if (queuedStationShipIds.has(shipId) || stationShipQueue.some(q => q.shipId === shipId)) continue;
      try {
        const ship = localEnv.SHIP.get<Ship>(localEnv.SHIP.idFromName(shipId));
        const state = await ship.getState();
        if (state?.phase === "at_station") {
          stationShipQueue.push({ shipId, tickId: status.tickId });
          queuedStationShipIds.add(shipId);
        }
      } catch {}
    }
    if (!isProcessingStationQueue) {
      processStationShipQueue(tickStartTime, Date.now() - systemsStartTime).catch(console.error);
    }
    status.systemsTicked = ticked.length;
    status.totalNPCs = totalNPCs;
  } catch (error) {
    console.error("[Galaxy Tick] Error:", error);
    status.message = "Tick failed - see server logs";
  } finally {
    status.completedAt = Date.now();
    isGalaxyTickInProgress = false;
  }
}

async function handleGalaxyTick(corsHeaders: Record<string, string>): Promise<Response> {
  if (isGalaxyTickInProgress) {
    return jsonResponse(
      {
        success: true,
        queued: false,
        inProgress: true,
        status: lastGalaxyTickStatus,
        message: "Tick already in progress",
      },
      202,
      corsHeaders
    );
  }

  const tickId = `tick-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const status: GalaxyTickStatus = {
    tickId,
    startedAt: Date.now(),
    message: "Tick queued for background processing",
  };
  lastGalaxyTickStatus = status;
  isGalaxyTickInProgress = true;

  setImmediate(() => {
    runGalaxyTick(status).catch((error) => {
      console.error("[Galaxy Tick] Unhandled error:", error);
    });
  });

  return jsonResponse(
    {
      success: true,
      queued: true,
      inProgress: true,
      tickId,
      status,
    },
    202,
    corsHeaders
  );
}

async function handleResetZeroInventoryMonitoring(corsHeaders: Record<string, string>): Promise<Response> {
  resetZeroInventoryMonitoring();
  for (let i = 0; i < GALAXY_SIZE; i++) {
    try {
      const system = localEnv.STAR_SYSTEM.get<StarSystem>(localEnv.STAR_SYSTEM.idFromName(`system-${i as SystemId}`));
      await system.resetMarkets();
    } catch {}
  }
  return jsonResponse({ success: true, message: "Reset complete" }, 200, corsHeaders);
}
async function processStationShipQueue(_tickStartTime: number, _systemsDuration: number): Promise<void> {
  if (isProcessingStationQueue) return;
  isProcessingStationQueue = true;
  try {
    while (stationShipQueue.length > 0) {
      if (isSystemTickInProgress || isProcessingTravelingQueue) {
        await new Promise(resolve => setImmediate(resolve));
        continue;
      }
      const queuedShip = stationShipQueue.shift();
      if (!queuedShip || (queuedShip.tickId !== currentTickId && currentTickId !== null)) continue;
      queuedStationShipIds.delete(queuedShip.shipId);
      try {
        const ship = localEnv.SHIP.get<Ship>(localEnv.SHIP.idFromName(queuedShip.shipId));
        await ship.tick();
        shipsProcessedLastTick++;
      } catch (error) {
        console.error(`Error ticking ship ${queuedShip.shipId}:`, error);
      }
      if (stationShipQueue.length % 10 === 0) await yieldToEventLoop();
    }
  } finally {
    isProcessingStationQueue = false;
  }
  if (stationShipQueue.length > 0 && currentTickId) {
    setImmediate(() => processStationShipQueue(_tickStartTime, _systemsDuration).catch(console.error));
  }
}




async function serveStaticFile(filename: string): Promise<Response> {
  const html = await fs.promises.readFile(
    pathModule.join(process.cwd(), "public", filename),
    "utf-8"
  ).catch(() => null);
  return html ? new Response(html, { headers: { "Content-Type": "text/html" } }) : new Response(`${filename} not found`, { status: 404, headers: { "Content-Type": "text/plain" } });
}

async function serveDevInterface(): Promise<Response> {
  let devHtml = await fs.promises.readFile(pathModule.join(process.cwd(), "public", "dev.html"), "utf-8").catch(() => null);
  if (!devHtml) return new Response("Dev interface not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  const galaxyDocs = getCategoryDocsHtml("Galaxy Operations");
  const systemDocs = getCategoryDocsHtml("System Operations");
  const shipDocs = getCategoryDocsHtml("Ship Operations");
  devHtml = devHtml.replace('<div id="galaxyDocs" style="display: none;"></div>', `<div id="galaxyDocs" style="display: none;">${galaxyDocs}</div>`);
  devHtml = devHtml.replace('<div id="systemDocs" style="display: none;"></div>', `<div id="systemDocs" style="display: none;">${systemDocs}</div>`);
  devHtml = devHtml.replace('<div id="shipDocs" style="display: none;"></div>', `<div id="shipDocs" style="display: none;">${shipDocs}</div>`);
  devHtml = devHtml.replace('<p id="serverInfo" style="color: #6bcf7f; margin-bottom: 20px;">Running on Local Node.js Server</p>', `<p id="serverInfo" style="color: #6bcf7f; margin-bottom: 20px;">Running on Local Node.js Server (Port ${PORT})</p>`);
  return new Response(devHtml, { headers: { "Content-Type": "text/html" } });
}
async function flushAllState(): Promise<void> {
  const systemsToFlush: SystemFlushEntry[] = [];
  const shipsToFlush: ShipFlushEntry[] = [];
  for (const [systemId, system] of systems.entries()) {
    const systemWithState = system as unknown as StarSystemWithState;
    if ((systemWithState as { dirty?: boolean }).dirty && (systemWithState as { systemState?: SystemState | null }).systemState) {
      const state = (systemWithState as { state?: DurableObjectState & { storage?: { getPendingSystemData(): SystemFlushData | null; clearPendingData(): void } } }).state;
      if (state?.storage) {
        await system.flushState();
        const pendingData = state.storage.getPendingSystemData();
        if (pendingData) systemsToFlush.push({ objectId: `system-${systemId}`, data: pendingData });
      }
    }
  }
  for (const [shipId, ship] of ships.entries()) {
    const shipWithState = ship as unknown as ShipWithState;
    if ((shipWithState as { dirty?: boolean }).dirty && (shipWithState as { shipState?: ShipState | null }).shipState) {
      const state = (shipWithState as { state?: DurableObjectState & { storage?: { getPendingShipData(): ShipState | null; clearPendingData(): void } } }).state;
      if (state?.storage) {
        await ship.flushState();
        const pendingData = state.storage.getPendingShipData();
        if (pendingData) shipsToFlush.push({ objectId: shipId, data: pendingData });
      }
    }
  }
  if (systemsToFlush.length > 0) {
    const { LocalStorage } = await import("./local-storage");
    await LocalStorage.flushAllSystems(systemsToFlush);
    for (const system of systems.values()) {
      const state = (system as unknown as { state?: DurableObjectState & { storage?: { clearPendingData(): void } } }).state;
      state?.storage?.clearPendingData();
    }
  }
  if (shipsToFlush.length > 0) {
    const { LocalStorage } = await import("./local-storage");
    await LocalStorage.flushAllShips(shipsToFlush);
    for (const ship of ships.values()) {
      const state = (ship as unknown as { state?: DurableObjectState & { storage?: { clearPendingData(): void } } }).state;
      state?.storage?.clearPendingData();
    }
  }
  console.log(`✅ Flushed ${systemsToFlush.length} systems and ${shipsToFlush.length} ships`);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  req.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.writeHead(408, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request timeout" }));
    }
  });

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(200, corsHeaders);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method || "GET";

    let body: unknown = null;
    if (method === "POST" || method === "PUT") {
      const chunks: Buffer[] = [];
      const bodyReadPromise = (async () => { for await (const chunk of req) chunks.push(chunk); })();
      const timeoutPromise = new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Request body read timeout")), 5000));
      try {
        await Promise.race([bodyReadPromise, timeoutPromise]);
        const bodyStr = Buffer.concat(chunks).toString();
        if (bodyStr) {
          try { body = JSON.parse(bodyStr); } catch { body = bodyStr; }
        }
      } catch (error) {
        console.warn(`[Server] Request body read failed for ${path}:`, error instanceof Error ? error.message : String(error));
      }
    }

    let response: Response;
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
    } else if ((path === "/api/galaxy/ships" && method === "GET") || (path.startsWith("/api/system/") && path.endsWith("/monitor") && method === "GET")) {
      response = jsonResponse({ error: "Endpoint removed in simplification" }, 404, corsHeaders);
    } else if (path.startsWith("/api/system/")) {
      const systemId = extractSystemId(path);
      if (systemId === null) {
        response = jsonResponse({ error: "Invalid system ID", path }, 400, corsHeaders);
      } else {
        const system = localEnv.STAR_SYSTEM.get<StarSystem>(localEnv.STAR_SYSTEM.idFromName(`system-${systemId}`));
        const action = url.searchParams.get("action") || "snapshot";
        if (action === "snapshot") {
          const snapshot = await system.getSnapshot();
          response = jsonResponse(serializeSystemSnapshot(snapshot), 200, corsHeaders);
        } else {
          response = jsonResponse({ error: "Invalid action. Only 'snapshot' is supported." }, 400, corsHeaders);
        }
      }
    } else if (path === "/api/galaxy/reset" && method === "POST") {
      resetDatabase();
      response = jsonResponse({ message: "Database reset complete" }, 200, corsHeaders);
    } else if (path === "/api/galaxy/initialize" && method === "POST") {
      response = await handleGalaxyInitialize(body || {}, corsHeaders);
    } else if (path === "/api/galaxy/tick" && method === "POST") {
      response = await handleGalaxyTick(corsHeaders);
    } else if (path === "/api/galaxy/reset-zero-inventory-monitoring" && method === "POST") {
      response = await handleResetZeroInventoryMonitoring(corsHeaders);
    } else if ((path === "/api/galaxy/map" || path === "/api/galaxy/requests" || path === "/api/galaxy/markets") && method === "GET") {
      response = jsonResponse({ error: "Endpoint removed in simplification" }, 404, corsHeaders);
    } else if (path === "/api/player") {
      if (method === "GET") {
        const name = normalizePlayerName(url.searchParams.get("name") || "");
        if (!name) {
          response = jsonResponse({ error: "Missing player name" }, 400, corsHeaders);
        } else {
          const player = getPlayerByName(name);
          response = player ? jsonResponse({ player }, 200, corsHeaders) : jsonResponse({ error: "Player not found" }, 404, corsHeaders);
        }
      } else if (method === "POST") {
        const name = normalizePlayerName(String((body as { name?: string } | null)?.name || ""));
        if (!name) {
          response = jsonResponse({ error: "Missing player name" }, 400, corsHeaders);
        } else {
          const existing = getPlayerByName(name);
          const player = upsertPlayer(name, existing?.shipId || makePlayerShipId(name), Date.now());
          response = jsonResponse({ player, created: !existing }, 200, corsHeaders);
        }
      } else {
        response = jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
      }
    } else if (path.includes("/delivery") || path.includes("/delivery-board")) {
      response = jsonResponse({ error: "Endpoint removed in simplification" }, 404, corsHeaders);
    } else if (path.startsWith("/api/ship/")) {
      const shipId = extractShipId(path);
      if (!shipId) {
        response = jsonResponse({ error: "Invalid ship ID", path }, 400, corsHeaders);
      } else {
        const ship = localEnv.SHIP.get<Ship>(localEnv.SHIP.idFromName(shipId as ShipId));
        if (path.endsWith("/trade") && method === "POST") {
          const tradeBody = body as { goodId?: GoodId; quantity?: number; type?: "buy" | "sell" } | null;
          if (!tradeBody?.goodId || !tradeBody.quantity || !tradeBody.type) {
            response = jsonResponse({ success: false, error: "Invalid trade parameters" }, 400, corsHeaders);
          } else {
            const tradeResult = await ship.trade({ goodId: tradeBody.goodId, quantity: tradeBody.quantity, type: tradeBody.type });
            response = jsonResponse(tradeResult, tradeResult.success ? 200 : 400, corsHeaders);
          }
        } else if (path.endsWith("/travel") && method === "POST") {
          const travelBody = body as { destinationSystem?: SystemId } | null;
          if (typeof travelBody?.destinationSystem !== "number") {
            response = jsonResponse({ success: false, error: "Invalid travel parameters" }, 400, corsHeaders);
          } else {
            const travelResult = await ship.travel({ destinationSystem: travelBody.destinationSystem });
            response = jsonResponse(travelResult, travelResult.success ? 200 : 400, corsHeaders);
          }
        } else if (path.endsWith("/initialize") && method === "POST") {
          const initBody = body as { id?: ShipId; name?: string; systemId?: SystemId; seed?: string; isNPC?: boolean } | null;
          if (!initBody?.id || !initBody.name || typeof initBody.systemId !== "number" || !initBody.seed) {
            response = jsonResponse({ success: false, error: "Invalid initialization parameters" }, 400, corsHeaders);
          } else {
            await ship.initialize({ id: initBody.id, name: initBody.name, systemId: initBody.systemId, seed: initBody.seed, isNPC: initBody.isNPC ?? false });
            response = jsonResponse({ success: true }, 200, corsHeaders);
          }
        } else if (path.match(/\/(node-map|scan|radio|travel\/node|travel\/sector|encounter|encounter\/choice|microgame\/start|microgame\/complete|microgame\/input|armaments)$/)) {
          response = jsonResponse({ error: "Endpoint removed in simplification" }, 404, corsHeaders);
        } else if (path.endsWith("/skill") && method === "GET") {
          response = jsonResponse({ success: true, skill: 0, experience: 0 }, 200, corsHeaders);
        } else {
          const action = (body as { action?: string } | null)?.action || url.searchParams.get("action");
          if (method === "GET") {
            const state = await ship.getState();
            response = state ? jsonResponse(state, 200, corsHeaders) : jsonResponse({ error: "Ship not initialized" }, 400, corsHeaders);
          } else if (method === "POST" && action === "tick") {
            const tickResult = await ship.tick();
            response = jsonResponse(tickResult.skipped ? { error: "Ship not initialized" } : { success: true }, tickResult.skipped ? 400 : 200, corsHeaders);
          } else if (method === "POST" && ((body as { id?: string } | null)?.id || action === "initialize")) {
            const initBody = body as { id?: ShipId; name?: string; systemId?: SystemId; seed?: string; isNPC?: boolean } | null;
            if (!initBody?.id || !initBody.name || typeof initBody.systemId !== "number" || !initBody.seed) {
              response = jsonResponse({ error: "Invalid initialization parameters" }, 400, corsHeaders);
            } else {
              await ship.initialize({ id: initBody.id, name: initBody.name, systemId: initBody.systemId, seed: initBody.seed, isNPC: initBody.isNPC ?? false });
              response = jsonResponse({ success: true }, 200, corsHeaders);
            }
          } else {
            response = jsonResponse({ error: "Invalid request" }, 400, corsHeaders);
          }
        }
      }
    } else if (path === "/api/health" && method === "GET") {
      response = jsonResponse({ status: "ok" }, 200, corsHeaders);
    } else if (path === "/api/player-logs" || path === "/api/navigation-config" || path === "/api/logging") {
      response = jsonResponse({ error: "Endpoint removed in simplification" }, 404, corsHeaders);
    } else if (path === "/api/trade-logging" || path === "/api/logging-config" || path === "/api/profiler" || path === "/api/ship-registry") {
      response = jsonResponse({ error: "Endpoint removed in simplification" }, 404, corsHeaders);
    } else if (path === "/api/auto-tick") {
      interface GlobalWithAutoTick {
        getAutoTickStatus?: () => { enabled: boolean; interval: number };
        startAutoTick?: () => void;
        stopAutoTick?: () => void;
      }
      const globalWithAutoTick = global as unknown as GlobalWithAutoTick;
      if (method === "GET") {
        response = jsonResponse(globalWithAutoTick.getAutoTickStatus?.() || { enabled: false, interval: TICK_INTERVAL_MS }, 200, corsHeaders);
      } else if (method === "POST") {
        const enabled = (body as { enabled?: boolean } | null)?.enabled;
        if (typeof enabled === "boolean") {
          enabled ? globalWithAutoTick.startAutoTick?.() : globalWithAutoTick.stopAutoTick?.();
          response = jsonResponse({ success: true, ...globalWithAutoTick.getAutoTickStatus?.() }, 200, corsHeaders);
        } else {
          response = jsonResponse({ error: "Invalid request. Expected { enabled: boolean }" }, 400, corsHeaders);
        }
      } else {
        response = jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
      }
    } else if (path === "/api/trade-logs") {
      response = jsonResponse({ error: "Endpoint removed in simplification" }, 404, corsHeaders);
    } else if (path === "/api/flush" && method === "POST") {
      await flushAllState();
      response = jsonResponse({ success: true, message: "State flushed to database" }, 200, corsHeaders);
    } else if (path.startsWith("/api/monitoring/") || path === "/api/galaxy-health" || path === "/api/galaxy/check-and-log") {
      response = jsonResponse({ error: "Endpoint removed in simplification" }, 404, corsHeaders);
    } else if (path.startsWith("/api/leaderboard")) {
      response = jsonResponse({ error: "Endpoint removed in simplification" }, 404, corsHeaders);
    } else if (path === "/" || path === "/player" || path === "/player.html") {
      response = await serveStaticFile("player.html");
    } else if (path === "/dev" || path === "/dev.html") {
      response = await serveDevInterface();
    } else if (path === "/markets" || path === "/markets.html") {
      response = await serveStaticFile("markets.html");
    } else if (path === "/viewport-test" || path === "/viewport-test.html") {
      response = await serveStaticFile("viewport-test.html");
    } else {
      response = jsonResponse({ error: "Not found" }, 404, corsHeaders);
    }

    const responseBody = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    res.writeHead(response.status, { ...headers, ...corsHeaders });
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

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`);
  } else {
    console.error(`❌ Server error:`, error);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Space Trader Local Server running on http://0.0.0.0:${PORT}`);
  console.log(`   Galaxy Size: ${GALAXY_SIZE}`);
  console.log(`   Tick Interval: ${TICK_INTERVAL_MS}ms`);
  console.log(`   Total NPCs: ${TOTAL_NPCS}`);
  console.log(`   Storage: SQLite database at .local-storage/durable-objects.db`);
  console.log(`   Write Mode: In-memory with periodic flush (every hour)`);
  console.log(`\n   Try: curl http://localhost:${PORT}/api/health`);
  
  // Initialize galaxy asynchronously after server is listening
  (async () => {
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
      // Removed setPopulationBaseline - simplified
    }


  })();

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
  interface GlobalWithAutoTick {
    startAutoTick?: () => void;
    stopAutoTick?: () => void;
    getAutoTickStatus?: () => { enabled: boolean; interval: number };
  }
  const globalWithAutoTick = global as unknown as GlobalWithAutoTick;
  globalWithAutoTick.startAutoTick = startAutoTick;
  globalWithAutoTick.stopAutoTick = stopAutoTick;
  globalWithAutoTick.getAutoTickStatus = getAutoTickStatus;
  
  if (AUTO_TICK) {
    startAutoTick();
  } else {
    console.log(`   Auto-tick disabled (set AUTO_TICK=false to disable)`);
  }

  setInterval(async () => await flushAllState(), 60 * 60 * 1000);
});

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
