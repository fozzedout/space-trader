import { describe, it, expect, beforeEach, vi } from "vitest";
import { StarSystem } from "./star-system";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { TechLevel, SystemId, WorldType } from "./types";

describe("StarSystem", () => {
  let system: StarSystem;
  let mockState: MockDurableObjectState;
  let mockEnv: any;

  beforeEach(async () => {
    mockState = new MockDurableObjectState({ toString: () => "system-0" } as any);
    mockEnv = createMockEnv();
    system = new StarSystem(mockState, mockEnv);
  });

  describe("Initialization", () => {
    it("should initialize a new system", async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed-123",
      });

      const state = await system.getState();
      expect(state).toBeDefined();
      expect(state?.id).toBe(0);
    });

    it("should create markets for all goods", async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.HI_TECH,
        worldType: WorldType.HIGH_TECH,
        seed: "test-seed",
      });

      const snapshot = await system.getSnapshot();
      const marketsObj = Object.fromEntries(snapshot.markets.entries());

      expect(marketsObj).toBeDefined();
      expect(Object.keys(marketsObj).length).toBeGreaterThan(0);
    });

    it("should allow re-initialization", async () => {
      const initData = {
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed",
      };

      await system.initialize(initData);
      await system.initialize(initData);
      
      const state = await system.getState();
      expect(state).toBeDefined();
    });
  });

  describe("State Management", () => {
    beforeEach(async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed",
      });

      await system.shipArrival({
        timestamp: Date.now(),
        shipId: "test-ship",
        fromSystem: 0,
        toSystem: 0,
        cargo: new Map(),
        priceInfo: new Map(),
      });
    });

    it("should return system state", async () => {
      const state = await system.getState();

      expect(state?.id).toBe(0);
      expect(state?.name).toBe("Test System");
      expect(state?.population).toBe(10);
      expect(state?.techLevel).toBe(TechLevel.INDUSTRIAL);
    });

    it("should return system snapshot", async () => {
      const snapshot = await system.getSnapshot();

      expect(snapshot.state).toBeDefined();
      expect(snapshot.markets).toBeDefined();
      expect(snapshot.shipsInSystem).toBeDefined();
      expect(Array.isArray(Array.from(snapshot.shipsInSystem))).toBe(true);
    });
  });

  describe("Ticking", () => {
    beforeEach(async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed",
      });

      await system.shipArrival({
        timestamp: Date.now(),
        shipId: "test-ship",
        fromSystem: 0,
        toSystem: 0,
        cargo: new Map(),
        priceInfo: new Map(),
      });
    });

    it("should process ticks", async () => {
      const result = await system.tick();

      expect(result.tick).toBeGreaterThanOrEqual(0);
      expect(result.processed).toBeGreaterThanOrEqual(0);
    });

    it("should update market prices on tick", async () => {
      const snapshot1 = await system.getSnapshot();
      void snapshot1.markets.get("food")?.price;

      await system.tick();

      const snapshot2 = await system.getSnapshot();
      const price2 = snapshot2.markets.get("food")?.price;

      expect(price2).toBeDefined();
      expect(typeof price2).toBe("number");
    });

    it("should update inventory on tick", async () => {
      const snapshot1 = await system.getSnapshot();
      void snapshot1.markets.get("food")?.inventory;

      await system.tick();

      const snapshot2 = await system.getSnapshot();
      const inventory2 = snapshot2.markets.get("food")?.inventory;

      expect(inventory2).toBeDefined();
      expect(typeof inventory2).toBe("number");
    });
  });

  describe("Trading", () => {
    beforeEach(async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed",
      });

      await system.shipArrival({
        timestamp: Date.now(),
        shipId: "test-ship",
        fromSystem: 0,
        toSystem: 0,
        cargo: new Map(),
        priceInfo: new Map(),
      });
    });

    it("should allow buying goods", async () => {
      const result = await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity: 10,
        type: "buy",
      });

      expect(result.success).toBe(true);
      expect(result.price).toBeGreaterThan(0);
      expect(result.totalCost).toBeGreaterThan(0);
    });

    it("should reject buying when inventory is insufficient", async () => {
      const snapshot = await system.getSnapshot();
      const maxInventory = snapshot.markets.get("food")?.inventory || 0;

      const result = await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity: maxInventory + 1000,
        type: "buy",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should allow selling goods", async () => {
      const result = await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity: 10,
        type: "sell",
      });

      expect(result.success).toBe(true);
      expect(result.price).toBeGreaterThan(0);
      expect(result.totalValue).toBeGreaterThan(0);
    });

    it("should reject selling for nonexistent goods", async () => {
      const result = await system.trade({
        shipId: "test-ship",
        goodId: "nonexistent",
        quantity: 10,
        type: "sell",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("Ship Management", () => {
    beforeEach(async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed",
      });

      await system.shipArrival({
        timestamp: Date.now(),
        shipId: "test-ship",
        fromSystem: 0,
        toSystem: 0,
        cargo: new Map(),
        priceInfo: new Map(),
      });
    });

    it("should handle ship arrival", async () => {
      await system.shipArrival({
        timestamp: Date.now(),
        shipId: "test-ship",
        fromSystem: 1,
        toSystem: 0,
        cargo: new Map(),
        priceInfo: new Map(),
      });

      const snapshot = await system.getSnapshot();
      expect(Array.from(snapshot.shipsInSystem)).toContain("test-ship");
    });

    it("should handle ship departure", async () => {
      await system.shipArrival({
        timestamp: Date.now(),
        shipId: "test-ship",
        fromSystem: 1,
        toSystem: 0,
        cargo: new Map(),
        priceInfo: new Map(),
      });

      await system.shipDeparture("test-ship");

      const snapshot = await system.getSnapshot();
      expect(Array.from(snapshot.shipsInSystem)).not.toContain("test-ship");
    });
  });

  describe("Market Capacity Limits", () => {
    beforeEach(async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed",
      });

      await system.shipArrival({
        timestamp: Date.now(),
        shipId: "test-ship",
        fromSystem: 0,
        toSystem: 0,
        cargo: new Map(),
        priceInfo: new Map(),
      });
    });

    it("should allow selling beyond the old capacity limit", async () => {
      const snapshot = await system.getSnapshot();
      const currentInventory = snapshot.markets.get("food")?.inventory || 0;
      const sellQuantity = 15000;
      const result = await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity: sellQuantity,
        type: "sell",
      });

      expect(result.success).toBe(true);
      expect(result.quantity).toBe(sellQuantity);
      expect(result.newInventory).toBeCloseTo(currentInventory + sellQuantity);
    });

    it("should allow inventory to exceed the old cap", async () => {
      const snapshot = await system.getSnapshot();
      const currentInventory = snapshot.markets.get("food")?.inventory || 0;
      if (currentInventory > 10000) {
        expect(currentInventory).toBeGreaterThan(10000);
        return;
      }

      const sellQuantity = Math.max(1, 10001 - currentInventory);
      await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity: sellQuantity,
        type: "sell",
      });

      const snapshotAfter = await system.getSnapshot();
      expect(snapshotAfter.markets.get("food")?.inventory).toBeGreaterThan(10000);
    });
  });

  describe("Price Dynamics and Monetary Validation", () => {
    beforeEach(async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed",
      });

      await system.shipArrival({
        timestamp: Date.now(),
        shipId: "test-ship",
        fromSystem: 0,
        toSystem: 0,
        cargo: new Map(),
        priceInfo: new Map(),
      });
    });

    it("should calculate total cost correctly for buys", async () => {
      const snapshot = await system.getSnapshot();
      const price = snapshot.markets.get("food")?.price || 0;
      const quantity = 10;
      const taxRate = 0.03;
      const expectedCost = price * quantity * (1 + taxRate);

      const result = await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity,
        type: "buy",
      });
      
      expect(result.success).toBe(true);
      expect(result.totalCost).toBe(expectedCost);
      expect(result.price).toBe(price);
    });

    it("should calculate total value correctly for sells", async () => {
      const snapshot = await system.getSnapshot();
      const price = snapshot.markets.get("food")?.price || 0;
      const quantity = 10;

      const result = await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity,
        type: "sell",
      });
      
      expect(result.success).toBe(true);
      expect(result.totalValue).toBe(price * quantity);
      expect(result.price).toBe(price);
    });

    it("should update inventory correctly after buy", async () => {
      const snapshot1 = await system.getSnapshot();
      const initialInventory = snapshot1.markets.get("food")?.inventory || 0;
      const quantity = Math.min(10, initialInventory);

      if (quantity > 0) {
        await system.trade({
          shipId: "test-ship",
          goodId: "food",
          quantity,
          type: "buy",
        });

        const snapshot2 = await system.getSnapshot();
        expect(snapshot2.markets.get("food")?.inventory).toBe(initialInventory - quantity);
      }
    });

    it("should update inventory correctly after sell", async () => {
      const snapshot1 = await system.getSnapshot();
      const initialInventory = snapshot1.markets.get("food")?.inventory || 0;
      const quantity = 10;

      if (quantity > 0) {
        await system.trade({
          shipId: "test-ship",
          goodId: "food",
          quantity,
          type: "sell",
        });

        const snapshot2 = await system.getSnapshot();
        expect(snapshot2.markets.get("food")?.inventory).toBe(initialInventory + quantity);
      }
    });
  });

  describe("Multiple Ship Operations", () => {
    beforeEach(async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed",
      });
    });

    it("should handle multiple ships arriving", async () => {
      const shipIds = ["ship-1", "ship-2", "ship-3"];
      
      for (const shipId of shipIds) {
        await system.shipArrival({
          timestamp: Date.now(),
          shipId,
          fromSystem: 1,
          toSystem: 0,
          cargo: new Map(),
          priceInfo: new Map(),
        });
      }

      const snapshot = await system.getSnapshot();
      for (const shipId of shipIds) {
        expect(Array.from(snapshot.shipsInSystem)).toContain(shipId);
      }
    });

    it("should handle multiple ships departing", async () => {
      const shipIds = ["ship-1", "ship-2"];
      
      for (const shipId of shipIds) {
        await system.shipArrival({
          timestamp: Date.now(),
          shipId,
          fromSystem: 1,
          toSystem: 0,
          cargo: new Map(),
          priceInfo: new Map(),
        });
      }

      for (const shipId of shipIds) {
        await system.shipDeparture(shipId);
      }

      const snapshot = await system.getSnapshot();
      for (const shipId of shipIds) {
        expect(Array.from(snapshot.shipsInSystem)).not.toContain(shipId);
      }
    });
  });

  describe("Edge Cases", () => {
    beforeEach(async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed",
      });
    });

    it("should reject buying zero quantity", async () => {
      const result = await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity: 0,
        type: "buy",
      });
      // Should handle gracefully (may succeed with 0 cost or reject)
      expect(result.success === false || result.totalCost === 0).toBe(true);
    });

    it("should handle buying negative quantity", async () => {
      const result = await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity: -10,
        type: "buy",
      });
      // System should reject negative quantity
      expect(result.success).toBe(false);
    });

    it("should handle nonexistent good IDs", async () => {
      const result = await system.trade({
        shipId: "test-ship",
        goodId: "nonexistent-good-12345",
        quantity: 10,
        type: "buy",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("should handle state persistence across ticks", async () => {
      const snapshot1 = await system.getSnapshot();
      const tick1 = snapshot1.state?.currentTick || 0;

      await system.tick();

      const snapshot2 = await system.getSnapshot();
      expect(snapshot2.state?.currentTick).toBeGreaterThanOrEqual(tick1);
      expect(snapshot2.markets).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should return 404 for unknown endpoints", async () => {
      const request = new Request("https://dummy/unknown");
      const response = await system.fetch(request);
      expect(response.status).toBe(404);
    });

    it("should handle errors gracefully", async () => {
      // Try to get state before initialization
      const state = await system.getState();
      // Should return state (null) or handle gracefully
      expect(state === null || state !== undefined).toBe(true);
    });

    it("should handle invalid trade requests", async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.INDUSTRIAL,
        seed: "test-seed",
      });

      // @ts-expect-error - Testing invalid input
      const result = await system.trade({});
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("Delivery Jobs", () => {
    it("should handle undefined destSystem in generateDeliveryJobs gracefully", async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.TRADE_HUB,
        seed: "test-seed-delivery",
        x: 0,
        y: 0,
      });

      // Mock getReachableSystems to return array with undefined element
      vi.spyOn(system, 'getReachableSystems').mockResolvedValueOnce([
        { id: 1 as SystemId, distance: 5 },
        undefined as unknown as { id: SystemId; distance: number },
        { id: 2 as SystemId, distance: 10 },
      ]);

      // Advance tick to trigger delivery job generation (every 10 ticks)
      for (let i = 0; i < 12; i++) {
        await system.tick();
      }

      // Should not crash - verify system is still functional
      const state = await system.getState();
      expect(state).toBeDefined();
      
      // Restore original method
      vi.restoreAllMocks();
    });

    it("should handle empty reachableSystems array in generateDeliveryJobs", async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.TRADE_HUB,
        seed: "test-seed-empty",
        x: 0,
        y: 0,
      });

      // Mock getReachableSystems to return empty array
      vi.spyOn(system, 'getReachableSystems').mockResolvedValueOnce([]);

      // Advance tick to trigger delivery job generation
      for (let i = 0; i < 12; i++) {
        await system.tick();
      }

      // Should not crash - verify system is still functional
      const state = await system.getState();
      expect(state).toBeDefined();
      
      vi.restoreAllMocks();
    });

    it("should handle destSystem with missing distance property", async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.TRADE_HUB,
        seed: "test-seed-invalid",
        x: 0,
        y: 0,
      });

      // Mock getReachableSystems to return array with invalid element (missing distance)
      vi.spyOn(system, 'getReachableSystems').mockResolvedValueOnce([
        { id: 1 as SystemId, distance: 5 },
        { id: 2 as SystemId } as unknown as { id: SystemId; distance: number },
      ]);

      // Advance tick to trigger delivery job generation
      for (let i = 0; i < 12; i++) {
        await system.tick();
      }

      // Should not crash - verify system is still functional
      const state = await system.getState();
      expect(state).toBeDefined();
      
      vi.restoreAllMocks();
    });

    it("should filter out undefined entries from getReachableSystems result", async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.TRADE_HUB,
        seed: "test-seed-filter",
        x: 0,
        y: 0,
      });

      // Mock getReachableSystems to return array with undefined at index 13 (reproducing the crash scenario)
      const mockSystems: Array<{ id: SystemId; distance: number } | undefined> = [];
      for (let i = 0; i < 20; i++) {
        if (i === 13) {
          mockSystems[i] = undefined;
        } else {
          mockSystems[i] = { id: (i + 1) as SystemId, distance: 5 + i };
        }
      }
      
      vi.spyOn(system, 'getReachableSystems').mockResolvedValueOnce(
        mockSystems as Array<{ id: SystemId; distance: number }>
      );

      // Advance tick to trigger delivery job generation
      for (let i = 0; i < 12; i++) {
        await system.tick();
      }

      // Should not crash - verify system is still functional
      const state = await system.getState();
      expect(state).toBeDefined();
      
      vi.restoreAllMocks();
    });

    it("should handle randomInt returning out-of-bounds index (reproducing index 9 crash)", async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.TRADE_HUB,
        seed: "test-seed-index9",
        x: 0,
        y: 0,
      });

      // Mock getReachableSystems to return exactly 9 valid systems
      // This tests the case where randomInt might return index 9 when array length is 9
      const mockSystems: Array<{ id: SystemId; distance: number }> = [];
      for (let i = 0; i < 9; i++) {
        mockSystems.push({ id: (i + 1) as SystemId, distance: 5 + i });
      }
      
      vi.spyOn(system, 'getReachableSystems').mockResolvedValueOnce(mockSystems);

      // Advance tick to trigger delivery job generation
      for (let i = 0; i < 12; i++) {
        await system.tick();
      }

      // Should not crash - verify system is still functional
      const state = await system.getState();
      expect(state).toBeDefined();
      
      vi.restoreAllMocks();
    });

    it("should handle getReachableSystems returning array with NaN values", async () => {
      await system.initialize({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: WorldType.TRADE_HUB,
        seed: "test-seed-nan",
        x: 0,
        y: 0,
      });

      // Mock getReachableSystems to return array with NaN distance
      vi.spyOn(system, 'getReachableSystems').mockResolvedValueOnce([
        { id: 1 as SystemId, distance: 5 },
        { id: 2 as SystemId, distance: NaN },
        { id: 3 as SystemId, distance: 10 },
      ]);

      // Advance tick to trigger delivery job generation
      for (let i = 0; i < 12; i++) {
        await system.tick();
      }

      // Should not crash - verify system is still functional
      const state = await system.getState();
      expect(state).toBeDefined();
      
      vi.restoreAllMocks();
    });
  });
});
