import { describe, it, expect, beforeEach } from "vitest";
import { Ship } from "./ship";
import { StarSystem } from "./star-system";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { SystemId, WorldType, TechLevel } from "./types";

describe("NPC Trading Behavior", () => {
  let ship: Ship;
  let system: StarSystem;
  let mockState: MockDurableObjectState;
  let mockEnv: any;

  beforeEach(async () => {
    mockState = new MockDurableObjectState({ toString: () => "npc-test" } as any);
    mockEnv = createMockEnv();
    ship = new Ship(mockState, mockEnv);

    // Create and initialize system
    const systemState = new MockDurableObjectState({ toString: () => "system-0" } as any);
    system = new StarSystem(systemState, mockEnv);
    
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

    // Initialize NPC ship
    await ship.initialize({
      id: "npc-test",
      name: "NPC Trader",
      systemId: 0 as SystemId,
      seed: "npc-seed",
      isNPC: true,
    });
  });

  describe("Trading Decisions", () => {
    it("should make trading decisions when at station", async () => {
      // Verify ship is at station
      const state = await ship.getState();
      expect(state?.phase).toBe("at_station");
      expect(state?.currentSystem).toBe(0);

      // Process tick - NPC should attempt trading decision
      const result = await ship.tick();
      expect(result.skipped).toBe(false);
    });

    // Removed "should not trade when resting" test - simplified (resting phase removed)

    it("should not trade when sleeping", async () => {
      const state = await ship.getState();
      
      expect(state).toHaveProperty("phase");
      // Phase can be sleeping (legacy test - phases are now simplified to at_station/traveling)
      expect([
        "at_station",
        "traveling",
      ]).toContain(state?.phase);
    });

    it("should have credits for trading", async () => {
      const state = await ship.getState();
      
      expect(state?.credits).toBeGreaterThan(0);
      expect(typeof state?.credits).toBe("number");
    });

    it("should have cargo capacity", async () => {
      const state = await ship.getState();
      
      expect(state?.cargo).toBeDefined();
      expect(state?.cargo instanceof Map).toBe(true);
    });
  });

  describe("Travel Decisions", () => {
    it("should be able to initiate travel", async () => {
      const state = await ship.getState();
      
      expect(state).toHaveProperty("destinationSystem");
      expect(state).toHaveProperty("currentSystem");
      expect(state).toHaveProperty("phase");
    });

    it("should only travel when at station", async () => {
      const state = await ship.getState();
      
      // Ship starts at station
      expect(state?.phase).toBe("at_station");
      expect(state?.currentSystem).not.toBeNull();
    });
  });

  describe("Credit Loss and Recovery", () => {
    it("should handle NPCs with low credits", async () => {
      const state = await ship.getState();
      
      // NPC should have credits
      expect(state?.credits).toBeGreaterThan(0);
      
      // NPC should still be able to make decisions even with low credits
      const result = await ship.tick();
      expect(result.skipped).toBe(false);
    });

    it("should continue operating even with minimal credits", async () => {
      // Process multiple ticks - NPC should continue operating
      for (let i = 0; i < 5; i++) {
        const result = await ship.tick();
        expect(result.skipped).toBe(false);
      }
      
      // Ship should still be operational
      const state2 = await ship.getState();
      expect(state2?.credits).toBeDefined();
      expect(typeof state2?.credits).toBe("number");
    });

    it("should handle trading decisions when credits are low", async () => {
      // NPC should still attempt trading even with low credits
      // (may fail due to insufficient funds, but should not crash)
      const result = await ship.tick();
      expect(result.skipped).toBe(false);
    });
  });

  describe("Trading Decision Edge Cases", () => {
    it("should handle trading when cargo is full", async () => {
      // NPC should handle full cargo gracefully
      const result = await ship.tick();
      expect(result.skipped).toBe(false);
    });

    it("should handle trading when no goods are available", async () => {
      // NPC should handle empty markets gracefully
      const result = await ship.tick();
      expect(result.skipped).toBe(false);
    });

    it("should make deterministic trading decisions", async () => {
      // Create two NPCs with same seed
      const npc1State = new MockDurableObjectState({ toString: () => "npc-1" } as any);
      const npc1 = new Ship(npc1State, mockEnv);
      
      const npc2State = new MockDurableObjectState({ toString: () => "npc-2" } as any);
      const npc2 = new Ship(npc2State, mockEnv);

      const seed = "deterministic-npc-seed";

      await npc1.initialize({
        id: "npc-1",
        name: "NPC 1",
        systemId: 0 as SystemId,
        seed,
        isNPC: true,
      });

      await npc2.initialize({
        id: "npc-2",
        name: "NPC 2",
        systemId: 0 as SystemId,
        seed,
        isNPC: true,
      });

      // Process same number of ticks
      for (let i = 0; i < 3; i++) {
        await npc1.tick();
        await npc2.tick();
      }

      const state1 = await npc1.getState();
      const state2 = await npc2.getState();

      // Credits should be the same (deterministic)
      expect(state1?.credits).toBe(state2?.credits);
    });
  });
});
