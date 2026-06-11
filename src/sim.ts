import { generateGalaxy, type Galaxy, type GalaxyOptions } from "./galaxy.js";
import { GOOD_IDS, GOODS, type GoodId } from "./goods.js";
import { observePlayer, type PlayerAction, type PlayerObservation } from "./player.js";
import { Rng } from "./rng.js";
import type { Shock, StarSystem } from "./system.js";
import { DEFAULT_TRADER_CONFIG, Trader, type TraderConfig } from "./trader.js";

export interface GoodMetrics {
  /** Mean of price/basePrice across systems. 1.0 = perfect equilibrium. */
  avgPriceRatio: number;
  maxPriceRatio: number;
  /** Systems whose inventory is below 5% of target (effectively starved). */
  stockouts: number;
}

export interface Metrics {
  tick: number;
  goods: Record<GoodId, GoodMetrics>;
  totalTraderCredits: number;
  tradersInTransit: number;
  /** Mean staleness (ticks) of traders' market knowledge across all systems. */
  avgInfoAgeTicks: number;
  /** Traders with negative credits. Transient small overdrafts (travel
   * costs while repositioning) are tolerable; a persistent count here
   * means the economy can't support its traders. */
  tradersInsolvent: number;
  /** Poorest active trader's credits — the canary for economy viability. */
  minTraderCredits: number;
  /** Outstanding station-bank debt across the fleet. */
  totalDebt: number;
  tradersIndebted: number;
  /** Ships seized by banks after loan default (lifetime count). */
  tradersSeized: number;
}

/**
 * The simulation: systems tick (produce/consume), then traders tick
 * (decide/travel/trade), in ascending id order. Deterministic for a
 * given seed: same seed + same external events = identical run.
 */
export class Simulation {
  readonly galaxy: Galaxy;
  readonly traderConfig: TraderConfig;
  tick = 0;
  private readonly rng: Rng;

  constructor(
    seed: number | string,
    opts?: { galaxy?: Partial<GalaxyOptions>; trader?: Partial<TraderConfig> },
  ) {
    this.galaxy = generateGalaxy(seed, opts?.galaxy);
    this.traderConfig = { ...DEFAULT_TRADER_CONFIG, ...opts?.trader };
    this.rng = new Rng(seed).fork("sim");
  }

  step(): void {
    this.galaxy.hubNet.prune(this.tick);
    for (const system of this.galaxy.systems) {
      system.tick(this.tick);
    }
    for (const trader of this.galaxy.traders) {
      trader.tick(this.tick, this.galaxy.systems, this.traderConfig, this.rng, this.galaxy.hubNet);
    }
    this.tick += 1;
  }

  run(ticks: number, onTick?: (sim: Simulation) => void): void {
    for (let i = 0; i < ticks; i++) {
      this.step();
      onTick?.(this);
    }
  }

  system(id: number): StarSystem {
    const sys = this.galaxy.systems.find((s) => s.id === id);
    if (!sys) throw new Error(`unknown system ${id}`);
    return sys;
  }

  /** Find systems by role, e.g. to target a disaster at an exporter. */
  systemsByRole(role: StarSystem["role"]): StarSystem[] {
    return this.galaxy.systems.filter((s) => s.role === role);
  }

  /**
   * Add a player-controlled ship. It participates exactly like an NPC —
   * same markets, news, bank, foreclosure — but executes queued actions
   * (see player.ts) instead of the planner. Returns the ship id.
   * Add players before running if determinism across runs matters.
   */
  addPlayer(opts?: { credits?: number; capacity?: number; locationId?: number }): number {
    const id = this.galaxy.traders.length;
    const player = new Trader({
      id,
      credits: opts?.credits ?? 5000,
      capacity: opts?.capacity ?? 100,
      locationId: opts?.locationId ?? this.galaxy.systems.find((s) => s.isHub)?.id ?? 0,
    });
    player.controller = "player";
    // Same founding survey every ship gets at galaxy creation; fresher
    // knowledge must physically travel, for players too.
    player.board.syncWith(this.galaxy.hubNet.board);
    this.galaxy.traders.push(player);
    return id;
  }

  /** What the ship is entitled to know right now (information symmetry). */
  observe(shipId: number): PlayerObservation {
    return observePlayer(
      this.ship(shipId),
      this.galaxy.systems,
      this.galaxy.hubNet,
      this.tick,
      this.traderConfig,
    );
  }

  /**
   * Queue an action for a player ship; it executes on the ship's next
   * tick (one action per tick; queueing again before then replaces it).
   * The outcome lands in the next observation's `lastActionResult`.
   */
  act(shipId: number, action: PlayerAction): void {
    const ship = this.ship(shipId);
    if (ship.controller !== "player") throw new Error(`ship ${shipId} is not player-controlled`);
    ship.pendingAction = action;
  }

  private ship(shipId: number): Trader {
    const ship = this.galaxy.traders.find((t) => t.id === shipId);
    if (!ship) throw new Error(`unknown ship ${shipId}`);
    return ship;
  }

  /**
   * External event: production/consumption shock on one system+good for
   * `duration` ticks (blight, mine collapse, war demand spike, ...).
   */
  applyShock(
    systemId: number,
    shock: Omit<Shock, "untilTick"> & { duration: number },
  ): void {
    this.system(systemId).shocks.push({
      good: shock.good,
      prodMult: shock.prodMult,
      consMult: shock.consMult,
      untilTick: this.tick + shock.duration,
    });
  }

  /**
   * External event: pirates raid a system and destroy a fraction of one
   * good's inventory. Nothing is refunded or injected — the market and
   * traders have to absorb it.
   */
  pirateRaid(systemId: number, good: GoodId, fraction: number): number {
    const market = this.system(systemId).markets[good];
    const destroyed = market.inventory * Math.min(1, Math.max(0, fraction));
    market.inventory -= destroyed;
    return destroyed;
  }

  metrics(): Metrics {
    const goods = {} as Record<GoodId, GoodMetrics>;
    for (const good of GOOD_IDS) {
      let sum = 0;
      let max = 0;
      let stockouts = 0;
      for (const system of this.galaxy.systems) {
        const market = system.markets[good];
        const ratio = market.price / GOODS[good].basePrice;
        sum += ratio;
        max = Math.max(max, ratio);
        if (market.inventory < market.targetStock * 0.05) stockouts += 1;
      }
      goods[good] = {
        avgPriceRatio: sum / this.galaxy.systems.length,
        maxPriceRatio: max,
        stockouts,
      };
    }
    const systemIds = this.galaxy.systems.map((s) => s.id);
    const traders = this.galaxy.traders.filter((t) => t.active);
    return {
      tick: this.tick,
      goods,
      totalTraderCredits: traders.reduce((acc, t) => acc + t.credits, 0),
      tradersInTransit: traders.filter((t) => t.travel !== null).length,
      avgInfoAgeTicks:
        traders.length === 0
          ? 0
          : traders.reduce((acc, t) => acc + t.board.avgAge(this.tick, systemIds), 0) /
            traders.length,
      tradersInsolvent: traders.filter((t) => t.credits < 0).length,
      minTraderCredits: traders.reduce((min, t) => Math.min(min, t.credits), Infinity),
      totalDebt: traders.reduce((acc, t) => acc + (t.loan?.principal ?? 0), 0),
      tradersIndebted: traders.filter((t) => t.loan !== null).length,
      tradersSeized: this.galaxy.traders.filter((t) => !t.active).length,
    };
  }

  /** Compact deterministic fingerprint of the full economic state. */
  stateHash(): string {
    const parts: string[] = [String(this.tick)];
    for (const system of this.galaxy.systems) {
      for (const good of GOOD_IDS) {
        parts.push(system.markets[good].inventory.toFixed(6));
      }
    }
    for (const trader of this.galaxy.traders) {
      parts.push(
        `${trader.locationId}:${trader.credits.toFixed(6)}:${trader.cargo?.good ?? "-"}:${
          trader.cargo?.qty ?? 0
        }:${trader.travel?.destId ?? "-"}:${trader.loan?.principal.toFixed(6) ?? "-"}:${
          trader.equipment.scoop ? "s" : ""
        }${trader.equipment.shredder ? "r" : ""}:${trader.active ? 1 : 0}`,
      );
    }
    return parts.join("|");
  }
}
