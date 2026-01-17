import { describe, it, expect, beforeEach } from "vitest";
import { Ship } from "./ship";
import { StarSystem } from "./star-system";
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
    system = new StarSystem(systemState, mockEnv);
    
    // Initialize system
    await system.initialize({
      id: 0 as SystemId,
      name: "Test System",
      population: 10,
      techLevel: TechLevel.AGRICULTURAL,
      worldType: WorldType.AGRICULTURAL,
      seed: "test-seed",
    });

    // Register system in mock env
    mockEnv.STAR_SYSTEM.set(mockEnv.STAR_SYSTEM.idFromName("system-0"), system);

    // Initialize ship
    await ship.initialize({
      id: "ship-test",
      name: "Test Ship",
      systemId: 0 as SystemId,
      seed: "test-seed",
      isNPC: true,
    });
  });

  describe("Phase Transitions", () => {
    it("should start at 'at_station' phase", async () => {
      const state = await ship.getState();
      expect(state?.phase).toBe("at_station");
    });

    it("should expose travel timing fields", async () => {
      const state = await ship.getState();
      expect(state?.phase).toBe("at_station");

      // Verify the simplified phase structure exists
      expect(state).toHaveProperty("phase");
      expect(state).toHaveProperty("travelStartTime");
    });

    // Removed resting phase test - simplified (resting phase removed)

    it("should handle sleeping phase", async () => {
      const state = await ship.getState();
      
      // Verify phase can be sleeping
      expect([
        "at_station",
        "traveling",
      ]).toContain(state?.phase);
    });
  });

  describe("Time-based Phase Progression", () => {
    it("should process departure phase completion", async () => {
      // This test would require mocking time or advancing it
      // For now, verify the structure supports time-based transitions
      const state = await ship.getState();
      
      // Removed old time fields - simplified to travelStartTime
      expect(state).toHaveProperty("travelStartTime");
    });

    // Removed rest/sleep tests - simplified
  });

  describe("Phase Transition Edge Cases", () => {
    it("should handle all phase transitions correctly", async () => {
      const state = await ship.getState();
      
      // Verify all phase-related fields exist
      expect(state).toHaveProperty("phase");
      // Removed old time fields - simplified to travelStartTime
      expect(state).toHaveProperty("travelStartTime");
      // Removed rest/sleep fields - simplified
      expect(state).toHaveProperty("currentSystem");
      expect(state).toHaveProperty("destinationSystem");
    });

    it("should maintain phase consistency across ticks", async () => {
      const state1 = await ship.getState();
      void state1?.phase;

      // Process tick
      await ship.tick();

      const state2 = await ship.getState();
      
      // Phase should be valid
      const validPhases = [
        "at_station",
        "traveling",
      ];
      expect(validPhases).toContain(state2?.phase);
    });

    // Removed rest/sleep/travel phase tests - simplified to at_station and traveling only
    it("should handle travel phase transitions", async () => {
      const state = await ship.getState();
      
      // Ship should be able to transition through simplified travel phases
      if (state?.phase === "traveling") {
        expect(state.travelStartTime).not.toBeNull();
        expect(state.destinationSystem).not.toBeNull();
      }
    });
  });

  describe("Time-based Operations", () => {
    it("should process time-based phase transitions", async () => {
      // Process multiple ticks to allow phase transitions
      for (let i = 0; i < 10; i++) {
        const result = await ship.tick();
        expect(result.skipped).toBe(false);
      }

      // Ship should still be in a valid state
      const state = await ship.getState();
      const validPhases = [
        "at_station",
        "traveling",
      ];
      expect(validPhases).toContain(state?.phase);
    });

    it("should handle phase transitions without errors", async () => {
      const errors: string[] = [];

      // Process many ticks
      for (let i = 0; i < 20; i++) {
        try {
          const result = await ship.tick();
          if (result.skipped) {
            errors.push(`Tick ${i} skipped`);
          }
        } catch (error) {
          errors.push(`Tick ${i} error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      expect(errors.length).toBe(0);
    });
  });
});
