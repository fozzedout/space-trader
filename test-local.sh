#!/bin/bash

# Local testing script for space-trader
# Make sure the dev server is running: npm run dev

BASE_URL="${1:-http://localhost:3000}"

echo "🚀 Testing Space Trader API at $BASE_URL"
echo ""

echo "1️⃣  Initializing galaxy..."
INIT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/galaxy/initialize" \
  -H "Content-Type: application/json" \
  -d '{"seed": "test-'$(date +%s)'"}')

echo "$INIT_RESPONSE" | jq '.'
echo ""

echo "2️⃣  Waiting for initialization to complete..."
sleep 3

echo ""
echo "3️⃣  Getting system 0 snapshot..."
SNAPSHOT=$(curl -s "$BASE_URL/api/system/0?action=snapshot")
echo "$SNAPSHOT" | jq '{
  system: .state.name,
  population: .state.population,
  techLevel: .state.techLevel,
  markets: .markets | to_entries | map({good: .key, price: .value.price, inventory: .value.inventory}) | .[0:3]
}'

echo ""
echo "4️⃣  Processing a tick..."
TICK_RESPONSE=$(curl -s -X POST "$BASE_URL/api/system/0?action=tick")
echo "$TICK_RESPONSE" | jq '.'

echo ""
echo "5️⃣  Getting updated snapshot (prices may have changed)..."
SNAPSHOT2=$(curl -s "$BASE_URL/api/system/0?action=snapshot")
echo "$SNAPSHOT2" | jq '{
  tick: .state.currentTick,
  markets: .markets | to_entries | map({good: .key, price: .value.price, inventory: .value.inventory}) | .[0:3]
}'

echo ""
echo "6️⃣  Testing experimental trade (non-canonical)..."
TRADE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/experimental/trade" \
  -H "Content-Type: application/json" \
  -d '{
    "systemId": 0,
    "goodId": "food",
    "quantity": 5,
    "type": "buy"
  }')
echo "$TRADE_RESPONSE" | jq '.'

echo ""
echo "7️⃣  Checking an NPC trader..."
SHIP_RESPONSE=$(curl -s "$BASE_URL/api/ship/npc-0")
echo "$SHIP_RESPONSE" | jq '{
  name: .name,
  system: .currentSystem,
  credits: .credits,
  cargo: .cargo
}'

echo ""
echo "✅ Testing complete!"
echo ""
echo "💡 Tip: Use 'npm run dev' in another terminal to see server logs"
