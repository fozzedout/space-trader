#!/bin/bash
# Quick test - just verify reset, init, and a few data points

set -e

cd "$(dirname "$0")/.."

echo "Quick Pipeline Test"
echo "==================="
echo ""

# Check server
if ! curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "❌ Server not running. Start with: npm run dev"
    exit 1
fi

echo "✅ Server is running"
echo ""

# Test reset
echo "Testing reset..."
RESET_RESULT=$(curl -s -X POST http://localhost:3000/api/galaxy/reset)
if echo "$RESET_RESULT" | grep -q "reset complete"; then
    echo "✅ Reset works"
else
    echo "❌ Reset failed: $RESET_RESULT"
    exit 1
fi

# Test initialize
echo "Testing initialize..."
INIT_RESULT=$(curl -s -X POST http://localhost:3000/api/galaxy/initialize -H "Content-Type: application/json" -d '{"seed":"test"}')
if echo "$INIT_RESULT" | grep -q "systemsInitialized"; then
    echo "✅ Initialize works"
else
    echo "❌ Initialize failed: $INIT_RESULT"
    exit 1
fi

# Test get system snapshot
echo "Testing data collection..."
SNAPSHOT=$(curl -s "http://localhost:3000/api/system/0?action=snapshot")
if echo "$SNAPSHOT" | grep -q "state"; then
    echo "✅ Data collection works"
else
    echo "❌ Data collection failed"
    exit 1
fi

echo ""
echo "✅ All basic operations work!"
echo ""
echo "Full test: npm run test:economy (runs 5 minutes)"
