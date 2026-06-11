import { describe, expect, it } from "vitest";
import {
  GOOD_IDS,
  GOODS,
  PRODUCTION_ORDER,
  ROLE_CONSUMPTION,
  ROLE_PRODUCTION,
  ROLES,
  type GoodId,
} from "./goods.js";

/**
 * Static sanity checks on the balance numbers themselves. The original
 * project never had these — production/consumption drift was discovered
 * only as mysterious instability hours into a run.
 */
describe("economy balance invariants", () => {
  it("production chain is a DAG with primary roots (no deadlock possible)", () => {
    // Every input of a good must appear earlier in PRODUCTION_ORDER.
    for (const good of GOOD_IDS) {
      const idx = PRODUCTION_ORDER.indexOf(good);
      expect(idx).toBeGreaterThanOrEqual(0);
      for (const input of Object.keys(GOODS[good].inputs) as GoodId[]) {
        expect(PRODUCTION_ORDER.indexOf(input)).toBeLessThan(idx);
      }
    }
    // Roots exist: at least one good with no inputs.
    const roots = GOOD_IDS.filter((g) => Object.keys(GOODS[g].inputs).length === 0);
    expect(roots.length).toBeGreaterThan(0);
  });

  it("every derived good is worth more than its inputs", () => {
    for (const good of GOOD_IDS) {
      let inputCost = 0;
      for (const [inp, qty] of Object.entries(GOODS[good].inputs) as [GoodId, number][]) {
        inputCost += GOODS[inp].basePrice * qty;
      }
      expect(GOODS[good].basePrice).toBeGreaterThan(inputCost);
    }
  });

  it("galaxy-wide supply exceeds demand for every good (with sane surplus)", () => {
    // Assume equal population across roles (galaxy generation deals roles
    // round-robin, so this approximates any generated galaxy).
    const perRolePop = 1 / ROLES.length;

    const production: Record<GoodId, number> = Object.fromEntries(
      GOOD_IDS.map((g) => [g, 0]),
    ) as Record<GoodId, number>;
    const demand: Record<GoodId, number> = Object.fromEntries(
      GOOD_IDS.map((g) => [g, 0]),
    ) as Record<GoodId, number>;

    for (const role of ROLES) {
      for (const [good, rate] of Object.entries(ROLE_PRODUCTION[role]) as [GoodId, number][]) {
        production[good] += rate * perRolePop;
        // Producing also demands inputs.
        for (const [inp, perUnit] of Object.entries(GOODS[good].inputs) as [GoodId, number][]) {
          demand[inp] += rate * perUnit * perRolePop;
        }
      }
      for (const [good, rate] of Object.entries(ROLE_CONSUMPTION[role]) as [GoodId, number][]) {
        demand[good] += rate * perRolePop;
      }
    }

    for (const good of GOOD_IDS) {
      const surplus = (production[good] - demand[good]) / demand[good];
      // Each good must run a positive surplus (logistics friction eats some
      // of it) but not a glut that floors prices everywhere.
      expect(surplus, `${good} surplus ${(surplus * 100).toFixed(1)}%`).toBeGreaterThan(0.02);
      // Fuel is exempt from the glut bound: most fuel demand is ship
      // travel, which is dynamic and invisible to this static check.
      // viability/self-balance tests cover the fuel economy at runtime.
      if (good !== "fuel") {
        expect(surplus, `${good} surplus ${(surplus * 100).toFixed(1)}%`).toBeLessThan(0.8);
      }
    }
  });
});
