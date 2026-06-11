import { generateGalaxy, type Galaxy, type GalaxyOptions } from "./galaxy.js";
import { GOOD_IDS, GOODS, type GoodId } from "./goods.js";
import { Rng } from "./rng.js";
import type { Shock, StarSystem } from "./system.js";
import { DEFAULT_TRADER_CONFIG, type TraderConfig } from "./trader.js";

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
  /** Poorest trader's credits — the canary for economy viability. */
  minTraderCredits: number;
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
    const traders = this.galaxy.traders;
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
        }:${trader.travel?.destId ?? "-"}`,
      );
    }
    return parts.join("|");
  }
}
