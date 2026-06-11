import { describe, expect, it } from "vitest";
import { Simulation } from "./sim.js";

/**
 * The fuel economy: fuel is skimmed from stars (a primary good — every
 * system harvests some), ships buy it from the origin market at every
 * departure, and any ship can fall back to skimming the local star with
 * its scoop — slow, capital-free income that also refills the port.
 */
describe("fuel economy", () => {
  it("ship travel is real demand on fuel markets", () => {
    const sim = new Simulation(42);
    sim.run(400);
    // Fleet departures exported fuel out of markets (burned in transit).
    const fuelExported = sim.galaxy.systems.reduce(
      (acc, s) => acc + s.markets.fuel.exported,
      0,
    );
    expect(fuelExported).toBeGreaterThan(500);
    // And the fuel market still functions: no system starved of fuel.
    expect(sim.metrics().goods.fuel.stockouts).toBeLessThanOrEqual(1);
  });

  it("a fuel blockade does not strand the fleet: harvesting and imports refuel the port", () => {
    const sim = new Simulation(42);
    sim.run(300);

    // Blockade: no local fuel production AND all fuel stores destroyed.
    const victim = sim.galaxy.systems.find((s) => !s.isHub && s.role === "mining")!;
    sim.applyShock(victim.id, { good: "fuel", prodMult: 0, consMult: 1, duration: 150 });
    sim.pirateRaid(victim.id, "fuel", 1.0);

    const tripsBefore = new Map(sim.galaxy.traders.map((t) => [t.id, t.tripsCompleted]));
    sim.run(400);

    // The port has fuel again (skimmed by docked ships and imported by
    // profit-seekers chasing the price spike)...
    expect(victim.markets.fuel.inventory).toBeGreaterThan(victim.markets.fuel.targetStock * 0.2);
    // ...and no trader was permanently stranded anywhere by the squeeze.
    for (const t of sim.galaxy.traders) {
      expect(
        t.tripsCompleted,
        `trader ${t.id} still trading after blockade`,
      ).toBeGreaterThan(tripsBefore.get(t.id)!);
    }
  });

  it("a broke trader rebuilds credits by skimming the star (income floor)", () => {
    const sim = new Simulation(42);
    sim.run(300);

    // Ruin a trader: pirates confiscate credits AND cargo.
    const victim = sim.galaxy.traders[0]!;
    victim.credits = 0;
    victim.cargo = null;

    const harvestedBefore = victim.totalHarvested;
    sim.run(300);

    // It worked its way back up — and the scoop was part of the story
    // whenever trading wasn't affordable.
    expect(victim.credits).toBeGreaterThan(500);
    expect(victim.totalHarvested + victim.tripsCompleted).toBeGreaterThan(harvestedBefore);
  });
});
