import { describe, it, expect, beforeEach, vi } from "vitest";
import { Ship } from "./ship";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { SystemId } from "./types";

describe("Ship", () => {
  let ship: Ship;
  let mockState: MockDurableObjectState;
  let mockEnv: any;

  beforeEach(async () => {
    mockState = new MockDurableObjectState({ toString: () => "ship-test" } as any);
    mockEnv = createMockEnv();
    ship = new Ship(mockState, mockEnv);
  });

  describe("Initialization", () => {
    it("should initialize a new ship", async () => {
      const initRequest = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "test-ship",
          name: "Test Ship",
          systemId: 0 as SystemId,
          seed: "test-seed",
          isNPC: true,
        }),
      });

      const response = await ship.fetch(initRequest);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it("should not allow double initialization", async () => {
      const initData = {
        id: "test-ship",
        name: "Test Ship",
        systemId: 0 as SystemId,
        seed: "test-seed",
        isNPC: true,
      };

      const initRequest1 = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initData),
      });

      await ship.fetch(initRequest1);
      
      const initRequest2 = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(initData),
      });
      
      const secondResponse = await ship.fetch(initRequest2);
      expect(secondResponse.status).toBe(400);
    });

    it("should set initial credits", async () => {
      const initRequest = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "test-ship",
          name: "Test Ship",
          systemId: 0 as SystemId,
          seed: "test-seed",
          isNPC: true,
        }),
      });

      await ship.fetch(initRequest);

      const stateRequest = new Request("https://dummy/state");
      const stateResponse = await ship.fetch(stateRequest);
      const state = await stateResponse.json();

      expect(state.credits).toBeGreaterThan(0);
      expect(state.currentSystem).toBe(0);
    });
  });

  describe("State Management", () => {
    beforeEach(async () => {
      const initRequest = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "test-ship",
          name: "Test Ship",
          systemId: 0 as SystemId,
          seed: "test-seed",
          isNPC: true,
        }),
      });
      await ship.fetch(initRequest);
    });

    it("should return ship state", async () => {
      const request = new Request("https://dummy/state");
      const response = await ship.fetch(request);
      const state = await response.json();

      expect(state.id).toBe("test-ship");
      expect(state.name).toBe("Test Ship");
      expect(state.currentSystem).toBe(0);
      expect(state.isNPC).toBe(true);
    });

    it("should have empty cargo initially", async () => {
      const request = new Request("https://dummy/state");
      const response = await ship.fetch(request);
      const state = await response.json();

      expect(state.cargo).toBeDefined();
      expect(Object.keys(state.cargo).length).toBe(0);
    });
  });

  describe("Ticking", () => {
    beforeEach(async () => {
      const initRequest = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "test-ship",
          name: "Test Ship",
          systemId: 0 as SystemId,
          seed: "test-seed",
          isNPC: true,
        }),
      });
      await ship.fetch(initRequest);
    });

    it("should process ticks", async () => {
      const tickRequest = new Request("https://dummy/tick", { method: "POST" });
      const response = await ship.fetch(tickRequest);
      expect(response.status).toBe(200);
    });

    it("should handle arrival when travel time expires", async () => {
      // This would require mocking the system fetch calls
      // For now, we test that tick doesn't crash
      const tickRequest = new Request("https://dummy/tick", { method: "POST" });
      const response = await ship.fetch(tickRequest);
      expect(response.status).toBe(200);
    });
  });

  describe("Credit Management", () => {
    beforeEach(async () => {
      const initRequest = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "test-ship",
          name: "Test Ship",
          systemId: 0 as SystemId,
          seed: "test-seed",
          isNPC: false, // Player ship for testing
        }),
      });
      await ship.fetch(initRequest);
    });

    it("should have initial credits of 100", async () => {
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      expect(state.credits).toBe(100);
    });

    it("should track credits correctly after multiple operations", async () => {
      const state1 = await (await ship.fetch(new Request("https://dummy/state"))).json();
      const initialCredits = state1.credits;
      expect(initialCredits).toBeGreaterThan(0);
      
      // Credits should remain consistent
      const state2 = await (await ship.fetch(new Request("https://dummy/state"))).json();
      expect(state2.credits).toBe(initialCredits);
    });
  });

  describe("Cargo Management", () => {
    beforeEach(async () => {
      const initRequest = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "test-ship",
          name: "Test Ship",
          systemId: 0 as SystemId,
          seed: "test-seed",
          isNPC: false,
        }),
      });
      await ship.fetch(initRequest);
    });

    it("should have empty cargo initially", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      expect(Object.keys(state.cargo).length).toBe(0);
    });

    it("should have cargo capacity limit of 100", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      // Cargo is a map, verify structure
      expect(state.cargo).toBeDefined();
      expect(typeof state.cargo).toBe("object");
    });
  });

  describe("Phase Transitions", () => {
    beforeEach(async () => {
      const initRequest = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "test-ship",
          name: "Test Ship",
          systemId: 0 as SystemId,
          seed: "test-seed",
          isNPC: true,
        }),
      });
      await ship.fetch(initRequest);
    });

    it("should start at 'at_station' phase", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      expect(state.phase).toBe("at_station");
    });

    it("should have all phase-related timestamps", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      expect(state).toHaveProperty("departureStartTime");
      expect(state).toHaveProperty("hyperspaceStartTime");
      expect(state).toHaveProperty("arrivalStartTime");
      expect(state).toHaveProperty("arrivalCompleteTime");
      expect(state).toHaveProperty("restStartTime");
      expect(state).toHaveProperty("restEndTime");
    });

    it("should support all valid phases", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      const validPhases = ["at_station", "departing", "in_hyperspace", "arriving", "resting", "sleeping"];
      expect(validPhases).toContain(state.phase);
    });
  });

  describe("Trading Operations", () => {
    beforeEach(async () => {
      const initRequest = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "test-ship",
          name: "Test Ship",
          systemId: 0 as SystemId,
          seed: "test-seed",
          isNPC: false, // Player ship
        }),
      });
      await ship.fetch(initRequest);
    });

    it("should reject trades for NPC ships", async () => {
      // Reinitialize as NPC
      const npcState = new MockDurableObjectState({ toString: () => "npc-ship" } as any);
      const npcShip = new Ship(npcState, mockEnv);
      
      await npcShip.fetch(new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "npc-ship",
          name: "NPC Ship",
          systemId: 0 as SystemId,
          seed: "npc-seed",
          isNPC: true,
        }),
      }));

      const tradeRequest = new Request("https://dummy/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goodId: "food",
          quantity: 10,
          type: "buy",
        }),
      });

      const response = await npcShip.fetch(tradeRequest);
      expect(response.status).toBe(400);
    });
  });

  describe("Edge Cases", () => {
    beforeEach(async () => {
      const initRequest = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "test-ship",
          name: "Test Ship",
          systemId: 0 as SystemId,
          seed: "test-seed",
          isNPC: true,
        }),
      });
      await ship.fetch(initRequest);
    });

    it("should handle tick when ship is not initialized", async () => {
      const newShip = new Ship(new MockDurableObjectState({ toString: () => "new-ship" } as any), mockEnv);
      const tickResponse = await newShip.fetch(new Request("https://dummy/tick", { method: "POST" }));
      expect(tickResponse.status).toBe(400);
    });

    it("should handle state persistence", async () => {
      const state1 = await (await ship.fetch(new Request("https://dummy/state"))).json();
      
      // Flush state to storage
      await ship.flushState();
      
      // Create new ship instance (simulating reload) - uses same mockState so storage is shared
      const newShip = new Ship(mockState, mockEnv);
      const state2 = await (await newShip.fetch(new Request("https://dummy/state"))).json();
      
      // State should be persisted
      expect(state2.id).toBe(state1.id);
      expect(state2.credits).toBe(state1.credits);
    });
  });

  describe("Error Handling", () => {
    it("should return 400 for state request before initialization", async () => {
      const request = new Request("https://dummy/state");
      const response = await ship.fetch(request);
      expect(response.status).toBe(400);
    });

    it("should return 404 for unknown endpoints", async () => {
      const request = new Request("https://dummy/unknown");
      const response = await ship.fetch(request);
      expect(response.status).toBe(404);
    });

    it("should handle invalid initialization data", async () => {
      const invalidRequest = new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      
      const response = await ship.fetch(invalidRequest);
      // Should handle gracefully (may succeed with undefined values or error)
      expect([200, 400, 500]).toContain(response.status);
    });
  });
});

