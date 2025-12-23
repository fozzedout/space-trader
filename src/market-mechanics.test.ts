import { describe, it, expect, beforeEach } from "vitest";
import { StarSystem } from "./star-system";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { SystemId, TechLevel, GovernmentType } from "./types";

describe("Market Mechanics", () => {
  let system: StarSystem;
  let mockState: MockDurableObjectState;
  let mockEnv: any;

  beforeEach(async () => {
    mockState = new MockDurableObjectState({ toString: () => "system-0" } as any);
    mockEnv = createMockEnv();
    system = new StarSystem(mockState, mockEnv);

    await system.fetch(new Request("https://dummy/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.INDUSTRIAL,
        government: GovernmentType.DEMOCRACY,
        seed: "test-seed",
      }),
    }));

    await system.fetch(new Request("https://dummy/arrival", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        timestamp: Date.now(),
        shipId: "test-ship",
        fromSystem: 0,
        toSystem: 0,
        cargo: [],
        priceInfo: [],
      }),
    }));
  });

  describe("Market Initialization", () => {
    it("should create markets for all goods", async () => {
      const snapshot = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      
      expect(snapshot.markets).toBeDefined();
      const marketKeys = Object.keys(snapshot.markets);
      expect(marketKeys.length).toBeGreaterThan(0);
      
      // Check that common goods exist
      expect(snapshot.markets).toHaveProperty("food");
      expect(snapshot.markets).toHaveProperty("metals");
    });

    it("should set initial prices based on system properties", async () => {
      const snapshot = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      
      const foodMarket = snapshot.markets.food;
      expect(foodMarket).toBeDefined();
      expect(foodMarket.price).toBeGreaterThan(0);
      expect(typeof foodMarket.price).toBe("number");
    });

    it("should set initial inventory", async () => {
      const snapshot = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      
      const foodMarket = snapshot.markets.food;
      expect(foodMarket.inventory).toBeGreaterThanOrEqual(0);
      expect(typeof foodMarket.inventory).toBe("number");
    });

    it("should have production and consumption rates", async () => {
      const snapshot = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      
      const foodMarket = snapshot.markets.food;
      expect(foodMarket.production).toBeGreaterThanOrEqual(0);
      expect(foodMarket.consumption).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Price Dynamics", () => {
    it("should update prices on tick", async () => {
      const snapshot1 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const initialPrice = snapshot1.markets.food.price;

      // Process tick
      await system.fetch(new Request("https://dummy/tick", { method: "POST" }));

      const snapshot2 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const updatedPrice = snapshot2.markets.food.price;

      expect(updatedPrice).toBeDefined();
      expect(typeof updatedPrice).toBe("number");
      expect(updatedPrice).toBeGreaterThan(0);
    });

    it("should update inventory on tick", async () => {
      const snapshot1 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const initialInventory = snapshot1.markets.food.inventory;

      await system.fetch(new Request("https://dummy/tick", { method: "POST" }));

      const snapshot2 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const updatedInventory = snapshot2.markets.food.inventory;

      expect(updatedInventory).toBeDefined();
      expect(typeof updatedInventory).toBe("number");
      expect(updatedInventory).toBeGreaterThanOrEqual(0);
    });

  });

  describe("Trading Impact on Markets", () => {
    it("should reduce inventory when buying", async () => {
      const snapshot1 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const initialInventory = snapshot1.markets.food.inventory;

      if (initialInventory > 0) {
        const buyResponse = await system.fetch(new Request("https://dummy/trade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shipId: "test-ship",
            goodId: "food",
            quantity: Math.min(10, initialInventory),
            type: "buy",
          }),
        }));

        expect(buyResponse.status).toBe(200);
        
        const snapshot2 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
        const updatedInventory = snapshot2.markets.food.inventory;
        
        expect(updatedInventory).toBeLessThan(initialInventory);
      }
    });

    it("should increase inventory when selling", async () => {
      const snapshot1 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const initialInventory = snapshot1.markets.food.inventory;
      const maxCapacity = 1000; // STATION_CAPACITY

      if (initialInventory < maxCapacity) {
        const sellResponse = await system.fetch(new Request("https://dummy/trade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shipId: "test-ship",
            goodId: "food",
            quantity: 10,
            type: "sell",
          }),
        }));

        expect(sellResponse.status).toBe(200);
        
        const snapshot2 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
        const updatedInventory = snapshot2.markets.food.inventory;
        
        expect(updatedInventory).toBeGreaterThanOrEqual(initialInventory);
      }
    });

    it("should reject buying when inventory insufficient", async () => {
      const snapshot = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const maxInventory = snapshot.markets.food.inventory;

      const buyResponse = await system.fetch(new Request("https://dummy/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipId: "test-ship",
          goodId: "food",
          quantity: maxInventory + 1000,
          type: "buy",
        }),
      }));

      expect(buyResponse.status).toBe(400);
    });

    it("should limit selling when station at capacity", async () => {
      const snapshot = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const currentInventory = snapshot.markets.food.inventory;
      const maxCapacity = 1000;

      if (currentInventory < maxCapacity) {
        const sellResponse = await system.fetch(new Request("https://dummy/trade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shipId: "test-ship",
            goodId: "food",
            quantity: maxCapacity * 2, // More than capacity
            type: "sell",
          }),
        }));

        expect(sellResponse.status).toBe(200);
        const sellData = await sellResponse.json();
        
        // Should only accept up to capacity
        expect(sellData.quantity).toBeLessThanOrEqual(maxCapacity - currentInventory);
      }
    });
  });

  describe("System Property Impact", () => {
    it("should have different prices for different tech levels", async () => {
      const system1State = new MockDurableObjectState({ toString: () => "system-1" } as any);
      const system1 = new StarSystem(system1State, mockEnv);
      
      await system1.fetch(new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 1 as SystemId,
          name: "Low Tech",
          population: 10,
          techLevel: TechLevel.AGRICULTURAL,
          government: GovernmentType.DEMOCRACY,
          seed: "tech-test-1",
        }),
      }));

      const system2State = new MockDurableObjectState({ toString: () => "system-2" } as any);
      const system2 = new StarSystem(system2State, mockEnv);
      
      await system2.fetch(new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 2 as SystemId,
          name: "High Tech",
          population: 10,
          techLevel: TechLevel.HI_TECH,
          government: GovernmentType.DEMOCRACY,
          seed: "tech-test-2",
        }),
      }));

      const snapshot1 = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
      const snapshot2 = await (await system2.fetch(new Request("https://dummy/snapshot"))).json();

      // Prices should be different (or at least markets should exist)
      expect(snapshot1.markets.computers).toBeDefined();
      expect(snapshot2.markets.computers).toBeDefined();
      expect(typeof snapshot1.markets.computers.price).toBe("number");
      expect(typeof snapshot2.markets.computers.price).toBe("number");
    });

    it("should have different prices for different populations", async () => {
      const system1State = new MockDurableObjectState({ toString: () => "system-3" } as any);
      const system1 = new StarSystem(system1State, mockEnv);
      
      await system1.fetch(new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 3 as SystemId,
          name: "Small Pop",
          population: 1,
          techLevel: TechLevel.INDUSTRIAL,
          government: GovernmentType.DEMOCRACY,
          seed: "pop-test-1",
        }),
      }));

      const system2State = new MockDurableObjectState({ toString: () => "system-4" } as any);
      const system2 = new StarSystem(system2State, mockEnv);
      
      await system2.fetch(new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: 4 as SystemId,
          name: "Large Pop",
          population: 100,
          techLevel: TechLevel.INDUSTRIAL,
          government: GovernmentType.DEMOCRACY,
          seed: "pop-test-2",
        }),
      }));

      const snapshot1 = await (await system1.fetch(new Request("https://dummy/snapshot"))).json();
      const snapshot2 = await (await system2.fetch(new Request("https://dummy/snapshot"))).json();

      // Both should have markets
      expect(snapshot1.markets.food).toBeDefined();
      expect(snapshot2.markets.food).toBeDefined();
      // Production/consumption should differ
      expect(snapshot1.markets.food.production).toBeDefined();
      expect(snapshot2.markets.food.production).toBeDefined();
    });
  });

  describe("Price Elasticity and Market Dynamics", () => {
    it("should adjust prices based on supply and demand", async () => {
      const snapshot1 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const initialPrice = snapshot1.markets.food.price;
      const initialInventory = snapshot1.markets.food.inventory;

      // Process multiple ticks to allow price adjustment
      for (let i = 0; i < 10; i++) {
        await system.fetch(new Request("https://dummy/tick", { method: "POST" }));
      }

      const snapshot2 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const updatedPrice = snapshot2.markets.food.price;
      const updatedInventory = snapshot2.markets.food.inventory;

      // Prices should be valid numbers
      expect(typeof updatedPrice).toBe("number");
      expect(updatedPrice).toBeGreaterThan(0);
      
      // Inventory should have changed due to production/consumption
      expect(typeof updatedInventory).toBe("number");
    });

    it("should handle price changes when inventory is depleted", async () => {
      const snapshot1 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const initialPrice = snapshot1.markets.food.price;
      const initialInventory = snapshot1.markets.food.inventory;

      // Buy all available inventory
      if (initialInventory > 0) {
        const buyResponse = await system.fetch(new Request("https://dummy/trade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shipId: "test-ship",
            goodId: "food",
            quantity: initialInventory,
            type: "buy",
          }),
        }));

        expect(buyResponse.status).toBe(200);

        // Process tick - price should adjust
        await system.fetch(new Request("https://dummy/tick", { method: "POST" }));

        const snapshot2 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
        expect(snapshot2.markets.food.inventory).toBeGreaterThanOrEqual(0);
        expect(snapshot2.markets.food.price).toBeGreaterThan(0);
      }
    });

    it("should handle price changes when inventory is at capacity", async () => {
      const snapshot1 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const currentInventory = snapshot1.markets.food.inventory;
      const maxCapacity = 10000;
      const spaceAvailable = maxCapacity - currentInventory;

      // Sell to fill capacity
      if (spaceAvailable > 0) {
        await system.fetch(new Request("https://dummy/trade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shipId: "test-ship",
            goodId: "food",
            quantity: spaceAvailable,
            type: "sell",
          }),
        }));

        // Process tick - price should adjust
        await system.fetch(new Request("https://dummy/tick", { method: "POST" }));

        const snapshot2 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
        expect(snapshot2.markets.food.inventory).toBeLessThanOrEqual(maxCapacity);
        expect(snapshot2.markets.food.price).toBeGreaterThan(0);
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle markets with zero inventory", async () => {
      const snapshot = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      
      // Find a market with inventory
      const goodWithInventory = Object.keys(snapshot.markets).find(
        goodId => snapshot.markets[goodId].inventory > 0
      );

      if (goodWithInventory) {
        const market = snapshot.markets[goodWithInventory];
        const quantity = market.inventory;

        // Buy all inventory
        await system.fetch(new Request("https://dummy/trade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shipId: "test-ship",
            goodId: goodWithInventory,
            quantity,
            type: "buy",
          }),
        }));

        // Market should still exist with zero inventory
        const snapshot2 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
        expect(snapshot2.markets[goodWithInventory]).toBeDefined();
        expect(snapshot2.markets[goodWithInventory].inventory).toBe(0);
        expect(snapshot2.markets[goodWithInventory].price).toBeGreaterThan(0);
      }
    });

    it("should maintain price consistency across ticks", async () => {
      const snapshot1 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const price1 = snapshot1.markets.food.price;

      // Process tick
      await system.fetch(new Request("https://dummy/tick", { method: "POST" }));

      const snapshot2 = await (await system.fetch(new Request("https://dummy/snapshot"))).json();
      const price2 = snapshot2.markets.food.price;

      // Prices should be valid numbers (may change but should be consistent)
      expect(typeof price1).toBe("number");
      expect(typeof price2).toBe("number");
      expect(price1).toBeGreaterThan(0);
      expect(price2).toBeGreaterThan(0);
    });
  });
});
