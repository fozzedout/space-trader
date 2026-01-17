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
  "systemsInitialized": 20,
  "npcsCreated": 100
}
```

**Notes:**
- Can take several seconds to initialize 20 systems and 100 NPCs
- Each system is initialized with unique properties based on deterministic RNG
- NPCs are randomly assigned to home systems

---

#### POST `/api/galaxy/tick`
Processes a simulation tick for all star systems and NPC ships in the galaxy.

**Response:**
```json
{
  "success": true,
  "systemsTicked": 20,
  "shipsTicked": 100,
  "totalNPCs": 100
}
```

**Notes:**
- Advances market prices, production/consumption, ship travel, and NPC trading decisions
- Can take time depending on galaxy size

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
  "phase": "traveling",
  "travelStartTime": 1234567890,
  "cargo": { "food": 10, "metals": 5 },
  "credits": 100,
  "isNPC": true
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

- `SystemId`: `number` (0-19)
- `ShipId`: `string`
- `GoodId`: `string`
- `Timestamp`: `number` (milliseconds since epoch)
- `ShipPhase`: `"at_station" | "traveling"`
- `GoodRole`: `"SP" | "P" | "N" | "C" | "SC"` (Strong Producer, Producer, Neutral, Consumer, Strong Consumer)

### Enums

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
  cargo: Map<GoodId, number>;
  purchasePrices: Map<GoodId, number>;
  credits: number;
  isNPC: boolean;
  seed: string;
  travelStartTime: number | null;
  lastTradeTick: number;
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
- `storage: DurableObjectStorage` - Storage interface
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
- `handleTick(request: Request): Promise<Response>` - Processes a ship tick
- `handleTrade(request: Request): Promise<Response>` - Handles trade operations
- `handleTravel(request: Request): Promise<Response>` - Handles travel requests
- `tick(): Promise<void>` - Internal tick processing
- `makeNPCTradingDecision(): Promise<void>` - Makes NPC trading decisions
- `tryTravel(): Promise<boolean>` - Attempts to travel to another system

**Properties:**
- `storage: DurableObjectStorage` - Storage interface
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
- `GALAXY_SIZE`: Default 20 systems (configurable via `process.env.GALAXY_SIZE`)
- `TICK_INTERVAL_MS`: 10000 (10 seconds per tick)
- `TOTAL_NPCS`: Default 5 NPCs per system (configurable via `process.env.TOTAL_NPCS`)
- `AUTO_TICK`: Enable auto-ticking by default (configurable via `process.env.AUTO_TICK`)
- `RESET_INTERVAL_MS`: 300000 (5 minutes for health check cycle)
- `SALES_TAX_RATE`: 0.03 (3% tax on purchases only)

### Ship Configuration

- `TRAVEL_TIME_MS`: 300000 (5 minutes travel time between systems)
- `MAX_CARGO_SPACE`: 100
- `INITIAL_CREDITS`: 500
- `MAX_TRAVEL_DISTANCE`: 15 (maximum distance ships can travel)

### System Constants

- `STATION_CAPACITY`: 10000 (max inventory per good)
- `MAX_EVENTS`: 10000 (max events in health tracking)

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

### Storage Functions (`src/local-storage.ts`)

- `hasInitializedGalaxy(): boolean` - Checks if galaxy has been initialized
- `getPlayerByName(name: string): PlayerRecord | null` - Gets player by name
- `upsertPlayer(name: string, shipId: string, now: number): PlayerRecord` - Creates or updates player
- `closeDatabase(): void` - Closes database connection

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

1. **Balance Config** - Centralized economic parameter configuration
2. **Economy Roles** - Determines production/consumption roles for goods by world type

### Data Flow

1. Galaxy initialization creates systems and NPCs
2. Systems tick independently, updating markets
3. Ships tick, making trading decisions based on market conditions
4. Ships travel between systems using simple timer-based travel
5. State is flushed to database periodically

---

## Notes

- All RNG uses deterministic seeds for reproducible simulations
- Player trades are canonical and affect markets just like NPC trades
- The system uses lazy writes - state is kept in memory and flushed periodically
- Travel is simplified to timer-based (5 minutes between systems)
- Ships have two phases: `at_station` and `traveling`

