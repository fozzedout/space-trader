import { COMMODITIES, POLITICS } from './data.js';
import { CommodityDefinition, CommodityId, MarketContext, RandomSource, SystemStatus } from './types.js';

const trunc = Math.trunc;
const ORIGINAL_DUBIOUS_SCORE = -5;

export function commodityAllowed(commodityId: CommodityId, politicsId: number): boolean {
  const politics = POLITICS[politicsId];
  if (!politics) throw new RangeError(`Unknown politics id ${politicsId}`);
  if (commodityId === CommodityId.Narcotics) return politics.drugsAllowed;
  if (commodityId === CommodityId.Firearms) return politics.firearmsAllowed;
  return true;
}

/** Original StandardPrice baseline, using C-style truncating integer arithmetic. */
export function standardPrice(commodity: CommodityDefinition, context: MarketContext): number {
  const politics = POLITICS[context.politicsId];
  if (!politics) throw new RangeError(`Unknown politics id ${context.politicsId}`);
  if (!commodityAllowed(commodity.id, context.politicsId)) return 0;

  let price = commodity.priceLowTech + context.techLevel * commodity.priceIncrease;
  if (politics.wantedCommodity === commodity.id) price = trunc(price * 4 / 3);
  price = trunc(price * (100 - 2 * politics.strengthTraders) / 100);
  price = trunc(price * (100 - context.size) / 100);
  if (commodity.cheapResource === context.resource) price = trunc(price * 3 / 4);
  if (commodity.expensiveResource === context.resource) price = trunc(price * 4 / 3);
  if (context.techLevel < commodity.techUsage) return 0;
  return Math.max(0, price);
}

/** Original trader-skill markup used when a captain buys cargo from a system. */
export function traderAdjustedBuyPrice(price: number, traderSkill: number): number {
  if (price <= 0) return 0;
  const skill = Math.max(1, Math.min(10, trunc(traderSkill)));
  return trunc(price * (103 + (10 - skill)) / 100);
}

/** Original 75% resale helper for installed equipment, not the dock cargo sell price. */
export function baseEquipmentSellPrice(price: number): number {
  return trunc(Math.max(0, price) * 3 / 4);
}

/** @deprecated Use baseEquipmentSellPrice; retained for source-name compatibility. */
export const baseSellPrice = baseEquipmentSellPrice;

export interface DeterminedPrice {
  readonly standard: number;
  /** Arrival market value before player-side trader and criminal adjustments. */
  readonly market: number;
  /** Price paid by the captain when buying from the system. */
  readonly buy: number;
  /** Price received by the captain when selling to the system. */
  readonly sell: number;
}

/**
 * Reproduces RecalculateBuyPrices: availability by production tech, criminal
 * intermediary rounding, trader markup, then the strict buy > sell invariant.
 */
export function recalculateBuyPrice(
  commodity: CommodityDefinition,
  context: MarketContext,
  sellPrice: number,
  traderSkill: number,
  policeRecord: number,
): number {
  if (
    sellPrice <= 0
    || context.techLevel < commodity.techProduction
    || !commodityAllowed(commodity.id, context.politicsId)
  ) return 0;

  const base = policeRecord < ORIGINAL_DUBIOUS_SCORE
    ? trunc(sellPrice * 100 / 90)
    : sellPrice;
  let buy = traderAdjustedBuyPrice(base, traderSkill);
  if (buy <= sellPrice) buy = sellPrice + 1;
  return buy;
}

/** Original arrival-price baseline; multiplayer stock pressure is intentionally layered elsewhere. */
export function determinePrice(
  commodity: CommodityDefinition,
  context: MarketContext,
  traderSkill: number,
  policeRecord: number,
  rng: RandomSource,
): DeterminedPrice {
  const standard = standardPrice(commodity, context);
  if (standard === 0) return { standard: 0, market: 0, buy: 0, sell: 0 };

  let market = standard;
  if (context.status === commodity.doublePriceStatus) market = trunc(market * 3 / 2);
  market += rng.nextInt(commodity.variance) - rng.nextInt(commodity.variance);
  if (market <= 0) return { standard, market: 0, buy: 0, sell: 0 };

  let sell = market;
  if (policeRecord < ORIGINAL_DUBIOUS_SCORE) sell = trunc(sell * 90 / 100);
  const buy = recalculateBuyPrice(commodity, context, sell, traderSkill, policeRecord);
  return { standard, market, buy, sell };
}

export function initialQuantity(
  commodity: CommodityDefinition,
  context: MarketContext,
  rng: RandomSource,
): number {
  if (context.techLevel < commodity.techProduction || !commodityAllowed(commodity.id, context.politicsId)) return 0;

  let qty = (9 + rng.nextInt(5) - Math.abs(commodity.techTopProduction - context.techLevel)) * (1 + context.size);
  if (commodity.id === CommodityId.Narcotics || commodity.id === CommodityId.Robots) {
    qty = trunc(qty * (5 - context.difficulty) / (6 - context.difficulty)) + 1;
  }
  if (commodity.cheapResource === context.resource) qty = trunc(qty * 4 / 3);
  if (commodity.expensiveResource === context.resource) qty = trunc(qty * 3 / 4);
  if (context.status === commodity.doublePriceStatus) qty = trunc(qty / 5);
  qty = qty - rng.nextInt(10) + rng.nextInt(10);
  return Math.max(0, qty);
}

/** Original 15% daily status transition used on arrival. */
export function shuffleSystemStatus(current: SystemStatus, rng: RandomSource): SystemStatus {
  if (current !== SystemStatus.Uneventful) {
    return rng.nextInt(100) < 15 ? SystemStatus.Uneventful : current;
  }
  if (rng.nextInt(100) < 15) {
    return (1 + rng.nextInt(7)) as SystemStatus;
  }
  return current;
}

export function quoteAllCommodities(
  context: MarketContext,
  traderSkill: number,
  policeRecord: number,
  rng: RandomSource,
): readonly DeterminedPrice[] {
  return COMMODITIES.map((commodity) => determinePrice(commodity, context, traderSkill, policeRecord, rng));
}
