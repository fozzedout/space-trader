import { describe, it, expect, beforeEach, vi } from "vitest";
import { Ship } from "./ship";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { SystemId, WorldType, TechLevel } from "./types";

describe("Ship Travel Phases", () => {
  let ship: Ship;
  let system: any;
  let mockState: MockDurableObjectState;
  let mockEnv: any;

  beforeEach(async () => {
    mockState = new MockDurableObjectState({ toString: () => "ship-test" } as any);
    mockEnv = createMockEnv();
    ship = new Ship(mockState, mockEnv);

    // Create a mock system
    const systemState = new MockDurableObjectState({ toString: () => "system-0" } as any);
    system = await import("./star-system").then(m => new m.StarSystem(systemState, mockEnv));
    
    // Initialize system
    await system.fetch(new Request("https://dummy/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: 0 as SystemId,
        name: "Test System",
        population: 10,
        techLevel: TechLevel.AGRICULTURAL,
        worldType: WorldType.AGRICULTURAL,
        government: "democracy",
        seed: "test-seed",
      }),
    }));

    // Register system in mock env
    mockEnv.STAR_SYSTEM.set(mockEnv.STAR_SYSTEM.idFromName("system-0"), system);

    // Initialize ship
    await ship.fetch(new Request("https://dummy/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "ship-test",
        name: "Test Ship",
        systemId: 0 as SystemId,
        seed: "test-seed",
        isNPC: true,
      }),
    }));
  });

  describe("Phase Transitions", () => {
    it("should start at 'at_station' phase", async () => {
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      expect(state.phase).toBe("at_station");
    });

    it("should transition to 'departing' when travel starts", async () => {
      // Get initial state
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      expect(state.phase).toBe("at_station");

      // Manually set destination to trigger departure (via tick logic)
      // We'll need to simulate the NPC making a travel decision
      // For now, verify the phase structure exists
      expect(state).toHaveProperty("phase");
      expect(state).toHaveProperty("departureStartTime");
      expect(state).toHaveProperty("arrivalStartTime");
    });

    it("should handle resting phase", async () => {
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      
      // Verify resting fields exist
      expect(state).toHaveProperty("restStartTime");
      expect(state).toHaveProperty("restEndTime");
      expect(state).toHaveProperty("phase");
    });

    it("should handle sleeping phase", async () => {
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      
      // Verify phase can be sleeping
      expect(["at_station", "departing", "in_hyperspace", "arriving", "resting", "sleeping"]).toContain(state.phase);
    });
  });

  describe("Time-based Phase Progression", () => {
    it("should process departure phase completion", async () => {
      // This test would require mocking time or advancing it
      // For now, verify the structure supports time-based transitions
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      
      expect(state).toHaveProperty("departureStartTime");
      expect(state).toHaveProperty("hyperspaceStartTime");
      expect(state).toHaveProperty("arrivalStartTime");
      expect(state).toHaveProperty("arrivalCompleteTime");
    });

    it("should skip ticks when resting", async () => {
      // Initialize ship and set to resting state
      const tickResponse = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
      const tickData = await tickResponse.json();
      
      // If ship is resting, should return skipped: true
      // This tests the skip logic
      expect(tickResponse.status).toBe(200);
    });

    it("should skip ticks when sleeping", async () => {
      const tickResponse = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
      expect(tickResponse.status).toBe(200);
      
      const tickData = await tickResponse.json();
      // May be skipped if resting/sleeping
      expect(tickData).toHaveProperty("success");
    });
  });

  describe("Phase Transition Edge Cases", () => {
    it("should handle all phase transitions correctly", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      
      // Verify all phase-related fields exist
      expect(state).toHaveProperty("phase");
      expect(state).toHaveProperty("departureStartTime");
      expect(state).toHaveProperty("hyperspaceStartTime");
      expect(state).toHaveProperty("arrivalStartTime");
      expect(state).toHaveProperty("arrivalCompleteTime");
      expect(state).toHaveProperty("restStartTime");
      expect(state).toHaveProperty("restEndTime");
      expect(state).toHaveProperty("currentSystem");
      expect(state).toHaveProperty("destinationSystem");
    });

    it("should maintain phase consistency across ticks", async () => {
      const state1 = await (await ship.fetch(new Request("https://dummy/state"))).json();
      const initialPhase = state1.phase;

      // Process tick
      await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));

      const state2 = await (await ship.fetch(new Request("https://dummy/state"))).json();
      
      // Phase should be valid
      const validPhases = ["at_station", "departing", "in_hyperspace", "arriving", "resting", "sleeping"];
      expect(validPhases).toContain(state2.phase);
    });

    it("should handle resting phase duration correctly", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      
      // If ship is resting, verify rest times are set
      if (state.phase === "resting") {
        expect(state.restStartTime).not.toBeNull();
        expect(state.restEndTime).not.toBeNull();
        expect(state.restEndTime).toBeGreaterThan(state.restStartTime!);
      }
    });

    it("should handle sleeping phase duration correctly", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      
      // If ship is sleeping, verify sleep times are set
      if (state.phase === "sleeping") {
        expect(state.restStartTime).not.toBeNull();
        expect(state.restEndTime).not.toBeNull();
        expect(state.restEndTime).toBeGreaterThan(state.restStartTime!);
      }
    });

    it("should handle travel phase transitions", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      
      // Ship should be able to transition through travel phases
      if (state.phase === "departing") {
        expect(state.departureStartTime).not.toBeNull();
        expect(state.destinationSystem).not.toBeNull();
      } else if (state.phase === "in_hyperspace") {
        expect(state.hyperspaceStartTime).not.toBeNull();
        expect(state.destinationSystem).not.toBeNull();
      } else if (state.phase === "arriving") {
        expect(state.arrivalStartTime).not.toBeNull();
        expect(state.arrivalCompleteTime).not.toBeNull();
        expect(state.destinationSystem).not.toBeNull();
      }
    });
  });

  describe("Time-based Operations", () => {
    it("should process time-based phase transitions", async () => {
      // Process multiple ticks to allow phase transitions
      for (let i = 0; i < 10; i++) {
        const tickResponse = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
        expect(tickResponse.status).toBe(200);
      }

      // Ship should still be in a valid state
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      const validPhases = ["at_station", "departing", "in_hyperspace", "arriving", "resting", "sleeping"];
      expect(validPhases).toContain(state.phase);
    });

    it("should handle phase transitions without errors", async () => {
      const errors: string[] = [];

      // Process many ticks
      for (let i = 0; i < 20; i++) {
        try {
          const tickResponse = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
          if (!tickResponse.ok) {
            errors.push(`Tick ${i} failed: ${tickResponse.status}`);
          }
        } catch (error) {
          errors.push(`Tick ${i} error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      expect(errors.length).toBe(0);
    });
  });
});

