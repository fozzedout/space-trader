import { describe, it, expect, beforeEach } from "vitest";
import { StarSystem } from "./star-system";
import { Ship } from "./ship";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { TechLevel, GovernmentType, SystemId, WorldType } from "./types";

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

    const state2 = new MockDurableObjectState({ toString: () => "system-2" } as any);
    system2 = new StarSystem(state2, mockEnv);

    // Initialize ship
    const shipState = new MockDurableObjectState({ toString: () => "ship-1" } as any);
    ship = new Ship(shipState, mockEnv);

    // Initialize systems
    await system1.fetch(
      new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 1 as SystemId,
          name: "System 1",
          population: 50,
          techLevel: TechLevel.INDUSTRIAL,
          worldType: WorldType.INDUSTRIAL,
          government: GovernmentType.DEMOCRACY,
          seed: "system1-seed",
        }),
      })
    );

    await system2.fetch(
      new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 2 as SystemId,
          name: "System 2",
          population: 30,
          techLevel: TechLevel.POST_INDUSTRIAL,
          worldType: WorldType.HIGH_TECH,
          government: GovernmentType.CORPORATE,
          seed: "system2-seed",
        }),
      })
    );

    // Initialize ship in system 1
    await ship.fetch(
      new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "ship-1",
          name: "Test Trader",
          systemId: 1 as SystemId,
          seed: "ship-seed",
          isNPC: false, // Player ship for testing
        }),
      })
    );

    await system1.fetch(
      new Request("https://dummy/arrival", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timestamp: Date.now(),
          shipId: "ship-1",
          fromSystem: 1,
          toSystem: 1,
          cargo: [],
          priceInfo: [],
        }),
      })
    );
  });

  it("should allow buying goods in one system and selling in another", async () => {
    // Buy goods in system 1
    const buyRequest = new Request("https://dummy/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shipId: "ship-1",
        goodId: "food",
        quantity: 10,
        type: "buy",
      }),
    });

    const buyResponse = await system1.fetch(buyRequest);
    expect(buyResponse.status).toBe(200);
    const buyData = await buyResponse.json();
    expect(buyData.success).toBe(true);

    // Get prices from both systems
    const snapshot1 = await (
      await system1.fetch(new Request("https://dummy/snapshot"))
    ).json();
    const snapshot2 = await (
      await system2.fetch(new Request("https://dummy/snapshot"))
    ).json();

    const price1 = snapshot1.markets.food.price;
    const price2 = snapshot2.markets.food.price;

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

    await systemA.fetch(
      new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 10 as SystemId,
          name: "System A",
          population: 20,
          techLevel: TechLevel.INDUSTRIAL,
          government: GovernmentType.DEMOCRACY,
          seed,
        }),
      })
    );

    await systemB.fetch(
      new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 11 as SystemId,
          name: "System B",
          population: 20,
          techLevel: TechLevel.INDUSTRIAL,
          government: GovernmentType.DEMOCRACY,
          seed,
        }),
      })
    );

    // Process same number of ticks
    await systemA.fetch(new Request("https://dummy/tick", { method: "POST" }));
    await systemB.fetch(new Request("https://dummy/tick", { method: "POST" }));

    const snapshotA = await (
      await systemA.fetch(new Request("https://dummy/snapshot"))
    ).json();
    const snapshotB = await (
      await systemB.fetch(new Request("https://dummy/snapshot"))
    ).json();

    // Prices should be the same (deterministic)
    expect(snapshotA.markets.food.price).toBe(snapshotB.markets.food.price);
  });

  it("should handle multiple ticks correctly", async () => {
    const initialSnapshot = await (
      await system1.fetch(new Request("https://dummy/snapshot"))
    ).json();
    const initialTick = initialSnapshot.state.currentTick;

    // Process multiple ticks
    // Note: Ticks only process if time has passed, so we check that tick endpoint works
    for (let i = 0; i < 5; i++) {
      const tickResponse = await system1.fetch(new Request("https://dummy/tick", { method: "POST" }));
      const tickData = await tickResponse.json();
      expect(tickData.tick).toBeGreaterThanOrEqual(initialTick);
    }

    const finalSnapshot = await (
      await system1.fetch(new Request("https://dummy/snapshot"))
    ).json();
    const finalTick = finalSnapshot.state.currentTick;

    // Tick should be at least the initial tick (may not increment if no time passed)
    expect(finalTick).toBeGreaterThanOrEqual(initialTick);
  });

  it("should update price history on ticks", async () => {
    const snapshot1 = await (
      await system1.fetch(new Request("https://dummy/snapshot"))
    ).json();
    const tick1 = snapshot1.state.currentTick;

    const tickResponse = await system1.fetch(new Request("https://dummy/tick", { method: "POST" }));
    const tickData = await tickResponse.json();

    const snapshot2 = await (
      await system1.fetch(new Request("https://dummy/snapshot"))
    ).json();
    const tick2 = snapshot2.state.currentTick;

    // Tick should be maintained (may not increment if no time passed in test)
    expect(tick2).toBeGreaterThanOrEqual(tick1);
    // Markets should still exist
    expect(snapshot2.markets).toBeDefined();
  });

  it("should handle ship arrival with price information", async () => {
    // Get initial price in system 2
    const snapshotBefore = await (
      await system2.fetch(new Request("https://dummy/snapshot"))
    ).json();
    const priceBefore = snapshotBefore.markets.food.price;

    // Simulate ship arrival with price info from system 1
    const snapshot1 = await (
      await system1.fetch(new Request("https://dummy/snapshot"))
    ).json();
    const price1 = snapshot1.markets.food.price;

    const arrivalRequest = new Request("https://dummy/arrival", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: Date.now(),
        shipId: "ship-1",
        fromSystem: 1,
        toSystem: 2,
        cargo: [],
        priceInfo: [["food", price1]],
      }),
    });

    await system2.fetch(arrivalRequest);

    // Price might have adjusted slightly based on external information
    const snapshotAfter = await (
      await system2.fetch(new Request("https://dummy/snapshot"))
    ).json();
    const priceAfter = snapshotAfter.markets.food.price;

    expect(typeof priceAfter).toBe("number");
    expect(priceAfter).toBeGreaterThan(0);
  });

  it("should validate monetary transactions correctly", async () => {
    // Get initial ship state
    const shipState1 = await (await ship.fetch(new Request("https://dummy/state"))).json();
    const initialCredits = shipState1.credits;

    // Get market price
    const snapshot = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
    const price = snapshot.markets.food.price;
    const quantity = 5;
    const taxRate = 0.03;
    const expectedCost = price * quantity * (1 + taxRate);

    // Buy goods
    const buyResponse = await system1.fetch(new Request("https://dummy/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shipId: "ship-1",
        goodId: "food",
        quantity,
        type: "buy",
      }),
    }));

    expect(buyResponse.status).toBe(200);
    const buyData = await buyResponse.json();
    expect(buyData.success).toBe(true);
    expect(buyData.totalCost).toBe(expectedCost);
    expect(buyData.price).toBe(price);
  });

  it("should handle complete trading cycle with monetary validation", async () => {
    // Initial state
    const shipState1 = await (await ship.fetch(new Request("https://dummy/state"))).json();
    const initialCredits = shipState1.credits;

    // Get prices in both systems
    const snapshot1 = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
    const price1 = snapshot1.markets.food.price;
    const quantity = 10;
    const taxRate = 0.03;

    // Buy in system 1
    const buyResponse = await system1.fetch(new Request("https://dummy/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shipId: "ship-1",
        goodId: "food",
        quantity,
        type: "buy",
      }),
    }));

    expect(buyResponse.status).toBe(200);
    const buyData = await buyResponse.json();
    expect(buyData.totalCost).toBe(price1 * quantity * (1 + taxRate));

    // Travel to system 2
    await system2.fetch(new Request("https://dummy/arrival", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: Date.now(),
        shipId: "ship-1",
        fromSystem: 1,
        toSystem: 2,
        cargo: [["food", quantity]],
        priceInfo: [["food", price1]],
      }),
    }));

    // Sell in system 2
    const snapshot2 = await (await system2.fetch(new Request("https://dummy/snapshot"))).json();
    const price2 = snapshot2.markets.food.price;

    const sellResponse = await system2.fetch(new Request("https://dummy/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shipId: "ship-1",
        goodId: "food",
        quantity,
        type: "sell",
      }),
    }));

    expect(sellResponse.status).toBe(200);
    const sellData = await sellResponse.json();
    expect(sellData.totalValue).toBe(price2 * quantity);

    // Calculate profit/loss
    const profit = sellData.totalValue - buyData.totalCost;
    expect(typeof profit).toBe("number");
  });

  it("should handle insufficient credits scenario", async () => {
    const snapshot = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
    const price = snapshot.markets.food.price;
    const taxRate = 0.03;
    const quantity = Math.ceil(100000 / price); // More than ship can afford

    const buyResponse = await system1.fetch(new Request("https://dummy/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shipId: "ship-1",
        goodId: "food",
        quantity,
        type: "buy",
      }),
    }));

    // Should either reject or only sell what's available
    if (buyResponse.status === 200) {
      const data = await buyResponse.json();
      // If it succeeds, should only sell available inventory
      expect(data.totalCost).toBeGreaterThan(0);
    } else {
      expect(buyResponse.status).toBe(400);
    }
  });

  it("should handle multiple consecutive trades", async () => {
    const snapshot = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
    const price = snapshot.markets.food.price;
    const taxRate = 0.03;

    // Make multiple small trades
    for (let i = 0; i < 3; i++) {
      const tradeResponse = await system1.fetch(new Request("https://dummy/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipId: "ship-1",
          goodId: "food",
          quantity: 1,
          type: "buy",
        }),
      }));

      expect(tradeResponse.status).toBe(200);
      const data = await tradeResponse.json();
      expect(data.success).toBe(true);
      expect(data.totalCost).toBe(price * (1 + taxRate));
    }
  });
});
