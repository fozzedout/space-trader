import { describe, expect, it } from "vitest";
import { equipmentQuote } from "./equipment.js";
import { Simulation } from "./sim.js";

/**
 * The station bank: loans against the ship as collateral. Two intended
 * uses — outfitting a broke trader with gear it works off locally, and
 * leveraging genuinely good trades beyond cash on hand. Default is real:
 * the bank seizes the ship.
 */
describe("station bank loans", () => {
  it("equipment is assembled from real parts taken out of the local market", () => {
    const sim = new Simulation(42);
    sim.run(50);
    const system = sim.system(2); // industrial: machinery in stock
    const machineryBefore = system.markets.machinery.inventory;
    const quote = equipmentQuote(system, "scoop");
    expect(quote).not.toBeNull();
    expect(quote!).toBeGreaterThan(0);
    // Strip the market of machinery: no parts, no scoop for sale.
    system.markets.machinery.inventory = 1;
    expect(equipmentQuote(system, "scoop")).toBeNull();
    system.markets.machinery.inventory = machineryBefore;
  });

  it("a ruined trader borrows against the ship, works it off, and recovers", () => {
    const sim = new Simulation(42);
    sim.run(300);

    // Total ruin: no credits, no cargo, no gear — only the hull is left,
    // and the hull is exactly what the bank lends against.
    const victim = sim.galaxy.traders[0]!;
    victim.credits = 0;
    victim.cargo = null;
    victim.equipment = { scoop: false, shredder: false };
    const borrowedBefore = victim.totalBorrowed;

    sim.run(500);

    expect(victim.totalBorrowed, "took a loan").toBeGreaterThan(borrowedBefore);
    expect(victim.active, "kept the ship").toBe(true);
    expect(victim.loan, "loan fully repaid").toBeNull();
    expect(victim.credits).toBeGreaterThan(500);
  });

  it("the fleet uses leverage but pays it back — no debt spiral, no seizures", () => {
    const sim = new Simulation(42);
    sim.run(800);
    const m = sim.metrics();
    const loansTaken = sim.galaxy.traders.reduce((a, t) => a + t.loansTaken, 0);
    const interest = sim.galaxy.traders.reduce((a, t) => a + t.interestAccrued, 0);
    expect(loansTaken, "loans are actually used").toBeGreaterThan(0);
    expect(interest, "the bank charges for them").toBeGreaterThan(0);
    expect(m.tradersSeized).toBe(0);
    // Outstanding debt is working capital in motion, not a growing pile.
    expect(m.totalDebt).toBeLessThan(m.totalTraderCredits * 0.05);
  });

  it("defaulting costs the ship: cargo liquidated, gear stripped, trader out", () => {
    const sim = new Simulation(42);
    sim.run(100);

    const debtor = sim.galaxy.traders[5]!;
    debtor.travel = null;
    debtor.locationId = 3;
    debtor.cargo = { good: "food", qty: 10, costBasis: 100 };
    debtor.loan = { principal: 50_000, lenderSystemId: 3, dueTick: sim.tick };

    const foodBefore = sim.system(3).markets.food.inventory;
    sim.run(2);

    expect(debtor.active).toBe(false);
    expect(debtor.credits).toBe(0);
    expect(debtor.equipment.scoop).toBe(false);
    expect(debtor.loan).toBeNull();
    // The bank liquidated the cargo into the local market.
    expect(sim.system(3).markets.food.inventory).toBeGreaterThan(foodBefore);
    expect(sim.metrics().tradersSeized).toBe(1);
    // A seized ship stops acting entirely.
    const frozenHash = `${debtor.locationId}:${debtor.credits}`;
    sim.run(50);
    expect(`${debtor.locationId}:${debtor.credits}`).toBe(frozenHash);
  });
});
