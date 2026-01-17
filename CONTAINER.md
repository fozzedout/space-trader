# Container Setup for Space Trader

This project can run in Podman or Docker containers for continuous operation, testing, and development.

## Prerequisites

- **Podman** (recommended) or **Docker**
- **podman-compose** or **docker-compose**

### Installing Podman (Fedora/RHEL)

```bash
sudo dnf install podman podman-compose
```

### Installing Docker (alternative)

```bash
sudo dnf install docker docker-compose
sudo systemctl enable --now docker
```

## Quick Start

### Using the Helper Script

```bash
# Start the container
./container-run.sh up

# View logs
./container-run.sh logs

# Run tests
./container-run.sh test

# Stop the container
./container-run.sh down
```

### Using Podman Compose Directly

```bash
# Start
podman-compose up -d

# View logs
podman-compose logs -f

# Stop
podman-compose down
```

### Using Docker Compose

```bash
# Start
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## Configuration

The container runs on **port 3001** by default. You can configure it via environment variables:

- `PORT` - Server port (default: 3001)
- `GALAXY_SIZE` - Number of star systems (default: 20)
- `TOTAL_NPCS` - Number of NPC traders (default: 100)
- `TICK_INTERVAL_MS` - Simulation tick interval in milliseconds (default: 30000)

### Example: Custom Configuration

Create a `.env` file or set environment variables:

```bash
export GALAXY_SIZE=30
export TOTAL_NPCS=150
podman-compose up -d
```

Or edit `podman-compose.yml`:

```yaml
environment:
  - PORT=3001
  - GALAXY_SIZE=30
  - TOTAL_NPCS=150
```

## Data Persistence

The container stores data in:
- `./data/` - SQLite database and persistent state
- `./logs/` - Application logs

These directories are mounted as volumes, so data persists across container restarts.

## Available Commands

### Helper Script (`./container-run.sh`)

| Command | Description |
|---------|-------------|
| `up`, `start` | Start the container |
| `down`, `stop` | Stop the container |
| `restart` | Restart the container |
| `logs` | View container logs (follow mode) |
| `build` | Build the container image |
| `rebuild` | Rebuild the container image (no cache) |
| `shell`, `exec` | Open shell in container |
| `test` | Run tests in container |
| `test:watch` | Run tests in watch mode |
| `status`, `ps` | Show container status |
| `clean` | Remove containers and volumes |

### NPM Scripts

```bash
npm run container:up      # Start container
npm run container:down   # Stop container
npm run container:logs   # View logs
npm run container:test   # Run tests
npm run container:build  # Build image
```

## Accessing the Application

Once running, access:

- **API**: http://localhost:3001/api/health
- **Dev Interface**: http://localhost:3001/dev
- **Player Interface**: http://localhost:3001/player
- **Markets**: http://localhost:3001/markets

## Development in Container

### Running Tests

```bash
# Run all tests
./container-run.sh test

# Run tests in watch mode
./container-run.sh test:watch

# Or directly
podman exec space-trader npm test
```

### Opening a Shell

```bash
./container-run.sh shell

# Or directly
podman exec -it space-trader /bin/bash
```

### Rebuilding After Code Changes

```bash
# Rebuild and restart
./container-run.sh rebuild
./container-run.sh restart
```

## Production Build

The container builds a production version:

1. Type checks TypeScript
2. Compiles TypeScript to JavaScript
3. Runs the compiled `dist/local-server.js`

For development with hot reload, you can override the CMD:

```yaml
# In podman-compose.yml, change:
command: npm run dev
```

## Troubleshooting

### Port Already in Use

If port 3001 is already in use:

```bash
# Change port in podman-compose.yml
ports:
  - "3002:3001"  # Host:Container
```

### Container Won't Start

Check logs:

```bash
./container-run.sh logs
```

### Database Issues

If the database is corrupted:

```bash
# Stop container
./container-run.sh down

# Remove data (WARNING: deletes all game state)
rm -rf data/

# Restart
./container-run.sh up
```

### Permission Issues

If you see permission errors with volumes:

```bash
# Fix ownership (adjust user/group as needed)
sudo chown -R $USER:$USER data/ logs/
```

## Continuous Running

For continuous operation, the container is configured with:

- `restart: unless-stopped` - Automatically restarts on failure
- Health check - Monitors container health
- Volume mounts - Data persists across restarts

### Systemd Service (Optional)

Create `/etc/systemd/system/space-trader.service`:

```ini
[Unit]
Description=Space Trader Container
After=network.target

[Service]
Type=forking
ExecStart=/usr/bin/podman-compose -f /path/to/space-trader/podman-compose.yml up -d
ExecStop=/usr/bin/podman-compose -f /path/to/space-trader/podman-compose.yml down
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl enable space-trader
sudo systemctl start space-trader
```

## Building from Scratch

```bash
# Build image
podman build -t space-trader -f Containerfile .

# Run manually
podman run -d \
  --name space-trader \
  -p 3001:3001 \
  -v ./data:/app/.local-storage \
  -v ./logs:/app/logs \
  -e PORT=3001 \
  space-trader
```
