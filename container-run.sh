#!/bin/bash
# Container run script for Space Trader

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Default to podman, but allow docker override
CONTAINER_CMD="${CONTAINER_CMD:-podman}"
COMPOSE_CMD="${CONTAINER_CMD}-compose"

# Check if command exists
if ! command -v "$CONTAINER_CMD" &> /dev/null; then
    echo "Error: $CONTAINER_CMD not found. Install it or set CONTAINER_CMD=docker"
    exit 1
fi

# Check if compose command exists
if ! command -v "$COMPOSE_CMD" &> /dev/null; then
    echo "Error: $COMPOSE_CMD not found. Install it or set CONTAINER_CMD=docker"
    exit 1
fi

# Create data and logs directories
mkdir -p data logs

# Parse command
case "${1:-up}" in
    up|start)
        echo "🚀 Starting Space Trader container..."
        $COMPOSE_CMD up -d
        echo ""
        echo "✅ Container started!"
        echo "   Access at: http://localhost:3001"
        echo "   Health check: http://localhost:3001/api/health"
        echo "   Dev interface: http://localhost:3001/dev"
        echo ""
        echo "View logs: $0 logs"
        echo "Stop: $0 stop"
        ;;
    down|stop)
        echo "🛑 Stopping Space Trader container..."
        $COMPOSE_CMD down
        ;;
    restart)
        echo "🔄 Restarting Space Trader container..."
        $COMPOSE_CMD restart
        ;;
    logs)
        $COMPOSE_CMD logs -f space-trader
        ;;
    build)
        echo "🔨 Building Space Trader container..."
        $COMPOSE_CMD build
        ;;
    rebuild)
        echo "🔨 Rebuilding Space Trader container..."
        $COMPOSE_CMD build --no-cache
        ;;
    shell|exec)
        echo "🐚 Opening shell in container..."
        # Try bash first, fall back to sh
        $CONTAINER_CMD exec -it space-trader /bin/bash 2>/dev/null || \
        $CONTAINER_CMD exec -it space-trader /bin/sh
        ;;
    test)
        echo "🧪 Running tests in container..."
        $CONTAINER_CMD exec space-trader npm test
        ;;
    test:watch)
        echo "🧪 Running tests in watch mode..."
        $CONTAINER_CMD exec -it space-trader npm run test:watch
        ;;
    status|ps)
        $COMPOSE_CMD ps
        ;;
    clean)
        echo "🧹 Cleaning up containers and volumes..."
        $COMPOSE_CMD down -v
        rm -rf data logs
        echo "✅ Cleaned up!"
        ;;
    *)
        echo "Usage: $0 {up|down|restart|logs|build|rebuild|shell|test|test:watch|status|clean}"
        echo ""
        echo "Commands:"
        echo "  up, start      - Start the container"
        echo "  down, stop     - Stop the container"
        echo "  restart        - Restart the container"
        echo "  logs           - View container logs"
        echo "  build          - Build the container image"
        echo "  rebuild        - Rebuild the container image (no cache)"
        echo "  shell, exec    - Open shell in container"
        echo "  test           - Run tests in container"
        echo "  test:watch     - Run tests in watch mode"
        echo "  status, ps     - Show container status"
        echo "  clean          - Remove containers and volumes"
        echo ""
        echo "Environment variables:"
        echo "  CONTAINER_CMD  - Container command (podman or docker, default: podman)"
        exit 1
        ;;
esac
