# Space Trader - Galaxy-Scale Market Simulator

A local Node.js live market simulator inspired by Elite, featuring deterministic simulation, system isolation, and thousands of NPC traders.

## Architecture

### Core Design Principles

1. **System Isolation**: Each of 256 star systems is an economic island with no instantaneous goods/information transfer
2. **Deterministic Simulation**: Reproducible results given the same initial state and event stream
3. **FTL Travel Only**: Only ships travel FTL (chaotic warp); goods and information move only via ships
4. **Tick-Based Continuous Time**: Markets are continuous-time but computed in discrete ticks (default: 1 minute)
5. **Single Writer Per System**: Each system is simulated independently with a single writer

### Local Architecture

- **Simulation Objects**:
  - `StarSystem`: One per system (256 total), handles economy simulation
  - `Ship`: One per NPC/player ship, handles trading and travel
- **HTTP Server**: Local API endpoint for observation, teleportation, and experimental trades
- **Deterministic RNG**: Uses `seedrandom` for reproducible random number generation

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
- **Tech Level**: 0-7 (affects which goods can be produced/consumed)
- **Government Type**: Affects market behavior
- **Markets**: Per-good supply/demand with dynamic pricing
- **Independent RNG Seed**: Ensures deterministic behavior

### Markets

- **Production/Consumption**: Based on population and tech level
- **Dynamic Pricing**: Responds to supply/demand imbalance
- **Inventory Limits**: Station capacity prevents infinite storage
- **Price History**: Tracks price changes over time

### NPC Traders

- **Autonomous Behavior**: Buy low, sell high, travel between systems
- **Deterministic Decisions**: Based on RNG seed
- **Cargo Management**: Limited cargo space, manages inventory
- **Travel**: Takes time (default: 5 minutes), ships can be lost

### Player Features

- **Observation Mode**: "Teleport" to any system to observe markets
- **Experimental Trades**: Run unlimited trades without affecting canonical simulation
- **Non-Canonical**: Player actions don't affect the deterministic NPC simulation

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
# Initialize entire galaxy (256 systems + NPCs)
POST /api/galaxy/initialize
Body: { "seed": "optional-seed" }

# Process ticks for all systems
POST /api/galaxy/tick
```

### Experimental Trading

```bash
# Run experimental trade (non-canonical)
POST /api/experimental/trade
Body: {
  "systemId": 0,
  "goodId": "food",
  "quantity": 10,
  "type": "buy" | "sell"
}
```

### Ship Management

```bash
# Get ship state
GET /api/ship/{shipId}

# Trigger ship tick
POST /api/ship/{shipId}
Body: { "action": "tick" }
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

See [LOCAL_SERVER.md](./LOCAL_SERVER.md) for detailed local development instructions.  
See [TESTING.md](./TESTING.md) for comprehensive testing guide.

### Configuration

Set environment variables to configure:
- `GALAXY_SIZE`: Number of star systems (default: 256)
- `TICK_INTERVAL_MS`: Milliseconds per tick (default: 60000 = 1 minute)
- `MAX_NPC_TRADERS_PER_SYSTEM`: NPCs per system (default: 50)

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

- Base price adjusted by tech level
- Price responds to inventory imbalance (supply/demand)
- Volatility factor adds randomness while maintaining determinism
- External price information spreads via ship arrivals (rumors)

### Goods

10 goods with varying:
- Base prices
- Weight (cargo space)
- Volatility
- Tech level requirements

## Future Enhancements

- Scheduled events for automatic ticking
- Ship loss mechanics (dangerous travel)
- NPC replacement system
- Event system (economic disruptions)
- Player ship integration
- Multi-player consistency (scale reads)

## License

MIT
