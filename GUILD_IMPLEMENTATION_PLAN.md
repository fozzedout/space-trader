# Guild/Request System Implementation Plan

## Overview
Implement a hybrid request-based trading system where systems generate trade requests (contracts) that NPCs/players can claim and fulfill. This creates guaranteed demand and incentivizes trading cheaper goods through tier progression.

## Core Components

### 1. Type Definitions (`src/types.ts`)

**New Types to Add:**

```typescript
// Trade Request
export interface TradeRequest {
  id: string;                    // Unique request ID: `req-${systemId}-${goodId}-${timestamp}`
  systemId: SystemId;            // System requesting the good
  goodId: GoodId;                // Good needed
  quantity: number;              // Quantity needed
  tier: number;                  // 1-5, determines unlock requirements
  baseReward: number;            // Base credit reward
  claimedBy: ShipId | null;      // Who claimed it (null = available)
  claimedAt: Timestamp | null;   // When claimed
  expiresAt: Timestamp;          // Request expiration time
  priority: 'low' | 'normal' | 'high' | 'urgent'; // Affects reward multiplier
  createdAt: Timestamp;          // When request was created
}

// Ship Reputation
export interface ShipReputation {
  shipId: ShipId;
  tierUnlocks: number;           // Highest tier unlocked (starts at 1)
  completedRequests: number;     // Total requests completed
  tierCompletions: Map<number, number>; // Completions per tier (tier -> count)
  reputationLevel: number;        // Overall reputation level (0-10)
  totalRewards: number;          // Total credits earned from requests
  lastRequestCompletion: Timestamp | null;
}

// Active Request Tracking (stored in ShipState)
export interface ActiveRequest {
  requestId: string;
  goodId: GoodId;
  quantity: number;
  destinationSystem: SystemId;
  reward: number;
  sourceSystem: SystemId | null; // Where to buy the good
}
```

**Modify `ShipState` interface:**
- Add `activeRequest: ActiveRequest | null`
- Add `sourceSystem: SystemId | null` (for request fulfillment)

**Modify `SystemState` interface:**
- Add `activeRequests: Map<string, TradeRequest>` (or store separately)

### 2. Reputation System (`src/reputation.ts` - NEW FILE)

**Constants:**
```typescript
// Reputation level thresholds
export const REPUTATION_THRESHOLDS = {
  0: 0,
  1: 5,
  2: 15,
  3: 30,
  4: 50,
  5: 75,
  6: 100,
  7: 150,
  8: 200,
  9: 300,
  10: 500,
};

// Discounts per reputation level
export const REPUTATION_DISCOUNTS = {
  0: { fuel: 1.0, repairs: 1.0, taxes: 1.0 },
  1: { fuel: 0.95, repairs: 0.95, taxes: 1.0 },
  2: { fuel: 0.90, repairs: 0.90, taxes: 0.98 },
  3: { fuel: 0.85, repairs: 0.85, taxes: 0.95 },
  4: { fuel: 0.80, repairs: 0.80, taxes: 0.92 },
  5: { fuel: 0.75, repairs: 0.75, taxes: 0.90 },
  6: { fuel: 0.70, repairs: 0.70, taxes: 0.85 },
  7: { fuel: 0.65, repairs: 0.65, taxes: 0.80 },
  8: { fuel: 0.60, repairs: 0.60, taxes: 0.75 },
  9: { fuel: 0.55, repairs: 0.55, taxes: 0.70 },
  10: { fuel: 0.50, repairs: 0.50, taxes: 0.65 },
};

// Requests needed per tier unlock
export const REQUESTS_PER_TIER = 5; // Complete 5 Tier N requests to unlock Tier N+1

// Request expiration time (30 minutes)
export const REQUEST_EXPIRY_MS = 30 * 60 * 1000;

// Request generation interval (every 5 ticks)
export const REQUEST_GENERATION_INTERVAL_TICKS = 5;
```

**Functions:**
- `getShipReputation(shipId: ShipId): Promise<ShipReputation>`
- `saveShipReputation(reputation: ShipReputation): Promise<void>`
- `calculateReputationLevel(completedRequests: number): number`
- `getReputationDiscounts(reputationLevel: number): { fuel: number; repairs: number; taxes: number }`
- `checkTierUnlock(reputation: ShipReputation, completedTier: number): boolean`

**Storage:**
- Store in Ship Durable Object state (or separate Reputation DO)
- For local server: Add `reputation` table to SQLite

### 3. Request Generation (`src/star-system.ts`)

**New Methods in StarSystem:**

```typescript
// Generate requests based on consumption deficit
private generateRequests(): TradeRequest[] {
  const requests: TradeRequest[] = [];
  const now = Date.now();
  
  for (const [goodId, market] of this.markets.entries()) {
    // Calculate consumption deficit
    const expectedConsumption = market.consumption * REQUEST_GENERATION_INTERVAL_TICKS;
    const currentInventory = market.inventory;
    const deficit = Math.max(0, expectedConsumption - currentInventory);
    
    if (deficit > 0 && market.consumption > 0) {
      const tier = getGoodTier(goodId);
      const priority = this.calculatePriority(deficit, expectedConsumption);
      
      requests.push({
        id: `req-${this.systemState.id}-${goodId}-${now}`,
        systemId: this.systemState.id,
        goodId,
        quantity: Math.ceil(deficit),
        tier,
        baseReward: this.calculateReward(goodId, deficit, tier, priority),
        claimedBy: null,
        claimedAt: null,
        expiresAt: now + REQUEST_EXPIRY_MS,
        priority,
        createdAt: now,
      });
    }
  }
  
  return requests;
}

// Calculate good tier based on base price
private getGoodTier(goodId: GoodId): number {
  const good = getGoodDefinition(goodId);
  if (!good) return 1;
  
  if (good.basePrice < 50) return 1;      // Tier 1: food, textiles
  if (good.basePrice < 200) return 2;     // Tier 2: metals, medicines
  if (good.basePrice < 500) return 3;     // Tier 3: machinery, luxuries
  if (good.basePrice < 1000) return 4;    // Tier 4: electronics, weapons
  return 5;                                // Tier 5: computers, narcotics
}

// Calculate request priority
private calculatePriority(deficit: number, expectedConsumption: number): 'low' | 'normal' | 'high' | 'urgent' {
  const ratio = deficit / expectedConsumption;
  if (ratio > 2.0) return 'urgent';
  if (ratio > 1.5) return 'high';
  if (ratio > 0.5) return 'normal';
  return 'low';
}

// Calculate reward for request
private calculateReward(goodId: GoodId, quantity: number, tier: number, priority: string): number {
  const good = getGoodDefinition(goodId);
  if (!good) return 0;
  
  const tierMultiplier = 1.0 + (tier - 1) * 0.2; // Tier 1 = 1.0x, Tier 5 = 1.8x
  const baseRewardPerUnit = good.basePrice * 0.20; // 20% profit margin
  const priorityMultiplier = getPriorityMultiplier(priority);
  
  return Math.ceil(baseRewardPerUnit * quantity * tierMultiplier * priorityMultiplier);
}

// Call from handleTick() every N ticks
private async updateRequests(): Promise<void> {
  if (this.systemState.currentTick % REQUEST_GENERATION_INTERVAL_TICKS === 0) {
    const newRequests = this.generateRequests();
    
    // Add new requests, expire old ones
    const now = Date.now();
    for (const [id, request] of this.activeRequests.entries()) {
      if (request.expiresAt < now && request.claimedBy === null) {
        this.activeRequests.delete(id);
      }
    }
    
    for (const request of newRequests) {
      // Don't duplicate existing unclaimed requests for same good
      const existing = Array.from(this.activeRequests.values())
        .find(r => r.goodId === request.goodId && r.claimedBy === null);
      
      if (!existing) {
        this.activeRequests.set(request.id, request);
      }
    }
    
    this.markDirty();
  }
}
```

**Storage:**
- Add `activeRequests: Map<string, TradeRequest>` to SystemState
- Store in Durable Object state (or separate table for local server)

### 4. Request Claiming (`src/star-system.ts`)

**New API Endpoints:**

```typescript
// GET /system/:id/requests - List available requests
async handleGetRequests(): Promise<Response> {
  const available = Array.from(this.activeRequests.values())
    .filter(r => r.claimedBy === null && r.expiresAt > Date.now());
  
  return new Response(JSON.stringify({
    requests: available.map(r => ({
      id: r.id,
      goodId: r.goodId,
      quantity: r.quantity,
      tier: r.tier,
      baseReward: r.baseReward,
      priority: r.priority,
      expiresAt: r.expiresAt,
    }))
  }));
}

// POST /system/:id/requests/:requestId/claim - Claim request (atomic)
async handleClaimRequest(requestId: string, shipId: ShipId): Promise<Response> {
  const request = this.activeRequests.get(requestId);
  
  if (!request) {
    return new Response(JSON.stringify({ error: 'Request not found' }), { status: 404 });
  }
  
  if (request.claimedBy !== null) {
    return new Response(JSON.stringify({ error: 'Request already claimed' }), { status: 409 });
  }
  
  if (request.expiresAt < Date.now()) {
    return new Response(JSON.stringify({ error: 'Request expired' }), { status: 410 });
  }
  
  // Atomic claim
  request.claimedBy = shipId;
  request.claimedAt = Date.now();
  this.activeRequests.set(requestId, request);
  this.markDirty();
  
  return new Response(JSON.stringify({ success: true, request }));
}

// POST /system/:id/requests/:requestId/fulfill - Fulfill request
async handleFulfillRequest(requestId: string, shipId: ShipId, quantity: number): Promise<Response> {
  const request = this.activeRequests.get(requestId);
  
  if (!request || request.claimedBy !== shipId) {
    return new Response(JSON.stringify({ error: 'Request not claimed by this ship' }), { status: 403 });
  }
  
  // Update market inventory
  const market = this.markets.get(request.goodId);
  if (!market) {
    return new Response(JSON.stringify({ error: 'Market not found' }), { status: 404 });
  }
  
  const fulfillQuantity = Math.min(quantity, request.quantity);
  market.inventory += fulfillQuantity;
  
  // Calculate reward
  const fulfillmentRatio = fulfillQuantity / request.quantity;
  const reward = request.baseReward * fulfillmentRatio * getPriorityMultiplier(request.priority);
  
  // Remove request if fully fulfilled
  if (fulfillQuantity >= request.quantity) {
    this.activeRequests.delete(requestId);
  } else {
    // Partial fulfillment - reduce quantity
    request.quantity -= fulfillQuantity;
    request.baseReward = request.baseReward * (1 - fulfillmentRatio);
  }
  
  this.markDirty();
  
  return new Response(JSON.stringify({
    success: true,
    reward,
    fulfilled: fulfillQuantity,
    remaining: request.quantity - fulfillQuantity,
  }));
}
```

### 5. Ship Integration (`src/ship.ts`)

**Modify `ShipState`:**
- Add `activeRequest: ActiveRequest | null`
- Add `sourceSystem: SystemId | null`

**New Methods:**

```typescript
// Try to claim a request (called before tryBuyGoods)
private async tryClaimRequest(
  currentSystem: SystemId,
  rng: DeterministicRNG
): Promise<boolean> {
  if (!this.shipState) return false;
  
  // Get reputation
  const reputation = await getShipReputation(this.shipState.id);
  
  // Find available requests in nearby systems
  const nearbySystems = this.getNearbySystems(currentSystem, 20);
  const allRequests: TradeRequest[] = [];
  
  for (const systemId of nearbySystems) {
    const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${systemId}`);
    const systemObj = this.env.STAR_SYSTEM.get(systemStub);
    const response = await systemObj.fetch(DO_INTERNAL("/requests"));
    const data = await response.json();
    
    const accessible = data.requests.filter((req: any) => 
      req.tier <= reputation.tierUnlocks &&
      req.expiresAt > Date.now()
    );
    
    allRequests.push(...accessible);
  }
  
  if (allRequests.length === 0) return false;
  
  // Filter by affordability
  const discounts = getReputationDiscounts(reputation.reputationLevel);
  const affordableRequests = allRequests.filter(req => {
    // Find source system (producer of this good)
    const sourceSystem = this.findSourceSystem(req.goodId, req.systemId);
    if (!sourceSystem) return false;
    
    const sourcePrice = await this.getMarketPrice(sourceSystem, req.goodId);
    const taxRate = SALES_TAX_RATE * discounts.taxes;
    const effectiveBuyPrice = sourcePrice * (1 + taxRate);
    const totalCost = effectiveBuyPrice * req.quantity;
    
    // Reserve fuel costs
    const fuelCost1 = this.calculateFuelCost(currentSystem, sourceSystem) * discounts.fuel;
    const fuelCost2 = this.calculateFuelCost(sourceSystem, req.systemId) * discounts.fuel;
    const availableCredits = this.shipState.credits - fuelCost1 - fuelCost2;
    
    return totalCost <= availableCredits;
  });
  
  if (affordableRequests.length === 0) return false;
  
  // Select best request (prefer lower tiers, then higher reward)
  const selected = affordableRequests.reduce((best, req) => {
    if (req.tier < best.tier) return req;
    if (req.tier > best.tier) return best;
    const rewardPerUnit = req.baseReward / req.quantity;
    const bestRewardPerUnit = best.baseReward / best.quantity;
    return rewardPerUnit > bestRewardPerUnit ? req : best;
  });
  
  // Claim the request
  const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${selected.systemId}`);
  const systemObj = this.env.STAR_SYSTEM.get(systemStub);
  const claimResponse = await systemObj.fetch(
    DO_INTERNAL(`/requests/${selected.id}/claim`),
    { method: 'POST', body: JSON.stringify({ shipId: this.shipState.id }) }
  );
  
  if (!claimResponse.ok) return false; // Someone else claimed it
  
  // Store active request
  const sourceSystem = this.findSourceSystem(selected.goodId, selected.systemId);
  this.shipState.activeRequest = {
    requestId: selected.id,
    goodId: selected.goodId,
    quantity: selected.quantity,
    destinationSystem: selected.systemId,
    reward: selected.baseReward,
    sourceSystem: sourceSystem || null,
  };
  this.shipState.sourceSystem = sourceSystem || null;
  
  return true;
}

// Fulfill request when arriving at destination
private async fulfillRequest(): Promise<boolean> {
  if (!this.shipState?.activeRequest) return false;
  
  const request = this.shipState.activeRequest;
  const cargoQuantity = this.shipState.cargo.get(request.goodId) || 0;
  
  if (cargoQuantity === 0) return false;
  
  const fulfillQuantity = Math.min(cargoQuantity, request.quantity);
  
  // Sell goods to system
  await this.executeTrade(request.goodId, fulfillQuantity, "sell");
  
  // Complete request
  const systemStub = this.env.STAR_SYSTEM.idFromName(`system-${request.destinationSystem}`);
  const systemObj = this.env.STAR_SYSTEM.get(systemStub);
  const fulfillResponse = await systemObj.fetch(
    DO_INTERNAL(`/requests/${request.requestId}/fulfill`),
    {
      method: 'POST',
      body: JSON.stringify({
        shipId: this.shipState.id,
        quantity: fulfillQuantity,
      }),
    }
  );
  
  if (!fulfillResponse.ok) return false;
  
  const result = await fulfillResponse.json();
  
  // Add reward credits
  this.shipState.credits += result.reward;
  
  // Update reputation
  await this.updateReputationAfterFulfillment(request.tier, result.reward);
  
  // Clear active request if fully fulfilled
  if (fulfillQuantity >= request.quantity) {
    this.shipState.activeRequest = null;
    this.shipState.sourceSystem = null;
  } else {
    // Partial fulfillment - update request
    request.quantity -= fulfillQuantity;
    request.reward = request.reward * (1 - fulfillQuantity / request.quantity);
  }
  
  return true;
}

// Update reputation after fulfilling request
private async updateReputationAfterFulfillment(tier: number, reward: number): Promise<void> {
  const reputation = await getShipReputation(this.shipState!.id);
  
  reputation.completedRequests++;
  reputation.totalRewards += reward;
  const tierCompletions = reputation.tierCompletions.get(tier) || 0;
  reputation.tierCompletions.set(tier, tierCompletions + 1);
  reputation.lastRequestCompletion = Date.now();
  
  // Check for tier unlock
  if (tier === reputation.tierUnlocks) {
    const completions = reputation.tierCompletions.get(tier) || 0;
    if (completions >= REQUESTS_PER_TIER && reputation.tierUnlocks < 5) {
      reputation.tierUnlocks++;
    }
  }
  
  // Update reputation level
  const newLevel = calculateReputationLevel(reputation.completedRequests);
  if (newLevel > reputation.reputationLevel) {
    reputation.reputationLevel = newLevel;
  }
  
  await saveShipReputation(reputation);
}
```

**Modify `tryBuyGoods()`:**
- Check for active request first
- If active request exists, buy from `sourceSystem` instead of current system
- Travel to `destinationSystem` instead of chosen destination

**Modify `tryTrading()`:**
- First try `tryClaimRequest()`
- If no request claimed, fall back to `tryBuyGoods()` (free trade)

**Modify `handleArrival()`:**
- Check if ship has active request
- If yes, call `fulfillRequest()` before normal trading

### 6. Discount Application (`src/ship.ts`)

**Modify fuel/repair/tax calculations:**

```typescript
// When buying fuel
private async buyFuel(quantity: number): Promise<number> {
  const reputation = await getShipReputation(this.shipState!.id);
  const discounts = getReputationDiscounts(reputation.reputationLevel);
  
  const baseCost = quantity * FUEL_PRICE_PER_LY;
  const discountedCost = baseCost * discounts.fuel;
  
  this.shipState!.credits -= discountedCost;
  this.shipState!.fuelLy += quantity;
  
  return discountedCost;
}

// When repairing hull
private async repairHull(points: number): Promise<number> {
  const reputation = await getShipReputation(this.shipState!.id);
  const discounts = getReputationDiscounts(reputation.reputationLevel);
  
  const baseCost = points * HULL_REPAIR_COST_PER_POINT;
  const discountedCost = baseCost * discounts.repairs;
  
  this.shipState!.credits -= discountedCost;
  this.shipState!.hullIntegrity = Math.min(
    this.shipState!.hullMax,
    this.shipState!.hullIntegrity + points
  );
  
  return discountedCost;
}

// When trading (apply tax discount)
private calculateTradeTax(amount: number, isBuy: boolean): Promise<number> {
  if (!isBuy) return Promise.resolve(0); // No tax on sales
  
  const reputation = await getShipReputation(this.shipState!.id);
  const discounts = getReputationDiscounts(reputation.reputationLevel);
  
  return Promise.resolve(amount * SALES_TAX_RATE * discounts.taxes);
}
```

### 7. Database Schema (Local Server)

**New Tables:**

```sql
-- Trade requests table
CREATE TABLE IF NOT EXISTS trade_requests (
  id TEXT PRIMARY KEY,
  system_id INTEGER NOT NULL,
  good_id TEXT NOT NULL,
  quantity REAL NOT NULL,
  tier INTEGER NOT NULL,
  base_reward REAL NOT NULL,
  claimed_by TEXT,
  claimed_at INTEGER,
  expires_at INTEGER NOT NULL,
  priority TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (system_id) REFERENCES systems(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trade_requests_system ON trade_requests(system_id);
CREATE INDEX IF NOT EXISTS idx_trade_requests_claimed ON trade_requests(claimed_by);

-- Ship reputation table
CREATE TABLE IF NOT EXISTS ship_reputation (
  ship_id TEXT PRIMARY KEY,
  tier_unlocks INTEGER NOT NULL DEFAULT 1,
  completed_requests INTEGER NOT NULL DEFAULT 0,
  reputation_level INTEGER NOT NULL DEFAULT 0,
  total_rewards REAL NOT NULL DEFAULT 0,
  last_request_completion INTEGER,
  FOREIGN KEY (ship_id) REFERENCES ships(id) ON DELETE CASCADE
);

-- Tier completions table (many-to-many)
CREATE TABLE IF NOT EXISTS ship_tier_completions (
  ship_id TEXT NOT NULL,
  tier INTEGER NOT NULL,
  completions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ship_id, tier),
  FOREIGN KEY (ship_id) REFERENCES ships(id) ON DELETE CASCADE
);
```

### 8. API Endpoints (`src/local-server.ts` / `src/index.ts`)

**New Endpoints:**

```typescript
// GET /api/system/:id/requests - List available requests
// POST /api/system/:id/requests/:requestId/claim - Claim request
// POST /api/system/:id/requests/:requestId/fulfill - Fulfill request
// GET /api/ship/:id/reputation - Get ship reputation
// POST /api/ship/:id/reputation/reset - Reset reputation (admin)
```

### 9. Configuration (`src/balance-config.ts`)

**Add Constants:**

```typescript
export const REQUEST_GENERATION_INTERVAL_TICKS = 5;
export const REQUEST_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
export const REQUESTS_PER_TIER = 5;
export const FREE_TRADE_PROFIT_MULTIPLIER = 0.75; // Free trade is 75% of request profit
```

## Implementation Order

1. **Phase 1: Core Types & Storage**
   - Add type definitions
   - Create reputation storage (file or DB table)
   - Add request storage to SystemState

2. **Phase 2: Request Generation**
   - Implement `generateRequests()` in StarSystem
   - Call from `handleTick()`
   - Test request generation

3. **Phase 3: Request Claiming**
   - Implement claim/fulfill endpoints
   - Test atomic claiming

4. **Phase 4: Ship Integration**
   - Add `tryClaimRequest()` to Ship
   - Modify `tryTrading()` to check requests first
   - Test request claiming flow

5. **Phase 5: Reputation System**
   - Implement reputation tracking
   - Implement tier unlocks
   - Test reputation progression

6. **Phase 6: Discount Application**
   - Apply discounts to fuel/repairs/taxes
   - Test discount calculations

7. **Phase 7: Free Trade Penalty**
   - Apply profit multiplier to free trade
   - Test hybrid system

8. **Phase 8: API & UI**
   - Add API endpoints
   - Update dev interface to show requests
   - Add reputation display

## Testing Considerations

1. **Request Generation:**
   - Verify requests generated when inventory < consumption
   - Verify tier assignment based on good price
   - Verify priority calculation

2. **Request Claiming:**
   - Test atomic claiming (no race conditions)
   - Test expiration handling
   - Test tier gating

3. **Request Fulfillment:**
   - Test full fulfillment
   - Test partial fulfillment
   - Test reward calculation

4. **Reputation:**
   - Test tier unlocks
   - Test reputation level progression
   - Test discount application

5. **Integration:**
   - Test NPCs prefer requests over free trade
   - Test NPCs unlock higher tiers over time
   - Test cheaper goods get traded (Tier 1 requirement)

## Migration Notes

- Existing ships start with reputation level 0, tier unlock 1
- No existing requests (start fresh)
- Free trade remains at 100% profit initially (can reduce later)

## Future Enhancements

- Equipment gating by reputation (Phase 2)
- Bounty hunting system (Phase 3)
- Request chains (multi-hop deliveries)
- Faction-specific reputation
- Request expiration notifications
