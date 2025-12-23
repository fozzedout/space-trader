# Local Node.js Development Server

This project includes a **local Node.js HTTP server** that runs the simulation logic with persistent file-based storage. This is the primary development environment.

## Quick Start

```bash
# Start the local server
npm run local:dev

# Server runs on http://localhost:3000
# (or PORT environment variable if set)
```

## What It Does

- **Same API endpoints** as the simulation engine
- **Same simulation logic** - uses the existing `StarSystem` and `Ship` classes
- **Persistent file-based storage** - data survives server restarts (stored in `.local-storage/` directory)
- **Fast iteration** - no external deployment needed for development

## Dev Interface

**Access the full dev testing interface at:**
```
http://localhost:3000/dev
```

This provides a complete web UI for testing all API endpoints, including:
- Galaxy initialization and ticking
- System operations (snapshot, state, tick)
- Ship operations and listing
- Experimental trading
- Quick test suites
- Price comparisons and market analysis

## API Endpoints

All endpoints work exactly like the local simulation server:

- `GET /` - API info
- `GET /api/health` - Health check
- `GET /dev` - **Full dev testing interface** (web UI)
- `POST /api/galaxy/initialize` - Initialize galaxy
- `POST /api/galaxy/tick` - Tick all systems
- `GET /api/system/{id}?action=snapshot` - Get system snapshot
- `GET /api/system/{id}?action=state` - Get system state
- `POST /api/system/{id}?action=tick` - Tick a system
- `GET /api/ship/{id}` - Get ship state
- `POST /api/ship/{id}` - Ship actions (e.g., `{ "action": "tick" }`)
- `POST /api/experimental/trade` - Experimental trade

## Environment Variables

```bash
PORT=3000                    # Server port (default: 3000)
GALAXY_SIZE=256             # Number of systems (default: 256)
TICK_INTERVAL_MS=60000      # Tick interval in ms (default: 60000)
MAX_NPC_TRADERS_PER_SYSTEM=50  # NPCs per system (default: 50)
```

## Example Usage

```bash
# Start server
npm run local:dev

# In another terminal:

# Health check
curl http://localhost:3000/api/health

# Initialize galaxy
curl -X POST http://localhost:3000/api/galaxy/initialize \
  -H "Content-Type: application/json" \
  -d '{"seed": "test-123"}'

# Get system 0 snapshot
curl http://localhost:3000/api/system/0?action=snapshot

# Tick all systems
curl -X POST http://localhost:3000/api/galaxy/tick

# Get ship state
curl http://localhost:3000/api/ship/npc-0
```

## How It Works

1. **File-based storage** (`src/local-storage.ts`) - Local persistent SQLite storage in `.local-storage/`
2. **Persistent simulation objects** - Creates `StarSystem` and `Ship` instances with persistent storage
3. **HTTP Server** (`src/local-server.ts`) - Node.js HTTP server that routes requests to the same handlers

## Storage

Data is persisted in a SQLite database at `.local-storage/durable-objects.db`:
- Each system/ship has its own storage namespace
- Data survives server restarts
- Database is automatically created and managed
- To reset: delete the `.local-storage/` directory

**Note:** The storage API provides a key-value interface, backed by SQLite tables.

## When to Use

✅ **Use local server for:**
- All development and testing
- Debugging simulation logic
- Rapid iteration
- Testing persistence (data survives restarts)

## Building for Production

If you want to build the local server:

```bash
npm run local:build
node dist/local-server.js
```

This compiles TypeScript to JavaScript first, then runs it with Node.
