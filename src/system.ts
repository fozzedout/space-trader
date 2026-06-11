import {
  GOOD_IDS,
  GOODS,
  PRODUCTION_ORDER,
  ROLE_CONSUMPTION,
  ROLE_PRODUCTION,
  type GoodId,
  type Role,
} from "./goods.js";
import { Market } from "./market.js";

export interface Shock {
  good: GoodId;
  /** Multiplier on production rate while active (e.g. 0.1 = blight). */
  prodMult: number;
  /** Multiplier on final-demand consumption while active. */
  consMult: number;
  /** Last tick (exclusive) the shock is active. */
  untilTick: number;
}

const TARGET_STOCK_CONS_TICKS = 30;
const TARGET_STOCK_PROD_TICKS = 15;
/**
 * Minimum target stock for any good a system actively produces or
 * consumes. Tiny markets (e.g. a small world's fuel demand) would
 * otherwise have targets of a few units — too small for lumpy ship
 * deliveries to ever keep stocked.
 */
const MIN_ACTIVE_TARGET_STOCK = 25;

export class StarSystem {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly role: Role;
  /** Population in millions; scales production and consumption. */
  readonly pop: number;
  readonly markets: Record<GoodId, Market>;
  shocks: Shock[] = [];

  constructor(opts: {
    id: number;
    name: string;
    x: number;
    y: number;
    role: Role;
    pop: number;
  }) {
    this.id = opts.id;
    this.name = opts.name;
    this.x = opts.x;
    this.y = opts.y;
    this.role = opts.role;
    this.pop = opts.pop;

    // Target stock covers final demand AND demand for production inputs,
    // so e.g. an industrial world holds a real buffer of ore.
    const prodRates = ROLE_PRODUCTION[this.role];
    const consRates = ROLE_CONSUMPTION[this.role];
    const inputDemand: Partial<Record<GoodId, number>> = {};
    for (const [out, rate] of Object.entries(prodRates) as [GoodId, number][]) {
      for (const [inp, perUnit] of Object.entries(GOODS[out].inputs) as [GoodId, number][]) {
        inputDemand[inp] = (inputDemand[inp] ?? 0) + rate * perUnit;
      }
    }

    this.markets = {} as Record<GoodId, Market>;
    for (const good of GOOD_IDS) {
      const prod = (prodRates[good] ?? 0) * this.pop;
      const cons = ((consRates[good] ?? 0) + (inputDemand[good] ?? 0)) * this.pop;
      let target = cons * TARGET_STOCK_CONS_TICKS + prod * TARGET_STOCK_PROD_TICKS;
      if (prod + cons > 0) target = Math.max(target, MIN_ACTIVE_TARGET_STOCK);
      this.markets[good] = new Market(good, target);
    }
  }

  distanceTo(other: StarSystem): number {
    return Math.hypot(this.x - other.x, this.y - other.y);
  }

  private shockMult(good: GoodId, tick: number, kind: "prodMult" | "consMult"): number {
    let mult = 1;
    for (const s of this.shocks) {
      if (s.good === good && tick < s.untilTick) mult *= s[kind];
    }
    return mult;
  }

  /**
   * One economic tick: produce (limited by inputs), consume, cap storage.
   * No inventory or credits are ever injected — only production,
   * consumption, and ship trades change state.
   */
  tick(tick: number): void {
    const prodRates = ROLE_PRODUCTION[this.role];
    const consRates = ROLE_CONSUMPTION[this.role];

    // Production in fixed topological order: inputs are always produced
    // before the goods that consume them.
    for (const good of PRODUCTION_ORDER) {
      const rate = prodRates[good];
      if (!rate) continue;
      const capacity = rate * this.pop * this.shockMult(good, tick, "prodMult");
      if (capacity <= 0) continue;

      // Output limited by the scarcest input.
      let output = capacity;
      for (const [inp, perUnit] of Object.entries(GOODS[good].inputs) as [GoodId, number][]) {
        output = Math.min(output, this.markets[inp].inventory / perUnit);
      }
      output = Math.max(0, output);

      for (const [inp, perUnit] of Object.entries(GOODS[good].inputs) as [GoodId, number][]) {
        this.markets[inp].inventory -= output * perUnit;
      }
      this.markets[good].inventory += output;
    }

    // Final-demand consumption. Unmet demand is lost, not backlogged.
    for (const good of GOOD_IDS) {
      const rate = consRates[good];
      if (!rate) continue;
      const demand = rate * this.pop * this.shockMult(good, tick, "consMult");
      const market = this.markets[good];
      market.inventory = Math.max(0, market.inventory - demand);
    }

    // Storage cap: overflow is discarded (spoilage / dumping).
    for (const good of GOOD_IDS) {
      const market = this.markets[good];
      if (market.inventory > market.maxStock) market.inventory = market.maxStock;
    }

    this.shocks = this.shocks.filter((s) => tick < s.untilTick);
  }
}
