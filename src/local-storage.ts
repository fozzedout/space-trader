/**
 * SQLite-based persistent storage adapter for local development
 * Uses D1 (SQLite) with proper normalized database schema
 * 
 * Creates proper tables for systems, ships, markets, cargo, etc.
 * Uses SQL queries instead of JSON blobs.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { SystemState, MarketState, ShipState, ShipId, GoodId, ShipPhase, TechLevel, WorldType } from "./types";

// SQLite query result types
interface PlayerRow {
  name: string;
  ship_id: string;
  created_at: number;
  last_seen: number;
}

interface SystemRow {
  id: number;
  name: string;
  population: number;
  tech_level: number;
  world_type: string;
  seed: string;
  last_tick_time: number;
  current_tick: number;
  x: number | null;
  y: number | null;
}

interface MarketRow {
  system_id: number;
  good_id: string;
  base_price: number;
  supply: number;
  demand: number;
  production: number;
  consumption: number;
  price: number;
  inventory: number;
}

interface ShipInSystemRow {
  ship_id: string;
}

interface PendingArrivalRow {
  system_id: number;
  ship_id: string;
  timestamp: number;
  from_system: number;
  to_system: number;
  cargo_json: string;
  price_info_json: string;
}

interface ShipRow {
  id: string;
  name: string;
  current_system: number | null;
  destination_system: number | null;
  phase: string;
  departure_start_time: number | null;
  hyperspace_start_time: number | null;
  arrival_start_time: number | null;
  arrival_complete_time: number | null;
  rest_start_time: number | null;
  rest_end_time?: number | null;
  sleep_start_time: number | null;
  credits: number;
  fuel_ly: number;
  fuel_capacity_ly?: number | null;
  cargo_json: string | null;
  purchase_prices_json: string | null;
  armaments_json: string | null;
  hull_max: number | null;
  hull_integrity: number | null;
  route_plan_json: string | null;
  is_npc?: number;
  seed?: string;
  position_x?: number | null;
  position_y?: number | null;
  arrival_start_x?: number | null;
  arrival_start_y?: number | null;
  origin_system?: number | null;
  origin_price_info?: string | null;
  chosen_destination_system_id?: number | null;
  expected_margin_at_choice_time?: number | null;
  route_plan_index?: number | null;
  route_plan_target_system_id?: number | null;
  route_plan_updated_at?: number | null;
}

interface CargoRow {
  good_id: string;
  quantity: number;
}

interface PurchasePriceRow {
  good_id: string;
  price: number;
}

interface SqliteError {
  code?: string;
  message?: string;
}

const STORAGE_DIR = path.join(process.cwd(), ".local-storage");
const DB_PATH = path.join(STORAGE_DIR, "durable-objects.db");

/**
 * Ensure storage directory exists (synchronous for better-sqlite3)
 */
function ensureStorageDir(): void {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist, that's fine
  }
}

/**
 * Get or create the SQLite database connection
 */
let dbInstance: Database.Database | null = null;

function getDatabase(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  ensureStorageDir();

  dbInstance = new Database(DB_PATH);
  
  // Optimize SQLite for bulk writes
  dbInstance.pragma("journal_mode = WAL"); // Write-Ahead Logging for better concurrency
  dbInstance.pragma("synchronous = NORMAL"); // Balance between safety and speed
  dbInstance.pragma("cache_size = -10000"); // 10MB cache
  dbInstance.pragma("temp_store = MEMORY"); // Store temp tables in memory
  dbInstance.pragma("mmap_size = 268435456"); // 256MB memory-mapped I/O
  
  // Create normalized tables
  dbInstance.exec(`
    -- Systems table
    CREATE TABLE IF NOT EXISTS systems (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      population REAL NOT NULL,
      tech_level INTEGER NOT NULL,
      world_type TEXT NOT NULL DEFAULT 'trade_hub',
      seed TEXT NOT NULL,
      last_tick_time INTEGER NOT NULL,
      current_tick INTEGER NOT NULL DEFAULT 0,
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0
    );

    -- Markets table (one row per system+good)
    CREATE TABLE IF NOT EXISTS markets (
      system_id INTEGER NOT NULL,
      good_id TEXT NOT NULL,
      base_price REAL NOT NULL,
      supply REAL NOT NULL,
      demand REAL NOT NULL,
      production REAL NOT NULL,
      consumption REAL NOT NULL,
      price REAL NOT NULL,
      inventory REAL NOT NULL,
      PRIMARY KEY (system_id, good_id),
      FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
    );

    -- Ships table
    CREATE TABLE IF NOT EXISTS ships (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      current_system INTEGER,
      destination_system INTEGER,
      phase TEXT NOT NULL,
      departure_start_time INTEGER,
      hyperspace_start_time INTEGER,
      arrival_start_time INTEGER,
      arrival_complete_time INTEGER,
      rest_start_time INTEGER,
      rest_end_time INTEGER,
      credits INTEGER NOT NULL,
      is_npc INTEGER NOT NULL DEFAULT 0,
      seed TEXT NOT NULL,
      fuel_ly REAL NOT NULL DEFAULT 15,
      fuel_capacity_ly REAL NOT NULL DEFAULT 15,
      hull_integrity INTEGER NOT NULL DEFAULT 100,
      hull_max INTEGER NOT NULL DEFAULT 100,
      armaments_json TEXT NOT NULL DEFAULT '{}',
      position_x REAL,
      position_y REAL,
      arrival_start_x REAL,
      arrival_start_y REAL,
      route_plan_json TEXT,
      route_plan_index INTEGER NOT NULL DEFAULT 0,
      route_plan_target_system_id INTEGER,
      route_plan_updated_at INTEGER
    );

    -- Ship cargo table (one row per ship+good)
    CREATE TABLE IF NOT EXISTS ship_cargo (
      ship_id TEXT NOT NULL,
      good_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      PRIMARY KEY (ship_id, good_id),
      FOREIGN KEY (ship_id) REFERENCES ships(id) ON DELETE CASCADE
    );

    -- Ship purchase prices table (one row per ship+good, stores purchase price per unit)
    CREATE TABLE IF NOT EXISTS ship_purchase_prices (
      ship_id TEXT NOT NULL,
      good_id TEXT NOT NULL,
      price REAL NOT NULL,
      PRIMARY KEY (ship_id, good_id),
      FOREIGN KEY (ship_id) REFERENCES ships(id) ON DELETE CASCADE
    );

    -- Ships in systems (many-to-many relationship)
    CREATE TABLE IF NOT EXISTS ships_in_systems (
      system_id INTEGER NOT NULL,
      ship_id TEXT NOT NULL,
      PRIMARY KEY (system_id, ship_id),
      FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE,
      FOREIGN KEY (ship_id) REFERENCES ships(id) ON DELETE CASCADE
    );

    -- Pending arrivals
    CREATE TABLE IF NOT EXISTS pending_arrivals (
      system_id INTEGER NOT NULL,
      ship_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      from_system INTEGER NOT NULL,
      to_system INTEGER NOT NULL,
      cargo_json TEXT NOT NULL,
      price_info_json TEXT NOT NULL,
      PRIMARY KEY (system_id, ship_id),
      FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE,
      FOREIGN KEY (ship_id) REFERENCES ships(id) ON DELETE CASCADE
    );

    -- Players table (name is unique key)
    CREATE TABLE IF NOT EXISTS players (
      name TEXT PRIMARY KEY,
      ship_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_players_ship_id ON players(ship_id);

    -- Generic key-value storage for any other keys
    CREATE TABLE IF NOT EXISTS durable_object_storage (
      object_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (object_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_object_id ON durable_object_storage(object_id);

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_markets_system ON markets(system_id);
    CREATE INDEX IF NOT EXISTS idx_ship_cargo_ship ON ship_cargo(ship_id);
    CREATE INDEX IF NOT EXISTS idx_ships_in_systems_system ON ships_in_systems(system_id);
    CREATE INDEX IF NOT EXISTS idx_ships_in_systems_ship ON ships_in_systems(ship_id);
    CREATE INDEX IF NOT EXISTS idx_pending_arrivals_system ON pending_arrivals(system_id);
  `);

  // Migrate existing databases: add world_type column to systems if missing
  try {
    const systemColumns = dbInstance.prepare("PRAGMA table_info(systems)").all() as Array<{ name: string }>;
    const systemColumnNames = new Set(systemColumns.map(column => column.name));
    if (!systemColumnNames.has("world_type")) {
      dbInstance.exec("ALTER TABLE systems ADD COLUMN world_type TEXT NOT NULL DEFAULT 'trade_hub'");
    }
  } catch (error) {
    // Table might not exist, that's fine
  }

  const columns = dbInstance.prepare("PRAGMA table_info(ships)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map(column => column.name));
  if (!columnNames.has("fuel_ly")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN fuel_ly REAL NOT NULL DEFAULT 15");
  }
  if (!columnNames.has("fuel_capacity_ly")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN fuel_capacity_ly REAL NOT NULL DEFAULT 15");
  }
  if (!columnNames.has("armaments_json")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN armaments_json TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columnNames.has("hull_integrity")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN hull_integrity INTEGER NOT NULL DEFAULT 100");
  }
  if (!columnNames.has("hull_max")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN hull_max INTEGER NOT NULL DEFAULT 100");
  }
  if (!columnNames.has("position_x")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN position_x REAL");
  }
  if (!columnNames.has("position_y")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN position_y REAL");
  }
  if (!columnNames.has("arrival_start_x")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN arrival_start_x REAL");
  }
  if (!columnNames.has("arrival_start_y")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN arrival_start_y REAL");
  }
  if (!columnNames.has("route_plan_json")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN route_plan_json TEXT");
  }
  if (!columnNames.has("route_plan_index")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN route_plan_index INTEGER NOT NULL DEFAULT 0");
  }
  if (!columnNames.has("route_plan_target_system_id")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN route_plan_target_system_id INTEGER");
  }
  if (!columnNames.has("route_plan_updated_at")) {
    dbInstance.exec("ALTER TABLE ships ADD COLUMN route_plan_updated_at INTEGER");
  }

  return dbInstance;
}

/**
 * Check if the database has any systems (galaxy is initialized)
 */
export function hasInitializedGalaxy(): boolean {
  const db = getDatabase();
  const result = db.prepare("SELECT COUNT(*) as count FROM systems").get() as { count: number };
  return result.count > 0;
}

export type PlayerRecord = {
  name: string;
  shipId: string;
  createdAt: number;
  lastSeen: number;
};

export function getPlayerByName(name: string): PlayerRecord | null {
  const db = getDatabase();
  const row = db.prepare("SELECT name, ship_id, created_at, last_seen FROM players WHERE name = ?").get(name) as PlayerRow | undefined;
  if (!row) return null;
  return {
    name: row.name,
    shipId: row.ship_id,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}

export function upsertPlayer(name: string, shipId: string, now: number): PlayerRecord {
  const db = getDatabase();
  const existing = getPlayerByName(name);
  if (existing) {
    db.prepare("UPDATE players SET ship_id = ?, last_seen = ? WHERE name = ?").run(shipId, now, name);
    return { ...existing, shipId, lastSeen: now };
  }
  db.prepare("INSERT INTO players (name, ship_id, created_at, last_seen) VALUES (?, ?, ?, ?)").run(name, shipId, now, now);
  return { name, shipId, createdAt: now, lastSeen: now };
}

/**
 * Storage adapter that provides a Durable Object-style storage API
 * but uses proper SQL tables under the hood
 */
export class LocalStorage {
  private objectId: string;
  private db: Database.Database;
  private objectType: "system" | "ship";
  private pendingSystemData: {
    systemState: SystemState;
    markets: Array<[GoodId, MarketState]>;
    shipsInSystem: ShipId[];
    pendingArrivals?: Array<{ timestamp: number; shipId: string; fromSystem: number; toSystem: number; cargo: Array<[string, number]>; priceInfo: Array<[string, number]> }>;
  } | null = null;
  private pendingShipData: ShipState | null = null;

  constructor(objectId: string) {
    this.objectId = objectId;
    this.db = getDatabase();
    
    // Determine object type from ID
    this.objectType = objectId.startsWith("system-") ? "system" : "ship";
  }

  async get<T = any>(key: string): Promise<T | undefined> {
    // For backward compatibility, we still support the "state" key
    // but load from proper tables
    if (key === "state") {
      if (this.objectType === "system") {
        return await this.loadSystemState() as T;
      } else {
        return await this.loadShipState() as T;
      }
    }
    
    // For other keys, use a generic key-value table (for any future needs)
    const stmt = this.db.prepare(`
      SELECT value FROM durable_object_storage 
      WHERE object_id = ? AND key = ?
    `);
    const row = stmt.get(this.objectId, key) as { value: string } | undefined;
    if (!row) return undefined;
    
    try {
      return JSON.parse(row.value) as T;
    } catch (error) {
      console.warn(`Failed to parse stored value for key ${key}:`, error);
      return undefined;
    }
  }

  async put<T = any>(key: string, value: T): Promise<void> {
    // For "state" key, save to proper tables
    if (key === "state") {
      if (this.objectType === "system") {
        await this.saveSystemState(value as {
          systemState: SystemState;
          markets: Array<[GoodId, MarketState]>;
          shipsInSystem: ShipId[];
          pendingArrivals?: Array<{ timestamp: number; shipId: string; fromSystem: number; toSystem: number; cargo: Array<[string, number]>; priceInfo: Array<[string, number]> }>;
        });
      } else {
        await this.saveShipState(value as ShipState);
      }
      return;
    }
    
    // For other keys, use generic key-value table
    const jsonValue = JSON.stringify(value);
    const stmt = this.db.prepare(`
      INSERT INTO durable_object_storage (object_id, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(object_id, key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(this.objectId, key, jsonValue);
  }

  async delete(key: string): Promise<boolean> {
    if (key === "state") {
      if (this.objectType === "system") {
        const systemId = parseInt(this.objectId.replace("system-", ""), 10);
        this.db.prepare("DELETE FROM systems WHERE id = ?").run(systemId);
        this.db.prepare("DELETE FROM markets WHERE system_id = ?").run(systemId);
        this.db.prepare("DELETE FROM ships_in_systems WHERE system_id = ?").run(systemId);
        this.db.prepare("DELETE FROM pending_arrivals WHERE system_id = ?").run(systemId);
        return true;
      } else {
        this.db.prepare("DELETE FROM ships WHERE id = ?").run(this.objectId);
        this.db.prepare("DELETE FROM ship_cargo WHERE ship_id = ?").run(this.objectId);
        this.db.prepare("DELETE FROM ships_in_systems WHERE ship_id = ?").run(this.objectId);
        this.db.prepare("DELETE FROM pending_arrivals WHERE ship_id = ?").run(this.objectId);
        return true;
      }
    }
    
    const stmt = this.db.prepare(`
      DELETE FROM durable_object_storage 
      WHERE object_id = ? AND key = ?
    `);
    const result = stmt.run(this.objectId, key);
    return (result.changes || 0) > 0;
  }

  async list<T = any>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    
    // For "state" key, return it
    if (!options?.prefix || options.prefix === "") {
      const state = await this.get("state");
      if (state) {
        result.set("state", state as T);
      }
    }
    
    // Also check generic storage
    const prefix = options?.prefix || "";
    const stmt = this.db.prepare(`
      SELECT key, value FROM durable_object_storage 
      WHERE object_id = ? AND key LIKE ?
      ORDER BY key
    `);
    const rows = stmt.all(this.objectId, `${prefix}%`) as Array<{ key: string; value: string }>;
    
    for (const row of rows) {
      try {
        result.set(row.key, JSON.parse(row.value) as T);
      } catch (error) {
        console.warn(`Failed to parse stored value for key ${row.key}:`, error);
      }
    }
    
    return result;
  }

  async deleteAll(): Promise<void> {
    if (this.objectType === "system") {
      const systemId = parseInt(this.objectId.replace("system-", ""), 10);
      this.db.prepare("DELETE FROM systems WHERE id = ?").run(systemId);
      this.db.prepare("DELETE FROM markets WHERE system_id = ?").run(systemId);
      this.db.prepare("DELETE FROM ships_in_systems WHERE system_id = ?").run(systemId);
      this.db.prepare("DELETE FROM pending_arrivals WHERE system_id = ?").run(systemId);
    } else {
      this.db.prepare("DELETE FROM ships WHERE id = ?").run(this.objectId);
      this.db.prepare("DELETE FROM ship_cargo WHERE ship_id = ?").run(this.objectId);
      this.db.prepare("DELETE FROM ships_in_systems WHERE ship_id = ?").run(this.objectId);
      this.db.prepare("DELETE FROM pending_arrivals WHERE ship_id = ?").run(this.objectId);
    }
    
    this.db.prepare("DELETE FROM durable_object_storage WHERE object_id = ?").run(this.objectId);
  }

  // System-specific load/save methods
  private async loadSystemState(): Promise<{
    systemState: SystemState;
    markets: Array<[GoodId, MarketState]>;
    shipsInSystem: ShipId[];
    pendingArrivals: Array<{ timestamp: number; shipId: string; fromSystem: number; toSystem: number; cargo: Array<[string, number]>; priceInfo: Array<[string, number]> }>;
  } | undefined> {
    const systemId = parseInt(this.objectId.replace("system-", ""), 10);
    
    // Load system
    const systemRow = this.db.prepare("SELECT * FROM systems WHERE id = ?").get(systemId) as SystemRow | undefined;
    if (!systemRow) return undefined;
    
    const systemState: SystemState = {
      id: systemRow.id,
      name: systemRow.name,
      population: systemRow.population,
      techLevel: systemRow.tech_level as TechLevel,
      worldType: (systemRow.world_type as WorldType) || WorldType.TRADE_HUB,
      seed: systemRow.seed,
      lastTickTime: systemRow.last_tick_time,
      currentTick: systemRow.current_tick,
      x: systemRow.x ?? 0,
      y: systemRow.y ?? 0,
    };
    
    // Load markets
    const marketRows = this.db.prepare("SELECT * FROM markets WHERE system_id = ?").all(systemId) as MarketRow[];
    const markets: Array<[GoodId, MarketState]> = marketRows.map(row => [
      row.good_id,
      {
        goodId: row.good_id,
        basePrice: row.base_price,
        supply: row.supply,
        demand: row.demand,
        production: row.production,
        consumption: row.consumption,
        price: row.price,
        inventory: row.inventory,
      }
    ]);
    
    // Load ships in system
    const shipRows = this.db.prepare("SELECT ship_id FROM ships_in_systems WHERE system_id = ?").all(systemId) as ShipInSystemRow[];
    const shipsInSystem = shipRows.map(row => row.ship_id);
    
    // Load pending arrivals
    const arrivalRows = this.db.prepare("SELECT * FROM pending_arrivals WHERE system_id = ?").all(systemId) as PendingArrivalRow[];
    const pendingArrivals = arrivalRows.map(row => ({
      timestamp: row.timestamp,
      shipId: row.ship_id,
      fromSystem: row.from_system,
      toSystem: row.to_system,
      cargo: JSON.parse(row.cargo_json) as Array<[string, number]>,
      priceInfo: JSON.parse(row.price_info_json) as Array<[string, number]>,
    }));
    
    return {
      systemState,
      markets,
      shipsInSystem,
      pendingArrivals,
    };
  }

  private async saveSystemState(data: {
    systemState: SystemState;
    markets: Array<[GoodId, MarketState]>;
    shipsInSystem: ShipId[];
    pendingArrivals?: Array<{ timestamp: number; shipId: string; fromSystem: number; toSystem: number; cargo: Array<[string, number]>; priceInfo: Array<[string, number]> }>;
  }): Promise<void> {
    // Store data for batch flush
    this.pendingSystemData = data;
  }

  /**
   * Batch flush all pending system states (called from flushAllSystems)
   */
  static async flushAllSystems(
    systems: Array<{
      objectId: string;
      data: {
        systemState: SystemState;
        markets: Array<[GoodId, MarketState]>;
        shipsInSystem: ShipId[];
        pendingArrivals?: Array<{ timestamp: number; shipId: string; fromSystem: number; toSystem: number; cargo: Array<[string, number]>; priceInfo: Array<[string, number]> }>;
      };
    }>
  ): Promise<void> {
    if (systems.length === 0) return;

    const db = getDatabase();
    // Disable foreign keys before transaction (pragma must be outside transaction in SQLite)
    db.pragma("foreign_keys = OFF");
    
    try {
      const transaction = db.transaction(() => {
      // Prepare statements
      const systemStmt = db.prepare(`
        INSERT INTO systems (id, name, population, tech_level, world_type, seed, last_tick_time, current_tick, x, y)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          population = excluded.population,
          tech_level = excluded.tech_level,
          world_type = excluded.world_type,
          seed = excluded.seed,
          last_tick_time = excluded.last_tick_time,
          current_tick = excluded.current_tick,
          x = excluded.x,
          y = excluded.y
      `);

      const marketStmt = db.prepare(`
        INSERT INTO markets (system_id, good_id, base_price, supply, demand, production, consumption, price, inventory)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(system_id, good_id) DO UPDATE SET
          base_price = excluded.base_price,
          supply = excluded.supply,
          demand = excluded.demand,
          production = excluded.production,
          consumption = excluded.consumption,
          price = excluded.price,
          inventory = excluded.inventory
      `);

      const shipInSystemStmt = db.prepare(`
        INSERT INTO ships_in_systems (system_id, ship_id) VALUES (?, ?)
        ON CONFLICT DO NOTHING
      `);

      const arrivalStmt = db.prepare(`
        INSERT INTO pending_arrivals (system_id, ship_id, timestamp, from_system, to_system, cargo_json, price_info_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(system_id, ship_id) DO UPDATE SET
          timestamp = excluded.timestamp,
          from_system = excluded.from_system,
          to_system = excluded.to_system,
          cargo_json = excluded.cargo_json,
          price_info_json = excluded.price_info_json
      `);

      // Collect all system IDs for batch deletes
      const systemIds: number[] = [];

      // Batch insert/update systems
      for (const { data: sysData } of systems) {
        const systemId = sysData.systemState.id;
        systemIds.push(systemId);

        systemStmt.run(
          systemId,
          sysData.systemState.name,
          sysData.systemState.population,
          sysData.systemState.techLevel,
          sysData.systemState.worldType,
          sysData.systemState.seed,
          sysData.systemState.lastTickTime,
          sysData.systemState.currentTick,
          sysData.systemState.x ?? 0,
          sysData.systemState.y ?? 0
        );
      }

      // Batch delete old data for all systems
      if (systemIds.length > 0) {
        const placeholders = systemIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM markets WHERE system_id IN (${placeholders})`).run(...systemIds);
        db.prepare(`DELETE FROM ships_in_systems WHERE system_id IN (${placeholders})`).run(...systemIds);
        db.prepare(`DELETE FROM pending_arrivals WHERE system_id IN (${placeholders})`).run(...systemIds);
      }

      // Batch insert markets
      for (const { data: sysData } of systems) {
        const systemId = sysData.systemState.id;
        for (const [goodId, market] of sysData.markets) {
          marketStmt.run(
            systemId,
            goodId,
            market.basePrice,
            market.supply,
            market.demand,
            market.production,
            market.consumption,
            market.price,
            market.inventory
          );
        }
      }

      // Batch insert ships in systems
      // Only insert if the ship exists (to avoid foreign key violations)
      // Ships might not be flushed yet, so we'll insert what we can
      for (const { data: sysData } of systems) {
        const systemId = sysData.systemState.id;
        for (const shipId of sysData.shipsInSystem) {
          try {
            shipInSystemStmt.run(systemId, shipId);
          } catch (error: unknown) {
            // Ignore foreign key violations - ship might not exist yet
            const sqliteError = error as SqliteError;
            if (sqliteError?.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') {
              throw error;
            }
          }
        }
      }

      // Batch insert pending arrivals
      // Only insert if the ship exists (to avoid foreign key violations)
      for (const { data: sysData } of systems) {
        const systemId = sysData.systemState.id;
        if (sysData.pendingArrivals && sysData.pendingArrivals.length > 0) {
          for (const arrival of sysData.pendingArrivals) {
            try {
              arrivalStmt.run(
                systemId,
                arrival.shipId,
                arrival.timestamp,
                arrival.fromSystem,
                arrival.toSystem,
                JSON.stringify(arrival.cargo),
                JSON.stringify(arrival.priceInfo)
              );
            } catch (error: unknown) {
              // Ignore foreign key violations - ship might not exist yet
              const sqliteError = error as SqliteError;
              if (sqliteError?.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') {
                throw error;
              }
            }
          }
        }
      }
      });
      
      transaction();
    } catch (error: unknown) {
      // If foreign key constraint fails, it might be because ships don't exist yet
      // This is okay - the relationship will be established when ships are flushed
      const sqliteError = error as SqliteError;
      if (sqliteError?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        console.warn('Foreign key constraint during system flush (ships may not exist yet):', sqliteError.message);
      } else {
        throw error;
      }
    } finally {
      // Always re-enable foreign keys
      db.pragma("foreign_keys = ON");
    }
  }

  // Ship-specific load/save methods
  private async loadShipState(): Promise<ShipState | undefined> {
    const shipRow = this.db.prepare("SELECT * FROM ships WHERE id = ?").get(this.objectId) as ShipRow | undefined;
    if (!shipRow) return undefined;
    
    // Load cargo
    const cargoRows = this.db.prepare("SELECT good_id, quantity FROM ship_cargo WHERE ship_id = ?").all(this.objectId) as CargoRow[];
    const cargo = new Map<GoodId, number>();
    for (const row of cargoRows) {
      cargo.set(row.good_id, row.quantity);
    }
    
    // Load purchase prices
    const purchasePriceRows = this.db.prepare("SELECT good_id, price FROM ship_purchase_prices WHERE ship_id = ?").all(this.objectId) as PurchasePriceRow[];
    const purchasePrices = new Map<GoodId, number>();
    for (const row of purchasePriceRows) {
      purchasePrices.set(row.good_id, row.price);
    }
    
    // Removed armaments loading - simplified

    // Removed route planning - simplified

    // Simplified to only core fields
    // Determine travelStartTime from phase and old time fields
    let travelStartTime: number | null = null;
    if (shipRow.phase === "traveling") {
      // Try to get travel start time from old fields
      travelStartTime = shipRow.departure_start_time ?? shipRow.hyperspace_start_time ?? null;
    }
    
    // Determine lastTradeTick (simplified - use 0 if not available)
    const lastTradeTick = 0; // Simplified - no longer tracking this in detail

    return {
      id: shipRow.id,
      name: shipRow.name,
      currentSystem: shipRow.current_system,
      destinationSystem: shipRow.destination_system,
      phase: shipRow.phase as ShipPhase,
      cargo,
      purchasePrices,
      credits: shipRow.credits,
      isNPC: shipRow.is_npc === 1,
      seed: shipRow.seed || "",
      travelStartTime,
      lastTradeTick,
    };
  }

  private async saveShipState(data: ShipState): Promise<void> {
    // Store data for batch flush
    this.pendingShipData = data;
  }

  /**
   * Get pending system data for batch flush
   */
  getPendingSystemData(): typeof this.pendingSystemData {
    return this.pendingSystemData;
  }

  /**
   * Get pending ship data for batch flush
   */
  getPendingShipData(): typeof this.pendingShipData {
    return this.pendingShipData;
  }

  /**
   * Clear pending data after flush
   */
  clearPendingData(): void {
    this.pendingSystemData = null;
    this.pendingShipData = null;
  }

  /**
   * Batch flush all pending ship states (called from flushAllShips)
   */
  static async flushAllShips(
    ships: Array<{
      objectId: string;
      data: ShipState;
    }>
  ): Promise<void> {
    if (ships.length === 0) return;

    const db = getDatabase();
    const transaction = db.transaction(() => {
      // Disable foreign keys temporarily for faster bulk operations
      db.pragma("foreign_keys = OFF");

      const shipStmt = db.prepare(`
        INSERT INTO ships (
          id, name, current_system, destination_system, phase,
          departure_start_time, hyperspace_start_time, arrival_start_time, arrival_complete_time,
          rest_start_time, rest_end_time, credits, is_npc, seed, fuel_ly, fuel_capacity_ly, hull_integrity, hull_max, armaments_json,
          position_x, position_y, arrival_start_x, arrival_start_y,
          route_plan_json, route_plan_index, route_plan_target_system_id, route_plan_updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          current_system = excluded.current_system,
          destination_system = excluded.destination_system,
          phase = excluded.phase,
          departure_start_time = excluded.departure_start_time,
          hyperspace_start_time = excluded.hyperspace_start_time,
          arrival_start_time = excluded.arrival_start_time,
          arrival_complete_time = excluded.arrival_complete_time,
          rest_start_time = excluded.rest_start_time,
          rest_end_time = excluded.rest_end_time,
          credits = excluded.credits,
          is_npc = excluded.is_npc,
          seed = excluded.seed,
          fuel_ly = excluded.fuel_ly,
          fuel_capacity_ly = excluded.fuel_capacity_ly,
          hull_integrity = excluded.hull_integrity,
          hull_max = excluded.hull_max,
          armaments_json = excluded.armaments_json,
          position_x = excluded.position_x,
          position_y = excluded.position_y,
          arrival_start_x = excluded.arrival_start_x,
          arrival_start_y = excluded.arrival_start_y,
          route_plan_json = excluded.route_plan_json,
          route_plan_index = excluded.route_plan_index,
          route_plan_target_system_id = excluded.route_plan_target_system_id,
          route_plan_updated_at = excluded.route_plan_updated_at
      `);

      const cargoStmt = db.prepare(`
        INSERT INTO ship_cargo (ship_id, good_id, quantity) VALUES (?, ?, ?)
        ON CONFLICT(ship_id, good_id) DO UPDATE SET quantity = excluded.quantity
      `);

      // Collect ship IDs for batch delete
      const shipIds: string[] = [];

      // Batch insert/update ships
      for (const { data: shipData } of ships) {
        shipIds.push(shipData.id);

        // Simplified - only use core fields, set old fields to null/defaults
        // Use travelStartTime for old time fields (for backward compatibility with DB schema)
        const travelStartTime = shipData.travelStartTime;
        shipStmt.run(
          shipData.id,
          shipData.name,
          shipData.currentSystem,
          shipData.destinationSystem,
          shipData.phase,
          travelStartTime, // departureStartTime - use travelStartTime
          travelStartTime, // hyperspaceStartTime - use travelStartTime
          null, // arrivalStartTime - removed
          null, // arrivalCompleteTime - removed
          null, // restStartTime - removed
          null, // restEndTime - removed
          shipData.credits,
          shipData.isNPC ? 1 : 0,
          shipData.seed,
          null, // fuelLy - removed
          null, // fuelCapacityLy - removed
          100, // hullIntegrity - default
          100, // hullMax - default
          '{}', // armaments_json - removed
          null, // positionX - removed
          null, // positionY - removed
          null, // arrivalStartX - removed
          null, // arrivalStartY - removed
          null, // route_plan_json - removed
          0, // route_plan_index - removed
          null, // route_plan_target_system_id - removed
          null // route_plan_updated_at - removed
        );
      }

      // Batch delete old cargo and purchase prices
      if (shipIds.length > 0) {
        const placeholders = shipIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM ship_cargo WHERE ship_id IN (${placeholders})`).run(...shipIds);
        db.prepare(`DELETE FROM ship_purchase_prices WHERE ship_id IN (${placeholders})`).run(...shipIds);
      }

      // Batch insert cargo
      for (const { data: shipData } of ships) {
        for (const [goodId, quantity] of shipData.cargo.entries()) {
          if (quantity > 0) {
            cargoStmt.run(shipData.id, goodId, quantity);
          }
        }
      }

      // Batch insert purchase prices - prepare statement here to avoid reuse issues
      const purchasePriceStmt = db.prepare(`
        INSERT INTO ship_purchase_prices (ship_id, good_id, price)
        VALUES (?, ?, ?)
        ON CONFLICT(ship_id, good_id) DO UPDATE SET price = excluded.price
      `);
      
      for (const { data: shipData } of ships) {
        if (shipData.purchasePrices && shipData.purchasePrices instanceof Map && shipData.purchasePrices.size > 0) {
          for (const [goodId, price] of shipData.purchasePrices.entries()) {
            if (typeof goodId === 'string' && typeof price === 'number' && !isNaN(price) && isFinite(price)) {
              try {
                purchasePriceStmt.run(shipData.id, goodId, price);
              } catch (error) {
                console.error(`[LocalStorage] Error inserting purchase price for ${shipData.id}/${goodId}:`, error, {
                  shipId: shipData.id,
                  goodId,
                  price,
                  priceType: typeof price,
                  purchasePricesType: shipData.purchasePrices.constructor.name
                });
                throw error;
              }
            }
          }
        }
      }

      // Re-enable foreign keys
      db.pragma("foreign_keys = ON");
    });

    transaction();
  }
}

/**
 * Local DurableObjectState for local development
 * Provides persistent storage using D1 (SQLite) with proper normalized tables
 */
export class LocalDurableObjectState {
  id: { toString(): string };
  storage: LocalStorage;

  constructor(id: string) {
    this.id = { toString: () => id };
    this.storage = new LocalStorage(id);
  }
}

/**
 * Close database connection (call on server shutdown)
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Reset the entire database - clears all data for a fresh start
 * WARNING: This deletes all systems, ships, markets, and players
 */
export function resetDatabase(): void {
  if (!dbInstance) {
    getDatabase(); // Ensure database is initialized
  }
  
  if (dbInstance) {
    // Delete all data from tables (in order to respect foreign keys)
    dbInstance.exec(`
      DELETE FROM pending_arrivals;
      DELETE FROM ships_in_systems;
      DELETE FROM ship_purchase_prices;
      DELETE FROM ship_cargo;
      DELETE FROM ships;
      DELETE FROM markets;
      DELETE FROM systems;
      DELETE FROM players;
      DELETE FROM durable_object_storage;
    `);
    
    // Reset SQLite sequences/auto-increment (if table exists)
    try {
      dbInstance.exec(`
        DELETE FROM sqlite_sequence WHERE name IN ('systems', 'ships', 'markets');
      `);
    } catch (error) {
      // sqlite_sequence table might not exist, that's fine
    }
  }
}
