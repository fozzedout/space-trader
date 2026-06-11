import { describe, expect, it } from "vitest";
import { StarSystem } from "./system.js";

function makeSystem(role: StarSystem["role"]): StarSystem {
  return new StarSystem({ id: 0, name: "Test", x: 0, y: 0, role, pop: 4 });
}

describe("StarSystem tick", () => {
  it("primary production needs no inputs (agri always grows food)", () => {
    const sys = makeSystem("agricultural");
    // Strip everything: total collapse.
    for (const market of Object.values(sys.markets)) market.inventory = 0;
    sys.tick(0);
    // food: produced 4.5 * 4 = 18, consumed 1.0 * 4 = 4.
    expect(sys.markets.food.inventory).toBeCloseTo(14);
  });

  it("derived production is limited by the scarcest input", () => {
    const sys = makeSystem("industrial");
    sys.markets.ore.inventory = 1; // machinery needs 1 ore each, fuel 0.5 each
    sys.markets.fuel.inventory = 100;
    const before = sys.markets.machinery.inventory;
    sys.tick(0);
    // fuel produced first (order: fuel before machinery): 0.5*4=2 capacity,
    // limited by ore 1/0.5 = 2 -> consumes all 1 ore. Machinery gets none.
    const produced = sys.markets.machinery.inventory - before;
    // Machinery production should be (near) zero, and certainly not capacity (2.2).
    expect(produced).toBeLessThanOrEqual(0);
  });

  it("never produces negative inventory and discards over-capacity stock", () => {
    const sys = makeSystem("mining");
    sys.markets.ore.inventory = 1e9;
    sys.tick(0);
    expect(sys.markets.ore.inventory).toBeCloseTo(sys.markets.ore.maxStock);
    for (const market of Object.values(sys.markets)) {
      expect(market.inventory).toBeGreaterThanOrEqual(0);
    }
  });

  it("production shocks cut output and expire", () => {
    const sys = makeSystem("agricultural");
    sys.shocks.push({ good: "food", prodMult: 0, consMult: 1, untilTick: 2 });

    const start = sys.markets.food.inventory;
    sys.tick(0); // no production, consumption only: -4
    expect(sys.markets.food.inventory).toBeCloseTo(start - 4);

    sys.tick(1); // still shocked
    expect(sys.markets.food.inventory).toBeCloseTo(start - 8);

    sys.tick(2); // expired: +18 produced, -4 consumed
    expect(sys.shocks).toHaveLength(0);
    expect(sys.markets.food.inventory).toBeCloseTo(start - 8 + 14);
  });
});
