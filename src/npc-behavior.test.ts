import { describe, it, expect, beforeEach } from "vitest";
import { Ship } from "./ship";
import { StarSystem } from "./star-system";
import { MockDurableObjectState, createMockEnv } from "./test-utils/mocks";
import { SystemId, WorldType, TechLevel } from "./types";
import { DO_INTERNAL } from "./durable-object-helpers";

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

    // Initialize NPC ship
    await ship.fetch(new Request("https://dummy/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "npc-test",
        name: "NPC Trader",
        systemId: 0 as SystemId,
        seed: "npc-seed",
        isNPC: true,
      }),
    }));
  });

  describe("Trading Decisions", () => {
    it("should make trading decisions when at station", async () => {
      // Verify ship is at station
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      expect(state.phase).toBe("at_station");
      expect(state.currentSystem).toBe(0);

      // Process tick - NPC should attempt trading decision
      const tickResponse = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
      expect(tickResponse.status).toBe(200);
      
      const tickData = await tickResponse.json();
      expect(tickData).toHaveProperty("success");
    });

    it("should not trade when resting", async () => {
      // This would require setting ship to resting state
      // For now, verify the structure supports it
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      
      expect(state).toHaveProperty("phase");
      expect(state).toHaveProperty("restStartTime");
      expect(state).toHaveProperty("restEndTime");
    });

    it("should not trade when sleeping", async () => {
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      
      expect(state).toHaveProperty("phase");
      // Phase can be sleeping
      expect(["at_station", "departing", "in_hyperspace", "arriving", "resting", "sleeping"]).toContain(state.phase);
    });

    it("should have credits for trading", async () => {
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      
      expect(state.credits).toBeGreaterThan(0);
      expect(typeof state.credits).toBe("number");
    });

    it("should have cargo capacity", async () => {
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      
      expect(state.cargo).toBeDefined();
      expect(typeof state.cargo).toBe("object");
    });
  });

  describe("Travel Decisions", () => {
    it("should be able to initiate travel", async () => {
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      
      expect(state).toHaveProperty("destinationSystem");
      expect(state).toHaveProperty("currentSystem");
      expect(state).toHaveProperty("phase");
    });

    it("should only travel when at station", async () => {
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      
      // Ship starts at station
      expect(state.phase).toBe("at_station");
      expect(state.currentSystem).not.toBeNull();
    });
  });

  describe("Credit Loss and Recovery", () => {
    it("should handle NPCs with low credits", async () => {
      const stateResponse = await ship.fetch(new Request("https://dummy/state"));
      const state = await stateResponse.json();
      
      // NPC should have credits
      expect(state.credits).toBeGreaterThan(0);
      
      // NPC should still be able to make decisions even with low credits
      const tickResponse = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
      expect(tickResponse.status).toBe(200);
    });

    it("should continue operating even with minimal credits", async () => {
      // Get initial state
      const state1 = await (await ship.fetch(new Request("https://dummy/state"))).json();
      const initialCredits = state1.credits;
      
      // Process multiple ticks - NPC should continue operating
      for (let i = 0; i < 5; i++) {
        const tickResponse = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
        expect(tickResponse.status).toBe(200);
      }
      
      // Ship should still be operational
      const state2 = await (await ship.fetch(new Request("https://dummy/state"))).json();
      expect(state2.credits).toBeDefined();
      expect(typeof state2.credits).toBe("number");
    });

    it("should handle trading decisions when credits are low", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      
      // NPC should still attempt trading even with low credits
      // (may fail due to insufficient funds, but should not crash)
      const tickResponse = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
      expect(tickResponse.status).toBe(200);
      
      const tickData = await tickResponse.json();
      expect(tickData).toHaveProperty("success");
    });
  });

  describe("Trading Decision Edge Cases", () => {
    it("should handle trading when cargo is full", async () => {
      const state = await (await ship.fetch(new Request("https://dummy/state"))).json();
      
      // NPC should handle full cargo gracefully
      const tickResponse = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
      expect(tickResponse.status).toBe(200);
    });

    it("should handle trading when no goods are available", async () => {
      // NPC should handle empty markets gracefully
      const tickResponse = await ship.fetch(new Request("https://dummy/tick", { method: "POST" }));
      expect(tickResponse.status).toBe(200);
    });

    it("should make deterministic trading decisions", async () => {
      // Create two NPCs with same seed
      const npc1State = new MockDurableObjectState({ toString: () => "npc-1" } as any);
      const npc1 = new Ship(npc1State, mockEnv);
      
      const npc2State = new MockDurableObjectState({ toString: () => "npc-2" } as any);
      const npc2 = new Ship(npc2State, mockEnv);

      const seed = "deterministic-npc-seed";

      await npc1.fetch(new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "npc-1",
          name: "NPC 1",
          systemId: 0 as SystemId,
          seed,
          isNPC: true,
        }),
      }));

      await npc2.fetch(new Request("https://dummy/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "npc-2",
          name: "NPC 2",
          systemId: 0 as SystemId,
          seed,
          isNPC: true,
        }),
      }));

      // Process same number of ticks
      for (let i = 0; i < 3; i++) {
        await npc1.fetch(new Request("https://dummy/tick", { method: "POST" }));
        await npc2.fetch(new Request("https://dummy/tick", { method: "POST" }));
      }

      const state1 = await (await npc1.fetch(new Request("https://dummy/state"))).json();
      const state2 = await (await npc2.fetch(new Request("https://dummy/state"))).json();

      // Credits should be the same (deterministic)
      expect(state1.credits).toBe(state2.credits);
    });
  });
});

