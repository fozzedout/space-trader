# Usage Examples

## Initialize the Galaxy

```bash
curl -X POST http://localhost:3000/api/galaxy/initialize \
  -H "Content-Type: application/json" \
  -d '{"seed": "my-galaxy-seed-12345"}'
```

This creates:
- 256 star systems with randomized properties
- ~12,800 NPC traders (50 per system)

## Observe a Star System

```bash
# Get full snapshot of system 0
curl http://localhost:3000/api/system/0?action=snapshot

# Response includes:
# - System state (population, tech level, government)
# - All market prices and inventory
# - Ships currently in system
# - Price history
```

## Run Experimental Trade

```bash
# Check what a trade would cost (doesn't affect simulation)
curl -X POST http://localhost:3000/api/experimental/trade \
  -H "Content-Type: application/json" \
  -d '{
    "systemId": 0,
    "goodId": "food",
    "quantity": 10,
    "type": "buy"
  }'
```

## Process Simulation Ticks

```bash
# Manually trigger ticks for all systems
curl -X POST http://localhost:3000/api/galaxy/tick

# Or tick a specific system
curl -X POST http://localhost:3000/api/system/0?action=tick
```

## Get Ship Information

```bash
# Get state of an NPC trader
curl http://localhost:3000/api/ship/npc-0

# Response includes:
# - Current location
# - Cargo
# - Credits
# - Travel status
```

## Monitoring Market Trends

```bash
# Get price history for a good in a system
curl http://localhost:3000/api/system/0?action=snapshot | jq '.priceHistory.food'

# Example response:
# [
#   { "tick": 0, "price": 10.5 },
#   { "tick": 1, "price": 10.3 },
#   { "tick": 2, "price": 10.8 },
#   ...
# ]
```

## Finding Arbitrage Opportunities

```bash
# Compare prices across systems
for i in {0..5}; do
  echo "System $i:"
  curl -s http://localhost:3000/api/system/$i?action=snapshot | \
    jq '.markets.food.price'
done
```
