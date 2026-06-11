/**
 * Goods catalog and production chain.
 *
 * Design rule that keeps the economy restartable: the chain is a DAG and
 * its roots (food, ore) require NO inputs. Whatever happens — disasters,
 * pirates, total stockouts — primary production always resumes, so the
 * chain can never deadlock the way a circular-dependency chain can.
 */

export type GoodId =
  | "food"
  | "ore"
  | "fuel"
  | "machinery"
  | "electronics"
  | "luxuries";

export interface GoodDef {
  readonly basePrice: number;
  /** How strongly price reacts to inventory deviation from target. */
  readonly priceElasticity: number;
  /** Price clamp as multiples of basePrice. */
  readonly minPriceMult: number;
  readonly maxPriceMult: number;
  /** Inputs consumed per 1 unit of output. Empty for primary goods. */
  readonly inputs: Readonly<Partial<Record<GoodId, number>>>;
}

export const GOODS: Readonly<Record<GoodId, GoodDef>> = {
  food: {
    basePrice: 10,
    priceElasticity: 1.0,
    minPriceMult: 0.3,
    maxPriceMult: 3.0,
    inputs: {},
  },
  ore: {
    basePrice: 25,
    priceElasticity: 0.8,
    minPriceMult: 0.3,
    maxPriceMult: 3.0,
    inputs: {},
  },
  fuel: {
    basePrice: 40,
    priceElasticity: 0.9,
    minPriceMult: 0.3,
    maxPriceMult: 3.0,
    inputs: { ore: 0.5 },
  },
  machinery: {
    basePrice: 120,
    priceElasticity: 1.0,
    minPriceMult: 0.3,
    maxPriceMult: 3.0,
    inputs: { ore: 1.0, fuel: 0.1 },
  },
  electronics: {
    basePrice: 350,
    priceElasticity: 1.1,
    minPriceMult: 0.3,
    maxPriceMult: 3.0,
    inputs: { ore: 0.5, machinery: 0.2 },
  },
  luxuries: {
    basePrice: 500,
    priceElasticity: 1.3,
    minPriceMult: 0.3,
    maxPriceMult: 3.0,
    inputs: { food: 0.3, electronics: 0.2 },
  },
};

export const GOOD_IDS = Object.keys(GOODS) as GoodId[];

/**
 * Fixed production order. Inputs always come earlier in the list than the
 * outputs that consume them (topological order of the DAG), so a single
 * left-to-right pass per tick is deterministic and correct.
 */
export const PRODUCTION_ORDER: readonly GoodId[] = [
  "food",
  "ore",
  "fuel",
  "machinery",
  "electronics",
  "luxuries",
];

export type Role = "agricultural" | "mining" | "industrial" | "high_tech";

export const ROLES: readonly Role[] = [
  "agricultural",
  "mining",
  "industrial",
  "high_tech",
];

/** Units produced per population per tick, given full input availability. */
export const ROLE_PRODUCTION: Readonly<
  Record<Role, Readonly<Partial<Record<GoodId, number>>>>
> = {
  agricultural: { food: 4.5 },
  mining: { ore: 1.2 },
  industrial: { fuel: 0.5, machinery: 0.55 },
  high_tech: { electronics: 0.45, luxuries: 0.2 },
};

/**
 * Units consumed per population per tick (final demand; demand for
 * production inputs is computed separately from ROLE_PRODUCTION).
 */
export const ROLE_CONSUMPTION: Readonly<
  Record<Role, Readonly<Partial<Record<GoodId, number>>>>
> = {
  agricultural: {
    food: 1.0,
    luxuries: 0.04,
    electronics: 0.05,
    fuel: 0.04,
    machinery: 0.15,
  },
  mining: {
    food: 1.0,
    luxuries: 0.04,
    electronics: 0.05,
    fuel: 0.08,
    machinery: 0.15,
  },
  industrial: {
    food: 1.0,
    luxuries: 0.04,
    electronics: 0.05,
    fuel: 0.2,
    machinery: 0.1,
  },
  high_tech: {
    food: 1.0,
    luxuries: 0.04,
    electronics: 0.2,
    fuel: 0.04,
    machinery: 0.0,
  },
};
