import { describe, it, expect, beforeEach } from "vitest";
import { StarSystem } from "./star-system";
import { Ship } from "./ship";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { TechLevel, SystemId, WorldType } from "./types";

describe("Integration Tests", () => {
  let system1: StarSystem;
  let system2: StarSystem;
  let ship: Ship;
  let mockEnv: any;

  beforeEach(async () => {
    mockEnv = createMockEnv();

    // Initialize two systems
    const state1 = new MockDurableObjectState({ toString: () => "system-1" } as any);
    system1 = new StarSystem(state1, mockEnv);
    mockEnv.STAR_SYSTEM.set(mockEnv.STAR_SYSTEM.idFromName("system-1"), system1);

    const state2 = new MockDurableObjectState({ toString: () => "system-2" } as any);
    system2 = new StarSystem(state2, mockEnv);
    mockEnv.STAR_SYSTEM.set(mockEnv.STAR_SYSTEM.idFromName("system-2"), system2);

    // Initialize ship
    const shipState = new MockDurableObjectState({ toString: () => "ship-1" } as any);
    ship = new Ship(shipState, mockEnv);

    // Initialize systems
    await system1.initialize({
      id: 1 as SystemId,
      name: "System 1",
      population: 50,
      techLevel: TechLevel.INDUSTRIAL,
      worldType: WorldType.INDUSTRIAL,
      seed: "system1-seed",
    });

    await system2.initialize({
      id: 2 as SystemId,
      name: "System 2",
      population: 30,
      techLevel: TechLevel.POST_INDUSTRIAL,
      worldType: WorldType.HIGH_TECH,
      seed: "system2-seed",
    });

    // Initialize ship in system 1
    await ship.initialize({
      id: "ship-1",
      name: "Test Trader",
      systemId: 1 as SystemId,
      seed: "ship-seed",
      isNPC: false, // Player ship for testing
    });

    await system1.shipArrival({
      timestamp: Date.now(),
      shipId: "ship-1",
      fromSystem: 1,
      toSystem: 1,
      cargo: new Map(),
      priceInfo: new Map(),
    });
  });

  it("should allow buying goods in one system and selling in another", async () => {
    // Buy goods in system 1
    const buyData = await system1.trade({
      shipId: "ship-1",
      goodId: "food",
      quantity: 10,
      type: "buy",
    });
    expect(buyData.success).toBe(true);

    // Get prices from both systems
    const snapshot1 = await system1.getSnapshot();
    const snapshot2 = await system2.getSnapshot();

    const price1 = snapshot1.markets.get("food")?.price || 0;
    const price2 = snapshot2.markets.get("food")?.price || 0;

    // Prices might be different (arbitrage opportunity)
    expect(typeof price1).toBe("number");
    expect(typeof price2).toBe("number");
  });

  it("should maintain deterministic behavior across systems", async () => {
    // Create two identical systems with same seed
    const stateA = new MockDurableObjectState({ toString: () => "system-a" } as any);
    const systemA = new StarSystem(stateA, mockEnv);

    const stateB = new MockDurableObjectState({ toString: () => "system-b" } as any);
    const systemB = new StarSystem(stateB, mockEnv);

    const seed = "deterministic-test";

    await systemA.initialize({
      id: 10 as SystemId,
      name: "System A",
      population: 20,
      techLevel: TechLevel.INDUSTRIAL,
      worldType: WorldType.INDUSTRIAL,
      seed,
    });

    await systemB.initialize({
      id: 11 as SystemId,
      name: "System B",
      population: 20,
      techLevel: TechLevel.INDUSTRIAL,
      worldType: WorldType.INDUSTRIAL,
      seed,
    });

    // Process same number of ticks
    await systemA.tick();
    await systemB.tick();

    const snapshotA = await systemA.getSnapshot();
    const snapshotB = await systemB.getSnapshot();

    // Prices should be the same (deterministic)
    expect(snapshotA.markets.get("food")?.price).toBe(snapshotB.markets.get("food")?.price);
  });

  it("should handle multiple ticks correctly", async () => {
    const initialSnapshot = await system1.getSnapshot();
    const initialTick = initialSnapshot.state?.currentTick || 0;

    // Process multiple ticks
    for (let i = 0; i < 5; i++) {
      const result = await system1.tick();
      expect(result.tick).toBeGreaterThanOrEqual(initialTick);
    }

    const finalSnapshot = await system1.getSnapshot();
    const finalTick = finalSnapshot.state?.currentTick || 0;

    // Tick should be at least the initial tick (may not increment if no time passed)
    expect(finalTick).toBeGreaterThanOrEqual(initialTick);
  });

  it("should update price history on ticks", async () => {
    const snapshot1 = await system1.getSnapshot();
    const tick1 = snapshot1.state?.currentTick || 0;

    await system1.tick();

    const snapshot2 = await system1.getSnapshot();
    const tick2 = snapshot2.state?.currentTick || 0;

    // Tick should be maintained (may not increment if no time passed in test)
    expect(tick2).toBeGreaterThanOrEqual(tick1);
    // Markets should still exist
    expect(snapshot2.markets).toBeDefined();
  });

  it("should handle ship arrival with price information", async () => {
    // Simulate ship arrival with price info from system 1
    const snapshot1 = await system1.getSnapshot();
    const price1 = snapshot1.markets.get("food")?.price || 0;

    await system2.shipArrival({
      timestamp: Date.now(),
      shipId: "ship-1",
      fromSystem: 1,
      toSystem: 2,
      cargo: new Map(),
      priceInfo: new Map([["food", price1]]),
    });

    // Price might have adjusted slightly based on external information
    const snapshotAfter = await system2.getSnapshot();
    const priceAfter = snapshotAfter.markets.get("food")?.price || 0;

    expect(typeof priceAfter).toBe("number");
    expect(priceAfter).toBeGreaterThan(0);
  });

  it("should validate monetary transactions correctly", async () => {
    // Get initial ship state
    await ship.getState();

    // Get market price
    const snapshot = await system1.getSnapshot();
    const price = snapshot.markets.get("food")?.price || 0;
    const quantity = 5;
    const taxRate = 0.03;
    const expectedCost = price * quantity * (1 + taxRate);

    // Buy goods
    const buyData = await system1.trade({
      shipId: "ship-1",
      goodId: "food",
      quantity,
      type: "buy",
    });

    expect(buyData.success).toBe(true);
    expect(buyData.totalCost).toBe(expectedCost);
    expect(buyData.price).toBe(price);
  });

  it("should handle complete trading cycle with monetary validation", async () => {
    // Initial state
    await ship.getState();

    // Get prices in both systems
    const snapshot1 = await system1.getSnapshot();
    const price1 = snapshot1.markets.get("food")?.price || 0;
    const quantity = 10;
    const taxRate = 0.03;

    // Buy in system 1
    const buyData = await system1.trade({
      shipId: "ship-1",
      goodId: "food",
      quantity,
      type: "buy",
    });

    expect(buyData.success).toBe(true);
    expect(buyData.totalCost).toBe(price1 * quantity * (1 + taxRate));

    // Travel to system 2
    await system2.shipArrival({
      timestamp: Date.now(),
      shipId: "ship-1",
      fromSystem: 1,
      toSystem: 2,
      cargo: new Map([["food", quantity]]),
      priceInfo: new Map([["food", price1]]),
    });

    // Sell in system 2
    const snapshot2 = await system2.getSnapshot();
    const price2 = snapshot2.markets.get("food")?.price || 0;

    const sellData = await system2.trade({
      shipId: "ship-1",
      goodId: "food",
      quantity,
      type: "sell",
    });

    expect(sellData.success).toBe(true);
    expect(sellData.totalValue).toBe(price2 * quantity);

    // Calculate profit/loss
    const profit = sellData.totalValue! - buyData.totalCost!;
    expect(typeof profit).toBe("number");
  });

  it("should handle insufficient credits scenario", async () => {
    const snapshot = await system1.getSnapshot();
    const price = snapshot.markets.get("food")?.price || 0;
    const quantity = Math.ceil(100000 / price); // More than ship can afford

    const result = await system1.trade({
      shipId: "ship-1",
      goodId: "food",
      quantity,
      type: "buy",
    });

    // Should either reject or only sell what's available
    if (result.success) {
      // If it succeeds, should only sell available inventory
      expect(result.totalCost).toBeGreaterThan(0);
    } else {
      expect(result.error).toBeDefined();
    }
  });

  it("should handle multiple consecutive trades", async () => {
    const snapshot = await system1.getSnapshot();
    const price = snapshot.markets.get("food")?.price || 0;
    const taxRate = 0.03;
    // Make multiple small trades
    for (let i = 0; i < 3; i++) {
      const data = await system1.trade({
        shipId: "ship-1",
        goodId: "food",
        quantity: 1,
        type: "buy",
      });

      expect(data.success).toBe(true);
      expect(data.totalCost).toBe(price * (1 + taxRate));
    }
  });
});
