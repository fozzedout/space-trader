# Space Trader API Documentation

Complete documentation for the Space Trader galaxy-scale market simulator system.

## Table of Contents

1. [Dependencies](#dependencies)
2. [API Endpoints](#api-endpoints)
3. [Type System](#type-system)
4. [Classes](#classes)
5. [Constants](#constants)
6. [Functions and Utilities](#functions-and-utilities)

---

## Dependencies

### Runtime Dependencies

- **seedrandom** (^3.0.5): Deterministic random number generation for reproducible simulations

### Development Dependencies

- **@types/better-sqlite3** (^7.6.13): TypeScript types for SQLite3
- **@types/node** (^20.11.0): TypeScript types for Node.js
- **@vitest/coverage-v8** (^1.1.0): Code coverage for Vitest
- **better-sqlite3** (^12.5.0): SQLite database driver for local storage
- **tsx** (^4.7.0): TypeScript execution environment
- **typescript** (^5.3.3): TypeScript compiler
- **vitest** (^1.1.0): Testing framework

### Node.js Built-in Modules

- `http`: HTTP server for local development
- `fs`: File system operations
- `path`: Path manipulation utilities
- `url`: URL parsing and manipulation

---

## API Endpoints

### Galaxy Operations

#### POST `/api/galaxy/initialize`
Initializes the entire galaxy with all star systems and NPC traders.

**Request Body:**
- `seed` (string, optional): Seed for deterministic galaxy generation. Defaults to "1".

**Response:**
```json
{
  "success": true,
  "systemsInitialized": 256,
  "npcsCreated": 12800
}
```

**Notes:**
- Can take several seconds to initialize 256 systems and thousands of NPCs
- Each system is initialized with unique properties based on deterministic RNG
- NPCs are randomly assigned to home systems

---

#### POST `/api/galaxy/tick`
Processes a simulation tick for all star systems and NPC ships in the galaxy.

**Response:**
```json
{
  "success": true,
  "systemsTicked": 256,
  "shipsTicked": 12000,
  "totalNPCs": 12800
}
```

**Notes:**
- Advances market prices, production/consumption, ship travel, and NPC trading decisions
- NPCs that are resting or sleeping are automatically skipped
- Can take time depending on galaxy size

---

#### POST `/api/galaxy/check-and-log`
Writes a cycle summary log file and stops logging.

**Response:**
```json
{
  "success": true,
  "logWritten": true,
  "loggingPaused": true,
  "timestamp": 1234567890000,
  "message": "Log written and logging paused. Restart server to resume logging."
}
```

**Notes:**
- Does NOT reset or reinitialize the galaxy
- Collects snapshots and writes them to cycle-log.json
- Always pauses logging until server restart
- Runs automatically every 5 minutes

---

#### GET `/api/health`
Simple health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

---

#### GET `/api/galaxy-health`
Returns comprehensive galactic health metrics.

**Response:**
```json
{
  "success": true,
  "health": {
    "timestamp": 1234567890000,
    "population": {
      "current": 12000,
      "target": 12800,
      "active": 12000,
      "inactive": 0
    },
    "ships": {
      "totalSpawns": 150,
      "totalRemovals": 20,
      "spawnsLastHour": 5,
      "removalsLastHour": 2,
      "netGrowth": 3,
      "removalReasons": {}
    },
    "trades": {
      "totalTrades": 1000,
      "successfulBuys": 450,
      "successfulSells": 500,
      "failedTrades": 50,
      "profitableTrades": 800,
      "unprofitableTrades": 100,
      "totalProfit": 50000,
      "totalLoss": 5000
    },
    "health": {
      "status": "healthy",
      "issues": []
    }
  }
}
```

**Notes:**
- Health status can be "healthy", "warning", or "critical"
- Tracks ship spawns/removals and trade quality over time

---

#### GET `/api/leaderboard`
Returns comprehensive galactic leaderboards.

**Query Parameters:**
- `limit` (number, optional): Maximum entries per category (default: 100, max: 1000)

**Response:**
```json
{
  "success": true,
  "leaderboard": {
    "traders": {
      "byCredits": [ /* top traders by credits */ ],
      "byTicks": [ /* top traders by ticks */ ],
      "byTrades": [ /* top traders by trades */ ],
      "byProfit": [ /* top traders by profit */ ],
      "byVolume": [ /* top traders by volume */ ]
    },
    "systems": {
      "byTradeVolume": [ /* top systems by volume */ ],
      "byTrades": [ /* top systems by trades */ ],
      "byUniqueTraders": [ /* top systems by traders */ ],
      "byProfit": [ /* top systems by profit */ ]
    },
    "routes": [ /* popular trade routes */ ]
  }
}
```

---

#### GET `/api/leaderboard/trader/{id}`
Gets detailed statistics for a specific trader.

**Response:**
```json
{
  "success": true,
  "trader": {
    "shipId": "npc-123",
    "name": "Trader 123",
    "currentCredits": 50000,
    "peakCredits": 55000,
    "totalTicks": 1000,
    "totalTrades": 500,
    "successfulTrades": 480,
    "totalProfit": 10000,
    "totalVolume": 100000,
    "systemsVisited": [0, 1, 2, 3]
  }
}
```

---

#### GET `/api/leaderboard/system/{id}`
Gets detailed statistics for a specific system.

**Response:**
```json
{
  "success": true,
  "system": {
    "systemId": 0,
    "name": "Sol",
    "totalTradeVolume": 500000,
    "totalTrades": 5000,
    "uniqueTraders": ["npc-0", "npc-1"],
    "totalProfit": 50000,
    "averagePrice": {
      "food": 10.5,
      "metals": 25.3
    }
  }
}
```

---

#### POST `/api/leaderboard/clear`
Clears all leaderboard tracking data.

**Response:**
```json
{
  "success": true,
  "message": "Leaderboard data cleared"
}
```

---

#### POST `/api/flush`
Manually triggers a flush of all in-memory state to the database.

**Response:**
```json
{
  "success": true,
  "message": "State flushed to database"
}
```

**Notes:**
- System uses lazy writes - state kept in memory and written periodically
- Flush happens automatically every hour, on shutdown, and on this request

---

### Player Accounts

#### GET `/api/player?name={name}`
Fetch a player account by name.

**Query Parameters:**
- `name` (string, required): Player name (unique key)

**Response:**
```json
{
  "player": {
    "name": "Ace Pilot",
    "shipId": "player-Ace%20Pilot",
    "createdAt": 1730000000000,
    "lastSeen": 1730000000000
  }
}
```

**Notes:**
- Returns 404 if player not found

---

#### POST `/api/player`
Create or update a player account by name.

**Request Body:**
- `name` (string, required): Player name (unique key)

**Response:**
```json
{
  "created": true,
  "player": {
    "name": "Ace Pilot",
    "shipId": "player-Ace%20Pilot",
    "createdAt": 1730000000000,
    "lastSeen": 1730000000000
  }
}
```

---

### System Operations

#### GET `/api/system/{id}?action=snapshot`
Gets a complete snapshot of a star system's current state.

**Path Parameters:**
- `id` (number, required): System ID (0-255)

**Query Parameters:**
- `action` (string, required): Must be "snapshot"

**Response:**
```json
{
  "state": {
    "id": 0,
    "name": "Sol",
    "population": 88.7,
    "techLevel": 4,
    "government": "dictatorship",
    "currentTick": 5
  },
  "markets": {
    "food": {
      "price": 14,
      "inventory": 6733,
      "production": 4.9,
      "consumption": 5.5
    }
  },
  "shipsInSystem": ["npc-0", "npc-1"]
}
```

**Notes:**
- Read-only operation - doesn't affect the simulation
- Useful for finding trading opportunities

---

### Ship Operations

#### GET `/api/ship/{id}`
Gets the current state of a ship.

**Path Parameters:**
- `id` (string, required): Ship ID (e.g., "npc-0", "npc-1")

**Response:**
```json
{
  "id": "npc-0",
  "name": "Trader 0",
  "currentSystem": 0,
  "destinationSystem": 5,
  "departureTime": 1234567890,
  "arrivalTime": 1234567890,
  "cargo": { "food": 10, "metals": 5 },
  "credits": 100,
  "isNPC": true,
  "armaments": {
    "lasers": { "front": "pulse", "rear": null, "left": null, "right": null },
    "missiles": 0,
    "ecm": false,
    "energyBomb": false
  },
  "fuelLy": 15,
  "fuelCapacityLy": 15
}
```

---

#### GET `/api/ship/{id}?action=armaments`
Gets current armaments, fuel status, and available upgrades.

**Path Parameters:**
- `id` (string, required): Ship ID

**Response:**
```json
{
  "armaments": {
    "lasers": { "front": "pulse", "rear": null, "left": null, "right": null },
    "missiles": 2,
    "ecm": false,
    "energyBomb": false
  },
  "fuelLy": 12,
  "fuelCapacityLy": 15,
  "techLevel": 4,
  "available": {
    "lasers": ["pulse", "beam"],
    "missiles": true,
    "ecm": true,
    "energyBomb": false
  }
}
```

---

#### POST `/api/ship/{id}?action=armaments`
Purchases armaments or refuels the hyperspace tank.

**Path Parameters:**
- `id` (string, required): Ship ID

**Request Body:**
- `category` (string, required): One of "laser", "missile", "ecm", "energyBomb", or "fuel"
- `mount` (string, optional): Laser mount (front, rear, left, right). Required for laser purchases.
- `laserType` (string, optional): Laser type (pulse, beam, military). Required for laser purchases.
- `quantity` (number, optional): Missile quantity to purchase (1-4)

**Response:**
```json
{
  "success": true,
  "cost": 600,
  "armaments": {
    "lasers": { "front": "pulse", "rear": "beam", "left": null, "right": null },
    "missiles": 2,
    "ecm": true,
    "energyBomb": false
  }
}
```

---

#### POST `/api/ship/{id}`
Performs an action on a ship.

**Path Parameters:**
- `id` (string, required): Ship ID

**Request Body:**
- `action` (string, required): Action to perform. Currently only "tick" is supported.

**Response:**
```json
{
  "success": true,
  "ship": { /* updated ship state */ }
}
```

---


## Type System

### Type Aliases

- `SystemId`: `number` (0-255)
- `ShipId`: `string`
- `GoodId`: `string`
- `Timestamp`: `number` (milliseconds since epoch)
- `LaserMount`: `"front" | "rear" | "left" | "right"`
- `LaserType`: `"pulse" | "beam" | "military"`
- `ShipPhase`: `"at_station" | "departing" | "in_hyperspace" | "arriving" | "resting" | "sleeping"`
- `TradeLoggingMode`: `"all" | "none" | string` (specific ship ID)
- `GoodRole`: `"SP" | "P" | "N" | "C" | "SC"` (Strong Producer, Producer, Neutral, Consumer, Strong Consumer)

### Enums

#### `GovernmentType`
```typescript
enum GovernmentType {
  ANARCHY = "anarchy",
  CORPORATE = "corporate",
  DEMOCRACY = "democracy",
  DICTATORSHIP = "dictatorship",
  FEUDAL = "feudal",
  MULTI_GOVERNMENT = "multi_government"
}
```

#### `TechLevel`
```typescript
enum TechLevel {
  AGRICULTURAL = 1,
  MEDIEVAL = 2,
  RENAISSANCE = 3,
  EARLY_INDUSTRIAL = 4,
  INDUSTRIAL = 5,
  POST_INDUSTRIAL = 6,
  HI_TECH = 7
}
```

#### `WorldType`
```typescript
enum WorldType {
  AGRICULTURAL = "agricultural",    // Focuses on food, textiles
  INDUSTRIAL = "industrial",        // Focuses on metals, machinery
  HIGH_TECH = "high_tech",          // Focuses on electronics, computers
  MINING = "mining",                // Focuses on metals, raw materials
  TRADE_HUB = "trade_hub",          // Balanced, no strong specialization
  RESORT = "resort"                 // High consumption, produces luxuries
}
```

### Interfaces

#### `SystemState`
```typescript
interface SystemState {
  id: SystemId;
  name: string;
  population: number;           // millions
  techLevel: TechLevel;
  worldType: WorldType;
  government: GovernmentType;
  seed: string;                 // RNG seed for deterministic simulation
  lastTickTime: Timestamp;
  currentTick: number;
  x: number;                    // 2D spatial coordinate
  y: number;                    // 2D spatial coordinate
}
```

#### `MarketState`
```typescript
interface MarketState {
  goodId: GoodId;
  basePrice: number;            // base price at tech level 0
  supply: number;               // current supply in station
  demand: number;               // current demand rate (units per tick)
  production: number;           // production rate (units per tick)
  consumption: number;         // consumption rate (units per tick)
  price: number;               // current market price
  inventory: number;           // current inventory at station
}
```

#### `ShipState`
```typescript
interface ShipState {
  id: ShipId;
  name: string;
  currentSystem: SystemId | null;
  destinationSystem: SystemId | null;
  phase: ShipPhase;
  positionX: number | null;
  positionY: number | null;
  arrivalStartX: number | null;
  arrivalStartY: number | null;
  departureStartTime: Timestamp | null;
  hyperspaceStartTime: Timestamp | null;
  arrivalStartTime: Timestamp | null;
  arrivalCompleteTime: Timestamp | null;
  restStartTime: Timestamp | null;
  restEndTime: Timestamp | null;
  cargo: Map<GoodId, number>;
  purchasePrices: Map<GoodId, number>;
  credits: number;
  isNPC: boolean;
  seed: string;
  armaments: ShipArmaments;
  fuelLy: number;
  fuelCapacityLy: number;
  hullIntegrity: number;
  hullMax: number;
  originSystem: SystemId | null;
  originPriceInfo: Array<[GoodId, number]> | null;
  chosenDestinationSystemId: SystemId | null;
  expectedMarginAtChoiceTime: number | null;
  immobileTicks: number;
  lastSuccessfulTradeTick: number;
  decisionCount: number;
  lastCargoPurchaseTick: number | null;
}
```

#### `ShipArmaments`
```typescript
interface ShipArmaments {
  lasers: Record<LaserMount, LaserType | null>;
  missiles: number;
  ecm: boolean;
  energyBomb: boolean;
}
```

#### `SystemSnapshot`
```typescript
interface SystemSnapshot {
  state: SystemState;
  markets: Map<GoodId, MarketState>;
  shipsInSystem: ShipId[];
}
```

#### `TradeEvent`
```typescript
interface TradeEvent {
  timestamp: Timestamp;
  shipId: ShipId;
  systemId: SystemId;
  goodId: GoodId;
  quantity: number;
  price: number;
  type: "buy" | "sell";
}
```

#### `ShipArrivalEvent`
```typescript
interface ShipArrivalEvent {
  timestamp: Timestamp;
  shipId: ShipId;
  fromSystem: SystemId;
  toSystem: SystemId;
  cargo: Map<GoodId, number>;
  priceInfo: Map<GoodId, number>;
}
```

#### `GoodDefinition`
```typescript
interface GoodDefinition {
  id: GoodId;
  name: string;
  basePrice: number;           // price at tech level 0
  weight: number;              // cargo space per unit
  volatility: number;          // price volatility factor (0-1)
  productionTech: TechLevel;   // minimum tech level to produce
  consumptionTech: TechLevel; // minimum tech level to consume
}
```

#### `BalanceConfig`
```typescript
interface BalanceConfig {
  priceElasticity: number;
  minProfitMargin: number;
  maxPriceChangePerTick: number;
  maxPriceMultiplier: number;
  minPriceMultiplier: number;
  meanReversionStrength: number;      // 0.01-0.05
  marketDepthFactor: number;          // 0.3-1.0
  transactionImpactMultiplier: number; // 0.01-0.1
  inventoryDampingThreshold: number;  // 0.1-0.2
  sigmoidSteepness: number;           // 2-5
}
```

#### `ShipSpawnEvent`
```typescript
interface ShipSpawnEvent {
  timestamp: number;
  shipId: string;
  systemId: number;
  reason: "initialization" | "respawn";
}
```

#### `ShipRemovalEvent`
```typescript
interface ShipRemovalEvent {
  timestamp: number;
  shipId: string;
  systemId: number | null;
  reason: string;
  credits: number;
}
```

#### `TradeAnalysis`
```typescript
interface TradeAnalysis {
  totalTrades: number;
  successfulBuys: number;
  successfulSells: number;
  failedTrades: number;
  profitableTrades: number;
  unprofitableTrades: number;
  totalProfit: number;
  totalLoss: number;
  tradesWithMissingProfit?: number;
}
```

#### `GalaxyHealthMetrics`
```typescript
interface GalaxyHealthMetrics {
  timestamp: number;
  population: {
    current: number;
    target: number;
    active: number;
    inactive: number;
  };
  ships: {
    totalSpawns: number;
    totalRemovals: number;
    spawnsLastHour: number;
    removalsLastHour: number;
    netGrowth: number;
    removalReasons: Record<string, number>;
  };
  trades: TradeAnalysis;
  health: {
    status: "healthy" | "warning" | "critical";
    issues: string[];
  };
  logging?: {
    paused: boolean;
    needsCodeChange: boolean;
    message?: string;
  };
}
```

#### `TraderStats`
```typescript
interface TraderStats {
  shipId: ShipId;
  name: string;
  totalTicks: number;
  totalTrades: number;
  successfulTrades: number;
  totalProfit: number;
  totalVolume: number;
  currentCredits: number;
  peakCredits: number;
  systemsVisited: Set<SystemId>;
  lastUpdated: Timestamp;
}
```

#### `SystemStats`
```typescript
interface SystemStats {
  systemId: SystemId;
  name: string;
  totalTradeVolume: number;
  totalTrades: number;
  uniqueTraders: Set<ShipId>;
  totalProfit: number;
  averagePrice: Record<GoodId, number>;
  lastUpdated: Timestamp;
}
```

#### `TradeRoute`
```typescript
interface TradeRoute {
  fromSystem: SystemId;
  toSystem: SystemId;
  tradeCount: number;
  volume: number;
  profit: number;
  traders: Set<ShipId>;
}
```

#### `LeaderboardData`
```typescript
interface LeaderboardData {
  traders: {
    byCredits: Array<{ shipId: ShipId; name: string; credits: number }>;
    byTicks: Array<{ shipId: ShipId; name: string; ticks: number }>;
    byTrades: Array<{ shipId: ShipId; name: string; trades: number }>;
    byProfit: Array<{ shipId: ShipId; name: string; profit: number }>;
    byVolume: Array<{ shipId: ShipId; name: string; volume: number }>;
  };
  systems: {
    byTradeVolume: Array<{ systemId: SystemId; name: string; volume: number }>;
    byTrades: Array<{ systemId: SystemId; name: string; trades: number }>;
    byUniqueTraders: Array<{ systemId: SystemId; name: string; traders: number }>;
    byProfit: Array<{ systemId: SystemId; name: string; profit: number }>;
  };
  routes: TradeRoute[];
}
```

#### `TradeLogEntry`
```typescript
interface TradeLogEntry {
  timestamp: number;
  message: string;
}
```

#### `ShipPresence`
```typescript
interface ShipPresence {
  shipId: ShipId;
  systemId: SystemId;
  lastSeen: Timestamp;
}
```

#### `PlayerRecord`
```typescript
interface PlayerRecord {
  name: string;
  shipId: string;
  createdAt: number;
  lastSeen: number;
}
```

#### `ApiEndpoint`
```typescript
interface ApiEndpoint {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  description: string;
  parameters?: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  requestBody?: {
    fields: Array<{
      name: string;
      type: string;
      required: boolean;
      description: string;
    }>;
  };
  response: {
    description: string;
    example?: any;
  };
  notes?: string[];
}
```

#### `ShipMetrics`
```typescript
interface ShipMetrics {
  shipId: string;
  credits: number;
  cargo: Record<string, number>;
  systemId: number | null;
  phase: string;
  timestamp: number;
}
```

#### `SystemMetrics`
```typescript
interface SystemMetrics {
  systemId: number;
  population: number;
  techLevel: number;
  marketCount: number;
  shipsInSystem: number;
  timestamp: number;
}
```

#### `GalaxyMetrics`
```typescript
interface GalaxyMetrics {
  totalShips: number;
  totalSystems: number;
  activeTraders: number;
  totalCredits: number;
  timestamp: number;
}
```

#### `MonitoringData`
```typescript
interface MonitoringData {
  ships: ShipMetrics[];
  systems: SystemMetrics[];
  galaxy: GalaxyMetrics[];
  timestamp: number;
}
```

---

## Classes

### `StarSystem`
Star system simulation object. Each star system is an economic island with deterministic economy simulation.

**Location:** `src/star-system.ts`

**Key Methods:**
- `fetch(request: Request | string): Promise<Response>` - Main entry point for HTTP requests
- `handleGetState(): Promise<Response>` - Returns system state
- `handleGetSnapshot(): Promise<Response>` - Returns complete system snapshot
- `handleTick(): Promise<Response>` - Processes a simulation tick
- `handleShipArrival(request: Request): Promise<Response>` - Handles ship arrival
- `handleShipDeparture(request: Request): Promise<Response>` - Handles ship departure
- `handleTrade(request: Request): Promise<Response>` - Handles trade operations
- `handleInitialize(request: Request): Promise<Response>` - Initializes the system
- `tick(): Promise<void>` - Internal tick processing
- `updateMarkets(): void` - Updates market prices and inventory
- `flushState(): Promise<void>` - Flushes state to database

**Properties:**
- `state: DurableObjectState` - Durable object state
- `env: StarSystemEnv` - Environment with namespaces
- `systemState: SystemState | null` - Current system state
- `markets: Map<GoodId, MarketState>` - Market states
- `shipsInSystem: Set<ShipId>` - Ships currently in system
- `pendingArrivals: ShipArrivalEvent[]` - Pending ship arrivals
- `dirty: boolean` - Whether state needs flushing

---

### `Ship`
Ship simulation object. Represents an NPC trader ship that travels between systems and trades.

**Location:** `src/ship.ts`

**Key Methods:**
- `fetch(request: Request | string): Promise<Response>` - Main entry point for HTTP requests
- `handleGetState(): Promise<Response>` - Returns ship state
- `handleGetArmaments(): Promise<Response>` - Returns armaments info
- `handlePurchaseArmaments(request: Request): Promise<Response>` - Purchases armaments
- `handleTick(request: Request): Promise<Response>` - Processes a ship tick
- `tick(): Promise<void>` - Internal tick processing
- `tryBuy(): Promise<boolean>` - Attempts to buy goods
- `trySell(): Promise<boolean>` - Attempts to sell goods
- `tryTravel(): Promise<boolean>` - Attempts to travel to another system
- `refuel(): boolean` - Refuels the ship
- `rest(): void` - Starts rest period
- `sleep(): void` - Starts sleep period

**Properties:**
- `state: DurableObjectState` - Durable object state
- `env: ShipEnv` - Environment with namespaces
- `shipState: ShipState | null` - Current ship state
- `dirty: boolean` - Whether state needs flushing

---

### `DeterministicRNG`
Deterministic random number generator for reproducible simulations.

**Location:** `src/deterministic-rng.ts`

**Key Methods:**
- `random(): number` - Returns random number between 0 and 1
- `randomInt(min: number, max: number): number` - Returns random integer
- `randomChoice<T>(array: T[]): T` - Returns random array element
- `shuffle<T>(array: T[]): T[]` - Shuffles array deterministically

**Properties:**
- `rng: seedrandom.prng` - Underlying PRNG instance

---

### `LocalStorage`
Local SQLite storage implementation for Durable Objects.

**Location:** `src/local-storage.ts`

**Key Methods:**
- `get(key: string): Promise<string | null>` - Gets value by key
- `put(key: string, value: string): Promise<void>` - Stores value by key
- `delete(key: string): Promise<void>` - Deletes value by key
- `list(options?: DurableObjectListOptions): Promise<Map<string, string>>` - Lists all keys

**Properties:**
- `db: Database` - SQLite database instance

---

### `LocalDurableObjectState`
Local implementation of DurableObjectState for development.

**Location:** `src/local-storage.ts`

**Key Methods:**
- `storage: DurableObjectStorage` - Storage interface
- `id: DurableObjectId` - Object ID

---

### `MockDurableObjectStorage`
Mock storage for testing.

**Location:** `src/test-utils/mocks.ts`

---

### `MockDurableObjectState`
Mock state for testing.

**Location:** `src/test-utils/mocks.ts`

---

### `MockDurableObjectNamespace`
Mock namespace for testing.

**Location:** `src/test-utils/mocks.ts`

---

## Constants

### System Configuration

- `PORT`: Default port 3000 (configurable via `process.env.PORT`)
- `GALAXY_SIZE`: Default 256 systems (configurable via `process.env.GALAXY_SIZE`)
- `TICK_INTERVAL_MS`: 10000 (10 seconds per tick)
- `TOTAL_NPCS`: Default 5 NPCs per system (configurable via `process.env.TOTAL_NPCS`)
- `AUTO_TICK`: Enable auto-ticking by default (configurable via `process.env.AUTO_TICK`)
- `RESET_INTERVAL_MS`: 300000 (5 minutes for health check cycle)
- `SALES_TAX_RATE`: 0.03 (3% tax on purchases only)

### Ship Configuration

- `HYPERSPACE_TRAVEL_TIME_MS`: 0 (instant transfer)
- `DEPARTURE_TIME_MS`: 10000 (10 seconds)
- `ARRIVAL_TIME_MS`: 60000 (60 seconds)
- `SPAWN_LEEWAY_MS`: 5000 (0-5 seconds random leeway)
- `REST_TIME_MIN_MS`: 300000 (5 minutes minimum)
- `REST_TIME_MAX_MS`: 3600000 (60 minutes maximum)
- `SLEEP_TIME_MAX_MS`: 43200000 (12 hours maximum)
- `REST_CHANCE_AFTER_TRADE`: 0.3 (30% chance)
- `SLEEP_CHANCE_AFTER_TRADE`: 0.05 (5% chance)
- `MAX_CARGO_SPACE`: 100
- `INITIAL_CREDITS`: 500
- `VERY_LOW_CREDITS_THRESHOLD`: 50
- `AIR_PURIFIER_TAX`: 0.01 (0.01 credits per tick)
- `TAX_BUFFER`: 50
- `HULL_MAX`: 100
- `HULL_REPAIR_COST_PER_POINT`: 10
- `MAX_TRAVEL_DISTANCE`: 15
- `MIN_TRAVEL_FUEL_LY`: 5

### NPC Lifecycle Thresholds

- `IMMOBILE_TICKS_TO_CULL`: 4
- `STAGNATION_DECISIONS_TO_CULL`: 75
- `DRAWDOWN_LIMIT`: 0.05
- `MIN_TRADES_FOR_DRAWDOWN`: 10
- `MAX_CARGO_HOLD_TICKS`: 200

### System Constants

- `STATION_CAPACITY`: 10000 (max inventory per good)
- `MAX_EVENTS`: 10000 (max events in health tracking)

### Armament Constants

- `FUEL_TANK_RANGE_LY`: 15
- `FUEL_PRICE_PER_LY`: 2
- `MAX_MISSILES`: 4

### Laser Prices

- `pulse`: 400 credits
- `beam`: 1000 credits
- `military`: 6000 credits

### Laser Tech Levels

- `pulse`: TechLevel.AGRICULTURAL (1)
- `beam`: TechLevel.RENAISSANCE (3)
- `military`: TechLevel.POST_INDUSTRIAL (6)

### Armament Prices

- `missile`: 30 credits
- `ecm`: 600 credits
- `energyBomb`: 900 credits

### Armament Tech Levels

- `missile`: TechLevel.MEDIEVAL (2)
- `ecm`: TechLevel.INDUSTRIAL (5)
- `energyBomb`: TechLevel.POST_INDUSTRIAL (6)

### Goods Catalog

**Location:** `src/goods.ts`

```typescript
const GOODS: GoodDefinition[] = [
  { id: "food", name: "Food", basePrice: 10, weight: 1, volatility: 0.1, productionTech: 1, consumptionTech: 1 },
  { id: "textiles", name: "Textiles", basePrice: 20, weight: 1, volatility: 0.15, productionTech: 1, consumptionTech: 1 },
  { id: "metals", name: "Metals", basePrice: 50, weight: 2, volatility: 0.2, productionTech: 2, consumptionTech: 2 },
  { id: "machinery", name: "Machinery", basePrice: 200, weight: 5, volatility: 0.25, productionTech: 4, consumptionTech: 4 },
  { id: "electronics", name: "Electronics", basePrice: 500, weight: 2, volatility: 0.3, productionTech: 6, consumptionTech: 6 },
  { id: "computers", name: "Computers", basePrice: 1000, weight: 1, volatility: 0.35, productionTech: 7, consumptionTech: 7 },
  { id: "luxuries", name: "Luxuries", basePrice: 300, weight: 1, volatility: 0.4, productionTech: 3, consumptionTech: 3 },
  { id: "medicines", name: "Medicines", basePrice: 150, weight: 1, volatility: 0.2, productionTech: 5, consumptionTech: 3 },
  { id: "weapons", name: "Weapons", basePrice: 800, weight: 3, volatility: 0.5, productionTech: 5, consumptionTech: 2 },
  { id: "narcotics", name: "Narcotics", basePrice: 2000, weight: 1, volatility: 0.6, productionTech: 6, consumptionTech: 6 }
];
```

### Balance Configuration Defaults

**Location:** `src/balance-config.ts`

```typescript
{
  priceElasticity: 0.1,
  minProfitMargin: 0.0001,              // 0.01%
  maxPriceChangePerTick: 0.1,
  maxPriceMultiplier: 10.0,
  minPriceMultiplier: 0.1,
  meanReversionStrength: 0.02,           // 2% per tick
  marketDepthFactor: 0.5,
  transactionImpactMultiplier: 0.05,     // 5%
  inventoryDampingThreshold: 0.15,       // 15%
  sigmoidSteepness: 3.0
}
```

---

## Functions and Utilities

### Goods Functions (`src/goods.ts`)

- `getGoodDefinition(goodId: GoodId): GoodDefinition | undefined` - Gets good definition by ID
- `getAllGoodIds(): GoodId[]` - Returns all good IDs
- `isSpecializedGood(goodId: GoodId, worldType: WorldType): boolean` - Checks if good is specialized for world type

### Economy Roles Functions (`src/economy-roles.ts`)

- `getBaseRole(worldType: WorldType, goodId: GoodId): GoodRole` - Gets base economic role
- `applyTechMasking(role: GoodRole, techLevel: TechLevel, good: GoodDefinition): GoodRole` - Applies tech level masking
- `applyBaselineDemandOverlay(role: GoodRole, worldType: WorldType): GoodRole` - Applies baseline demand overlay
- `applyTradeHubNarrowing(role: GoodRole, worldType: WorldType): GoodRole` - Applies trade hub narrowing
- `getPriceMultiplier(worldType: WorldType, goodId: GoodId, techLevel: TechLevel): number` - Gets price multiplier

### Balance Config Functions (`src/balance-config.ts`)

- `getBalanceConfig(): BalanceConfig` - Gets current balance configuration
- `updateBalanceConfig(updates: Partial<BalanceConfig>): void` - Updates balance configuration
- `getPriceElasticity(): number` - Gets price elasticity
- `getMinProfitMargin(): number` - Gets minimum profit margin
- `getMaxPriceChangePerTick(): number` - Gets max price change per tick
- `getMaxPriceMultiplier(): number` - Gets max price multiplier
- `getMinPriceMultiplier(): number` - Gets min price multiplier
- `getMeanReversionStrength(): number` - Gets mean reversion strength
- `getMarketDepthFactor(): number` - Gets market depth factor
- `getTransactionImpactMultiplier(): number` - Gets transaction impact multiplier
- `getInventoryDampingThreshold(): number` - Gets inventory damping threshold
- `getSigmoidSteepness(): number` - Gets sigmoid steepness

### Armament Functions (`src/armaments.ts`)

- `getDefaultArmaments(): ShipArmaments` - Gets default armament configuration
- `canInstallLaser(techLevel: TechLevel, laserType: LaserType): boolean` - Checks if laser can be installed
- `getLaserPrice(laserType: LaserType): number` - Gets laser price
- `getLaserOptions(techLevel: TechLevel): LaserType[]` - Gets available laser options
- `getAvailableArmaments(techLevel: TechLevel, armaments: ShipArmaments)` - Gets available armaments
- `isValidLaserMount(mount: string): mount is LaserMount` - Validates laser mount

### Galaxy Health Functions (`src/galaxy-health.ts`)

- `recordSpawn(shipId: string, systemId: number, reason: "initialization" | "respawn"): void` - Records ship spawn
- `recordRemoval(shipId: string, systemId: number | null, reason: string, credits: number): void` - Records ship removal
- `recordTradeEvent(type: "buy" | "sell", profit?: number): void` - Records trade event
- `analyzeTrades(tradeLogs?: Array<{ timestamp: number; message: string }>): TradeAnalysis` - Analyzes trade logs
- `getGalaxyHealth(currentPopulation: number, targetPopulation: number, activeShips: number, tradeLogs: Array<{ timestamp: number; message: string }>): GalaxyHealthMetrics` - Gets galaxy health metrics
- `clearHealthData(): void` - Clears all health tracking data

### Leaderboard Functions (`src/leaderboard.ts`)

- `recordTick(shipId: ShipId, name: string): void` - Records ship tick
- `recordTravel(shipId: ShipId, name: string, fromSystem: SystemId, toSystem: SystemId): void` - Records travel
- `recordTrade(shipId: ShipId, name: string, systemId: SystemId, goodId: GoodId, quantity: number, price: number, type: "buy" | "sell", profit?: number): void` - Records trade
- `recordFailedTrade(shipId: ShipId, name: string, systemId: SystemId, goodId: GoodId, type: "buy" | "sell", reason: string): void` - Records failed trade
- `updateTraderCredits(shipId: ShipId, name: string, credits: number): void` - Updates trader credits
- `getLeaderboard(limit: number = 100): LeaderboardData` - Gets leaderboard data
- `getTraderDetails(shipId: ShipId): TraderStats | null` - Gets trader details
- `getSystemDetails(systemId: SystemId): SystemStats | null` - Gets system details
- `clearLeaderboard(): void` - Clears leaderboard data

### Trade Logging Functions (`src/trade-logging.ts`)

- `setTradeLoggingMode(mode: TradeLoggingMode): void` - Sets trade logging mode
- `getTradeLoggingMode(): TradeLoggingMode` - Gets trade logging mode
- `shouldLogTrade(shipId: string): boolean` - Checks if trade should be logged
- `shouldLogTradeNow(shipId: string): boolean` - Checks if trade should be logged now (with rate limiting)
- `logTrade(message: string): void` - Logs trade message
- `getTradeLogs(): TradeLogEntry[]` - Gets all trade logs
- `clearTradeLogs(): void` - Clears trade logs
- `shouldLogDecisions(shipId: string): boolean` - Checks if decisions should be logged
- `logDecision(shipId: string, message: string): void` - Logs decision message
- `getRateLimitStats()` - Gets rate limit statistics
- `shouldTickTraders(): boolean` - Checks if traders should be ticked

### Ship Registry Functions (`src/local-ship-registry.ts`)

- `updateShipPresence(shipState: ShipState): void` - Updates ship presence
- `removeShipPresence(shipId: ShipId): void` - Removes ship presence
- `clearShipPresence(): void` - Clears all ship presence
- `listShipsInSystem(systemId: SystemId, staleMs?: number): ShipId[]` - Lists ships in system
- `getPresenceBySystem(staleMs?: number): Record<number, ShipPresence[]>` - Gets presence by system

### Storage Functions (`src/local-storage.ts`)

- `hasInitializedGalaxy(): boolean` - Checks if galaxy has been initialized
- `getPlayerByName(name: string): PlayerRecord | null` - Gets player by name
- `upsertPlayer(name: string, shipId: string, now: number): PlayerRecord` - Creates or updates player
- `closeDatabase(): void` - Closes database connection

### Monitoring Functions (`src/monitoring.ts`)

- `collectShipMetrics(shipId: string, shipState: {...}): ShipMetrics` - Collects ship metrics
- `collectSystemMetrics(systemId: SystemId, systemState: {...}, markets: Map<...>, shipsInSystem: ShipId[]): SystemMetrics` - Collects system metrics
- `collectGalaxyMetrics(ships: Array<...>, systems: Array<...>): GalaxyMetrics` - Collects galaxy metrics
- `getMonitoringData(): MonitoringData` - Gets monitoring data
- `clearMonitoringData(): void` - Clears monitoring data
- `analyzeAndRecommend()` - Analyzes data and provides recommendations

### Durable Object Helpers (`src/durable-object-helpers.ts`)

- `DO_INTERNAL(path: string): string` - Creates internal DO URL
- `createDORequest(path: string, init?: RequestInit): Request` - Creates DO request

### API Documentation Functions (`src/api-docs.ts`)

- `getFormattedDocs(): string` - Gets formatted markdown documentation
- `getEndpointDocHtml(endpoint: ApiEndpoint): string` - Gets HTML for endpoint
- `getCategoryDocsHtml(category: string): string` - Gets HTML for category
- `findEndpointByPath(pathPattern: string): ApiEndpoint | null` - Finds endpoint by path
- `findEndpointByAction(category: string, action: string): ApiEndpoint | null` - Finds endpoint by action

---

## System Architecture

### Core Components

1. **StarSystem** - Manages individual star systems with markets and economic simulation
2. **Ship** - Manages NPC trader ships with autonomous trading behavior
3. **LocalStorage** - SQLite-based storage for Durable Objects
4. **DeterministicRNG** - Reproducible random number generation

### Supporting Systems

1. **Galaxy Health** - Tracks ship spawns/removals and trade quality
2. **Leaderboard** - Tracks trader and system statistics
3. **Trade Logging** - Logs trade events with rate limiting
4. **Monitoring** - Collects metrics for analysis
5. **Balance Config** - Centralized economic parameter configuration

### Data Flow

1. Galaxy initialization creates systems and NPCs
2. Systems tick independently, updating markets
3. Ships tick, making trading decisions based on market conditions
4. Trades are logged and tracked in leaderboards
5. Health metrics are collected and evaluated periodically
6. State is flushed to database periodically

---

## Notes

- All RNG uses deterministic seeds for reproducible simulations
- Player trades are experimental and don't affect NPC simulation
- The system uses lazy writes - state is kept in memory and flushed periodically
- NPCs that are resting or sleeping are skipped in tick calculations
- Health checks run automatically every 5 minutes
- Logging can be paused if code changes are needed

