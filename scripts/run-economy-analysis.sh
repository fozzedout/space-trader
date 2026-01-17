#!/bin/bash
# Main script to run 30-minute economy analysis

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo "=========================================="
echo "Economy Analysis Pipeline"
echo "=========================================="
echo ""

# Check if server is running
if ! curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "Starting local server in background..."
    npm run dev > /tmp/space-trader-server.log 2>&1 &
    SERVER_PID=$!
    echo "Server started with PID: $SERVER_PID"
    
    # Wait for server to be ready
    echo "Waiting for server to be ready..."
    for i in {1..30}; do
        if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
            echo "Server is ready!"
            break
        fi
        sleep 1
    done
    
    if ! curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
        echo "ERROR: Server failed to start"
        kill $SERVER_PID 2>/dev/null || true
        exit 1
    fi
else
    echo "Server is already running"
    SERVER_PID=""
fi

# Step 1: Collect data
echo ""
echo "Step 1: Collecting economy data (30 minutes)..."
echo "This will take approximately 30 minutes"
echo ""

npx tsx scripts/collect-economy-data.ts

# Find the most recent data file
DATA_FILE=$(ls -t economy-data/economy-data-*.json 2>/dev/null | head -1)

if [ -z "$DATA_FILE" ]; then
    echo "ERROR: No data file found"
    exit 1
fi

echo ""
echo "Data collection complete: $DATA_FILE"
echo ""

# Step 2: Analyze with LM Studio
echo "Step 2: Analyzing data with LM Studio..."
echo ""

# Check if LM Studio is accessible
if ! curl -s http://localhost:1234/v1/models > /dev/null 2>&1; then
    echo "WARNING: LM Studio API not accessible at http://localhost:1234"
    echo "Make sure LM Studio is running with the API enabled"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

npx tsx scripts/analyze-with-llm.ts "$DATA_FILE"

# Find the most recent report
REPORT_FILE=$(ls -t economy-reports/economy-report-*.md 2>/dev/null | head -1)

if [ -n "$REPORT_FILE" ]; then
    echo ""
    echo "=========================================="
    echo "Analysis Complete!"
    echo "=========================================="
    echo "Data file: $DATA_FILE"
    echo "Report: $REPORT_FILE"
    echo ""
    echo "To view the report:"
    echo "  cat $REPORT_FILE"
    echo "  or"
    echo "  less $REPORT_FILE"
    echo ""
fi

# Cleanup: stop server if we started it
if [ -n "$SERVER_PID" ]; then
    echo "Stopping server (PID: $SERVER_PID)..."
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
fi

echo "Done!"
