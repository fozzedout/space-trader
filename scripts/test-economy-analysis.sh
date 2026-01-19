#!/bin/bash
# Test script to run 5-minute economy analysis

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo "=========================================="
echo "Economy Analysis Test (5 minutes)"
echo "=========================================="
echo ""

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
HEALTH_URL="${SERVER_URL%/}/api/health"
DEFAULT_SERVER_URL="http://localhost:3000"

check_url() {
    local url="$1"
    if command -v curl > /dev/null 2>&1; then
        curl -s "$url" > /dev/null 2>&1
    else
        node -e "require('http').get('$url', (r) => {process.exit(r.statusCode === 200 ? 0 : 1);}).on('error', () => process.exit(1));"
    fi
}

# Check if server is running
if ! check_url "$HEALTH_URL"; then
    if [ "$SERVER_URL" != "$DEFAULT_SERVER_URL" ]; then
        echo "ERROR: Server not reachable at $SERVER_URL"
        exit 1
    fi
    echo "Starting local server in background..."
    npm run dev > /tmp/space-trader-server-test.log 2>&1 &
    SERVER_PID=$!
    echo "Server started with PID: $SERVER_PID"
    
    # Wait for server to be ready
    echo "Waiting for server to be ready..."
    for i in {1..30}; do
        if check_url "$HEALTH_URL"; then
            echo "Server is ready!"
            break
        fi
        sleep 1
    done
    
    if ! check_url "$HEALTH_URL"; then
        echo "ERROR: Server failed to start"
        kill $SERVER_PID 2>/dev/null || true
        exit 1
    fi
else
    echo "Server is already running at $SERVER_URL"
    SERVER_PID=""
fi

# Step 1: Collect data (5 minutes in test mode)
echo ""
echo "Step 1: Collecting economy data (5 minutes - TEST MODE)..."
echo ""

TEST_MODE=true SERVER_URL="$SERVER_URL" npx tsx scripts/collect-economy-data.ts --test

# Find the most recent data file
DATA_FILE=$(ls -t economy-data/economy-data-*.json 2>/dev/null | head -1)

if [ -z "$DATA_FILE" ]; then
    echo "ERROR: No data file found"
    if [ -n "$SERVER_PID" ]; then
        kill $SERVER_PID 2>/dev/null || true
    fi
    exit 1
fi

echo ""
echo "Data collection complete: $DATA_FILE"
echo ""

# Step 2: Analyze with LM Studio (optional in test mode)
echo "Step 2: Analyzing data with LM Studio..."
echo ""

# Check if LM Studio is accessible
if ! check_url "http://localhost:1234/v1/models"; then
    echo "⚠️  WARNING: LM Studio API not accessible at http://localhost:1234"
    echo "Skipping LLM analysis in test mode (this is optional)"
    echo ""
    echo "Data file saved: $DATA_FILE"
    echo "You can analyze it later with:"
    echo "  npx tsx scripts/analyze-with-llm.ts $DATA_FILE"
    echo ""
else
    npx tsx scripts/analyze-with-llm.ts "$DATA_FILE"
    
    # Find the most recent report
    REPORT_FILE=$(ls -t economy-reports/economy-report-*.md 2>/dev/null | head -1)
    
    if [ -n "$REPORT_FILE" ]; then
        echo ""
        echo "=========================================="
        echo "Test Complete!"
        echo "=========================================="
        echo "Data file: $DATA_FILE"
        echo "Report: $REPORT_FILE"
        echo ""
    fi
fi

# Cleanup: stop server if we started it
if [ -n "$SERVER_PID" ]; then
    echo "Stopping server (PID: $SERVER_PID)..."
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
fi

echo ""
echo "✅ Test pipeline completed successfully!"
