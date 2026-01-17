/**
 * Data collection script for economy analysis
 * Runs simulation for 30 minutes and collects economic data
 */

import http from "http";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const TEST_MODE = process.env.TEST_MODE === "true" || process.argv.includes("--test");
const DEFAULT_DURATION_MINUTES = TEST_MODE ? 5 : 30;
const DEFAULT_COLLECTION_INTERVAL_SECONDS = TEST_MODE ? 10 : 30; // Collect data every 10s in test mode, 30s in production
const TICK_WAIT_TIMEOUT_MS = 45000;
const TICK_POLL_INTERVAL_MS = 1000;

function readNumberEnv(name: string): number | null {
  if (!process.env[name]) return null;
  const parsed = parseInt(process.env[name] as string, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function readNumberArg(flag: string): number | null {
  const argWithValue = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (argWithValue) {
    const parsed = parseInt(argWithValue.split("=").slice(1).join("="), 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const flagIndex = process.argv.indexOf(flag);
  if (flagIndex === -1 || flagIndex + 1 >= process.argv.length) return null;
  const parsed = parseInt(process.argv[flagIndex + 1], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

const DURATION_MINUTES = readNumberArg("--duration")
  ?? readNumberEnv("DURATION_MINUTES")
  ?? DEFAULT_DURATION_MINUTES;
const COLLECTION_INTERVAL_SECONDS = readNumberArg("--interval")
  ?? readNumberEnv("COLLECTION_INTERVAL_SECONDS")
  ?? DEFAULT_COLLECTION_INTERVAL_SECONDS;

interface CollectedData {
  timestamp: number;
  systems: SystemData[];
  ships: ShipData[];
  trades: TradeEvent[];
  metrics: EconomyMetrics;
}

interface SystemData {
  id: number;
  name: string;
  population: number;
  techLevel: number;
  worldType: string;
  currentTick: number;
  markets: MarketData[];
}

interface MarketData {
  goodId: string;
  price: number;
  inventory: number;
  production: number;
  consumption: number;
  basePrice: number;
}

interface ShipData {
  id: string;
  name: string;
  isNPC: boolean;
  currentSystem: number | null;
  phase: string;
  credits: number;
  cargo: Record<string, number>;
}

interface TradeEvent {
  timestamp: number;
  shipId: string;
  systemId: number;
  goodId: string;
  quantity: number;
  price: number;
  type: "buy" | "sell";
}

interface EconomyMetrics {
  totalCredits: number;
  totalCargo: number;
  activeTraders: number;
  travelingShips: number;
  atStationShips: number;
  averagePrice: Record<string, number>;
  totalInventory: Record<string, number>;
}

const collectedData: CollectedData[] = [];

async function httpRequest(path: string, method: string = "GET", body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_URL);
    const options = {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
    };

    const req = http.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function resetGalaxy(): Promise<void> {
  console.log("Resetting galaxy (clearing all data)...");
  try {
    await httpRequest("/api/galaxy/reset", "POST");
    console.log("Galaxy reset complete");
  } catch (error) {
    console.error("Error resetting galaxy:", error);
    throw error;
  }
}

async function initializeGalaxy(): Promise<void> {
  console.log("Initializing galaxy...");
  const result = await httpRequest("/api/galaxy/initialize", "POST", { seed: `economy-analysis-${Date.now()}` });
  console.log("Galaxy initialized:", result);
}

async function getSystemSnapshot(systemId: number): Promise<SystemData | null> {
  try {
    const snapshot = await httpRequest(`/api/system/${systemId}?action=snapshot`);
    if (!snapshot || snapshot.error) {
      return null;
    }

    const markets: MarketData[] = [];
    if (snapshot.markets) {
      for (const [goodId, market] of Object.entries(snapshot.markets)) {
        markets.push({
          goodId,
          price: (market as any).price || 0,
          inventory: (market as any).inventory || 0,
          production: (market as any).production || 0,
          consumption: (market as any).consumption || 0,
          basePrice: (market as any).basePrice || 0,
        });
      }
    }

    return {
      id: snapshot.state?.id || systemId,
      name: snapshot.state?.name || `System ${systemId}`,
      population: snapshot.state?.population || 0,
      techLevel: snapshot.state?.techLevel || 0,
      worldType: snapshot.state?.worldType || "",
      currentTick: snapshot.state?.currentTick || 0,
      markets,
    };
  } catch (error) {
    console.error(`Error getting snapshot for system ${systemId}:`, error);
    return null;
  }
}

async function getSystemTick(systemId: number): Promise<number | null> {
  try {
    const snapshot = await httpRequest(`/api/system/${systemId}?action=snapshot`);
    if (!snapshot || snapshot.error) {
      return null;
    }
    return typeof snapshot.state?.currentTick === "number" ? snapshot.state.currentTick : null;
  } catch (error) {
    return null;
  }
}

async function waitForSystemTick(systemId: number, startingTick: number): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < TICK_WAIT_TIMEOUT_MS) {
    const currentTick = await getSystemTick(systemId);
    if (currentTick !== null && currentTick > startingTick) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_POLL_INTERVAL_MS));
  }
  return false;
}

async function getAllSystems(): Promise<SystemData[]> {
  const systems: SystemData[] = [];
  const GALAXY_SIZE = 20;

  for (let i = 0; i < GALAXY_SIZE; i++) {
    const system = await getSystemSnapshot(i);
    if (system) {
      systems.push(system);
    }
    // Small delay to avoid overwhelming the server
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return systems;
}

async function getShipState(shipId: string): Promise<ShipData | null> {
  try {
    const state = await httpRequest(`/api/ship/${shipId}`);
    if (!state || state.error) {
      return null;
    }

    const cargo: Record<string, number> = {};
    if (state.cargo) {
      for (const [goodId, quantity] of Object.entries(state.cargo)) {
        cargo[goodId] = quantity as number;
      }
    }

    return {
      id: state.id || shipId,
      name: state.name || shipId,
      isNPC: state.isNPC !== false,
      currentSystem: state.currentSystem ?? null,
      phase: state.phase || "unknown",
      credits: state.credits || 0,
      cargo,
    };
  } catch (error) {
    return null;
  }
}

async function getAllShips(systems: SystemData[]): Promise<ShipData[]> {
  // Collect all unique ship IDs from systems
  const shipIds = new Set<string>();
  
  for (const system of systems) {
    // Get ships in this system from snapshot
    try {
      const snapshot = await httpRequest(`/api/system/${system.id}?action=snapshot`);
      if (snapshot.shipsInSystem && Array.isArray(snapshot.shipsInSystem)) {
        for (const shipId of snapshot.shipsInSystem) {
          shipIds.add(shipId);
        }
      }
    } catch (error) {
      // Ignore errors for individual systems
    }
  }

  // Also try common NPC IDs (npc-0 to npc-99) to catch traveling ships
  const TOTAL_NPCS = 100;
  for (let i = 0; i < TOTAL_NPCS; i++) {
    shipIds.add(`npc-${i}`);
  }

  // Fetch all ship states
  const ships: ShipData[] = [];
  for (const shipId of shipIds) {
    const ship = await getShipState(shipId);
    if (ship) {
      ships.push(ship);
    }
    // Small delay to avoid overwhelming server
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return ships;
}

function calculateMetrics(systems: SystemData[], ships: ShipData[]): EconomyMetrics {
  let totalCredits = 0;
  let totalCargo = 0;
  let activeTraders = 0;
  let travelingShips = 0;
  let atStationShips = 0;

  const priceSum: Record<string, number> = {};
  const priceCount: Record<string, number> = {};
  const inventorySum: Record<string, number> = {};

  for (const ship of ships) {
    totalCredits += ship.credits;
    for (const quantity of Object.values(ship.cargo)) {
      totalCargo += quantity;
    }
    if (ship.phase === "traveling") {
      travelingShips++;
    } else if (ship.phase === "at_station") {
      atStationShips++;
      activeTraders++;
    }
  }

  for (const system of systems) {
    for (const market of system.markets) {
      if (!priceSum[market.goodId]) {
        priceSum[market.goodId] = 0;
        priceCount[market.goodId] = 0;
        inventorySum[market.goodId] = 0;
      }
      priceSum[market.goodId] += market.price;
      priceCount[market.goodId]++;
      inventorySum[market.goodId] += market.inventory;
    }
  }

  const averagePrice: Record<string, number> = {};
  for (const goodId of Object.keys(priceSum)) {
    averagePrice[goodId] = priceCount[goodId] > 0 ? priceSum[goodId] / priceCount[goodId] : 0;
  }

  return {
    totalCredits,
    totalCargo,
    activeTraders,
    travelingShips,
    atStationShips,
    averagePrice,
    totalInventory: inventorySum,
  };
}

async function triggerGalaxyTick(): Promise<void> {
  try {
    await httpRequest("/api/galaxy/tick", "POST");
  } catch (error) {
    console.error("Error triggering galaxy tick:", error);
  }
}

async function collectDataPoint(): Promise<void> {
  const timestamp = Date.now();
  console.log(`[${new Date(timestamp).toISOString()}] Collecting data point...`);

  // Trigger a tick to advance simulation, then wait until it is observed in a snapshot.
  const tickSystemId = 0;
  const startingTick = await getSystemTick(tickSystemId);
  await triggerGalaxyTick();
  if (startingTick !== null) {
    const tickObserved = await waitForSystemTick(tickSystemId, startingTick);
    if (!tickObserved) {
      console.warn(`  Warning: tick not observed for system ${tickSystemId} within ${TICK_WAIT_TIMEOUT_MS / 1000}s`);
    }
  }

  // Collect system data
  const systems = await getAllSystems();
  console.log(`  Collected ${systems.length} systems`);

  // Collect ship data (using systems to find ship IDs)
  const ships = await getAllShips(systems);
  console.log(`  Collected ${ships.length} ships`);

  // Calculate metrics
  const metrics = calculateMetrics(systems, ships);

  // Store data point
  collectedData.push({
    timestamp,
    systems,
    ships,
    trades: [], // Trade events would need to be collected from logs or a different endpoint
    metrics,
  });

  console.log(`  Metrics: ${metrics.activeTraders} active traders, ${metrics.travelingShips} traveling, ${metrics.totalCredits.toFixed(0)} total credits`);
}

async function saveData(): Promise<void> {
  const fs = await import("fs/promises");
  const path = await import("path");

  const outputDir = path.join(process.cwd(), "economy-data");
  await fs.mkdir(outputDir, { recursive: true });

  const filename = `economy-data-${Date.now()}.json`;
  const filepath = path.join(outputDir, filename);

  await fs.writeFile(filepath, JSON.stringify(collectedData, null, 2));
  console.log(`\nData saved to: ${filepath}`);
  console.log(`Total data points: ${collectedData.length}`);

  return filepath;
}

async function main(): Promise<void> {
  console.log("Starting economy data collection...");
  if (TEST_MODE) {
    console.log("🧪 TEST MODE: Running for 5 minutes");
  }
  console.log(`Duration: ${DURATION_MINUTES} minutes`);
  console.log(`Collection interval: ${COLLECTION_INTERVAL_SECONDS} seconds`);
  console.log(`Server: ${SERVER_URL}\n`);

  // Wait for server to be ready
  console.log("Waiting for server to be ready...");
  let serverReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      await httpRequest("/api/health");
      serverReady = true;
      break;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  if (!serverReady) {
    console.error("Server is not ready. Make sure it's running on", SERVER_URL);
    process.exit(1);
  }

  // Reset and initialize galaxy (fresh start)
  await resetGalaxy();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await initializeGalaxy();
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Collect data periodically
  const startTime = Date.now();
  const endTime = startTime + DURATION_MINUTES * 60 * 1000;
  const intervalMs = COLLECTION_INTERVAL_SECONDS * 1000;

  console.log("\nStarting data collection...\n");

  while (Date.now() < endTime) {
    await collectDataPoint();

    const remaining = Math.ceil((endTime - Date.now()) / 1000 / 60);
    console.log(`  Remaining: ~${remaining} minutes\n`);

    // Wait for next collection interval
    if (Date.now() < endTime) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  // Final data collection
  console.log("Collecting final data point...");
  await collectDataPoint();

  // Save data
  const filepath = await saveData();
  console.log(`\nData collection complete!`);
  console.log(`Output file: ${filepath}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
