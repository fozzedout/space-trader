# Trading Incentive Solutions

## Problem Statement

When consumption > production globally, NPCs optimize for **profit margin percentage** rather than considering other factors. This leads to:

1. **Cheaper goods ignored**: Food (base 10 cr) might offer 10% margin = 1 cr profit, while computers (base 1000 cr) offer 10% = 100 cr profit. NPCs prefer computers even if food is profitable.

2. **Systems go to zero**: Cheaper goods accumulate inventory at producer systems because NPCs skip them in favor of higher-value goods, even when cheaper goods have profitable destinations.

3. **Market imbalance**: In a consumption > production world, cheaper goods need MORE trading activity (higher volume) to balance markets, but NPCs optimize for margin percentage, not volume.

## Root Cause Analysis

Current NPC selection logic (`ship.ts:1866-1988`):
- Sorts candidates by `priceRatio` (cheaper first)
- Takes top 5 candidates
- Checks profitability (margin ≥ 0.1%)
- Selects first profitable candidate

**Problem**: This optimizes for margin percentage, not:
- Total profit potential (margin × affordable quantity)
- Profit per cargo space
- Profit per credit invested
- Market velocity needs

## Solution Ideas

### 1. Multi-Factor Scoring System (Recommended)

Replace simple `priceRatio` sorting with a composite score that considers:

```typescript
score = (
  profitMargin * 0.3 +           // Margin percentage (30% weight)
  profitPerCargoSpace * 0.25 +   // Efficiency (25% weight)
  totalProfitPotential * 0.25 +  // Volume potential (25% weight)
  inventoryPressure * 0.2        // Market need (20% weight)
)
```

**Benefits**:
- Cheaper goods score higher when they offer better efficiency
- Considers total profit, not just percentage
- Rewards trading goods that need volume

**Implementation**:
- `profitPerCargoSpace = profitMargin / good.weight`
- `totalProfitPotential = profitMargin * affordableQuantity`
- `inventoryPressure = market.inventory / expectedStock` (higher = more need to trade)

### 2. Volume-Based Profit Optimization

Instead of optimizing for margin percentage, optimize for **total profit per trade**:

```typescript
// Calculate total profit potential for each candidate
const affordableQuantity = Math.floor(spendableCredits / effectiveBuyPrice);
const profitPerUnit = (netSellPrice - purchasePrice);
const totalProfitPotential = profitPerUnit * affordableQuantity;

// Sort by total profit potential, not margin percentage
candidates.sort((a, b) => b.totalProfitPotential - a.totalProfitPotential);
```

**Benefits**:
- Cheaper goods can win if they allow buying more units
- Better matches market needs (cheaper goods need volume)
- More realistic trader behavior

### 3. Tiered Selection with Fallback

Implement a two-pass system:

**Pass 1**: Try high-margin goods (margin > 5%)
- If profitable destination found, buy

**Pass 2**: If Pass 1 fails, try ALL profitable goods sorted by:
- Total profit potential (margin × affordable quantity)
- Or profit per cargo space

**Benefits**:
- Still prefers high-margin when available
- Guarantees cheaper goods get traded if they're profitable
- Prevents systems from going to zero

### 4. Inventory Pressure Multiplier

Add a bonus to goods where inventory is accumulating:

```typescript
// Higher inventory = more pressure to trade
const inventoryRatio = market.inventory / expectedStock;
const pressureBonus = Math.max(1.0, inventoryRatio / 0.5); // 2x bonus at 100% of expected

// Apply to score
score = baseScore * pressureBonus;
```

**Benefits**:
- Automatically prioritizes goods that need trading
- Self-correcting: as inventory builds, trading increases
- Prevents accumulation at producer systems

### 5. Profit Per Credit (ROI) Optimization

Optimize for return on investment rather than margin percentage:

```typescript
const roi = profitMargin / effectiveBuyPrice; // Profit per credit invested
// Higher ROI = better use of limited capital
```

**Benefits**:
- Cheaper goods often have better ROI (same margin, less capital)
- Better for NPCs with limited credits
- Encourages volume trading

### 6. Market Velocity Consideration

Consider how much trading activity a good needs:

```typescript
// Goods with high production/consumption need more volume
const marketVelocity = market.production + market.consumption;
const velocityScore = Math.log(marketVelocity + 1) / 10; // Logarithmic scaling

// Add to candidate score
score += velocityScore;
```

**Benefits**:
- Prioritizes goods that need high trading volume
- Matches market needs (high-volume goods get more traders)
- Prevents accumulation

### 7. Diversity Bonus

Prevent NPCs from all trading the same goods:

```typescript
// Track recent trades in this system (last N ticks)
const recentTrades = getRecentTrades(systemId, goodId);
const diversityBonus = recentTrades.length < 3 ? 1.2 : 1.0; // 20% bonus for less-traded goods

score *= diversityBonus;
```

**Benefits**:
- Spreads trading across goods
- Prevents all NPCs from converging on same route
- Better market balance

### 8. Combined Approach: "Smart Scoring"

Combine multiple factors into a single smart score:

```typescript
function calculateTradeScore(
  candidate: GoodCandidate,
  market: MarketState,
  affordableQuantity: number,
  profitMargin: number,
  netSellPrice: number,
  purchasePrice: number
): number {
  const good = candidate.good;
  
  // Base: Profit margin (30%)
  const marginScore = profitMargin * 0.3;
  
  // Efficiency: Profit per cargo space (20%)
  const profitPerUnit = netSellPrice - purchasePrice;
  const profitPerCargoSpace = profitPerUnit / good.weight;
  const efficiencyScore = (profitPerCargoSpace / good.basePrice) * 0.2;
  
  // Volume: Total profit potential (25%)
  const totalProfit = profitPerUnit * affordableQuantity;
  const volumeScore = (totalProfit / 1000) * 0.25; // Normalize to ~1000 cr scale
  
  // Market need: Inventory pressure (15%)
  const expectedStock = Math.max(1, (market.production + market.consumption) * 10);
  const inventoryRatio = market.inventory / expectedStock;
  const pressureScore = Math.min(2.0, inventoryRatio / 0.5) * 0.15; // Bonus up to 2x
  
  // Velocity: Market activity (10%)
  const marketVelocity = market.production + market.consumption;
  const velocityScore = Math.log(marketVelocity + 1) / 20 * 0.1;
  
  return marginScore + efficiencyScore + volumeScore + pressureScore + velocityScore;
}
```

**Benefits**:
- Balances all factors
- Cheaper goods can win when they're efficient or needed
- More realistic trader behavior

## Recommended Implementation Strategy

### Phase 1: Quick Win (Volume-Based Profit)
- Change sorting from `priceRatio` to `totalProfitPotential`
- Minimal code change, immediate impact
- File: `ship.ts:1886` - change sort key

### Phase 2: Smart Scoring
- Implement `calculateTradeScore()` function
- Replace simple sorting with score-based selection
- More balanced, considers multiple factors

### Phase 3: Market Pressure
- Add inventory pressure multiplier
- Self-correcting system
- Prevents accumulation

## Example: Why This Works

**Scenario**: System produces food (base 10, price 5.5, margin 10% = 0.55 cr profit) and computers (base 1000, price 900, margin 10% = 90 cr profit)

**Current behavior**:
- NPC has 500 credits
- Can buy 90 food (495 cr) or 0 computers (can't afford)
- Checks computers first → no profitable destination → skips
- Checks food → profitable → buys food
- **BUT**: If NPC had 1000 credits, would prefer computers

**With volume-based profit**:
- Food: 90 units × 0.55 cr = 49.5 cr total profit
- Computers: 1 unit × 90 cr = 90 cr total profit
- Still prefers computers IF affordable
- **BUT**: If computers aren't affordable, food wins on total profit

**With smart scoring**:
- Food: High efficiency (0.55 cr/space), high volume potential, market pressure
- Computers: High margin, but low volume if unaffordable
- Food can win even when computers are affordable if market needs food

## Testing Considerations

1. **Monitor inventory levels**: Cheaper goods should not accumulate
2. **Track trade diversity**: NPCs should trade variety of goods
3. **Check profit distribution**: Both high and low value goods should be profitable
4. **Verify market balance**: Systems shouldn't go to zero

## Configuration Parameters

Add to `balance-config.ts`:

```typescript
tradeScoringWeights: {
  profitMargin: 0.3,        // Margin percentage weight
  profitPerCargoSpace: 0.25, // Efficiency weight
  totalProfitPotential: 0.25, // Volume weight
  inventoryPressure: 0.2,    // Market need weight
}
```

### 9. Dynamic Price Floor System (Unconventional)

Instead of fixing the problem in NPC selection, fix it in pricing:

```typescript
// When inventory accumulates, create artificial price pressure
const inventoryRatio = market.inventory / expectedStock;
if (inventoryRatio > 1.5) {
  // High inventory: reduce price more aggressively to attract traders
  const pressureMultiplier = Math.min(0.7, 1.0 - (inventoryRatio - 1.5) * 0.2);
  market.price = market.basePrice * pressureMultiplier;
}
```

**Benefits**:
- Cheaper goods become MORE attractive as inventory builds
- Self-correcting: accumulation → lower price → more trading
- No NPC logic changes needed

**Drawbacks**:
- May cause price volatility
- Could break price discovery

### 10. Credit-Based Good Tiering (Unconventional)

Assign NPCs to "tiers" based on credit level, each tier prefers different goods:

```typescript
// Low-credit NPCs (0-200): Prefer cheap goods (food, textiles)
// Mid-credit NPCs (200-1000): Prefer mid-tier goods (metals, machinery)
// High-credit NPCs (1000+): Prefer expensive goods (computers, narcotics)

const tier = this.shipState.credits < 200 ? 'low' : 
             this.shipState.credits < 1000 ? 'mid' : 'high';

const tierBonus = {
  low: { food: 2.0, textiles: 2.0, metals: 1.0, computers: 0.5 },
  mid: { food: 1.0, textiles: 1.0, metals: 2.0, machinery: 2.0, computers: 1.0 },
  high: { food: 0.5, textiles: 0.5, metals: 1.0, computers: 2.0, narcotics: 2.0 }
};

score *= tierBonus[tier][goodId] || 1.0;
```

**Benefits**:
- Natural distribution: low-credit NPCs trade cheap goods
- High-credit NPCs can afford expensive goods
- Mimics real-world behavior (small traders vs. large traders)

### 11. Opportunity Cost Consideration (Unconventional)

Consider what you're NOT buying when selecting a good:

```typescript
// If buying expensive good, can't buy many units
// If buying cheap good, can buy many units
// Opportunity cost = profit from alternative use of credits

const opportunityCost = {
  expensive: affordableQuantity < 5 ? 0.5 : 1.0, // Penalty if can't buy many
  cheap: affordableQuantity > 20 ? 1.2 : 1.0       // Bonus if can buy many
};

score *= opportunityCost[good.basePrice < 100 ? 'cheap' : 'expensive'];
```

**Benefits**:
- Considers trade-offs explicitly
- Rewards volume when capital is limited
- More sophisticated decision-making

### 12. Time-to-Profit Optimization (Unconventional)

Optimize for fastest profit realization, not just profit amount:

```typescript
// Cheaper goods = faster to fill cargo = faster to sell = faster profit
// Expensive goods = slower to fill = longer to profit

const cargoFillTime = affordableQuantity / MAX_CARGO_SPACE; // 0-1, lower is better
const timeToProfitScore = (1 - cargoFillTime) * 0.3; // 30% weight on speed

score += timeToProfitScore;
```

**Benefits**:
- Rewards faster trading cycles
- Cheaper goods win on speed
- Better capital turnover

### 13. Risk-Adjusted Returns (Unconventional)

Consider volatility as risk, adjust returns:

```typescript
// High volatility = higher risk = need higher returns
// Low volatility = lower risk = acceptable lower returns

const riskAdjustedReturn = profitMargin / (good.volatility + 0.1);
// Low volatility goods (food) get higher risk-adjusted score
```

**Benefits**:
- More realistic risk/reward trade-off
- Stable goods become attractive
- Prevents over-concentration in volatile goods

### 14. Market Maker Incentives (Unconventional)

Reward NPCs for "making markets" in under-traded goods:

```typescript
// Track how many NPCs are trading each good in this system
const traderCount = getTraderCount(systemId, goodId);
const marketMakerBonus = traderCount < 2 ? 1.5 : 1.0; // 50% bonus for first traders

score *= marketMakerBonus;
```

**Benefits**:
- Early traders get rewarded
- Prevents market concentration
- Encourages exploration

### 15. Supply Chain Efficiency (Unconventional)

Consider the full supply chain, not just one trade:

```typescript
// After selling, what can I buy at destination?
// Food → Industrial system → buy machinery → next system
// vs Computers → Industrial system → can't afford anything → stuck

const destinationMarkets = await getDestinationMarkets(destinationId);
const canBuyAtDestination = destinationMarkets.some(m => 
  m.price * (1 + SALES_TAX_RATE) <= creditsAfterSale
);

const supplyChainScore = canBuyAtDestination ? 1.2 : 0.8;
score *= supplyChainScore;
```

**Benefits**:
- Considers multi-hop trading
- Prevents NPCs from getting stuck
- More strategic thinking

### 16. Price Momentum Trading (Unconventional)

Consider price trends, not just current price:

```typescript
// If price is rising, buy now before it goes up more
// If price is falling, wait or buy cheaper goods

const priceHistory = getPriceHistory(goodId, systemId, lastN=5);
const priceTrend = (priceHistory[0] - priceHistory[priceHistory.length-1]) / priceHistory[0];
const momentumScore = priceTrend > 0 ? 1.2 : 1.0; // Bonus for rising prices

score *= momentumScore;
```

**Benefits**:
- More dynamic trading behavior
- NPCs react to market conditions
- Prevents buying into falling markets

## Most Unconventional: Hybrid Economic Model

Instead of fixing NPC behavior, fix the economic model itself:

**Problem**: Consumption > production creates deficit that cheaper goods can't fill.

**Solution**: Make cheaper goods have **higher production multipliers**:

```typescript
// Baseline goods (food, textiles) get production bonus
const isBaselineGood = ['food', 'textiles', 'metals'].includes(goodId);
const productionMultiplier = isBaselineGood ? 1.5 : 1.0;

// Result: Baseline goods produce MORE, creating surplus that needs trading
// NPCs naturally trade surplus goods
```

**Benefits**:
- Fixes root cause, not symptom
- Cheaper goods become abundant (need trading)
- More expensive goods remain scarce (premium pricing)
- Natural market forces drive trading

---

## Revolutionary Solution: Request-Based Trading System (Hybrid Model)

### Concept Overview

Hybrid trading system combining **contract-based fulfillment** with **free trading**:

- Systems post **requests** (contracts) for goods they need
- NPCs/players **claim** requests before fulfilling them (exclusive)
- Requests are **tiered** - must complete lower-tier requests to unlock higher tiers
- **Free trading** remains available but less profitable (70-80% of request rewards)
- **Reputation system** unlocks discounts on fuel, repairs, and services
- Creates natural incentive: fulfill contracts to unlock discounts and higher-tier requests

### How It Works

#### 1. Request Generation

Systems generate requests based on consumption needs:

```typescript
interface TradeRequest {
  id: string;                    // Unique request ID
  systemId: SystemId;            // System requesting the good
  goodId: GoodId;                // Good needed
  quantity: number;              // Quantity needed
  tier: number;                  // 1-5, determines unlock requirements
  baseReward: number;            // Base credit reward
  claimedBy: ShipId | null;      // Who claimed it (null = available)
  claimedAt: Timestamp | null;   // When claimed
  expiresAt: Timestamp;          // Request expiration time
  priority: 'low' | 'normal' | 'high' | 'urgent'; // Affects reward multiplier
}

interface ShipReputation {
  shipId: ShipId;
  tierUnlocks: number;           // Highest tier unlocked (starts at 1)
  completedRequests: number;     // Total requests completed
  tierCompletions: Map<number, number>; // Completions per tier
  reputationLevel: number;        // Overall reputation level (0-10)
  totalRewards: number;          // Total credits earned from requests
  lastRequestCompletion: Timestamp | null;
}

// Reputation levels unlock discounts AND equipment access
const REPUTATION_DISCOUNTS = {
  0: { fuel: 1.0, repairs: 1.0, taxes: 1.0 },      // No discount
  1: { fuel: 0.95, repairs: 0.95, taxes: 1.0 },    // 5% discount (5 requests)
  2: { fuel: 0.90, repairs: 0.90, taxes: 0.98 },  // 10% discount (15 requests)
  3: { fuel: 0.85, repairs: 0.85, taxes: 0.95 },  // 15% discount (30 requests)
  4: { fuel: 0.80, repairs: 0.80, taxes: 0.92 },  // 20% discount (50 requests)
  5: { fuel: 0.75, repairs: 0.75, taxes: 0.90 },  // 25% discount (75 requests)
  6: { fuel: 0.70, repairs: 0.70, taxes: 0.85 },  // 30% discount (100 requests)
  7: { fuel: 0.65, repairs: 0.65, taxes: 0.80 },  // 35% discount (150 requests)
  8: { fuel: 0.60, repairs: 0.60, taxes: 0.75 },  // 40% discount (200 requests)
  9: { fuel: 0.55, repairs: 0.55, taxes: 0.70 },  // 45% discount (300 requests)
  10: { fuel: 0.50, repairs: 0.50, taxes: 0.65 },  // 50% discount (500 requests)
};

// Equipment access gated by reputation level
// Systems require reputation to purchase advanced weapons/equipment
const REPUTATION_EQUIPMENT_GATES = {
  // Basic equipment (no reputation required)
  0: {
    lasers: ['pulse'],           // Basic pulse laser only
    armaments: [],               // No advanced armaments
    description: 'Novice Trader'
  },
  // Reputation Level 1-2: Basic combat equipment
  1: {
    lasers: ['pulse', 'beam'],   // Unlock beam laser
    armaments: ['missile'],       // Unlock missiles
    description: 'Established Trader'
  },
  // Reputation Level 3-4: Intermediate equipment
  3: {
    lasers: ['pulse', 'beam'],   
    armaments: ['missile', 'ecm'], // Unlock ECM
    description: 'Trusted Trader'
  },
  // Reputation Level 5-6: Advanced equipment
  5: {
    lasers: ['pulse', 'beam', 'military'], // Unlock military laser
    armaments: ['missile', 'ecm'],
    description: 'Elite Trader'
  },
  // Reputation Level 7-8: Bounty hunter equipment
  7: {
    lasers: ['pulse', 'beam', 'military'],
    armaments: ['missile', 'ecm', 'energyBomb'], // Unlock energy bomb
    description: 'Bounty Hunter'
  },
  // Reputation Level 9-10: Maximum equipment access
  9: {
    lasers: ['pulse', 'beam', 'military'],
    armaments: ['missile', 'ecm', 'energyBomb'],
    description: 'Legendary Trader'
  },
};

// Generate requests based on consumption deficit
function generateRequests(system: StarSystem): TradeRequest[] {
  const requests: TradeRequest[] = [];
  
  for (const [goodId, market] of system.markets.entries()) {
    // Calculate consumption deficit (how much is needed)
    const expectedConsumption = market.consumption * TICKS_PER_REQUEST_GENERATION;
    const currentInventory = market.inventory;
    const deficit = Math.max(0, expectedConsumption - currentInventory);
    
    if (deficit > 0) {
      // Determine tier based on good value
      const good = getGoodDefinition(goodId);
      const tier = getGoodTier(goodId); // food=1, textiles=1, metals=2, machinery=3, computers=5
      
      // Generate request
      requests.push({
        id: `req-${system.id}-${goodId}-${Date.now()}`,
        systemId: system.id,
        goodId,
        quantity: Math.ceil(deficit),
        tier,
        baseReward: calculateReward(goodId, deficit, tier),
        claimedBy: null,
        claimedAt: null,
        expiresAt: Date.now() + REQUEST_EXPIRY_MS,
        priority: deficit > expectedConsumption * 2 ? 'urgent' : 'normal'
      });
    }
  }
  
  return requests;
}

function getGoodTier(goodId: GoodId): number {
  const good = getGoodDefinition(goodId);
  if (!good) return 1;
  
  // Tier based on base price
  if (good.basePrice < 50) return 1;      // Tier 1: food, textiles
  if (good.basePrice < 200) return 2;     // Tier 2: metals, medicines
  if (good.basePrice < 500) return 3;     // Tier 3: machinery, luxuries
  if (good.basePrice < 1000) return 4;    // Tier 4: electronics, weapons
  return 5;                                // Tier 5: computers, narcotics
}
```

#### 2. Request Claiming System

NPCs can only claim requests they're eligible for:

```typescript
interface ShipReputation {
  shipId: ShipId;
  tierUnlocks: number;           // Highest tier unlocked (starts at 1)
  completedRequests: number;     // Total requests completed
  tierCompletions: Map<number, number>; // Completions per tier
}

// NPC checks available requests
async function findAvailableRequests(
  ship: Ship,
  currentSystem: SystemId
): Promise<TradeRequest[]> {
  const reputation = await getShipReputation(ship.id);
  
  // Get all systems within range
  const nearbySystems = getNearbySystems(currentSystem, MAX_TRAVEL_DISTANCE);
  const allRequests: TradeRequest[] = [];
  
  for (const systemId of nearbySystems) {
    const systemRequests = await getSystemRequests(systemId);
    
    // Filter: only requests NPC can access (tier unlocked) and not claimed
    const accessible = systemRequests.filter(req => 
      req.tier <= reputation.tierUnlocks &&
      req.claimedBy === null &&
      req.expiresAt > Date.now()
    );
    
    allRequests.push(...accessible);
  }
  
  // Sort by: tier (lower first), then reward per unit
  return allRequests.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return (b.baseReward / b.quantity) - (a.baseReward / a.quantity);
  });
}

// Claim a request (exclusive - only one NPC can claim)
async function claimRequest(
  shipId: ShipId,
  requestId: string
): Promise<boolean> {
  const request = await getRequest(requestId);
  
  if (!request || request.claimedBy !== null) {
    return false; // Already claimed or doesn't exist
  }
  
  // Atomically claim (prevent race conditions)
  const claimed = await atomicClaim(requestId, shipId);
  return claimed;
}
```

#### 3. Tier Progression & Reputation System

NPCs unlock higher tiers and reputation levels by completing requests:

```typescript
// After completing a request
async function completeRequest(
  shipId: ShipId,
  requestId: string,
  actualQuantity: number
): Promise<void> {
  const request = await getRequest(requestId);
  if (!request || request.claimedBy !== shipId) {
    throw new Error("Request not claimed by this ship");
  }
  
  const reputation = await getShipReputation(shipId);
  
  // Calculate reward (may be reduced if partial fulfillment)
  const fulfillmentRatio = actualQuantity / request.quantity;
  const reward = request.baseReward * fulfillmentRatio * getPriorityMultiplier(request.priority);
  
  // Update ship credits
  await addCredits(shipId, reward);
  
  // Update reputation
  reputation.completedRequests++;
  reputation.totalRewards += reward;
  const tierCompletions = reputation.tierCompletions.get(request.tier) || 0;
  reputation.tierCompletions.set(request.tier, tierCompletions + 1);
  reputation.lastRequestCompletion = Date.now();
  
  // Check for tier unlock
  // Unlock Tier N+1 after completing X requests of Tier N
  const REQUESTS_PER_TIER = 5; // Complete 5 Tier 1 requests to unlock Tier 2
  if (request.tier === reputation.tierUnlocks) {
    const completions = reputation.tierCompletions.get(request.tier) || 0;
    if (completions >= REQUESTS_PER_TIER && reputation.tierUnlocks < 5) {
      reputation.tierUnlocks++;
      // Notify ship of tier unlock
      await notifyTierUnlock(shipId, reputation.tierUnlocks);
    }
  }
  
  // Update reputation level (unlocks discounts)
  const newReputationLevel = calculateReputationLevel(reputation.completedRequests);
  if (newReputationLevel > reputation.reputationLevel) {
    reputation.reputationLevel = newReputationLevel;
    await notifyReputationLevelUp(shipId, newReputationLevel);
  }
  
  await saveReputation(reputation);
  
  // Remove completed request
  await removeRequest(requestId);
}

function calculateReputationLevel(completedRequests: number): number {
  // Reputation levels based on total requests completed
  if (completedRequests >= 500) return 10;
  if (completedRequests >= 300) return 9;
  if (completedRequests >= 200) return 8;
  if (completedRequests >= 150) return 7;
  if (completedRequests >= 100) return 6;
  if (completedRequests >= 75) return 5;
  if (completedRequests >= 50) return 4;
  if (completedRequests >= 30) return 3;
  if (completedRequests >= 15) return 2;
  if (completedRequests >= 5) return 1;
  return 0;
}
```

#### 3a. Equipment Access Gating

Reputation gates access to advanced equipment, creating progression:

```typescript
// Check if ship can purchase equipment based on reputation
function canPurchaseEquipment(
  shipId: ShipId,
  equipmentType: 'laser' | 'armament',
  equipmentName: string
): { allowed: boolean; reason?: string } {
  const reputation = await getShipReputation(shipId);
  const reputationLevel = reputation.reputationLevel;
  
  // Find the highest reputation gate that applies
  const gates = Object.keys(REPUTATION_EQUIPMENT_GATES)
    .map(Number)
    .filter(level => level <= reputationLevel)
    .sort((a, b) => b - a);
  
  if (gates.length === 0) {
    return { allowed: false, reason: 'Insufficient reputation' };
  }
  
  const highestGate = REPUTATION_EQUIPMENT_GATES[gates[0]];
  
  if (equipmentType === 'laser') {
    const allowed = highestGate.lasers.includes(equipmentName as LaserType);
    return {
      allowed,
      reason: allowed ? undefined : `Requires reputation level ${getRequiredLevelForEquipment(equipmentName)}`
    };
  } else if (equipmentType === 'armament') {
    const allowed = highestGate.armaments.includes(equipmentName);
    return {
      allowed,
      reason: allowed ? undefined : `Requires reputation level ${getRequiredLevelForEquipment(equipmentName)}`
    };
  }
  
  return { allowed: false, reason: 'Unknown equipment type' };
}

function getRequiredLevelForEquipment(equipmentName: string): number {
  // Find minimum reputation level required
  for (const [level, gate] of Object.entries(REPUTATION_EQUIPMENT_GATES)) {
    if (gate.lasers.includes(equipmentName) || gate.armaments.includes(equipmentName)) {
      return Number(level);
    }
  }
  return 0;
}

// In armaments purchase endpoint
async function handlePurchaseArmament(
  equipmentType: 'laser' | 'armament',
  equipmentName: string
): Promise<Response> {
  const accessCheck = await canPurchaseEquipment(this.shipState.id, equipmentType, equipmentName);
  
  if (!accessCheck.allowed) {
    return new Response(JSON.stringify({
      error: accessCheck.reason || 'Equipment not available',
      requiredReputation: getRequiredLevelForEquipment(equipmentName),
      currentReputation: (await getShipReputation(this.shipState.id)).reputationLevel,
      message: `This equipment requires ${getRequiredLevelForEquipment(equipmentName)} reputation. Complete more trade requests to unlock.`
    }), { status: 403 });
  }
  
  // Also check system tech level (existing requirement)
  const systemTechLevel = await getSystemTechLevel(this.shipState.currentSystem);
  if (equipmentType === 'laser') {
    const canInstall = canInstallLaser(systemTechLevel, equipmentName as LaserType);
    if (!canInstall) {
      return new Response(JSON.stringify({
        error: 'System tech level insufficient',
        requiredTech: LASER_TECH_LEVEL[equipmentName as LaserType],
        currentTech: systemTechLevel
      }), { status: 403 });
    }
  }
  
  // Proceed with purchase...
}
```

#### Equipment Progression Examples

```typescript
// Example: Ship progression through reputation levels

// Reputation 0: Novice Trader
// - Can only buy: Pulse laser (basic)
// - Vulnerable to pirates
// - Must focus on safe trading routes
// - Goal: Complete 5 Tier 1 requests to unlock Level 1

// Reputation 1-2: Established Trader  
// - Can buy: Pulse laser, Beam laser, Missiles
// - Can defend against weak pirates
// - Unlocks: 5-10% discounts on fuel/repairs
// - Goal: Complete 15 requests total to unlock Level 3

// Reputation 3-4: Trusted Trader
// - Can buy: Pulse, Beam, ECM
// - Better defense capabilities
// - Unlocks: 10-15% discounts
// - Can accept low-tier bounties (when implemented)
// - Goal: Complete 50 requests to unlock Level 5

// Reputation 5-6: Elite Trader
// - Can buy: Pulse, Beam, Military laser, ECM
// - Strong combat capabilities
// - Unlocks: 20-30% discounts
// - Can accept medium-tier bounties
// - Goal: Complete 100 requests to unlock Level 7

// Reputation 7-8: Bounty Hunter
// - Can buy: All lasers, Missiles, ECM, Energy Bomb
// - Maximum combat equipment
// - Unlocks: 30-40% discounts
// - Can accept high-tier bounties
// - Goal: Complete 200 requests to unlock Level 9

// Reputation 9-10: Legendary Trader
// - All equipment available
// - Maximum discounts (45-50%)
// - Can accept extreme bounties
// - Elite status in all systems
```

#### 3b. Discount Application System

Apply reputation-based discounts to fuel, repairs, and taxes:

```typescript
// In ship.ts - when buying fuel
async function buyFuel(quantity: number): Promise<number> {
  const reputation = await getShipReputation(this.shipState.id);
  const discounts = REPUTATION_DISCOUNTS[reputation.reputationLevel] || REPUTATION_DISCOUNTS[0];
  
  const baseCost = quantity * FUEL_PRICE_PER_LY;
  const discountedCost = baseCost * discounts.fuel;
  
  // Apply tax (also discounted if reputation level high enough)
  const taxRate = SALES_TAX_RATE * discounts.taxes;
  const totalCost = discountedCost * (1 + taxRate);
  
  this.shipState.credits -= totalCost;
  this.shipState.fuelLy += quantity;
  
  return totalCost;
}

// When repairing hull
async function repairHull(points: number): Promise<number> {
  const reputation = await getShipReputation(this.shipState.id);
  const discounts = REPUTATION_DISCOUNTS[reputation.reputationLevel] || REPUTATION_DISCOUNTS[0];
  
  const baseCost = points * HULL_REPAIR_COST_PER_POINT;
  const discountedCost = baseCost * discounts.repairs;
  
  this.shipState.credits -= discountedCost;
  this.shipState.hullIntegrity = Math.min(
    this.shipState.hullMax,
    this.shipState.hullIntegrity + points
  );
  
  return discountedCost;
}

// When trading (apply tax discount)
function calculateTradeTax(amount: number, isBuy: boolean): number {
  if (!isBuy) return 0; // No tax on sales
  
  const reputation = await getShipReputation(this.shipState.id);
  const discounts = REPUTATION_DISCOUNTS[reputation.reputationLevel] || REPUTATION_DISCOUNTS[0];
  
  return amount * SALES_TAX_RATE * discounts.taxes;
}
```

#### 4. Hybrid Trading: Requests + Free Trade

NPCs can choose between request fulfillment or free trading:

```typescript
// In ship.ts - hybrid trading decision
private async tryTrading(
  currentSystem: SystemId,
  rng: DeterministicRNG
): Promise<boolean> {
  if (!this.shipState) return false;
  
  // First, try to claim a request (higher profit + reputation)
  const requestClaimed = await this.tryClaimRequest(currentSystem, rng);
  if (requestClaimed) {
    return true; // Proceed with request fulfillment
  }
  
  // If no requests available, fall back to free trading (lower profit)
  return await this.tryFreeTrade(currentSystem, rng);
}

private async tryClaimRequest(
  currentSystem: SystemId,
  rng: DeterministicRNG
): Promise<boolean> {
  if (!this.shipState) return false;
  
  // Get available requests
  const availableRequests = await findAvailableRequests(this, currentSystem);
  
  if (availableRequests.length === 0) {
    return false; // No requests available, fall back to free trade
  }
  
  // Filter by affordability and cargo space
  const reputation = await getShipReputation(this.shipState.id);
  const discounts = REPUTATION_DISCOUNTS[reputation.reputationLevel] || REPUTATION_DISCOUNTS[0];
  
  const affordableRequests = availableRequests.filter(req => {
    const good = getGoodDefinition(req.goodId);
    if (!good) return false;
    
    // Check if we can afford to buy the good
    const sourceSystem = await findSourceSystem(req.goodId, req.systemId);
    if (!sourceSystem) return false;
    
    const sourcePrice = await getMarketPrice(sourceSystem.id, req.goodId);
    const taxRate = SALES_TAX_RATE * discounts.taxes; // Apply reputation tax discount
    const effectiveBuyPrice = sourcePrice * (1 + taxRate);
    const totalCost = effectiveBuyPrice * req.quantity;
    
    // Reserve fuel costs (with discount)
    const fuelCost = calculateFuelCost(currentSystem, sourceSystem.id) * discounts.fuel;
    const travelCost = calculateFuelCost(sourceSystem.id, req.systemId) * discounts.fuel;
    const availableCredits = this.shipState.credits - fuelCost - travelCost;
    
    return totalCost <= availableCredits;
  });
  
  if (affordableRequests.length === 0) {
    return false;
  }
  
  // Select best request (consider tier progression and reward)
  const selected = affordableRequests.reduce((best, req) => {
    const rewardPerUnit = req.baseReward / req.quantity;
    const bestRewardPerUnit = best.baseReward / best.quantity;
    
    // Prefer lower tiers (easier to complete, unlocks progression)
    if (req.tier < best.tier) return req;
    if (req.tier > best.tier) return best;
    
    // Same tier: prefer higher reward
    return rewardPerUnit > bestRewardPerUnit ? req : best;
  });
  
  // Claim the request
  const claimed = await claimRequest(this.shipState.id, selected.id);
  if (!claimed) {
    return false; // Someone else claimed it, fall back to free trade
  }
  
  // Store request info for fulfillment
  this.shipState.activeRequest = {
    requestId: selected.id,
    goodId: selected.goodId,
    quantity: selected.quantity,
    destinationSystem: selected.systemId,
    reward: selected.baseReward
  };
  
  // Find source system to buy from
  const sourceSystem = await findSourceSystem(selected.goodId, selected.systemId);
  this.shipState.sourceSystem = sourceSystem.id;
  
  return true; // Request claimed, proceed to buy and fulfill
}

// Free trading (fallback when no requests available)
private async tryFreeTrade(
  currentSystem: SystemId,
  rng: DeterministicRNG
): Promise<boolean> {
  if (!this.shipState) return false;
  
  // Use existing tryBuyGoods logic, but apply profit penalty
  // Free trade profits are 70-80% of what they would be with requests
  
  const FREE_TRADE_PROFIT_MULTIPLIER = 0.75; // 75% of request profit
  
  // Existing trade logic, but when calculating profit:
  // profit = (sellPrice - buyPrice) * FREE_TRADE_PROFIT_MULTIPLIER
  
  // This makes free trading less attractive but still viable
  // NPCs will prefer requests when available, but can still trade freely
  
  return await this.tryBuyGoods(currentSystem, rng, FREE_TRADE_PROFIT_MULTIPLIER);
}
```

#### 5. Request Fulfillment Flow

```typescript
// After buying goods and traveling to destination
private async fulfillRequest(): Promise<boolean> {
  if (!this.shipState?.activeRequest) return false;
  
  const request = await getRequest(this.shipState.activeRequest.requestId);
  if (!request || request.claimedBy !== this.shipState.id) {
    return false; // Request expired or not claimed by us
  }
  
  // Check cargo
  const cargoQuantity = this.shipState.cargo.get(request.goodId) || 0;
  const fulfillQuantity = Math.min(cargoQuantity, request.quantity);
  
  if (fulfillQuantity === 0) {
    return false; // No cargo to fulfill
  }
  
  // Sell goods to system (fulfill request)
  await this.executeTrade(request.goodId, fulfillQuantity, "sell");
  
  // Complete request
  await completeRequest(
    this.shipState.id,
    request.id,
    fulfillQuantity
  );
  
  // Clear active request
  this.shipState.activeRequest = null;
  this.shipState.sourceSystem = null;
  
  return true;
}
```

### Benefits of Hybrid Request-Based System

1. **Guaranteed Trading**: Systems actively request goods, creating guaranteed demand
2. **Natural Progression**: NPCs must trade cheap goods (Tier 1) to unlock profitable goods (Tier 3+)
3. **No Zero Inventory**: Requests are generated based on consumption needs, ensuring demand exists
4. **Flexibility**: Free trading remains available for opportunistic trades
5. **Reputation Rewards**: Discounts on fuel/repairs/taxes incentivize contract fulfillment
6. **Progressive Benefits**: Higher reputation = better discounts = more profitable trading
7. **Prevents Hoarding**: Requests expire, creating urgency
8. **Exclusive Contracts**: Claiming prevents multiple NPCs from competing for same trade
9. **Clear Incentives**: Reward structure makes trading profitable even for cheap goods
10. **Scalable**: Can add request types (delivery, procurement, emergency, etc.)

### Profit Comparison: Requests vs Free Trade

```typescript
// Example: Trading food (base price 10 cr)

// Request fulfillment:
// - Buy at 5.5 cr (producer price)
// - Sell via request: 8.0 cr reward (guaranteed)
// - Profit: 2.5 cr per unit (45% margin)
// - Plus: Reputation gain, unlocks higher tiers

// Free trade:
// - Buy at 5.5 cr (producer price)
// - Sell at 7.0 cr (consumer price, 75% of request reward)
// - Profit: 1.5 cr per unit (27% margin)
// - No reputation gain

// With reputation level 5 (25% discount):
// - Fuel costs: 25% cheaper
// - Repair costs: 25% cheaper
// - Tax on purchases: 10% instead of 3% (27% discount)
// - Net effect: Significantly more profitable over time
```

### Implementation Considerations

#### Request Storage

```typescript
// Store requests in StarSystem Durable Object
interface SystemState {
  // ... existing fields
  activeRequests: Map<string, TradeRequest>; // requestId -> request
  requestHistory: TradeRequest[];            // Completed requests (for analytics)
}

// API endpoints
POST /system/:id/requests - Generate new requests
GET /system/:id/requests - List available requests
POST /system/:id/requests/:requestId/claim - Claim request
POST /system/:id/requests/:requestId/fulfill - Fulfill request
```

#### Reputation Storage

```typescript
// Store in Ship Durable Object or separate Reputation DO
interface ShipReputation {
  shipId: ShipId;
  tierUnlocks: number;
  completedRequests: number;
  tierCompletions: Map<number, number>;
  totalRewards: number;
  lastRequestCompletion: Timestamp | null;
}
```

#### Request Generation Timing

```typescript
// Generate requests on system tick
// Frequency: Every N ticks, or when inventory drops below threshold
const REQUEST_GENERATION_INTERVAL_TICKS = 5; // Every 5 ticks
const INVENTORY_THRESHOLD_RATIO = 0.3; // Generate when inventory < 30% of expected

// In StarSystem.handleTick()
if (this.systemState.currentTick % REQUEST_GENERATION_INTERVAL_TICKS === 0) {
  const newRequests = generateRequests(this);
  for (const request of newRequests) {
    this.systemState.activeRequests.set(request.id, request);
  }
}
```

### Reward Calculation

```typescript
function calculateReward(
  goodId: GoodId,
  quantity: number,
  tier: number,
  priority: string
): number {
  const good = getGoodDefinition(goodId);
  if (!good) return 0;
  
  // Base reward = market price difference + profit margin
  // Higher tier = higher reward multiplier
  const tierMultiplier = 1.0 + (tier - 1) * 0.2; // Tier 1 = 1.0x, Tier 5 = 1.8x
  
  // Reward should be profitable even for cheap goods
  // Request rewards are 25-33% higher than free trade equivalent
  const baseRewardPerUnit = good.basePrice * 0.20; // 20% profit margin (vs 15% for free trade)
  const priorityMultiplier = getPriorityMultiplier(priority);
  
  const reward = baseRewardPerUnit * quantity * tierMultiplier * priorityMultiplier;
  
  return Math.ceil(reward);
}

function getPriorityMultiplier(priority: string): number {
  switch (priority) {
    case 'urgent': return 1.5;  // 50% bonus for urgent requests
    case 'high': return 1.2;     // 20% bonus
    case 'normal': return 1.0;   // Standard
    case 'low': return 0.8;       // 20% reduction
    default: return 1.0;
  }
}

// Free trade profit calculation (used when no requests available)
function calculateFreeTradeProfit(
  buyPrice: number,
  sellPrice: number,
  quantity: number
): number {
  // Free trade gets 75% of the profit margin compared to requests
  const FREE_TRADE_MULTIPLIER = 0.75;
  const profitPerUnit = (sellPrice - buyPrice) * FREE_TRADE_MULTIPLIER;
  return profitPerUnit * quantity;
}
```

### Future Expansion: Pirates & Bounty Hunting

The reputation system creates a natural foundation for combat mechanics:

#### Bounty Hunting System

```typescript
interface Bounty {
  id: string;
  targetShipId: ShipId;
  targetName: string;
  crime: 'piracy' | 'smuggling' | 'assault' | 'theft';
  reward: number;
  reputationLevel: number;        // Minimum reputation to accept bounty
  lastSeenSystem: SystemId;
  dangerLevel: 'low' | 'medium' | 'high' | 'extreme';
}

// Bounties require reputation level 3+ (Trusted Trader)
// Higher reputation = access to higher-value bounties
function getAvailableBounties(shipId: ShipId): Bounty[] {
  const reputation = await getShipReputation(shipId);
  const allBounties = await getAllActiveBounties();
  
  return allBounties.filter(bounty => 
    bounty.reputationLevel <= reputation.reputationLevel
  );
}

// Completing bounties grants reputation (faster than trading)
async function completeBounty(
  hunterId: ShipId,
  bountyId: string
): Promise<void> {
  const bounty = await getBounty(bountyId);
  const reputation = await getShipReputation(hunterId);
  
  // Bounty rewards: credits + reputation
  await addCredits(hunterId, bounty.reward);
  
  // Bounty hunting grants reputation faster than trading
  // 1 bounty = 2-3 request completions worth of reputation
  const reputationGain = calculateBountyReputationGain(bounty);
  reputation.completedRequests += reputationGain;
  
  // Update reputation level
  const newLevel = calculateReputationLevel(reputation.completedRequests);
  if (newLevel > reputation.reputationLevel) {
    reputation.reputationLevel = newLevel;
    await notifyReputationLevelUp(hunterId, newLevel);
  }
  
  await saveReputation(reputation);
}
```

#### Equipment Progression for Combat

```typescript
// Equipment tiers tied to reputation:
// Level 0-1: Basic trader (pulse laser only) - vulnerable to pirates
// Level 2-3: Can defend (beam laser, missiles) - can fight weak pirates
// Level 4-5: Well-armed (military laser) - can fight medium pirates
// Level 6-7: Bounty hunter (ECM, energy bomb) - can hunt dangerous targets
// Level 8-10: Elite (all equipment) - can hunt extreme bounties

// Pirates spawn based on system security level
// Low-security systems = more pirates = need better equipment
// High-security systems = fewer pirates = safer for traders

// Combat outcomes affect reputation:
// - Defeating pirates: +reputation (proves reliability)
// - Being defeated: -reputation (systems lose trust)
// - Fleeing from pirates: neutral (survival is acceptable)
```

#### Incentive Structure

1. **Early Game (Reputation 0-2)**:
   - Focus on trading to build reputation
   - Avoid dangerous systems (pirates)
   - Basic equipment only (vulnerable)

2. **Mid Game (Reputation 3-5)**:
   - Unlock better equipment (beam/military lasers)
   - Can defend against weak pirates
   - Access to low-tier bounties
   - Discounts make trading more profitable

3. **Late Game (Reputation 6-10)**:
   - Access to all equipment
   - Can hunt dangerous bounties
   - Significant discounts (30-50%)
   - Elite trader status

#### Pirate Mechanics (Future)

```typescript
interface Pirate {
  shipId: ShipId;
  threatLevel: number;           // 1-10, determines equipment/difficulty
  preferredTargets: string[];    // What they attack (traders, miners, etc.)
  spawnSystem: SystemId;
  lastActivity: Timestamp;
}

// Pirates attack ships based on:
// - Cargo value (high-value cargo = more attractive)
// - Ship equipment (weak ships = easier targets)
// - System security (low security = more pirate activity)

// Defeating pirates:
// - Grants credits (loot)
// - Grants reputation (proves reliability)
// - Unlocks bounty hunting opportunities

// Being defeated by pirates:
// - Lose cargo
// - Lose credits
// - Lose reputation (systems lose trust)
// - Must repair/recover
```

### Migration Strategy

1. **Phase 1**: Add request system alongside existing trading (dual mode)
   - Requests generate but are optional
   - Free trading remains at 100% profit
   - Reputation system tracks completions but no discounts yet

2. **Phase 2**: Introduce reputation discounts & equipment gating
   - Free trading reduced to 75% profit
   - Reputation levels 1-3 unlock small discounts (5-15%)
   - Equipment gating: reputation required for advanced weapons
   - NPCs start preferring requests when available

3. **Phase 3**: Full hybrid system
   - All reputation levels active (up to 50% discounts)
   - Free trading at 70-75% profit
   - Requests clearly more profitable + unlock progression
   - Equipment fully gated by reputation

4. **Phase 4**: Combat expansion
   - Add pirate spawning system
   - Implement bounty hunting contracts
   - Combat affects reputation (defeating pirates = +rep)
   - Equipment becomes critical for survival

5. **Phase 5**: Optional enhancements
   - Player-specific request types (high-value contracts)
   - Request chains (multi-hop deliveries)
   - Reputation decay (maintain activity to keep discounts)
   - Faction-specific reputation (different systems value different activities)

### Comparison to Other Solutions

| Aspect | Hybrid Request System | Smart Scoring | Volume-Based |
|--------|----------------------|---------------|--------------|
| **Guarantees demand** | ✅ Yes (requests) | ❌ No | ❌ No |
| **Prevents zero inventory** | ✅ Yes | ⚠️ Maybe | ⚠️ Maybe |
| **Natural progression** | ✅ Yes (tiers + reputation) | ❌ No | ❌ No |
| **Flexibility** | ✅ Yes (free trade available) | ✅ Yes | ✅ Yes |
| **Long-term incentives** | ✅ Yes (discounts) | ❌ No | ❌ No |
| **Complexity** | ⚠️ High | ✅ Medium | ✅ Low |
| **Player experience** | ✅ Clear goals + progression | ⚠️ Opaque | ⚠️ Opaque |
| **Implementation effort** | ⚠️ High | ✅ Medium | ✅ Low |
| **Addresses root cause** | ✅ Yes (guaranteed demand) | ⚠️ Partial | ⚠️ Partial |

### Conclusion

The **Hybrid Request-Based Trading System** is the most comprehensive solution:

**Advantages**:
- **Guarantees** that cheaper goods get traded (Tier 1 requirement)
- **Prevents** systems from going to zero (requests generated from consumption needs)
- **Creates** clear progression and long-term incentives (reputation discounts + equipment)
- **Maintains** flexibility (free trading still available)
- **Rewards** contract fulfillment with tangible benefits (fuel/repair/tax discounts)
- **Gates** equipment access, creating meaningful progression
- **Enables** future combat mechanics (pirates, bounty hunting)
- **Incentivizes** ship protection (better equipment = better survival)
- **Scales** well (can add request types, reputation tiers, combat features, etc.)

**Key Innovation**: The reputation system creates a **virtuous cycle** with multiple progression paths:

**Trading Path**:
1. Complete requests → Gain reputation
2. Higher reputation → Better discounts + Equipment access
3. Better discounts → More profitable trading
4. More profitable trading → More credits to fulfill higher-tier requests
5. Higher-tier requests → More reputation → Better discounts

**Combat Path** (Future):
1. Build reputation through trading → Unlock combat equipment
2. Better equipment → Can defend against pirates
3. Defeat pirates → Gain reputation + credits
4. Higher reputation → Access to bounty hunting
5. Complete bounties → Faster reputation gain + high rewards
6. Elite reputation → Maximum equipment + discounts

**Risk/Reward Balance**:
- Low reputation: Vulnerable to pirates, limited equipment, lower profits
- High reputation: Well-equipped, can hunt bounties, maximum discounts, safer trading

**Implementation Recommendation**:
- **Short-term**: Implement **Smart Scoring** (Solution 8) as a quick fix
- **Medium-term**: Add **Hybrid Request System** with reputation discounts
- **Long-term**: Expand request types and reputation benefits

This hybrid approach provides the best of both worlds: structured contract fulfillment with guaranteed demand, while maintaining the flexibility and emergent gameplay of free trading.

## Conclusion

The core issue is that NPCs optimize for **margin percentage** when they should optimize for **total value creation**. By considering profit per cargo space, total profit potential, and market needs, cheaper goods become competitive even when more expensive goods offer better margins.

The recommended approach is **Smart Scoring** (Solution 8) combined with **Volume-Based Profit** (Solution 2) as a fallback, ensuring that:
1. High-margin goods are preferred when affordable
2. Cheaper goods are competitive when they offer efficiency or volume
3. Market needs (inventory pressure) influence selection
4. Systems don't accumulate inventory and go to zero

**Most radical solution**: Fix the economic model itself (Solution 17) - make baseline goods produce more, creating natural surplus that needs trading. This addresses the root cause rather than patching NPC behavior.
