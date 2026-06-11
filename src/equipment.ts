import type { GoodId } from "./goods.js";
import type { StarSystem } from "./system.js";

/**
 * Ship equipment, bought at stations and assembled from REAL parts taken
 * out of the local market — outfitting is demand on the goods economy,
 * and gear is cheap where machinery is glutted. The fitting fee is a
 * credit sink (station labor).
 */
export type EquipmentId = "scoop" | "shredder";

export interface EquipmentDef {
  readonly parts: Readonly<Partial<Record<GoodId, number>>>;
  readonly fittingFee: number;
  /** Nominal resale value, counted toward loan collateral. */
  readonly collateralValue: number;
}

export const EQUIPMENT: Readonly<Record<EquipmentId, EquipmentDef>> = {
  /** Fuel scoop: skim the local star for fuel (see Trader.harvest). */
  scoop: {
    parts: { machinery: 6, electronics: 1 },
    fittingFee: 150,
    collateralValue: 800,
  },
  /** Asteroid shredder: grind local asteroids into ore. */
  shredder: {
    parts: { machinery: 10, electronics: 3 },
    fittingFee: 250,
    collateralValue: 1400,
  },
};

/** Current cost to buy and fit `id` here, or null if parts are not in stock. */
export function equipmentQuote(system: StarSystem, id: EquipmentId): number | null {
  const def = EQUIPMENT[id];
  let cost = def.fittingFee;
  for (const [good, qty] of Object.entries(def.parts) as [GoodId, number][]) {
    const market = system.markets[good];
    if (market.inventory < qty) return null;
    cost += market.quoteBuy(qty);
  }
  return cost;
}

/** Execute the purchase: parts leave the local market. Returns total cost. */
export function buyEquipment(system: StarSystem, id: EquipmentId): number {
  const def = EQUIPMENT[id];
  let cost = def.fittingFee;
  for (const [good, qty] of Object.entries(def.parts) as [GoodId, number][]) {
    cost += system.markets[good].executeBuy(qty);
  }
  return cost;
}
