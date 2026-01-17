# Space Trader - Simple Trading Economy Simulator

A simple trading economy simulation where NPCs run autonomously and players can join to trade like NPCs. Features deterministic simulation, system isolation, and canonical player trading.

## Architecture

### Core Design Principles

1. **System Isolation**: Each of 20 star systems is an economic island with no instantaneous goods/information transfer
2. **Deterministic Simulation**: Reproducible results given the same initial state and event stream
3. **Simple Travel**: Ships travel between systems with timer-based travel
4. **Tick-Based Markets**: Markets update in discrete ticks (default: 30 seconds)
5. **Canonical Players**: Player trades affect markets just like NPC trades

### Local Architecture

- **Simulation Objects**:
  - `StarSystem`: One per system (20 total), handles economy simulation
  - `Ship`: One per NPC/player ship (100 NPCs), handles trading and travel
- **HTTP Server**: Local API endpoint for observation and player trading
- **Deterministic RNG**: Uses deterministic RNG for reproducible random number generation
- **SQLite Storage**: Local database for persistence

## Project Structure

```
space-trader/
├── src/
│   ├── local-server.ts       # Local HTTP API
│   ├── star-system.ts        # StarSystem simulation object
│   ├── ship.ts               # Ship simulation object
│   ├── types.ts              # TypeScript type definitions
│   ├── deterministic-rng.ts # Deterministic RNG implementation
│   └── goods.ts              # Goods catalog and definitions
├── package.json
├── tsconfig.json
└── README.md
```

## Features

### Star Systems

Each system has:
- **Population**: Millions of inhabitants (affects production/consumption)
- **Tech Level**: 1-7 (affects which goods can be produced/consumed)
- **World Type**: Affects production specialization and consumption patterns
- **Markets**: Per-good supply/demand with dynamic pricing
- **Independent RNG Seed**: Ensures deterministic behavior

### Markets

- **Production/Consumption**: Based on population and tech level
- **Dynamic Pricing**: Responds to supply/demand imbalance
- **Simple Pricing**: Base price + supply/demand adjustment based on inventory levels

### NPC Traders

- **Autonomous Behavior**: Buy low, sell high, travel between systems
- **Deterministic Decisions**: Based on RNG seed
- **Cargo Management**: Limited cargo space (100 units), manages inventory
- **Travel**: Simple timer-based travel (5 minutes between systems)
- **Phases**: Two phases - `at_station` (trading) and `traveling` (in transit)

### Player Features

- **Canonical Trading**: Players trade just like NPCs - all trades affect markets
- **Join Anytime**: Create a player ship and start trading
- **Market Impact**: Player trades affect prices and inventory just like NPC trades

## API Endpoints

### System Observation

```bash
# Get system snapshot (teleportation)
GET /api/system/{id}?action=snapshot

# Get system state
GET /api/system/{id}?action=state

# Manually trigger system tick
POST /api/system/{id}?action=tick
```

### Galaxy Management

```bash
# Initialize entire galaxy (20 systems + 100 NPCs)
POST /api/galaxy/initialize
Body: { "seed": "optional-seed" }

# Process ticks for all systems
POST /api/galaxy/tick
```

### Player Management

```bash
# Create or get player
POST /api/player
Body: { "name": "PlayerName" }

# Get player state
GET /api/player?name=PlayerName
```

### Ship Management

```bash
# Get ship state
GET /api/ship/{shipId}

# Trigger ship tick
POST /api/ship/{shipId}/tick

# Initiate travel to another system
POST /api/ship/{shipId}/travel
Body: { "destinationSystem": 5 }

# Execute trade
POST /api/ship/{shipId}/trade
Body: {
  "goodId": "food",
  "quantity": 10,
  "type": "buy" | "sell"
}
```

## Development

### Prerequisites

- Node.js 18+
- npm or yarn

### Setup

```bash
# Install dependencies
npm install

# Run local development server
npm run dev
# Server starts at http://localhost:3000

# Type check
npm run type-check

# Run tests
npm test

```

**Development:** Use `npm run dev` for local development with persistent file-based storage.

### Container Setup (Podman/Docker)

For continuous running, testing, and production deployment:

```bash
# Start container (runs on port 3001)
./container-run.sh up

# View logs
./container-run.sh logs

# Run tests in container
./container-run.sh test

# Stop container
./container-run.sh down
```

See [CONTAINER.md](./CONTAINER.md) for detailed container setup and usage instructions.

See [LOCAL_SERVER.md](./LOCAL_SERVER.md) for detailed local development instructions.  
See [TESTING.md](./TESTING.md) for comprehensive testing guide.

### Configuration

Set environment variables to configure:
- `GALAXY_SIZE`: Number of star systems (default: 20)
- `TICK_INTERVAL_MS`: Milliseconds per system tick (default: 30000 = 30 seconds)
- `TOTAL_NPCS`: Total number of NPC traders (default: 100)

## Deterministic Simulation

The simulation is fully deterministic:

1. Each system has a unique RNG seed
2. Events are processed in order
3. Ticks are computed deterministically based on time
4. Same initial state + event stream = same results

This enables:
- **Debugging**: Reproduce issues exactly
- **Rewind/Branch**: Experiment with different scenarios
- **Testing**: Verify behavior with known inputs

## System Economy Model

### Production/Consumption

- Production rate = `population * (techLevel + 1) * 16 / 1000` (adjusted by good definition, 1.5× for specialized goods)
- Consumption rate = `population * (techLevel + 1) * 14 / 1000` (adjusted by good definition, 2× for resort worlds)
- Galaxy-wide production slightly exceeds consumption to maintain healthy inventory levels
- Only goods matching tech level requirements are produced/consumed

### Pricing

- Base price adjusted by tech level and world type
- Simple model: base price + (inventory ratio - 1.0) * multiplier
- Price responds to inventory imbalance (supply/demand)
- Deterministic but responsive to market conditions

### Goods

10 goods with varying:
- Base prices
- Weight (cargo space)
- Volatility
- Tech level requirements

## Simplified Architecture

The codebase has been simplified to focus on core trading mechanics:

- **Removed**: Combat, encounters, microgames, skill system, node maps, hex grids, delivery jobs, armaments, complex monitoring/leaderboards, government types, complex request system
- **Simplified**: 
  - Travel is timer-based (5 minutes between systems)
  - Ships have 2 phases: `at_station` (trading) and `traveling` (in transit)
  - Pricing model: simple supply/demand adjustment
  - 20 systems, 100 NPCs (down from 256 systems, 8000 NPCs)
- **Core Focus**: Economic simulation, market dynamics, autonomous NPC trading, and canonical player trading

## Future Enhancements

- Scheduled events for automatic ticking
- NPC replacement system
- Event system (economic disruptions)
- Player ship integration
- Multi-player consistency (scale reads)

## License

MIT
