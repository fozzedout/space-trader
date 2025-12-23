# Economic Model Improvements Proposal

## Current Issues

1. **Price Spirals**: Linear imbalance calculation causes extreme price swings
2. **No Mean Reversion**: Prices don't naturally return to equilibrium
3. **Base Price Dependency**: Price changes based on base price, not current price
4. **No Market Depth**: All markets equally volatile regardless of size
5. **No Transaction Impact**: Trades affect inventory but price response is delayed

## Proposed Solutions

### 1. Non-Linear Response Curve (Sigmoid/Tanh)

Replace linear imbalance with a sigmoid curve to prevent extreme swings:

```typescript
// Instead of: imbalance = 1 - inventoryRatio
// Use sigmoid curve for smoother response
const normalizedInventory = (market.inventory / STATION_CAPACITY) * 2 - 1; // -1 to 1
const imbalance = -Math.tanh(normalizedInventory * 3); // Smooth S-curve, clamped to [-1, 1]
```

**Benefits**: 
- Prevents runaway price spirals
- Smooth transitions at extremes
- More realistic market behavior

### 2. Mean Reversion (Price Drift Toward Base)

Add a force that pulls prices back toward base price:

```typescript
const meanReversionStrength = 0.02; // 2% per tick toward base
const priceDeviation = (market.price - market.basePrice) / market.basePrice;
const reversionForce = -priceDeviation * meanReversionStrength * market.price;
```

**Benefits**:
- Prices naturally stabilize
- Prevents permanent price floors/ceilings
- Creates dynamic equilibrium

### 3. Percentage-Based Price Changes

Change calculation to use current price, not base price:

```typescript
// Instead of: priceChange = imbalance * elasticity * basePrice
// Use: priceChange = imbalance * elasticity * currentPrice
const priceChange = imbalance * priceElasticity * market.price;
```

**Benefits**:
- Prevents exponential growth
- More realistic market dynamics
- Self-limiting price movements

### 4. Market Depth (Volatility Based on Market Size)

Larger markets (higher production/consumption) should be less volatile:

```typescript
const marketVolume = market.production + market.consumption;
const marketDepth = Math.min(1.0, marketVolume / 100); // Normalize to 0-1
const effectiveElasticity = priceElasticity * (0.3 + 0.7 * marketDepth); // 30-100% of base
```

**Benefits**:
- Small markets more volatile (realistic)
- Large markets more stable
- Prevents production worlds from crashing prices

### 5. Transaction Impact (Immediate Price Response)

When trades occur, apply immediate price adjustment:

```typescript
// In handleTrade, after updating inventory:
const tradeImpact = (quantity / STATION_CAPACITY) * 0.1; // 10% of capacity = 0.1 impact
const priceAdjustment = type === "buy" 
  ? tradeImpact * market.price * 0.05  // Buy increases price slightly
  : -tradeImpact * market.price * 0.05; // Sell decreases price slightly
market.price = Math.max(
  market.basePrice * minMultiplier,
  Math.min(market.basePrice * maxMultiplier, market.price + priceAdjustment)
);
```

**Benefits**:
- Immediate feedback for traders
- Prevents inventory manipulation
- More dynamic pricing

### 6. Inventory Buffer Zones

Add "buffer zones" where price changes are damped:

```typescript
const inventoryRatio = market.inventory / STATION_CAPACITY;
let dampingFactor = 1.0;

if (inventoryRatio < 0.1) {
  // Very low inventory - reduce price increase rate
  dampingFactor = 0.5 + (inventoryRatio / 0.1) * 0.5; // 0.5 to 1.0
} else if (inventoryRatio > 0.9) {
  // Very high inventory - reduce price decrease rate
  dampingFactor = 0.5 + ((1 - inventoryRatio) / 0.1) * 0.5; // 0.5 to 1.0
}

const priceChange = imbalance * priceElasticity * market.price * dampingFactor;
```

**Benefits**:
- Prevents extreme price swings at inventory limits
- More stable markets
- Realistic supply/demand curves

## Recommended Implementation Order

1. **Phase 1 (Critical)**: Non-linear response + Mean reversion
   - Prevents spirals
   - Creates stability

2. **Phase 2 (Important)**: Percentage-based changes + Market depth
   - Prevents exponential growth
   - Realistic market behavior

3. **Phase 3 (Enhancement)**: Transaction impact + Buffer zones
   - Immediate feedback
   - Fine-tuned damping

## Configuration Parameters

Add to `BalanceConfig`:

```typescript
interface BalanceConfig {
  // Existing
  priceElasticity: number;
  maxPriceChangePerTick: number;
  
  // New
  meanReversionStrength: number;      // 0.01-0.05 (1-5% per tick)
  marketDepthFactor: number;          // 0.3-1.0 (volatility scaling)
  transactionImpactMultiplier: number; // 0.01-0.1 (trade impact)
  inventoryDampingThreshold: number;  // 0.1-0.2 (buffer zone size)
  sigmoidSteepness: number;           // 2-5 (curve shape)
}
```

## Example: Combined Formula

```typescript
// 1. Calculate non-linear imbalance
const normalizedInventory = (market.inventory / STATION_CAPACITY) * 2 - 1;
const imbalance = -Math.tanh(normalizedInventory * sigmoidSteepness);

// 2. Apply market depth
const marketVolume = market.production + market.consumption;
const marketDepth = Math.min(1.0, marketVolume / 100);
const effectiveElasticity = priceElasticity * (0.3 + 0.7 * marketDepth);

// 3. Calculate supply/demand price change
const supplyDemandChange = imbalance * effectiveElasticity * market.price;

// 4. Calculate mean reversion
const priceDeviation = (market.price - market.basePrice) / market.basePrice;
const reversionChange = -priceDeviation * meanReversionStrength * market.price;

// 5. Apply damping for extreme inventory
const inventoryRatio = market.inventory / STATION_CAPACITY;
let dampingFactor = 1.0;
if (inventoryRatio < inventoryDampingThreshold) {
  dampingFactor = 0.5 + (inventoryRatio / inventoryDampingThreshold) * 0.5;
} else if (inventoryRatio > (1 - inventoryDampingThreshold)) {
  dampingFactor = 0.5 + ((1 - inventoryRatio) / inventoryDampingThreshold) * 0.5;
}

// 6. Combine and apply
const totalChange = (supplyDemandChange + reversionChange) * dampingFactor;
const cappedChange = Math.max(
  -maxChange * market.price,
  Math.min(maxChange * market.price, totalChange)
);
market.price = Math.max(
  market.basePrice * minMultiplier,
  Math.min(market.basePrice * maxMultiplier, market.price + cappedChange)
);
```

## Expected Results

- **Stable prices**: Mean reversion prevents permanent extremes
- **Realistic volatility**: Market depth creates varied behavior
- **No spirals**: Non-linear response prevents runaway prices
- **Dynamic equilibrium**: Prices oscillate around base price
- **Trade feedback**: Immediate price response to transactions

