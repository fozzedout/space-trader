import { GOOD_IDS, type GoodId } from "./goods.js";
import { HubNetwork, InfoBoard, takeSnapshot } from "./info.js";
import type { Rng } from "./rng.js";
import type { StarSystem } from "./system.js";

export interface TraderConfig {
  /** Distance travelled per tick. */
  speed: number;
  /** Credit cost per unit of distance (hull wear; pure credit sink). */
  costPerDist: number;
  /** Fuel units burned per unit of distance, bought at the origin market. */
  fuelPerDist: number;
  /** Fuel units a ship's scoop can skim from the star per idle tick. */
  harvestRate: number;
  /** Minimum profit as a fraction of purchase cost to accept a route. */
  minMarginFrac: number;
  /** After this many idle ticks, relocate to a random system. */
  idleRelocateAfter: number;
  /** Traders only buy inventory above this fraction of target stock. */
  originReserveFrac: number;
  /** When relocating idle, probability of heading to a hub for fresh news. */
  hubRelocateBias: number;
}

export const DEFAULT_TRADER_CONFIG: TraderConfig = {
  speed: 12,
  costPerDist: 0.3,
  fuelPerDist: 0.015,
  harvestRate: 0.5,
  minMarginFrac: 0.05,
  idleRelocateAfter: 8,
  originReserveFrac: 0.4,
  hubRelocateBias: 0.5,
};

interface Cargo {
  good: GoodId;
  qty: number;
  costBasis: number;
}

interface Travel {
  destId: number;
  arrivalTick: number;
}

/**
 * An NPC trader. Pure profit-seeker: buys where goods are cheap (surplus),
 * sells where it BELIEVES they're dear (shortage). Belief comes from its
 * InfoBoard — personal observations plus hub network news — never from
 * live remote state. Player ships get exactly the same information
 * mechanics. The aggregate effect of many of these is the self-balancing
 * distribution network — there is no central coordinator.
 */
export class Trader {
  readonly id: number;
  credits: number;
  readonly capacity: number;
  locationId: number;
  cargo: Cargo | null = null;
  travel: Travel | null = null;
  idleTicks = 0;
  /** What this ship knows about the galaxy's markets. */
  readonly board = new InfoBoard();

  /** Lifetime diagnostics. */
  tripsCompleted = 0;
  totalProfit = 0;
  totalHarvested = 0;

  constructor(opts: { id: number; credits: number; capacity: number; locationId: number }) {
    this.id = opts.id;
    this.credits = opts.credits;
    this.capacity = opts.capacity;
    this.locationId = opts.locationId;
  }

  tick(
    tick: number,
    systems: StarSystem[],
    cfg: TraderConfig,
    rng: Rng,
    hubNet: HubNetwork,
  ): void {
    if (this.travel) {
      if (tick < this.travel.arrivalTick) return;
      this.arrive(systems);
    }
    this.plan(tick, systems, cfg, rng, hubNet);
  }

  private arrive(systems: StarSystem[]): void {
    if (!this.travel) return;
    this.locationId = this.travel.destId;
    this.travel = null;
    if (this.cargo) {
      const market = this.systemById(systems, this.locationId).markets[this.cargo.good];
      const revenue = market.executeSell(this.cargo.qty);
      this.credits += revenue;
      this.totalProfit += revenue - this.cargo.costBasis;
      this.tripsCompleted += 1;
      this.cargo = null;
    }
  }

  private plan(
    tick: number,
    systems: StarSystem[],
    cfg: TraderConfig,
    rng: Rng,
    hubNet: HubNetwork,
  ): void {
    const here = this.systemById(systems, this.locationId);

    // Being docked here means seeing this market live; docking at a hub
    // additionally swaps news with the whole relay network.
    this.board.record(here.id, takeSnapshot(here, tick));
    if (here.isHub) this.board.syncWith(hubNet.board);

    const best = this.bestRouteFrom(here, here, 0, systems, cfg, hubNet);

    if (best) {
      const market = here.markets[best.good];
      const cost = market.executeBuy(best.qty);
      this.credits -= cost;
      this.cargo = { good: best.good, qty: best.qty, costBasis: cost };
      this.depart(tick, here, best.dest, cfg);
      // Departing a hub with cargo files a public flight plan.
      if (here.isHub && this.travel) {
        hubNet.file({
          destId: best.dest.id,
          good: best.good,
          qty: best.qty,
          arrivalTick: this.travel.arrivalTick,
        });
      }
      this.idleTicks = 0;
      return;
    }

    // Nothing profitable from here. Look for a two-leg plan: fly empty to
    // a system the board says has cheap surplus, buy there, deliver
    // onward. This is how remote gluts get tapped instead of rotting
    // behind storage caps (out-of-the-way exporters would otherwise only
    // be visited by chance).
    const fuelMarket = here.markets.fuel;
    const canFuel = (s: StarSystem) =>
      fuelMarket.inventory >= here.distanceTo(s) * cfg.fuelPerDist;
    let reposition: { origin: StarSystem; score: number } | null = null;
    for (const origin of systems) {
      if (origin.id === here.id || !canFuel(origin)) continue;
      const firstLeg = Math.max(1, Math.ceil(here.distanceTo(origin) / cfg.speed));
      const plan = this.bestRouteFrom(here, origin, firstLeg, systems, cfg, hubNet);
      if (plan && (!reposition || plan.score > reposition.score)) {
        reposition = { origin, score: plan.score };
      }
    }
    if (reposition) {
      this.depart(tick, here, reposition.origin, cfg);
      this.idleTicks = 0;
      return;
    }

    // Not even a repositioning plan (as far as this ship knows): after a
    // while, drift — preferring a hub, where the latest news is — so stuck
    // traders refresh stale boards instead of idling forever.
    this.idleTicks += 1;
    if (this.idleTicks >= cfg.idleRelocateAfter && systems.length > 1) {
      const hubs = systems.filter((s) => s.isHub && s.id !== here.id && canFuel(s));
      const reachable = systems.filter((s) => s.id !== here.id && canFuel(s));
      let dest: StarSystem | null = null;
      if (hubs.length > 0 && rng.next() < cfg.hubRelocateBias) {
        dest = rng.pick(hubs);
      } else if (reachable.length > 0) {
        dest = rng.pick(reachable);
      }
      if (dest) {
        this.depart(tick, here, dest, cfg);
        this.idleTicks = 0;
        return;
      }
      // No fuel in port for any journey: stranded — fall through to the
      // scoop, which refills this very market until escape is possible.
    }

    this.harvest(here, cfg);
  }

  /**
   * Best (good, destination) trade starting at `origin`, scored as profit
   * per tick including `leadTicks` spent getting to the origin first.
   * When `origin` is not the ship's current system, origin state comes
   * from the InfoBoard — the plan is a bet on remembered prices.
   */
  private bestRouteFrom(
    here: StarSystem,
    origin: StarSystem,
    leadTicks: number,
    systems: StarSystem[],
    cfg: TraderConfig,
    hubNet: HubNetwork,
  ): { good: GoodId; qty: number; dest: StarSystem; score: number } | null {
    const isLive = origin.id === here.id;
    const originSnap = this.board.get(origin.id);
    if (!isLive && !originSnap) return null;
    const originInv = (good: GoodId): number =>
      isLive ? origin.markets[good].inventory : originSnap!.inventories[good];

    let best: { good: GoodId; qty: number; dest: StarSystem; score: number } | null = null;

    for (const good of GOOD_IDS) {
      const market = origin.markets[good];
      const inv = originInv(good);
      const available = Math.floor(inv - market.targetStock * cfg.originReserveFrac);
      if (available < 1) continue;
      const priceNow = market.priceAt(inv);
      const maxLoad = Math.min(this.capacity, available, Math.floor(this.credits / priceNow));
      if (maxLoad < 1) continue;

      for (const dest of systems) {
        if (dest.id === origin.id) continue;
        const dist = origin.distanceTo(dest);

        // Travel burns fuel, bought at the origin at departure. No fuel
        // in port, no trip (harvesting can refill a port — see plan()).
        const fuelUnits = dist * cfg.fuelPerDist;
        const fuelInv = originInv("fuel");
        const fuelAvailable = good === "fuel" ? fuelInv - fuelUnits : fuelInv;
        if (fuelAvailable < fuelUnits) continue;
        const fuelCost = origin.markets.fuel.priceAt(fuelInv - fuelUnits / 2) * fuelUnits;

        // Destination state is known only as of the last report — the
        // trade is a bet that the shortage still exists on arrival.
        const snap = this.board.get(dest.id);
        if (!snap) continue;
        const destMarket = dest.markets[good]; // static structure only (targetStock, price curve)
        // At a hub, the manifests show cargo already in flight to this
        // destination — count it as if it had landed, so hub-synced
        // traders don't all chase the same shortage.
        const pending = here.isHub ? hubNet.pendingFor(dest.id, good) : 0;
        const knownInv = snap.inventories[good] + pending;

        // Ship only what the destination can absorb above its target —
        // dumping a full hold into a tiny market would crash its price
        // (and the midpoint estimate prices that in, making it unprofitable).
        const absorbable = Math.floor(destMarket.targetStock * 1.2 - knownInv);
        const qty = Math.min(good === "fuel" ? maxLoad - Math.ceil(fuelUnits) : maxLoad, absorbable);
        if (qty < 1) continue;

        const cost = market.priceAt(inv - qty / 2) * qty;
        if (cost > this.credits) continue;
        const travelTicks = Math.max(1, Math.ceil(dist / cfg.speed));
        const revenue = destMarket.priceAt(knownInv + qty / 2) * qty;
        const profit = revenue - cost - dist * cfg.costPerDist - fuelCost;
        if (profit < cost * cfg.minMarginFrac) continue;
        const score = profit / (leadTicks + travelTicks);
        if (!best || score > best.score) {
          best = { good, qty, dest, score };
        }
      }
    }
    return best;
  }

  /**
   * Skim fuel from the local star and sell it to the station. Slow, but
   * needs no capital and no fuel — the income floor for a trader down on
   * its luck, and the bootstrap that refuels a fuel-starved port.
   */
  private harvest(here: StarSystem, cfg: TraderConfig): void {
    this.credits += here.markets.fuel.executeSell(cfg.harvestRate);
    this.totalHarvested += cfg.harvestRate;
  }

  private depart(tick: number, from: StarSystem, to: StarSystem, cfg: TraderConfig): void {
    const dist = from.distanceTo(to);
    // Wear is deducted unchecked: a broke trader may run a small overdraft
    // to reposition rather than be stranded forever in a dead market.
    // viability.test.ts bounds how deep this can ever go.
    this.credits -= dist * cfg.costPerDist;
    // Fuel is physical: bought from the origin market (callers have
    // checked availability). Burning it is the fleet's demand on the
    // fuel economy.
    const fuelUnits = dist * cfg.fuelPerDist;
    this.credits -= from.markets.fuel.executeBuy(fuelUnits);
    this.travel = {
      destId: to.id,
      arrivalTick: tick + Math.max(1, Math.ceil(dist / cfg.speed)),
    };
  }

  private systemById(systems: StarSystem[], id: number): StarSystem {
    const sys = systems.find((s) => s.id === id);
    if (!sys) throw new Error(`unknown system ${id}`);
    return sys;
  }
}
