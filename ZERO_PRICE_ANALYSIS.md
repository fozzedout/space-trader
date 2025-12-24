# Zero Price Analysis: System 88 Machinery

## Problem Summary

System 88 machinery price dropped from base price of **174.85** to **23.28** (13.3% of base), and inventory reached zero. The root cause is a **backwards inventory pressure calculation** in the Smart Scoring system.

## Root Cause

### The Bug: Inverted Inventory Pressure Logic

In `src/ship.ts` lines 1863-1869, the inventory pressure calculation is **backwards**:

```typescript
// 4. Inventory pressure - market need (20% weight)
// Higher inventory relative to expected stock = more pressure to trade
const expectedStock = Math.max(1, (market.production + market.consumption) * 10);
const inventoryRatio = market.inventory / expectedStock;
// Bonus up to 2x when inventory is high (needs trading)
const pressureMultiplier = Math.min(2.0, inventoryRatio / 0.5);
const pressureScore = pressureMultiplier * weights.inventoryPressure;
```

### What's Wrong

**Current (broken) behavior:**
- **Low inventory** (ratio = 0.011) → pressure multiplier = 0.022 → **LOW score** → traders **DON'T prioritize buying**
- **High inventory** (ratio = 1.0) → pressure multiplier = 2.0 → **HIGH score** → traders **DO prioritize buying**

This is backwards! When inventory is LOW, traders should be incentivized to BUY and bring goods in. When inventory is HIGH, traders should be incentivized to SELL and remove goods.

### System 88 Machinery Example

- **Production**: 7.89 units/tick
- **Consumption**: 14.69 units/tick  
- **Net**: -6.8 units/tick (consumption exceeds production)
- **Expected stock** (scoring): 225.79 units
- **Actual inventory**: 2.55 units
- **Inventory ratio**: 0.0113
- **Pressure multiplier**: 0.0226 (very low!)

Result: Traders don't prioritize buying machinery at system 88 because the pressure score is low, even though inventory is critically low and consumption exceeds production.

## Impact

1. **Price collapse**: Price dropped from 174.85 to 23.28 (87% drop) because:
   - Low inventory → price calculation sees extreme shortage
   - Traders don't buy (low pressure score) → no goods brought in
   - Consumption exceeds production → inventory drains to zero
   - Price keeps dropping due to low inventory ratio

2. **Zero inventory**: Inventory reached zero because:
   - Production (7.89) < Consumption (14.69)
   - Traders not incentivized to buy (low pressure score)
   - No goods imported to offset deficit

## Fix Required

The inventory pressure calculation should be **inverted**:

```typescript
// 4. Inventory pressure - market need (20% weight)
// LOW inventory = HIGH pressure to BUY (bring goods in)
// HIGH inventory = LOW pressure to BUY (market is saturated)
const expectedStock = Math.max(1, (market.production + market.consumption) * 10);
const inventoryRatio = market.inventory / expectedStock;
// Invert: low ratio (low inventory) = high multiplier (high pressure to buy)
// Map from [0, 1] to [2.0, 0.2] where 0 = max pressure, 1 = min pressure
const pressureMultiplier = 2.0 - (inventoryRatio * 1.8); // 2.0 when ratio=0, 0.2 when ratio=1
const pressureScore = pressureMultiplier * weights.inventoryPressure;
```

This ensures:
- **Low inventory** (ratio = 0.01) → multiplier = 1.98 → **HIGH score** → traders **DO prioritize buying**
- **High inventory** (ratio = 1.0) → multiplier = 0.2 → **LOW score** → traders **DON'T prioritize buying**

## Additional Issues

1. **Mismatch in expected stock calculations**:
   - Price update uses `baselineStock = 2000` (fixed)
   - Smart scoring uses `(production + consumption) * 10` (dynamic)
   - This inconsistency may cause other issues

2. **Price floor**: Price can't go below `basePrice * 0.1` (17.49 for machinery), but it got very close (23.28), indicating severe market imbalance.
