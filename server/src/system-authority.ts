import {
  PHASE0_TUNING,
  RULESET_VERSION,
  applyMarketRecovery,
  bootstrapMarketGood,
  commitQuote,
  progressiveQuote,
  matchEncounterPairs,
  deriveEncounterId,
  type MarketGoodState,
  type OccupancyInterval,
  type EncounterPair,
  CommodityId,
  type WreckDebris,
  transitionEscapePod,
  scoopCargo,
  dueAutomatedRecovery,
} from '@sto/ruleset-phase0-v1';
import { hashPayload } from './hash.js';

export type ReservationState = 'HELD' | 'COMMIT_REQUIRED' | 'COMMITTED' | 'CANCELLED';

export interface MarketReservation {
  operationId: string;
  captainId: string;
  good: CommodityId;
  side: 'buy' | 'sell';
  quantity: number;
  lockedTotal: number;
  unitPrices: number[];
  state: ReservationState;
  requestHash: string;
  activeExpiresAt: number;
  reconcileExpiresAt: number;
  finalStock: number;
  finalPressureBps: number;
}

export interface TravelPresence {
  captainId: string;
  routeArea: string;
  approachTick: number;
  occupancyStartedAt: number;
  occupancyEndsAt: number;
  encounterId: string | null;
  status: 'present' | 'claimed' | 'closed';
  travelGroupId?: string;
  matchable?: boolean;
}

export interface SystemState {
  systemId: string;
  name: string;
  techLevel: number;
  politicsId: number;
  size: number;
  markets: Map<CommodityId, MarketGoodState>;
  reservations: Map<string, MarketReservation>;
  presence: Map<string, TravelPresence>;
  docked: Set<string>;
  completedMatches: Map<string, EncounterPair[]>; // key: routeArea:globalTick
  wrecks: Map<string, WreckDebris>;
  policePresence: number;
}

export type SystemCommandResult =
  | { ok: true; reservation: MarketReservation }
  | { ok: true; pairs: EncounterPair[] }
  | { ok: true; market: MarketGoodState[] }
  | { ok: true; presence: TravelPresence[] }
  | { ok: true; reservation: MarketReservation | null }
  | { ok: false; error: string; code: string };

export function createSystemState(args: {
  systemId: string;
  name: string;
  techLevel: number;
  politicsId: number;
  size: number;
  goods: Array<{ good: CommodityId; equilibriumPrice: number; targetStock: number }>;
  nowMs: number;
  policePresence?: number;
}): SystemState {
  const markets = new Map<CommodityId, MarketGoodState>();
  for (const g of args.goods) {
    markets.set(g.good, bootstrapMarketGood(g.good, g.equilibriumPrice, g.targetStock, args.nowMs));
  }
  return {
    systemId: args.systemId,
    name: args.name,
    techLevel: args.techLevel,
    politicsId: args.politicsId,
    size: args.size,
    markets,
    reservations: new Map(),
    presence: new Map(),
    docked: new Set(),
    completedMatches: new Map(),
    wrecks: new Map(),
    policePresence: args.policePresence ?? 3,
  };
}

function recoverAll(state: SystemState, nowMs: number): void {
  for (const [good, market] of state.markets) {
    state.markets.set(good, applyMarketRecovery(market, nowMs));
  }
}

export function getMarketSnapshot(state: SystemState, nowMs: number): MarketGoodState[] {
  recoverAll(state, nowMs);
  return [...state.markets.values()];
}

export function reserveTrade(
  state: SystemState,
  args: {
    operationId: string;
    captainId: string;
    good: CommodityId;
    side: 'buy' | 'sell';
    quantity: number;
    requestHash: string;
    nowMs: number;
  },
): SystemCommandResult {
  recoverAll(state, args.nowMs);
  const existing = state.reservations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== args.requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY' };
    }
    return { ok: true, reservation: existing };
  }

  const market = state.markets.get(args.good);
  if (!market) return { ok: false, error: 'unknown good', code: 'NOT_FOUND' };

  let quote;
  try {
    quote = progressiveQuote(market, args.side, args.quantity);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'quote failed', code: 'REJECTED' };
  }

  const reservation: MarketReservation = {
    operationId: args.operationId,
    captainId: args.captainId,
    good: args.good,
    side: args.side,
    quantity: args.quantity,
    lockedTotal: quote.total,
    unitPrices: [...quote.unitPrices],
    state: 'HELD',
    requestHash: args.requestHash,
    activeExpiresAt: args.nowMs + PHASE0_TUNING.tradeReservationMs,
    reconcileExpiresAt: args.nowMs + PHASE0_TUNING.reservationReconcileMs,
    finalStock: quote.finalStock,
    finalPressureBps: quote.finalPressureBps,
  };
  state.reservations.set(args.operationId, reservation);
  return { ok: true, reservation };
}

export function promoteReservation(state: SystemState, operationId: string, requestHash: string): SystemCommandResult {
  const reservation = state.reservations.get(operationId);
  if (!reservation) return { ok: false, error: 'unknown reservation', code: 'NOT_FOUND' };
  if (reservation.requestHash !== requestHash) {
    return { ok: false, error: 'request hash mismatch', code: 'INTEGRITY' };
  }
  if (reservation.state === 'COMMITTED') return { ok: true, reservation };
  if (reservation.state === 'CANCELLED') {
    return { ok: false, error: 'reservation cancelled', code: 'REJECTED' };
  }
  reservation.state = 'COMMIT_REQUIRED';
  return { ok: true, reservation };
}

export function commitReservation(state: SystemState, operationId: string, requestHash: string, nowMs: number): SystemCommandResult {
  recoverAll(state, nowMs);
  const reservation = state.reservations.get(operationId);
  if (!reservation) return { ok: false, error: 'unknown reservation', code: 'NOT_FOUND' };
  if (reservation.requestHash !== requestHash) {
    return { ok: false, error: 'request hash mismatch', code: 'INTEGRITY' };
  }
  if (reservation.state === 'COMMITTED') return { ok: true, reservation };
  if (reservation.state === 'CANCELLED') {
    return { ok: false, error: 'reservation cancelled', code: 'REJECTED' };
  }
  if (reservation.state !== 'COMMIT_REQUIRED' && reservation.state !== 'HELD') {
    return { ok: false, error: `invalid reservation state ${reservation.state}`, code: 'REJECTED' };
  }

  // Once CAPTAIN_COMMITTED, HELD must be treated as COMMIT_REQUIRED (design §14.3).
  reservation.state = 'COMMIT_REQUIRED';

  const market = state.markets.get(reservation.good);
  if (!market) return { ok: false, error: 'unknown good', code: 'NOT_FOUND' };

  const quote = {
    good: reservation.good,
    side: reservation.side,
    quantity: reservation.quantity,
    unitPrices: reservation.unitPrices,
    total: reservation.lockedTotal,
    finalStock: reservation.finalStock,
    finalPressureBps: reservation.finalPressureBps,
  };
  state.markets.set(reservation.good, {
    ...commitQuote(market, quote),
    updatedAt: nowMs,
  });
  reservation.state = 'COMMITTED';
  return { ok: true, reservation };
}

export function getReservation(state: SystemState, operationId: string): MarketReservation | null {
  return state.reservations.get(operationId) ?? null;
}

export function expireHeldReservations(state: SystemState, nowMs: number): void {
  for (const reservation of state.reservations.values()) {
    if (reservation.state === 'HELD' && nowMs > reservation.activeExpiresAt) {
      // Remains recoverable during reconcile window; mark cancelled only after reconcile expiry.
      if (nowMs > reservation.reconcileExpiresAt) {
        reservation.state = 'CANCELLED';
      }
    }
  }
}

export function registerPresence(
  state: SystemState,
  presence: TravelPresence,
): SystemCommandResult {
  const existing = state.presence.get(presence.captainId);
  if (existing?.encounterId && existing.status === 'claimed') {
    return { ok: false, error: 'captain already claimed', code: 'CLAIMED' };
  }
  state.presence.set(presence.captainId, presence);
  return { ok: true, presence: [...state.presence.values()] };
}

export function closePresence(state: SystemState, captainId: string): void {
  const row = state.presence.get(captainId);
  if (row) {
    state.presence.set(captainId, { ...row, status: 'closed', occupancyEndsAt: Math.min(row.occupancyEndsAt, Date.now()) });
  }
}

export function matchWindow(
  state: SystemState,
  args: { routeArea: string; globalTick: number; nowMs: number },
): SystemCommandResult {
  const key = `${args.routeArea}:${args.globalTick}`;
  const prior = state.completedMatches.get(key);
  if (prior) return { ok: true, pairs: prior };

  const eligible: OccupancyInterval[] = [];
  for (const row of state.presence.values()) {
    if (row.status === 'closed' || row.status === 'claimed') continue;
    if (row.routeArea !== args.routeArea) continue;
    if (row.encounterId) continue;
    // Occupancy overlaps window if started before window end and ends after window start.
    const windowStart = args.globalTick * PHASE0_TUNING.travelWindowMs;
    const windowEnd = windowStart + PHASE0_TUNING.travelWindowMs;
    if (row.occupancyStartedAt < windowEnd && row.occupancyEndsAt > windowStart) {
      eligible.push({
        captainId: row.captainId,
        routeArea: row.routeArea,
        startedAt: row.occupancyStartedAt,
        endsAt: row.occupancyEndsAt,
        ...(row.travelGroupId !== undefined ? { travelGroupId: row.travelGroupId } : {}),
        ...(row.matchable !== undefined ? { matchable: row.matchable } : {}),
        claimed: false,
      });
    }
  }

  const pairs = matchEncounterPairs({
    systemId: state.systemId,
    routeArea: args.routeArea,
    globalTick: args.globalTick,
    eligible,
  });
  state.completedMatches.set(key, pairs);
  return { ok: true, pairs };
}

export function markClaimed(state: SystemState, captainId: string, encounterId: string): boolean {
  const row = state.presence.get(captainId);
  if (!row || row.status === 'claimed' || row.encounterId) return false;
  state.presence.set(captainId, { ...row, status: 'claimed', encounterId });
  return true;
}

export function releaseClaim(state: SystemState, captainId: string, encounterId: string): void {
  const row = state.presence.get(captainId);
  if (!row || row.encounterId !== encounterId) return;
  state.presence.set(captainId, { ...row, status: 'present', encounterId: null });
}

export function marketProjectionRows(state: SystemState, nowMs: number) {
  return getMarketSnapshot(state, nowMs).map((m) => ({
    system_id: state.systemId,
    good: m.good,
    equilibrium_price: m.equilibriumPrice,
    stock: m.stock,
    target_stock: m.targetStock,
    pressure_bps: m.pressureBps,
    updated_at: m.updatedAt,
  }));
}

export function reservationRequestHash(input: {
  captainId: string;
  systemId: string;
  good: CommodityId;
  side: 'buy' | 'sell';
  quantity: number;
}): string {
  return hashPayload({ ...input, ruleset: RULESET_VERSION });
}

export function addWreck(state: SystemState, wreck: WreckDebris): void {
  state.wrecks.set(wreck.wreckId, wreck);
}

export function rescueEscapePod(
  state: SystemState,
  args: { wreckId: string; rescuerId: string; nowMs: number },
): { ok: true; wreck: WreckDebris; rescuedCaptainId: string } | { ok: false; error: string; code: string } {
  const wreck = state.wrecks.get(args.wreckId);
  if (!wreck) return { ok: false, error: 'unknown wreck', code: 'NOT_FOUND' };
  if (wreck.podState !== 'AVAILABLE' || !wreck.escapePodCaptainId) {
    return { ok: false, error: 'pod not rescueable', code: 'REJECTED' };
  }
  const next = transitionEscapePod(wreck, 'RESCUED', args.nowMs);
  const complete = transitionEscapePod(next, 'COMPLETE', args.nowMs);
  state.wrecks.set(args.wreckId, complete);
  return { ok: true, wreck: complete, rescuedCaptainId: wreck.escapePodCaptainId };
}

export function destroyEscapePod(
  state: SystemState,
  args: { wreckId: string; nowMs: number },
): { ok: true; wreck: WreckDebris } | { ok: false; error: string; code: string } {
  const wreck = state.wrecks.get(args.wreckId);
  if (!wreck) return { ok: false, error: 'unknown wreck', code: 'NOT_FOUND' };
  if (wreck.podState !== 'AVAILABLE') {
    return { ok: false, error: 'pod not attackable', code: 'REJECTED' };
  }
  const next = transitionEscapePod(wreck, 'DESTROYED', args.nowMs);
  state.wrecks.set(args.wreckId, next);
  return { ok: true, wreck: next };
}

export function scoopWreckCargo(
  state: SystemState,
  args: { wreckId: string; freeCapacity: number; requested: Array<{ good: CommodityId; qty: number }> },
): { ok: true; wreck: WreckDebris; scooped: Array<{ good: CommodityId; qty: number }> } | { ok: false; error: string; code: string } {
  const wreck = state.wrecks.get(args.wreckId);
  if (!wreck) return { ok: false, error: 'unknown wreck', code: 'NOT_FOUND' };
  const result = scoopCargo(wreck, args.freeCapacity, args.requested);
  state.wrecks.set(args.wreckId, result.wreck);
  return { ok: true, wreck: result.wreck, scooped: result.scooped as Array<{ good: CommodityId; qty: number }> };
}

export function processDuePodRecoveries(
  state: SystemState,
  nowMs: number,
): Array<{ wreckId: string; captainId: string }> {
  const due: Array<{ wreckId: string; captainId: string }> = [];
  for (const [id, wreck] of state.wrecks) {
    if (!dueAutomatedRecovery(wreck, nowMs) || !wreck.escapePodCaptainId) continue;
    const next = transitionEscapePod(wreck, 'AUTOMATED_RECOVERY', nowMs);
    const complete = transitionEscapePod(next, 'COMPLETE', nowMs);
    state.wrecks.set(id, complete);
    due.push({ wreckId: id, captainId: wreck.escapePodCaptainId });
  }
  return due;
}

export function listWrecks(state: SystemState): WreckDebris[] {
  return [...state.wrecks.values()];
}

export function listWrecksInRouteArea(state: SystemState, routeArea: string): WreckDebris[] {
  return [...state.wrecks.values()].filter((w) => w.routeArea === routeArea);
}

export { deriveEncounterId, PHASE0_TUNING, RULESET_VERSION };
