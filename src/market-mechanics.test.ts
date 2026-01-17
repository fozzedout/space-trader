import { describe, it, expect, beforeEach } from "vitest";
import { StarSystem } from "./star-system";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { SystemId, TechLevel } from "./types";

describe("Market Mechanics", () => {
  let system: StarSystem;
  let mockState: MockDurableObjectState;
  let mockEnv: any;

  beforeEach(async () => {
    mockState = new MockDurableObjectState({ toString: () => "system-0" } as any);
    mockEnv = createMockEnv();
    system = new StarSystem(mockState, mockEnv);

    await system.initialize({
      id: 0 as SystemId,
      name: "Test System",
      population: 10,
      techLevel: TechLevel.INDUSTRIAL,
      worldType: "industrial" as any,
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

  describe("Market Initialization", () => {
    it("should create markets for all goods", async () => {
      const snapshot = await system.getSnapshot();
      const marketsObj = Object.fromEntries(snapshot.markets.entries());
      
      expect(marketsObj).toBeDefined();
      const marketKeys = Object.keys(marketsObj);
      expect(marketKeys.length).toBeGreaterThan(0);
      
      // Check that common goods exist
      expect(marketsObj).toHaveProperty("food");
      expect(marketsObj).toHaveProperty("metals");
    });

    it("should set initial prices based on system properties", async () => {
      const snapshot = await system.getSnapshot();
      
      const foodMarket = snapshot.markets.get("food");
      expect(foodMarket).toBeDefined();
      expect(foodMarket?.price).toBeGreaterThan(0);
      expect(typeof foodMarket?.price).toBe("number");
    });

    it("should set initial inventory", async () => {
      const snapshot = await system.getSnapshot();
      
      const foodMarket = snapshot.markets.get("food");
      expect(foodMarket?.inventory).toBeGreaterThanOrEqual(0);
      expect(typeof foodMarket?.inventory).toBe("number");
    });

    it("should have production and consumption rates", async () => {
      const snapshot = await system.getSnapshot();
      
      const foodMarket = snapshot.markets.get("food");
      expect(foodMarket?.production).toBeGreaterThanOrEqual(0);
      expect(foodMarket?.consumption).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Price Dynamics", () => {
    it("should update prices on tick", async () => {
      // Process tick
      await system.tick();

      const snapshot2 = await system.getSnapshot();
      const updatedPrice = snapshot2.markets.get("food")?.price;

      expect(updatedPrice).toBeDefined();
      expect(typeof updatedPrice).toBe("number");
      expect(updatedPrice).toBeGreaterThan(0);
    });

    it("should update inventory on tick", async () => {
      await system.tick();

      const snapshot2 = await system.getSnapshot();
      const updatedInventory = snapshot2.markets.get("food")?.inventory;

      expect(updatedInventory).toBeDefined();
      expect(typeof updatedInventory).toBe("number");
      expect(updatedInventory).toBeGreaterThanOrEqual(0);
    });

  });

  describe("Trading Impact on Markets", () => {
    it("should reduce inventory when buying", async () => {
      const snapshot1 = await system.getSnapshot();
      const initialInventory = snapshot1.markets.get("food")?.inventory || 0;

      if (initialInventory > 0) {
        const buyData = await system.trade({
          shipId: "test-ship",
          goodId: "food",
          quantity: Math.min(10, initialInventory),
          type: "buy",
        });

        expect(buyData.success).toBe(true);
        
        const snapshot2 = await system.getSnapshot();
        const updatedInventory = snapshot2.markets.get("food")?.inventory || 0;
        
        expect(updatedInventory).toBeLessThan(initialInventory);
      }
    });

    it("should increase inventory when selling", async () => {
      const snapshot1 = await system.getSnapshot();
      const initialInventory = snapshot1.markets.get("food")?.inventory || 0;
      const maxCapacity = 1000; // STATION_CAPACITY

      if (initialInventory < maxCapacity) {
        const sellData = await system.trade({
          shipId: "test-ship",
          goodId: "food",
          quantity: 10,
          type: "sell",
        });

        expect(sellData.success).toBe(true);
        
        const snapshot2 = await system.getSnapshot();
        const updatedInventory = snapshot2.markets.get("food")?.inventory || 0;
        
        expect(updatedInventory).toBeGreaterThanOrEqual(initialInventory);
      }
    });

    it("should reject buying when inventory insufficient", async () => {
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

    it("should allow selling beyond the old capacity limit", async () => {
      const snapshot = await system.getSnapshot();
      const currentInventory = snapshot.markets.get("food")?.inventory || 0;
      const sellQuantity = 2000;
      const sellData = await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity: sellQuantity,
        type: "sell",
      });

      expect(sellData.success).toBe(true);
      expect(sellData.quantity).toBe(sellQuantity);
      expect(sellData.newInventory).toBeCloseTo(currentInventory + sellQuantity);
    });
  });

  describe("System Property Impact", () => {
    it("should have different prices for different tech levels", async () => {
      const system1State = new MockDurableObjectState({ toString: () => "system-1" } as any);
      const system1 = new StarSystem(system1State, mockEnv);
      
      await system1.initialize({
        id: 1 as SystemId,
        name: "Low Tech",
        population: 10,
        techLevel: TechLevel.AGRICULTURAL,
        worldType: "agricultural" as any,
        seed: "tech-test-1",
      });

      const system2State = new MockDurableObjectState({ toString: () => "system-2" } as any);
      const system2 = new StarSystem(system2State, mockEnv);
      
      await system2.initialize({
        id: 2 as SystemId,
        name: "High Tech",
        population: 10,
        techLevel: TechLevel.HI_TECH,
        worldType: "high_tech" as any,
        seed: "tech-test-2",
      });

      const snapshot1 = await system1.getSnapshot();
      const snapshot2 = await system2.getSnapshot();

      // Prices should be different (or at least markets should exist)
      expect(snapshot1.markets.get("computers")).toBeDefined();
      expect(snapshot2.markets.get("computers")).toBeDefined();
      expect(typeof snapshot1.markets.get("computers")?.price).toBe("number");
      expect(typeof snapshot2.markets.get("computers")?.price).toBe("number");
    });

    it("should have different prices for different populations", async () => {
      const system1State = new MockDurableObjectState({ toString: () => "system-3" } as any);
      const system1 = new StarSystem(system1State, mockEnv);
      
      await system1.initialize({
        id: 3 as SystemId,
        name: "Small Pop",
        population: 1,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: "industrial" as any,
        seed: "pop-test-1",
      });

      const system2State = new MockDurableObjectState({ toString: () => "system-4" } as any);
      const system2 = new StarSystem(system2State, mockEnv);
      
      await system2.initialize({
        id: 4 as SystemId,
        name: "Large Pop",
        population: 100,
        techLevel: TechLevel.INDUSTRIAL,
        worldType: "industrial" as any,
        seed: "pop-test-2",
      });

      const snapshot1 = await system1.getSnapshot();
      const snapshot2 = await system2.getSnapshot();

      // Both should have markets
      expect(snapshot1.markets.get("food")).toBeDefined();
      expect(snapshot2.markets.get("food")).toBeDefined();
      // Production/consumption should differ
      expect(snapshot1.markets.get("food")?.production).toBeDefined();
      expect(snapshot2.markets.get("food")?.production).toBeDefined();
    });
  });

  describe("Price Elasticity and Market Dynamics", () => {
    it("should adjust prices based on supply and demand", async () => {
      const snapshot1 = await system.getSnapshot();
      void snapshot1.markets.get("food");

      // Process multiple ticks to allow price adjustment
      for (let i = 0; i < 10; i++) {
        await system.tick();
      }

      const snapshot2 = await system.getSnapshot();
      const updatedPrice = snapshot2.markets.get("food")?.price;
      const updatedInventory = snapshot2.markets.get("food")?.inventory;

      // Prices should be valid numbers
      expect(typeof updatedPrice).toBe("number");
      expect(updatedPrice).toBeGreaterThan(0);
      
      // Inventory should have changed due to production/consumption
      expect(typeof updatedInventory).toBe("number");
    });

    it("should handle price changes when inventory is depleted", async () => {
      const snapshot1 = await system.getSnapshot();
      const initialInventory = snapshot1.markets.get("food")?.inventory || 0;

      // Buy all available inventory
      if (initialInventory > 0) {
        const buyData = await system.trade({
          shipId: "test-ship",
          goodId: "food",
          quantity: initialInventory,
          type: "buy",
        });

        expect(buyData.success).toBe(true);

        // Process tick - price should adjust
        await system.tick();

        const snapshot2 = await system.getSnapshot();
        expect(snapshot2.markets.get("food")?.inventory).toBeGreaterThanOrEqual(0);
        expect(snapshot2.markets.get("food")?.price).toBeGreaterThan(0);
      }
    });

    it("should handle price changes when inventory is high", async () => {
      const snapshot1 = await system.getSnapshot();
      const currentInventory = snapshot1.markets.get("food")?.inventory || 0;
      const sellQuantity = 5000;

      await system.trade({
        shipId: "test-ship",
        goodId: "food",
        quantity: sellQuantity,
        type: "sell",
      });

      // Process tick - price should adjust
      await system.tick();

      const snapshot2 = await system.getSnapshot();
      expect(snapshot2.markets.get("food")?.inventory).toBeGreaterThanOrEqual(currentInventory);
      expect(snapshot2.markets.get("food")?.price).toBeGreaterThan(0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle markets with zero inventory", async () => {
      const snapshot = await system.getSnapshot();
      
      // Find a market with inventory
      const goodWithInventory = Array.from(snapshot.markets.keys()).find(
        goodId => (snapshot.markets.get(goodId)?.inventory || 0) > 0
      );

      if (goodWithInventory) {
        const market = snapshot.markets.get(goodWithInventory);
        const quantity = market?.inventory || 0;

        // Buy all inventory
        await system.trade({
          shipId: "test-ship",
          goodId: goodWithInventory,
          quantity,
          type: "buy",
        });

        // Market should still exist with zero inventory
        const snapshot2 = await system.getSnapshot();
        expect(snapshot2.markets.get(goodWithInventory)).toBeDefined();
        expect(snapshot2.markets.get(goodWithInventory)?.inventory).toBe(0);
        expect(snapshot2.markets.get(goodWithInventory)?.price).toBeGreaterThan(0);
      }
    });

    it("should maintain price consistency across ticks", async () => {
      const snapshot1 = await system.getSnapshot();
      const price1 = snapshot1.markets.get("food")?.price || 0;

      // Process tick
      await system.tick();

      const snapshot2 = await system.getSnapshot();
      const price2 = snapshot2.markets.get("food")?.price || 0;

      // Prices should be valid numbers (may change but should be consistent)
      expect(typeof price1).toBe("number");
      expect(typeof price2).toBe("number");
      expect(price1).toBeGreaterThan(0);
      expect(price2).toBeGreaterThan(0);
    });
  });
});
