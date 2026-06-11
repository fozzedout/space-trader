import { describe, expect, it } from "vitest";
import { heuristicDecider } from "./llm-driver.js";
import type { PlayerAction } from "./player.js";
import { Simulation } from "./sim.js";

/**
 * The player/agent API: a player ship is an ordinary ship. Same market
 * impact, same information limits, same bank — and enough signal in the
 * observation for an agent (scripted or LLM) to actually play.
 */
describe("player ships", () => {
  function dockedPlayer(seed = 42): { sim: Simulation; id: number } {
    const sim = new Simulation(seed);
    const id = sim.addPlayer({ credits: 5000, capacity: 100, locationId: 0 });
    sim.run(300);
    return { sim, id };
  }

  it("player trades move the market exactly like NPC trades", () => {
    const { sim, id } = dockedPlayer();
    const obs = sim.observe(id);
    // Pick a good whose price isn't pinned at the floor clamp (a floored
    // glut correctly absorbs purchases without moving) and that has
    // stock to take a real bite out of.
    const target = obs
      .dockedAt!.market.filter((m) => m.inventory >= 20)
      .sort((a, b) => b.price / b.targetStock - a.price / a.targetStock)
      .find((m) => m.inventory < m.targetStock * 1.8)!;
    const qty = Math.min(
      50,
      Math.floor(target.inventory * 0.4),
      Math.floor(obs.you.credits / (target.price * 1.5)),
    );
    const before = sim.system(obs.dockedAt!.id).markets[target.good].inventory;

    sim.act(id, { type: "buy", good: target.good, qty });
    sim.step();

    const result = sim.observe(id).lastActionResult!;
    expect(result.ok, result.detail).toBe(true);
    // The goods are in the hold, paid at the quoted (price-impact) cost...
    const after = sim.observe(id);
    expect(after.you.cargo).toEqual(expect.objectContaining({ good: target.good, qty }));
    expect(after.you.credits).toBeLessThan(obs.you.credits);
    // ...the market lost stock...
    expect(sim.system(obs.dockedAt!.id).markets[target.good].inventory).toBeLessThan(before);
    // ...and the price responded to the player's own trade.
    const priceAfter = after.dockedAt!.market.find((m) => m.good === target.good)!.price;
    expect(priceAfter).toBeGreaterThan(target.price);
  });

  it("observations respect information symmetry", () => {
    const { sim, id } = dockedPlayer();
    const obs = sim.observe(id);

    // Local market is live; remote systems are dated snapshots.
    expect(obs.dockedAt).not.toBeNull();
    for (const sys of obs.knownSystems) {
      expect(sys.newsAgeTicks).toBeGreaterThanOrEqual(0);
      // Manifests are hub privileges: not docked at a hub => no inbound data.
      if (!obs.dockedAt!.isHub) expect(sys.inboundCargo).toBeUndefined();
    }
    // In transit you see nothing live.
    const dest = obs.knownSystems[0]!;
    sim.act(id, { type: "travel", destId: dest.id });
    sim.step();
    const transit = sim.observe(id);
    expect(transit.you.inTransit).not.toBeNull();
    expect(transit.dockedAt).toBeNull();
  });

  it("invalid actions fail with reasons, never crash, and cost only the tick", () => {
    const { sim, id } = dockedPlayer();
    const cases: PlayerAction[] = [
      { type: "buy", good: "food", qty: 1_000_000 },
      { type: "sell", good: "ore", qty: 5 },
      { type: "travel", destId: 999 },
      { type: "harvest" },
      { type: "borrow", amount: 1e9 },
      { type: "repay", amount: 100 },
    ];
    for (const action of cases) {
      sim.act(id, action);
      sim.step();
      const result = sim.observe(id).lastActionResult!;
      expect(result.ok, JSON.stringify(action)).toBe(false);
      expect(result.detail.length).toBeGreaterThan(0);
    }
    expect(sim.observe(id).you.active).toBe(true);
  });

  it("players use the same bank — including foreclosure", () => {
    const { sim, id } = dockedPlayer();

    sim.act(id, { type: "borrow", amount: 2000 });
    sim.step();
    expect(sim.observe(id).you.loan!.principal).toBeGreaterThanOrEqual(2000);

    // Repay part: still indebted but in good standing.
    sim.act(id, { type: "repay", amount: 1000 });
    sim.step();
    expect(sim.observe(id).you.loan!.principal).toBeLessThan(1100);

    // Now stop paying past the due date: the bank takes the ship.
    const ship = sim.galaxy.traders[id]!;
    ship.loan!.dueTick = sim.tick;
    ship.loan!.lastPaymentTick = sim.tick - 1000;
    sim.step();
    expect(sim.observe(id).you.active).toBe(false);
  });

  it("same seed + same action script = identical run (determinism)", () => {
    const script: PlayerAction[] = [
      { type: "buy", good: "food", qty: 30 },
      { type: "travel", destId: 2 },
      { type: "sell", good: "food", qty: 30 },
      { type: "travel", destId: 4 },
    ];
    const hashes: string[] = [];
    for (let run = 0; run < 2; run++) {
      const sim = new Simulation(7);
      const id = sim.addPlayer({ credits: 5000, capacity: 100, locationId: 0 });
      sim.run(100);
      for (const action of script) {
        sim.act(id, action);
        sim.step();
        while (sim.observe(id).you.inTransit) sim.step();
      }
      sim.run(50);
      hashes.push(sim.stateHash());
    }
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("the observation carries enough signal to play: the scripted decider turns a profit", async () => {
    const sim = new Simulation(42);
    const id = sim.addPlayer({ credits: 5000, capacity: 100 });
    sim.run(300);

    const startWorth = () => {
      const o = sim.observe(id);
      return o.you.credits + (o.you.cargo?.costBasis ?? 0) - (o.you.loan?.principal ?? 0);
    };
    const start = startWorth();

    for (let i = 0; i < 60; i++) {
      let guard = 0;
      while (sim.observe(id).you.inTransit && guard++ < 100) sim.step();
      if (!sim.observe(id).you.active) break;
      const { action } = await heuristicDecider(sim.observe(id), []);
      sim.act(id, action);
      sim.step();
    }

    expect(sim.observe(id).you.active).toBe(true);
    expect(startWorth()).toBeGreaterThan(start);
  });
});
