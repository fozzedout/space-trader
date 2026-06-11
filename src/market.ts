import { GOODS, type GoodId } from "./goods.js";

/**
 * A single good's market in one star system.
 *
 * Price is a PURE function of inventory vs target stock — no smoothing, no
 * hidden corrections. Every unit a trader buys or sells moves the price
 * immediately, which is the feedback loop the whole simulation rests on:
 * shortage -> high price -> traders deliver -> price falls.
 */
export class Market {
  readonly good: GoodId;
  inventory: number;
  /** Stock level at which price equals basePrice. */
  targetStock: number;
  /** Inventory above this is discarded each tick (warehousing limit). */
  maxStock: number;

  /** Cumulative units sold to / bought from ships (diagnostics). */
  imported = 0;
  exported = 0;

  constructor(good: GoodId, targetStock: number) {
    this.good = good;
    this.targetStock = Math.max(1, targetStock);
    this.maxStock = this.targetStock * 2.5;
    this.inventory = this.targetStock;
  }

  /** Price if inventory were `inv`. */
  priceAt(inv: number): number {
    const def = GOODS[this.good];
    const ratio = Math.max(0, inv) / this.targetStock;
    const mult = 1 + def.priceElasticity * (1 - ratio);
    const clamped = Math.min(def.maxPriceMult, Math.max(def.minPriceMult, mult));
    return def.basePrice * clamped;
  }

  get price(): number {
    return this.priceAt(this.inventory);
  }

  /**
   * Cost for a ship to buy `qty` units. Priced at the midpoint inventory
   * so large trades pay the price impact they cause.
   */
  quoteBuy(qty: number): number {
    return this.priceAt(this.inventory - qty / 2) * qty;
  }

  /** Revenue for a ship selling `qty` units here. */
  quoteSell(qty: number): number {
    return this.priceAt(this.inventory + qty / 2) * qty;
  }

  /** Ship buys from the market. Returns actual cost. */
  executeBuy(qty: number): number {
    if (qty <= 0) return 0;
    if (qty > this.inventory + 1e-9) {
      throw new Error(`buy ${qty} exceeds inventory ${this.inventory} (${this.good})`);
    }
    const cost = this.quoteBuy(qty);
    this.inventory -= qty;
    this.exported += qty;
    return cost;
  }

  /** Ship sells to the market. Returns actual revenue. */
  executeSell(qty: number): number {
    if (qty <= 0) return 0;
    const revenue = this.quoteSell(qty);
    this.inventory += qty;
    this.imported += qty;
    return revenue;
  }
}
