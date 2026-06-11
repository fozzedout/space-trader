import { describe, expect, it } from "vitest";
import { Simulation } from "./sim.js";

/**
 * Economy viability from the traders' side: a game economy where NPC
 * traders steadily go out of business is not viable — the distribution
 * network (and any player following the same incentives) would collapse.
 * These tests run long, disaster-laden simulations and require that the
 * trading profession itself stays profitable.
 */
describe("trader viability", () => {
  function punishingRun(seed: number): {
    sim: Simulation;
    worstDipEver: number;
  } {
    const sim = new Simulation(seed);
    let worstDipEver = Infinity;
    const track = (s: Simulation) => {
      worstDipEver = Math.min(worstDipEver, s.metrics().minTraderCredits);
    };

    // 2,500 ticks with a rolling disaster schedule.
    sim.run(300, track);
    const agri = sim.systemsByRole("agricultural")[0]!;
    sim.applyShock(agri.id, { good: "food", prodMult: 0, consMult: 1, duration: 120 });
    sim.pirateRaid(agri.id, "food", 0.85);
    sim.run(300, track);
    const ind = sim.systemsByRole("industrial")[0]!;
    sim.pirateRaid(ind.id, "machinery", 0.9);
    sim.pirateRaid(ind.id, "fuel", 0.9);
    sim.run(300, track);
    const mining = sim.systemsByRole("mining")[0]!;
    sim.applyShock(mining.id, { good: "ore", prodMult: 0.1, consMult: 1, duration: 200 });
    sim.run(300, track);
    const ht = sim.systemsByRole("high_tech")[0]!;
    sim.applyShock(ht.id, { good: "fuel", prodMult: 1, consMult: 8, duration: 100 });
    sim.run(1300, track);

    return { sim, worstDipEver };
  }

  it("no trader goes out of business, even through repeated disasters", () => {
    for (const seed of [42, 7]) {
      const { sim, worstDipEver } = punishingRun(seed);
      const traders = sim.galaxy.traders;

      // Nobody ends insolvent or even back at their starting stake.
      expect(sim.metrics().tradersInsolvent, `seed ${seed} insolvent`).toBe(0);
      const minFinal = sim.metrics().minTraderCredits;
      expect(minFinal, `seed ${seed} poorest trader`).toBeGreaterThan(8000); // > max start credits

      // Worst transient dip is a small travel overdraft, not a debt spiral.
      expect(worstDipEver, `seed ${seed} worst dip`).toBeGreaterThan(-1000);

      // Every trader is profitable over its lifetime and trading actively.
      for (const t of traders) {
        expect(t.totalProfit, `seed ${seed} trader ${t.id} lifetime profit`).toBeGreaterThan(0);
        expect(t.tripsCompleted, `seed ${seed} trader ${t.id} trips`).toBeGreaterThan(100);
      }
    }
  });

  it("trading stays profitable late in the run (margins don't dry up)", () => {
    const sim = new Simulation(42);
    sim.run(1500);
    const before = sim.galaxy.traders.map((t) => t.totalProfit);
    sim.run(500);
    // The fleet as a whole still earns in the mature economy, and most
    // individual traders are still finding profitable work.
    const stillEarning = sim.galaxy.traders.filter((t, i) => t.totalProfit > before[i]! + 100);
    expect(stillEarning.length).toBeGreaterThan(sim.galaxy.traders.length * 0.8);
  });
});
