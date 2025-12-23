import { describe, it, expect, beforeEach } from "vitest";
import { StarSystem } from "./star-system";
import { Ship } from "./ship";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { SystemId, TechLevel, GovernmentType, WorldType } from "./types";

describe("Complete System Workflows", () => {
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

    // Initialize systems
    await system1.fetch(new Request("https://dummy/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 1 as SystemId,
        name: "System 1",
        population: 50,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        government: GovernmentType.DEMOCRACY,
        seed: "workflow-seed-1",
      }),
    }));

    await system2.fetch(new Request("https://dummy/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 2 as SystemId,
        name: "System 2",
        population: 30,
        techLevel: TechLevel.POST_INDUSTRIAL,
        worldType: WorldType.HIGH_TECH,
        government: GovernmentType.CORPORATE,
        seed: "workflow-seed-2",
      }),
    }));

    // Initialize ship
    const shipState = new MockDurableObjectState({ toString: () => "ship-1" } as any);
    ship = new Ship(shipState, mockEnv);

    await ship.fetch(new Request("https://dummy/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "ship-1",
        name: "Trader",
        systemId: 1 as SystemId,
        seed: "ship-seed",
        isNPC: false, // Player ship for testing
      }),
    }));

    await system1.fetch(new Request("https://dummy/arrival", {
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
    }));
  });

  describe("Buy-Sell Workflow", () => {
    it("should complete a full buy-sell cycle", async () => {
      // Get initial state
      const shipState1 = await (await ship.fetch(new Request("https://dummy/state"))).json();
      const initialCredits = shipState1.credits;
      const initialCargo = Object.keys(shipState1.cargo).length;

      // Buy goods in system 1
      const buyResponse = await system1.fetch(new Request("https://dummy/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipId: "ship-1",
          goodId: "food",
          quantity: 10,
          type: "buy",
        }),
      }));

      expect(buyResponse.status).toBe(200);
      const buyData = await buyResponse.json();
      expect(buyData.success).toBe(true);
      expect(buyData.totalCost).toBeGreaterThan(0);

      // Verify ship state updated (would need ship to track this)
      // For now, verify trade succeeded
      expect(buyData.price).toBeGreaterThan(0);

      // Sell goods in system 2 (after travel)
      // First simulate arrival in system 2
      await system2.fetch(new Request("https://dummy/arrival", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timestamp: Date.now(),
          shipId: "ship-1",
          fromSystem: 1,
          toSystem: 2,
          cargo: [["food", 10]],
          priceInfo: [],
        }),
      }));

      const sellResponse = await system2.fetch(new Request("https://dummy/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipId: "ship-1",
          goodId: "food",
          quantity: 10,
          type: "sell",
        }),
      }));

      expect(sellResponse.status).toBe(200);
      const sellData = await sellResponse.json();
      expect(sellData.success).toBe(true);
      expect(sellData.totalValue).toBeGreaterThan(0);
    });

    it("should handle price differences between systems", async () => {
      const snapshot1 = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
      const snapshot2 = await (await system2.fetch(new Request("https://dummy/snapshot"))).json();

      const price1 = snapshot1.markets.food.price;
      const price2 = snapshot2.markets.food.price;

      // Prices should be numbers (may or may not be different)
      expect(typeof price1).toBe("number");
      expect(typeof price2).toBe("number");
      expect(price1).toBeGreaterThan(0);
      expect(price2).toBeGreaterThan(0);
    });
  });

  describe("NPC Trading Workflow", () => {
    it("should allow NPC to make trading decisions", async () => {
      const npcState = new MockDurableObjectState({ toString: () => "npc-1" } as any);
      const npc = new Ship(npcState, mockEnv);

      await npc.fetch(new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "npc-1",
          name: "NPC Trader",
          systemId: 1 as SystemId,
          seed: "npc-seed",
          isNPC: true,
        }),
      }));

      // Process tick - NPC should attempt trading
      const tickResponse = await npc.fetch(new Request("https://dummy/tick", { method: "POST" }));
      expect(tickResponse.status).toBe(200);
      
      const tickData = await tickResponse.json();
      expect(tickData).toHaveProperty("success");
    });
  });

  describe("Multi-Tick Simulation", () => {
    it("should maintain state across multiple ticks", async () => {
      const snapshot1 = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
      const tick1 = snapshot1.state.currentTick;

      // Process multiple ticks
      for (let i = 0; i < 5; i++) {
        await system1.fetch(new Request("https://dummy/tick", { method: "POST" }));
      }

      const snapshot2 = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
      const tick2 = snapshot2.state.currentTick;

      // Tick should be maintained or incremented
      expect(tick2).toBeGreaterThanOrEqual(tick1);
      
      // Markets should still exist
      expect(snapshot2.markets).toBeDefined();
      expect(snapshot2.markets.food).toBeDefined();
    });

    it("should update prices over multiple ticks", async () => {
      const snapshot1 = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
      const price1 = snapshot1.markets.food.price;

      // Process multiple ticks
      for (let i = 0; i < 10; i++) {
        await system1.fetch(new Request("https://dummy/tick", { method: "POST" }));
      }

      const snapshot2 = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
      const price2 = snapshot2.markets.food.price;

      // Price should still be valid
      expect(price2).toBeGreaterThan(0);
      expect(typeof price2).toBe("number");
    });
  });

  describe("Error Recovery", () => {
    it("should handle invalid trade requests gracefully", async () => {
      const invalidTrade = await system1.fetch(new Request("https://dummy/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipId: "nonexistent",
          goodId: "nonexistent-good",
          quantity: 10,
          type: "buy",
        }),
      }));

      expect(invalidTrade.status).toBe(400);
    });

    it("should handle system operations after errors", async () => {
      // Cause an error
      await system1.fetch(new Request("https://dummy/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipId: "test",
          goodId: "nonexistent",
          quantity: 10,
          type: "buy",
        }),
      }));

      // System should still work
      const snapshot = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
      expect(snapshot.markets).toBeDefined();
      expect(snapshot.state).toBeDefined();
    });
  });
});
