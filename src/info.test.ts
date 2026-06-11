import { describe, expect, it } from "vitest";
import { HubNetwork, InfoBoard, type MarketSnapshot } from "./info.js";
import { Simulation } from "./sim.js";

function snap(tick: number, food: number): MarketSnapshot {
  return {
    tick,
    prices: { food, ore: 0, fuel: 0, machinery: 0, electronics: 0, luxuries: 0 },
    inventories: { food: 0, ore: 0, fuel: 0, machinery: 0, electronics: 0, luxuries: 0 },
  };
}

describe("InfoBoard", () => {
  it("keeps the freshest snapshot per system", () => {
    const board = new InfoBoard();
    board.record(1, snap(10, 99));
    board.record(1, snap(5, 11)); // older: ignored
    expect(board.get(1)!.prices.food).toBe(99);
    board.record(1, snap(20, 42)); // newer: wins
    expect(board.get(1)!.prices.food).toBe(42);
  });

  it("two-way sync leaves both sides with the freshest of each entry", () => {
    const ship = new InfoBoard();
    const hub = new InfoBoard();
    ship.record(1, snap(10, 1));
    hub.record(1, snap(20, 2));
    hub.record(2, snap(5, 3));
    ship.syncWith(hub);
    expect(ship.get(1)!.tick).toBe(20);
    expect(ship.get(2)!.tick).toBe(5);
    expect(hub.get(1)!.tick).toBe(20);
  });
});

describe("HubNetwork manifests", () => {
  it("sums in-flight cargo per destination and prunes arrivals", () => {
    const net = new HubNetwork();
    net.file({ destId: 3, good: "food", qty: 50, arrivalTick: 10 });
    net.file({ destId: 3, good: "food", qty: 30, arrivalTick: 20 });
    net.file({ destId: 3, good: "ore", qty: 99, arrivalTick: 20 });
    net.file({ destId: 4, good: "food", qty: 7, arrivalTick: 20 });
    expect(net.pendingFor(3, "food")).toBe(80);
    net.prune(10); // first shipment has landed
    expect(net.pendingFor(3, "food")).toBe(30);
    expect(net.pendingFor(3, "ore")).toBe(99);
  });
});

describe("information propagation through hubs", () => {
  it("news of a shock physically reaches the hub network, then the fleet", () => {
    const sim = new Simulation(42);
    sim.run(300);

    const victim = sim.systemsByRole("agricultural")[0]!;
    expect(victim.isHub).toBe(false); // news must travel, not originate at a hub
    const shockTick = sim.tick;
    sim.pirateRaid(victim.id, "food", 0.9);

    sim.run(100);

    // The relay network has heard (some ship saw it and docked at a hub)...
    expect(sim.galaxy.hubNet.board.get(victim.id)!.tick).toBeGreaterThanOrEqual(shockTick);
    // ...and the news has spread to most of the fleet.
    const informed = sim.galaxy.traders.filter(
      (t) => (t.board.get(victim.id)?.tick ?? 0) >= shockTick,
    );
    expect(informed.length).toBeGreaterThan(sim.galaxy.traders.length / 2);
  });

  it("hubs keep the fleet's knowledge fresher than no hubs at all", () => {
    const withHubs = new Simulation(42);
    const noHubs = new Simulation(42, { galaxy: { hubCount: 0 } });
    withHubs.run(400);
    noHubs.run(400);
    expect(withHubs.metrics().avgInfoAgeTicks).toBeLessThan(noHubs.metrics().avgInfoAgeTicks);
  });

  it("the economy still functions on hub-relayed information alone", () => {
    // The point of the rework: traders are NOT omniscient (and players,
    // who use the same InfoBoard mechanics, never will be either).
    const sim = new Simulation(42);
    sim.run(400);
    const m = sim.metrics();
    expect(m.avgInfoAgeTicks).toBeGreaterThan(0); // genuinely stale knowledge
    expect(m.goods.food.stockouts).toBeLessThanOrEqual(1); // yet nobody starves
  });
});
