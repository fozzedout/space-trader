import type { CommodityId } from '@sto/original-baseline-rules';
import { PHASE0_TUNING } from './config.js';
import type { MarketGoodState, ProgressiveQuote } from './types.js';

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Design §12.4 unit price from stock and pressure. */
export function unitPrice(equilibriumPrice: number, currentStock: number, targetStock: number, pressureBps: number): number {
  const stockRatio = clamp(
    (targetStock - currentStock) / Math.max(1, targetStock),
    -1,
    1,
  );
  const stockAdjustmentBps = Math.round(stockRatio * PHASE0_TUNING.stockEffectMaxBps);
  const pressure = clamp(pressureBps, -PHASE0_TUNING.pressureMaxBps, PHASE0_TUNING.pressureMaxBps);
  const combined = clamp(
    stockAdjustmentBps + pressure,
    -PHASE0_TUNING.totalEffectMaxBps,
    PHASE0_TUNING.totalEffectMaxBps,
  );
  return Math.max(1, Math.round((equilibriumPrice * (10_000 + combined)) / 10_000));
}

export function applyBuyUnit(state: MarketGoodState): MarketGoodState {
  return {
    ...state,
    stock: Math.max(0, state.stock - 1),
    pressureBps: clamp(
      state.pressureBps + PHASE0_TUNING.buyPressureStepBps,
      -PHASE0_TUNING.pressureMaxBps,
      PHASE0_TUNING.pressureMaxBps,
    ),
  };
}

export function applySellUnit(state: MarketGoodState): MarketGoodState {
  return {
    ...state,
    stock: state.stock + 1,
    pressureBps: clamp(
      state.pressureBps - PHASE0_TUNING.sellPressureStepBps,
      -PHASE0_TUNING.pressureMaxBps,
      PHASE0_TUNING.pressureMaxBps,
    ),
  };
}

/** Progressive multi-unit quote; commits nothing until reservation commit. */
export function progressiveQuote(
  state: MarketGoodState,
  side: 'buy' | 'sell',
  quantity: number,
): ProgressiveQuote {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError('quantity must be a positive safe integer');
  }
  if (side === 'buy' && quantity > state.stock) {
    throw new RangeError('insufficient stock');
  }

  let cursor = { ...state };
  const unitPrices: number[] = [];
  for (let i = 0; i < quantity; i += 1) {
    unitPrices.push(unitPrice(cursor.equilibriumPrice, cursor.stock, cursor.targetStock, cursor.pressureBps));
    cursor = side === 'buy' ? applyBuyUnit(cursor) : applySellUnit(cursor);
  }
  const total = unitPrices.reduce((sum, p) => sum + p, 0);
  return {
    good: state.good,
    side,
    quantity,
    unitPrices,
    total,
    finalStock: cursor.stock,
    finalPressureBps: cursor.pressureBps,
  };
}

export function commitQuote(state: MarketGoodState, quote: ProgressiveQuote): MarketGoodState {
  if (quote.good !== state.good) throw new Error('good mismatch');
  return {
    ...state,
    stock: quote.finalStock,
    pressureBps: quote.finalPressureBps,
  };
}

/** Design §12.5 elapsed recovery toward target stock and zero pressure. */
export function applyMarketRecovery(state: MarketGoodState, nowMs: number): MarketGoodState {
  if (nowMs < state.updatedAt) return state;
  const periods = Math.floor((nowMs - state.updatedAt) / PHASE0_TUNING.recoveryPeriodMs);
  if (periods <= 0) return state;

  let stock = state.stock;
  let pressure = state.pressureBps;
  for (let i = 0; i < periods; i += 1) {
    const stockRecovery = Math.round((state.targetStock - stock) * PHASE0_TUNING.stockRecoveryRateBps / 10_000);
    const pressureRecovery = Math.round((0 - pressure) * PHASE0_TUNING.pressureDecayRateBps / 10_000);
    stock += stockRecovery;
    pressure += pressureRecovery;
  }
  return {
    ...state,
    stock,
    pressureBps: clamp(pressure, -PHASE0_TUNING.pressureMaxBps, PHASE0_TUNING.pressureMaxBps),
    updatedAt: state.updatedAt + periods * PHASE0_TUNING.recoveryPeriodMs,
  };
}

export function bootstrapMarketGood(
  good: CommodityId,
  equilibriumPrice: number,
  targetStock: number,
  nowMs: number,
): MarketGoodState {
  return {
    good,
    equilibriumPrice: Math.max(1, equilibriumPrice),
    stock: Math.max(0, targetStock),
    targetStock: Math.max(0, targetStock),
    pressureBps: 0,
    updatedAt: nowMs,
  };
}
