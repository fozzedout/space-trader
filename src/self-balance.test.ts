import { describe, expect, it } from "vitest";
import { GOOD_IDS } from "./goods.js";
import { Simulation } from "./sim.js";

/**
 * The reason this project exists: prove that the economy balances itself
 * through price signals and profit-seeking traders — with no global
 * restocking, no credit injection, no hidden stabilizers.
 */
describe("self-balancing economy", () => {
  it("traders ARE the balancing mechanism (without them, the galaxy starves)", () => {
    const noTraders = new Simulation(42, { galaxy: { tradersPerSystem: 0 } });
    noTraders.run(400);
    const starved = noTraders.metrics();
    // Non-agricultural systems (3/4 of the galaxy) run out of food.
    expect(starved.goods.food.stockouts).toBeGreaterThanOrEqual(
      Math.floor(noTraders.galaxy.systems.length * 0.5),
    );

    const withTraders = new Simulation(42);
    withTraders.run(400);
    const fed = withTraders.metrics();
    expect(fed.goods.food.stockouts).toBeLessThanOrEqual(1);
  });

  it("reaches a working equilibrium from a cold start", () => {
    const sim = new Simulation(42);
    sim.run(400);
    const m = sim.metrics();
    for (const good of GOOD_IDS) {
      const g = m.goods[good];
      expect(g.stockouts, `${good} stockouts`).toBeLessThanOrEqual(1);
      expect(g.avgPriceRatio, `${good} avg price`).toBeGreaterThan(0.3);
      expect(g.avgPriceRatio, `${good} avg price`).toBeLessThan(2.0);
    }
    // Trading is actually happening, broadly.
    const active = sim.galaxy.traders.filter((t) => t.tripsCompleted > 0);
    expect(active.length).toBeGreaterThan(sim.galaxy.traders.length * 0.5);
  });

  it("a disaster (crop blight + granary raid) creates a shortage that traders fill, then recovers", () => {
    const sim = new Simulation(42);
    sim.run(300);

    const victim = sim.systemsByRole("agricultural")[0]!;
    const food = victim.markets.food;
    const preShockPrice = food.price;
    const importedBefore = food.imported;

    // Full disaster: harvest wiped out for 120 ticks AND pirates burn 85%
    // of stored food, so the system's own buffer can't ride it out.
    sim.applyShock(victim.id, { good: "food", prodMult: 0, consMult: 1, duration: 120 });
    sim.pirateRaid(victim.id, "food", 0.85);

    // Track the peak price during the shock.
    let peakPrice = 0;
    sim.run(120, () => {
      peakPrice = Math.max(peakPrice, food.price);
    });

    // The shortage was real: price spiked well above pre-shock level...
    expect(peakPrice).toBeGreaterThan(preShockPrice * 1.5);
    // ...which pulled in imports from profit-seeking traders.
    expect(food.imported).toBeGreaterThan(importedBefore);

    // After the blight ends, the system recovers on its own. With
    // hub-relayed (imperfect) information the recovery oscillates, so
    // judge the galaxy over a window rather than at one instant.
    sim.run(150);
    let stockoutSum = 0;
    const windowTicks = 100;
    sim.run(windowTicks, (s) => {
      stockoutSum += s.metrics().goods.food.stockouts;
    });
    expect(food.price).toBeLessThan(peakPrice * 0.7);
    expect(food.inventory).toBeGreaterThan(food.targetStock * 0.2);
    expect(stockoutSum / windowTicks).toBeLessThan(1.5);
  });

  it("a pirate raid is absorbed and the market recovers", () => {
    const sim = new Simulation(42);
    sim.run(300);

    const target = sim.systemsByRole("industrial")[0]!;
    const machinery = target.markets.machinery;
    const destroyed = sim.pirateRaid(target.id, "machinery", 0.9);
    expect(destroyed).toBeGreaterThan(0);
    const postRaidPrice = machinery.price;

    sim.run(200);
    expect(machinery.inventory).toBeGreaterThan(machinery.targetStock * 0.3);
    expect(machinery.price).toBeLessThan(postRaidPrice);
  });

  it("a demand spike (war) raises prices, attracts supply, and unwinds", () => {
    const sim = new Simulation(7);
    sim.run(300);

    const warzone = sim.systemsByRole("mining")[0]!;
    const fuelMarket = warzone.markets.fuel;
    const importedBefore = fuelMarket.imported;
    sim.applyShock(warzone.id, { good: "fuel", prodMult: 1, consMult: 6, duration: 60 });

    let peak = 0;
    sim.run(60, () => {
      peak = Math.max(peak, fuelMarket.price);
    });
    expect(fuelMarket.imported).toBeGreaterThan(importedBefore);

    sim.run(200);
    expect(fuelMarket.price).toBeLessThan(Math.max(peak * 0.8, 50));
  });
});
