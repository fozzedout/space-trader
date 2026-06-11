import { describe, expect, it } from "vitest";
import { Simulation } from "./sim.js";

describe("determinism", () => {
  it("same seed produces an identical run", () => {
    const a = new Simulation(1234);
    const b = new Simulation(1234);
    a.run(300);
    b.run(300);
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it("same seed with identical external events stays identical", () => {
    const a = new Simulation(99);
    const b = new Simulation(99);
    for (const sim of [a, b]) {
      sim.run(100);
      sim.applyShock(0, { good: "food", prodMult: 0.2, consMult: 1, duration: 50 });
      sim.pirateRaid(1, "ore", 0.5);
      sim.run(200);
    }
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it("different seeds diverge", () => {
    const a = new Simulation(1);
    const b = new Simulation(2);
    a.run(50);
    b.run(50);
    expect(a.stateHash()).not.toBe(b.stateHash());
  });

  it("long runs stay finite and non-negative", () => {
    const sim = new Simulation(7);
    sim.run(1000);
    for (const system of sim.galaxy.systems) {
      for (const market of Object.values(system.markets)) {
        expect(Number.isFinite(market.inventory)).toBe(true);
        expect(market.inventory).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(market.price)).toBe(true);
      }
    }
    for (const trader of sim.galaxy.traders) {
      expect(Number.isFinite(trader.credits)).toBe(true);
    }
  });
});
