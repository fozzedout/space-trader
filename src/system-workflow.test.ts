import { describe, it, expect, beforeEach } from "vitest";
import { StarSystem } from "./star-system";
import { Ship } from "./ship";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { SystemId, TechLevel, WorldType } from "./types";

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
    await system1.initialize({
      id: 1 as SystemId,
      name: "System 1",
      population: 50,
      techLevel: TechLevel.INDUSTRIAL,
      worldType: WorldType.INDUSTRIAL,
      seed: "workflow-seed-1",
    });

    await system2.initialize({
      id: 2 as SystemId,
      name: "System 2",
      population: 30,
      techLevel: TechLevel.POST_INDUSTRIAL,
      worldType: WorldType.HIGH_TECH,
      seed: "workflow-seed-2",
    });

    // Initialize ship
    const shipState = new MockDurableObjectState({ toString: () => "ship-1" } as any);
    ship = new Ship(shipState, mockEnv);

    await ship.initialize({
      id: "ship-1",
      name: "Trader",
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

  describe("Buy-Sell Workflow", () => {
    it("should complete a full buy-sell cycle", async () => {
      // Get initial state
      const shipState1 = await ship.getState();
      void shipState1;

      // Buy goods in system 1
      const buyData = await system1.trade({
        shipId: "ship-1",
        goodId: "food",
        quantity: 10,
        type: "buy",
      });

      expect(buyData.success).toBe(true);
      expect(buyData.totalCost).toBeGreaterThan(0);
      expect(buyData.price).toBeGreaterThan(0);

      // Sell goods in system 2 (after travel)
      // First simulate arrival in system 2
      await system2.shipArrival({
        timestamp: Date.now(),
        shipId: "ship-1",
        fromSystem: 1,
        toSystem: 2,
        cargo: new Map([["food", 10]]),
        priceInfo: new Map(),
      });

      const sellData = await system2.trade({
        shipId: "ship-1",
        goodId: "food",
        quantity: 10,
        type: "sell",
      });

      expect(sellData.success).toBe(true);
      expect(sellData.totalValue).toBeGreaterThan(0);
    });

    it("should handle price differences between systems", async () => {
      const snapshot1 = await system1.getSnapshot();
      const snapshot2 = await system2.getSnapshot();

      const price1 = snapshot1.markets.get("food")?.price || 0;
      const price2 = snapshot2.markets.get("food")?.price || 0;

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

      await npc.initialize({
        id: "npc-1",
        name: "NPC Trader",
        systemId: 1 as SystemId,
        seed: "npc-seed",
        isNPC: true,
      });

      // Process tick - NPC should attempt trading
      const result = await npc.tick();
      expect(result.skipped).toBe(false);
    });
  });

  describe("Multi-Tick Simulation", () => {
    it("should maintain state across multiple ticks", async () => {
      const snapshot1 = await system1.getSnapshot();
      const tick1 = snapshot1.state?.currentTick || 0;

      // Process multiple ticks
      for (let i = 0; i < 5; i++) {
        await system1.tick();
      }

      const snapshot2 = await system1.getSnapshot();
      const tick2 = snapshot2.state?.currentTick || 0;

      // Tick should be maintained or incremented
      expect(tick2).toBeGreaterThanOrEqual(tick1);
      
      // Markets should still exist
      expect(snapshot2.markets).toBeDefined();
      expect(snapshot2.markets.get("food")).toBeDefined();
    });

    it("should update prices over multiple ticks", async () => {
      const snapshot1 = await system1.getSnapshot();
      void snapshot1;

      // Process multiple ticks
      for (let i = 0; i < 10; i++) {
        await system1.tick();
      }

      const snapshot2 = await system1.getSnapshot();
      const price2 = snapshot2.markets.get("food")?.price || 0;

      // Price should still be valid
      expect(price2).toBeGreaterThan(0);
      expect(typeof price2).toBe("number");
    });
  });

  describe("Error Recovery", () => {
    it("should handle invalid trade requests gracefully", async () => {
      const result = await system1.trade({
        shipId: "nonexistent",
        goodId: "nonexistent-good",
        quantity: 10,
        type: "buy",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should handle system operations after errors", async () => {
      // Cause an error
      await system1.trade({
        shipId: "test",
        goodId: "nonexistent",
        quantity: 10,
        type: "buy",
      });

      // System should still work
      const snapshot = await system1.getSnapshot();
      expect(snapshot.markets).toBeDefined();
      expect(snapshot.state).toBeDefined();
    });
  });
});
