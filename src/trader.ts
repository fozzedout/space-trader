import { GOOD_IDS, type GoodId } from "./goods.js";
import type { Rng } from "./rng.js";
import type { StarSystem } from "./system.js";

export interface TraderConfig {
  /** Distance travelled per tick. */
  speed: number;
  /** Credit cost per unit of distance (pure credit sink). */
  costPerDist: number;
  /** Minimum profit as a fraction of purchase cost to accept a route. */
  minMarginFrac: number;
  /** After this many idle ticks, relocate to a random system. */
  idleRelocateAfter: number;
  /** Traders only buy inventory above this fraction of target stock. */
  originReserveFrac: number;
}

export const DEFAULT_TRADER_CONFIG: TraderConfig = {
  speed: 12,
  costPerDist: 1.0,
  minMarginFrac: 0.05,
  idleRelocateAfter: 8,
  originReserveFrac: 0.4,
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
 * An NPC trader. Pure profit-seeker with full price visibility: buys where
 * goods are cheap (surplus), sells where they're dear (shortage). The
 * aggregate effect of many of these is the self-balancing distribution
 * network — there is no central coordinator.
 */
export class Trader {
  readonly id: number;
  credits: number;
  readonly capacity: number;
  locationId: number;
  cargo: Cargo | null = null;
  travel: Travel | null = null;
  idleTicks = 0;

  /** Lifetime diagnostics. */
  tripsCompleted = 0;
  totalProfit = 0;

  constructor(opts: { id: number; credits: number; capacity: number; locationId: number }) {
    this.id = opts.id;
    this.credits = opts.credits;
    this.capacity = opts.capacity;
    this.locationId = opts.locationId;
  }

  tick(tick: number, systems: StarSystem[], cfg: TraderConfig, rng: Rng): void {
    if (this.travel) {
      if (tick < this.travel.arrivalTick) return;
      this.arrive(systems);
    }
    this.plan(tick, systems, cfg, rng);
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

  private plan(tick: number, systems: StarSystem[], cfg: TraderConfig, rng: Rng): void {
    const here = this.systemById(systems, this.locationId);

    let best: { good: GoodId; qty: number; dest: StarSystem; score: number; cost: number } | null =
      null;

    for (const good of GOOD_IDS) {
      const market = here.markets[good];
      const available = Math.floor(market.inventory - market.targetStock * cfg.originReserveFrac);
      if (available < 1) continue;
      const maxLoad = Math.min(this.capacity, available, Math.floor(this.credits / market.price));
      if (maxLoad < 1) continue;

      for (const dest of systems) {
        if (dest.id === here.id) continue;
        const destMarket = dest.markets[good];

        // Ship only what the destination can absorb above its target —
        // dumping a full hold into a tiny market would crash its price
        // (and the midpoint quote prices that in, making it unprofitable).
        const absorbable = Math.floor(destMarket.targetStock * 1.2 - destMarket.inventory);
        const qty = Math.min(maxLoad, absorbable);
        if (qty < 1) continue;

        const cost = market.quoteBuy(qty);
        if (cost > this.credits) continue;
        const dist = here.distanceTo(dest);
        const travelTicks = Math.max(1, Math.ceil(dist / cfg.speed));
        const revenue = destMarket.quoteSell(qty);
        const profit = revenue - cost - dist * cfg.costPerDist;
        if (profit < cost * cfg.minMarginFrac) continue;
        const score = profit / travelTicks;
        if (!best || score > best.score) {
          best = { good, qty, dest, score, cost };
        }
      }
    }

    if (best) {
      const market = here.markets[best.good];
      const cost = market.executeBuy(best.qty);
      this.credits -= cost;
      this.cargo = { good: best.good, qty: best.qty, costBasis: cost };
      this.depart(tick, here, best.dest, cfg);
      this.idleTicks = 0;
      return;
    }

    // Nothing profitable here: after a while, reposition to a random
    // system so traders don't pile up in dead corners of the galaxy.
    this.idleTicks += 1;
    if (this.idleTicks >= cfg.idleRelocateAfter && systems.length > 1) {
      let dest: StarSystem;
      do {
        dest = rng.pick(systems);
      } while (dest.id === here.id);
      this.depart(tick, here, dest, cfg);
      this.idleTicks = 0;
    }
  }

  private depart(tick: number, from: StarSystem, to: StarSystem, cfg: TraderConfig): void {
    const dist = from.distanceTo(to);
    this.credits -= dist * cfg.costPerDist;
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
