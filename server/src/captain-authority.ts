import {
  RULESET_VERSION,
  PHASE0_TUNING,
  publicDisposition,
  activeBounty,
  clampScore,
  generateTravelSequence,
  globalTick,
  CommodityId,
  SHIP_TYPES,
  ESCAPE_POD_PRICE,
  fuelPurchaseCost,
  repairCost,
  shipPurchasePrice,
  shipTradeInValue,
  type TravelSequence,
  type RelationshipState,
  decayHostility,
  RulesetRng,
  fnv1a32,
  shouldTriggerPoliceContact,
  selectPoliceContactType,
  policeCombatantSnapshot,
  resolvePoliceRound,
  POLITICS,
  type PoliceContactType,
  type PolicePhase,
  type PoliceResponse,
  type CombatantSnapshot,
} from '@sto/ruleset-phase0-v1';
import { hashPayload } from './hash.js';
import type { MarketReservation } from './system-authority.js';
import { reservationRequestHash } from './system-authority.js';
import { applyPoliceRecord, emptyRelationship } from './settlement-effects.js';
import { combatantFromCaptain } from './encounter-authority.js';

export type CaptainLifecycle =
  | 'ACTIVE'
  | 'TRAVELLING'
  | 'ENCOUNTER_CLAIMED'
  | 'IN_ENCOUNTER'
  | 'SETTLING'
  | 'AWAITING_RECOVERY'
  | 'RECOVERING'
  | 'RETIRED'
  | 'DEAD';

export type TradeOpState =
  | 'RESERVED'
  | 'CAPTAIN_COMMITTED'
  | 'SYSTEM_COMMITTED'
  | 'PROJECTING_TO_D1'
  | 'COMPLETE';

export interface CargoLot {
  good: CommodityId;
  qty: number;
  avgCost: number;
}

export interface PoliceEncounterCrime {
  kind: string;
  policeDelta: number;
}

/** In-DO police patrol encounter (no Encounter DO — single captain vs fixed opponent). */
export interface PoliceEncounterState {
  policeEncounterId: string;
  contact: PoliceContactType;
  phase: PolicePhase;
  politicsId: number;
  policeSnapshot: CombatantSnapshot;
  systemId: string;
  routeArea: string;
  createdAt: number;
  actionDeadlineAt: number;
  pendingCrimes: PoliceEncounterCrime[];
}

export type CaptainOperationType =
  | 'trade'
  | 'travel_start'
  | 'travel_advance'
  | 'claim'
  | 'claim_release'
  | 'refuel'
  | 'repair'
  | 'ship_upgrade'
  | 'equipment'
  | 'retire'
  | 'recovery'
  | 'police';

export interface CaptainOperation {
  operationId: string;
  operationType: CaptainOperationType;
  state: TradeOpState | 'COMPLETE' | 'PENDING';
  requestHash: string;
  deltaHash: string;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface CaptainState {
  captainId: string;
  kind: 'human' | 'npc';
  handle: string;
  credits: number;
  bank: number;
  debt: number;
  systemId: string;
  shipTypeId: number;
  shipType: string;
  hull: number;
  maxHull: number;
  shields: number;
  fuel: number;
  cargoBays: number;
  cargo: Map<CommodityId, CargoLot>;
  policeRecord: number;
  combatProfile: number;
  tradeProfile: number;
  proxyMode: 'learned' | 'coward';
  hasEscapePod: boolean;
  recoveryDueAt: number | null;
  /** NPC-only direct relationship memory keyed by other captain id. */
  relationships: Map<string, RelationshipState>;
  lifecycle: CaptainLifecycle;
  activeTrip: TravelSequence | null;
  approachTick: number;
  activeEncounterId: string | null;
  claimExpiresAt: number | null;
  operations: Map<string, CaptainOperation>;
  pendingTrade: {
    operationId: string;
    state: TradeOpState;
    side: 'buy' | 'sell';
    good: CommodityId;
    quantity: number;
    lockedTotal: number;
    requestHash: string;
    systemId: string;
    projectionHash: string;
    unitPrices: number[];
  } | null;
  pendingDockOp: {
    operationId: string;
    operationType: CaptainOperationType;
    state: TradeOpState;
    requestHash: string;
    projectionHash: string;
    result: Record<string, unknown>;
  } | null;
  activePoliceEncounter: PoliceEncounterState | null;
  policeRngSeed: number;
  policeRngDrawPosition: number;
  pendingPoliceProjection: {
    operationId: string;
    encounterId: string;
    systemId: string;
    routeArea: string;
    resultHash: string;
    payloadJson: string;
    crimes: Array<{
      id: string;
      encounter_id: string;
      kind: string;
      actor_id: string;
      target_id: string | null;
      police_delta: number;
      created_at: number;
    }>;
    createdAt: number;
  } | null;
  updatedAt: number;
}

export interface SystemPort {
  reserveTrade(args: {
    operationId: string;
    captainId: string;
    good: CommodityId;
    side: 'buy' | 'sell';
    quantity: number;
    requestHash: string;
    nowMs: number;
  }): Promise<{ ok: true; reservation: MarketReservation } | { ok: false; error: string; code: string }>;

  promoteReservation(operationId: string, requestHash: string): Promise<{ ok: true; reservation: MarketReservation } | { ok: false; error: string; code: string }>;

  commitReservation(operationId: string, requestHash: string, nowMs: number): Promise<{ ok: true; reservation: MarketReservation } | { ok: false; error: string; code: string }>;

  getReservation(operationId: string): Promise<MarketReservation | null>;

  registerPresence(args: {
    captainId: string;
    routeArea: string;
    approachTick: number;
    occupancyStartedAt: number;
    occupancyEndsAt: number;
    travelGroupId?: string;
    matchable?: boolean;
  }): Promise<{ ok: true } | { ok: false; error: string; code: string }>;

  closePresence(captainId: string): Promise<void>;

  /** Destination-system politics for police-contact checks during travel. */
  getPolitics(): Promise<{ politicsId: number; strengthPolice: number }>;

  /** Wrecks currently in a specific approach-space segment. */
  listWrecksInRouteArea(routeArea: string): Promise<Array<{
    wreckId: string;
    routeArea: string;
    cargo: ReadonlyArray<{ good: string; qty: number }>;
    escapePodCaptainId: string | null;
    podState: string | null;
  }>>;
}

export interface ProjectionPort {
  projectCaptain(row: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  projectTrade(row: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  projectOperation(row: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  projectEncounter?(row: {
    encounter_id: string;
    system_id: string;
    route_area: string;
    result_hash: string;
    payload_json: string;
    created_at: number;
  }, crimes: Array<{
    id: string;
    encounter_id: string;
    kind: string;
    actor_id: string;
    target_id: string | null;
    police_delta: number;
    created_at: number;
  }>): Promise<{ ok: boolean; error?: string }>;
}

function shipById(id: number) {
  const ship = SHIP_TYPES[id];
  if (!ship) throw new RangeError(`Unknown ship type ${id}`);
  return ship;
}

export function createCaptainState(args: {
  captainId: string;
  kind: 'human' | 'npc';
  handle: string;
  systemId: string;
  credits?: number;
  nowMs: number;
  combatProfile?: number;
  tradeProfile?: number;
  hasEscapePod?: boolean;
  shipTypeId?: number;
}): CaptainState {
  const ship = shipById(args.shipTypeId ?? 1);
  return {
    captainId: args.captainId,
    kind: args.kind,
    handle: args.handle,
    credits: args.credits ?? 10_000,
    bank: 0,
    debt: 0,
    systemId: args.systemId,
    shipTypeId: ship.id,
    shipType: ship.name,
    hull: ship.hullStrength,
    maxHull: ship.hullStrength,
    shields: 0,
    fuel: ship.fuelTanks,
    cargoBays: ship.cargoBays,
    cargo: new Map(),
    policeRecord: 0,
    combatProfile: args.combatProfile ?? 0,
    tradeProfile: args.tradeProfile ?? 0,
    proxyMode: 'learned',
    hasEscapePod: args.hasEscapePod ?? false,
    recoveryDueAt: null,
    relationships: new Map(),
    lifecycle: 'ACTIVE',
    activeTrip: null,
    approachTick: 0,
    activeEncounterId: null,
    claimExpiresAt: null,
    operations: new Map(),
    pendingTrade: null,
    pendingDockOp: null,
    activePoliceEncounter: null,
    policeRngSeed: fnv1a32(`police:${args.captainId}`) || 1,
    policeRngDrawPosition: 0,
    pendingPoliceProjection: null,
    updatedAt: args.nowMs,
  };
}

function cargoUsed(state: CaptainState): number {
  let used = 0;
  for (const lot of state.cargo.values()) used += lot.qty;
  return used;
}

function economicallyLocked(state: CaptainState): boolean {
  if (state.pendingTrade !== null && state.pendingTrade.state !== 'COMPLETE') return true;
  if (state.pendingDockOp !== null && state.pendingDockOp.state !== 'COMPLETE') return true;
  return false;
}

function canTrade(state: CaptainState): boolean {
  return state.lifecycle === 'ACTIVE' && !economicallyLocked(state) && !state.activeEncounterId;
}

function canTravel(state: CaptainState): boolean {
  if (economicallyLocked(state)) return false;
  return state.lifecycle === 'ACTIVE' || state.lifecycle === 'TRAVELLING';
}

export type CaptainResult =
  | { ok: true; state: CaptainState; result: Record<string, unknown> }
  | { ok: false; error: string; code: string; state: CaptainState };

export async function executeTrade(
  state: CaptainState,
  system: SystemPort,
  projections: ProjectionPort,
  args: {
    operationId: string;
    good: CommodityId;
    side: 'buy' | 'sell';
    quantity: number;
    nowMs: number;
  },
): Promise<CaptainResult> {
  const request = {
    captainId: state.captainId,
    systemId: state.systemId,
    good: args.good,
    side: args.side,
    quantity: args.quantity,
  };
  const requestHash = reservationRequestHash(request);

  const existing = state.operations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return {
      ok: true,
      state,
      result: existing.result ?? { operationId: args.operationId, state: existing.state },
    };
  }

  if (!canTrade(state)) {
    return { ok: false, error: 'captain cannot trade now', code: 'LOCKED', state };
  }
  if (args.quantity <= 0) {
    return { ok: false, error: 'invalid quantity', code: 'REJECTED', state };
  }

  if (args.side === 'buy') {
    // funds checked after quote
  } else {
    const have = state.cargo.get(args.good)?.qty ?? 0;
    if (have < args.quantity) {
      return { ok: false, error: 'insufficient cargo', code: 'REJECTED', state };
    }
  }

  const reserved = await system.reserveTrade({
    operationId: args.operationId,
    captainId: state.captainId,
    good: args.good,
    side: args.side,
    quantity: args.quantity,
    requestHash,
    nowMs: args.nowMs,
  });
  if (!reserved.ok) {
    return { ok: false, error: reserved.error, code: reserved.code, state };
  }

  const reservation = reserved.reservation;
  if (args.side === 'buy') {
    if (state.credits < reservation.lockedTotal) {
      return { ok: false, error: 'insufficient credits', code: 'REJECTED', state };
    }
    if (cargoUsed(state) + args.quantity > state.cargoBays) {
      return { ok: false, error: 'insufficient cargo space', code: 'REJECTED', state };
    }
  }

  // Captain applies pending change
  if (args.side === 'buy') {
    state.credits -= reservation.lockedTotal;
    const prev = state.cargo.get(args.good);
    const qty = (prev?.qty ?? 0) + args.quantity;
    const avgCost = prev
      ? Math.trunc(((prev.avgCost * prev.qty) + reservation.lockedTotal) / qty)
      : Math.trunc(reservation.lockedTotal / args.quantity);
    state.cargo.set(args.good, { good: args.good, qty, avgCost });
  } else {
    state.credits += reservation.lockedTotal;
    const prev = state.cargo.get(args.good)!;
    const qty = prev.qty - args.quantity;
    if (qty <= 0) state.cargo.delete(args.good);
    else state.cargo.set(args.good, { ...prev, qty });
  }

  state.pendingTrade = {
    operationId: args.operationId,
    state: 'CAPTAIN_COMMITTED',
    side: args.side,
    good: args.good,
    quantity: args.quantity,
    lockedTotal: reservation.lockedTotal,
    requestHash,
    systemId: state.systemId,
    projectionHash: '',
    unitPrices: reservation.unitPrices,
  };

  const promoted = await system.promoteReservation(args.operationId, requestHash);
  if (!promoted.ok) {
    return { ok: false, error: promoted.error, code: promoted.code, state };
  }

  const committed = await system.commitReservation(args.operationId, requestHash, args.nowMs);
  if (!committed.ok) {
    // Remain locked; caller/alarm retries by operation_id — no rollback.
    const op: CaptainOperation = {
      operationId: args.operationId,
      operationType: 'trade',
      state: 'CAPTAIN_COMMITTED',
      requestHash,
      deltaHash: hashPayload({ credits: state.credits, cargo: [...state.cargo.values()] }),
      request,
      result: null,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
    };
    state.operations.set(args.operationId, op);
    return { ok: false, error: committed.error, code: 'RETRY', state };
  }

  state.pendingTrade.state = 'SYSTEM_COMMITTED';
  state.pendingTrade.state = 'PROJECTING_TO_D1';

  const projectionHash = hashPayload({
    operationId: args.operationId,
    ...request,
    total: reservation.lockedTotal,
  });
  state.pendingTrade.projectionHash = projectionHash;

  const projected = await flushTradeProjection(state, projections, args.nowMs);
  if (!projected.ok) {
    state.operations.set(args.operationId, {
      operationId: args.operationId,
      operationType: 'trade',
      state: 'PROJECTING_TO_D1',
      requestHash,
      deltaHash: projectionHash,
      request,
      result: null,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
    });
    return { ok: false, error: projected.error ?? 'projection failed', code: 'RETRY', state };
  }

  return completeTradeAfterProjection(state, args.operationId, requestHash, request, args.nowMs);
}

async function flushTradeProjection(
  state: CaptainState,
  projections: ProjectionPort,
  nowMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const pending = state.pendingTrade;
  if (!pending || pending.state !== 'PROJECTING_TO_D1') {
    return { ok: false, error: 'no pending trade projection' };
  }
  const tradeRow = {
    operation_id: pending.operationId,
    captain_id: state.captainId,
    system_id: pending.systemId,
    side: pending.side,
    good: pending.good,
    quantity: pending.quantity,
    total: pending.lockedTotal,
    projection_hash: pending.projectionHash,
    created_at: nowMs,
  };
  const tradeRes = await projections.projectTrade(tradeRow);
  if (!tradeRes.ok) return tradeRes;
  const opRes = await projections.projectOperation({
    operation_id: pending.operationId,
    operation_type: 'trade',
    projection_hash: pending.projectionHash,
    payload_json: JSON.stringify({
      request: {
        captainId: state.captainId,
        systemId: pending.systemId,
        good: pending.good,
        side: pending.side,
        quantity: pending.quantity,
      },
      total: pending.lockedTotal,
    }),
    created_at: nowMs,
  });
  if (!opRes.ok) return opRes;
  return projectCaptainView(state, projections, nowMs);
}

function completeTradeAfterProjection(
  state: CaptainState,
  operationId: string,
  requestHash: string,
  request: Record<string, unknown>,
  nowMs: number,
): CaptainResult {
  const pending = state.pendingTrade;
  if (!pending) {
    return { ok: false, error: 'missing pending trade', code: 'REJECTED', state };
  }
  const result = {
    operationId,
    state: 'COMPLETE',
    total: pending.lockedTotal,
    unitPrices: pending.unitPrices,
    credits: state.credits,
    rulesetVersion: RULESET_VERSION,
  };
  state.pendingTrade = null;
  state.operations.set(operationId, {
    operationId,
    operationType: 'trade',
    state: 'COMPLETE',
    requestHash,
    deltaHash: hashPayload(result),
    request,
    result,
    createdAt: nowMs,
    updatedAt: nowMs,
  });
  state.updatedAt = nowMs;
  return { ok: true, state, result };
}

/** Retry D1 projection for a trade stuck in PROJECTING_TO_D1 (alarm / restart). */
export async function retryTradeProjection(
  state: CaptainState,
  system: SystemPort,
  projections: ProjectionPort,
  args: { operationId: string; nowMs: number },
): Promise<CaptainResult> {
  const pending = state.pendingTrade;
  if (!pending || pending.operationId !== args.operationId) {
    const existing = state.operations.get(args.operationId);
    if (existing?.state === 'COMPLETE') {
      return { ok: true, state, result: existing.result ?? { operationId: args.operationId } };
    }
    return { ok: false, error: 'no pending trade for operation', code: 'REJECTED', state };
  }

  if (pending.state === 'CAPTAIN_COMMITTED') {
    const committed = await system.commitReservation(args.operationId, pending.requestHash, args.nowMs);
    if (!committed.ok) {
      return { ok: false, error: committed.error, code: 'RETRY', state };
    }
    pending.state = 'PROJECTING_TO_D1';
  }

  if (pending.state !== 'PROJECTING_TO_D1' && pending.state !== 'SYSTEM_COMMITTED') {
    return { ok: false, error: `unexpected pending state ${pending.state}`, code: 'REJECTED', state };
  }
  pending.state = 'PROJECTING_TO_D1';
  if (!pending.projectionHash) {
    pending.projectionHash = hashPayload({
      operationId: pending.operationId,
      captainId: state.captainId,
      systemId: pending.systemId,
      good: pending.good,
      side: pending.side,
      quantity: pending.quantity,
      total: pending.lockedTotal,
    });
  }

  const projected = await flushTradeProjection(state, projections, args.nowMs);
  if (!projected.ok) {
    return { ok: false, error: projected.error ?? 'projection failed', code: 'RETRY', state };
  }
  return completeTradeAfterProjection(
    state,
    pending.operationId,
    pending.requestHash,
    {
      captainId: state.captainId,
      systemId: pending.systemId,
      good: pending.good,
      side: pending.side,
      quantity: pending.quantity,
    },
    args.nowMs,
  );
}

export async function startTravel(
  state: CaptainState,
  system: SystemPort,
  projections: ProjectionPort,
  args: {
    operationId: string;
    destinationSystemId: string;
    seed: number;
    nowMs: number;
  },
): Promise<CaptainResult> {
  const request = {
    captainId: state.captainId,
    destinationSystemId: args.destinationSystemId,
    seed: args.seed,
  };
  const requestHash = hashPayload(request);
  const existing = state.operations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { operationId: args.operationId } };
  }

  if (!canTravel(state) || state.lifecycle !== 'ACTIVE') {
    return { ok: false, error: 'cannot start travel', code: 'LOCKED', state };
  }
  if (args.destinationSystemId === state.systemId) {
    return { ok: false, error: 'already there', code: 'REJECTED', state };
  }
  if (state.fuel <= 0) {
    return { ok: false, error: 'no fuel', code: 'REJECTED', state };
  }

  const trip = generateTravelSequence({
    tripId: args.operationId,
    seed: args.seed,
    destinationSystemId: args.destinationSystemId,
    routeArea: `${args.destinationSystemId}:approach`,
  });

  const occupancyEnds = args.nowMs + PHASE0_TUNING.travelWindowMs;
  const reg = await system.registerPresence({
    captainId: state.captainId,
    routeArea: trip.routeArea,
    approachTick: 0,
    occupancyStartedAt: args.nowMs,
    occupancyEndsAt: occupancyEnds,
    matchable: true,
  });
  if (!reg.ok) {
    return { ok: false, error: reg.error, code: reg.code, state };
  }

  state.fuel -= 1;
  state.activeTrip = trip;
  state.approachTick = 0;
  state.lifecycle = 'TRAVELLING';
  state.systemId = args.destinationSystemId; // hyperspace arrives at destination approach space ownership
  state.updatedAt = args.nowMs;

  const result = {
    operationId: args.operationId,
    trip,
    approachTick: 0,
    lifecycle: state.lifecycle,
  };
  state.operations.set(args.operationId, {
    operationId: args.operationId,
    operationType: 'travel_start',
    state: 'COMPLETE',
    requestHash,
    deltaHash: hashPayload(result),
    request,
    result,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  });
  await projectCaptainView(state, projections, args.nowMs);
  return { ok: true, state, result };
}

export async function advanceTravel(
  state: CaptainState,
  system: SystemPort,
  projections: ProjectionPort,
  args: { operationId: string; nowMs: number },
): Promise<CaptainResult> {
  const request = { captainId: state.captainId, tickFrom: state.approachTick };
  const requestHash = hashPayload({ ...request, operationId: args.operationId });
  const existing = state.operations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { operationId: args.operationId } };
  }

  if (state.lifecycle === 'ENCOUNTER_CLAIMED' || state.lifecycle === 'IN_ENCOUNTER') {
    return { ok: false, error: 'claimed for encounter', code: 'CLAIMED', state };
  }
  if (state.lifecycle !== 'TRAVELLING' || !state.activeTrip) {
    return { ok: false, error: 'not travelling', code: 'REJECTED', state };
  }
  if (economicallyLocked(state)) {
    return { ok: false, error: 'economically locked', code: 'LOCKED', state };
  }

  const nextTick = state.approachTick + 1;
  if (nextTick >= state.activeTrip.approachTicks) {
    await system.closePresence(state.captainId);
    state.approachTick = nextTick;
    state.activeTrip = null;
    state.lifecycle = 'ACTIVE';
    state.updatedAt = args.nowMs;
    const result = { operationId: args.operationId, docked: true, systemId: state.systemId };
    state.operations.set(args.operationId, {
      operationId: args.operationId,
      operationType: 'travel_advance',
      state: 'COMPLETE',
      requestHash,
      deltaHash: hashPayload(result),
      request,
      result,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
    });
    await projectCaptainView(state, projections, args.nowMs);
    return { ok: true, state, result };
  }

  state.approachTick = nextTick;

  // Police contact check (design § Police encounters) — seed + draw position always advance.
  const politics = await system.getPolitics();
  const strengthPolice = politics.strengthPolice
    ?? POLITICS[politics.politicsId]?.strengthPolice
    ?? 0;
  const policeRng = new RulesetRng(state.policeRngSeed, state.policeRngDrawPosition);
  const triggered = shouldTriggerPoliceContact(state.policeRecord, strengthPolice, policeRng);
  let policeContact: PoliceContactType | null = null;
  let policeSnapshot: CombatantSnapshot | null = null;
  if (triggered) {
    policeContact = selectPoliceContactType(state.policeRecord, strengthPolice, policeRng);
    if (policeContact !== 'PASS') {
      policeSnapshot = policeCombatantSnapshot(strengthPolice, state.policeRecord, policeRng);
    }
  }
  state.policeRngDrawPosition = policeRng.drawPosition();

  if (policeContact && policeContact !== 'PASS' && policeSnapshot) {
    await system.closePresence(state.captainId);
    const policeEncounterId = `police-${state.captainId}-${args.nowMs}`;
    state.activePoliceEncounter = {
      policeEncounterId,
      contact: policeContact,
      phase: 'CONTACT',
      politicsId: politics.politicsId,
      policeSnapshot,
      systemId: state.systemId,
      routeArea: state.activeTrip.routeArea,
      createdAt: args.nowMs,
      actionDeadlineAt: args.nowMs + PHASE0_TUNING.encounterClaimTimeoutMs,
      pendingCrimes: [],
    };
    state.lifecycle = 'IN_ENCOUNTER';
    state.updatedAt = args.nowMs;
    const result = {
      operationId: args.operationId,
      approachTick: nextTick,
      globalTick: globalTick(args.nowMs),
      routeArea: state.activeTrip.routeArea,
      remaining: state.activeTrip.approachTicks - nextTick,
      policeEncounterId,
      policeContact,
      lifecycle: state.lifecycle,
    };
    state.operations.set(args.operationId, {
      operationId: args.operationId,
      operationType: 'travel_advance',
      state: 'COMPLETE',
      requestHash,
      deltaHash: hashPayload(result),
      request,
      result,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
    });
    await projectCaptainView(state, projections, args.nowMs);
    return { ok: true, state, result };
  }

  const occupancyEnds = args.nowMs + PHASE0_TUNING.travelWindowMs;
  const reg = await system.registerPresence({
    captainId: state.captainId,
    routeArea: state.activeTrip.routeArea,
    approachTick: nextTick,
    occupancyStartedAt: args.nowMs,
    occupancyEndsAt: occupancyEnds,
    matchable: true,
  });
  if (!reg.ok) {
    return { ok: false, error: reg.error, code: reg.code, state };
  }

  const routeArea = state.activeTrip.routeArea;
  const wrecksHere = await system.listWrecksInRouteArea(routeArea);
  const sighted = wrecksHere.find(
    (w) => w.cargo.length > 0 || w.podState === 'AVAILABLE',
  );
  const wreckSighted = sighted
    ? {
      wreckId: sighted.wreckId,
      hasEscapePod: sighted.escapePodCaptainId !== null,
      podState: sighted.podState,
    }
    : null;

  const result = {
    operationId: args.operationId,
    approachTick: nextTick,
    globalTick: globalTick(args.nowMs),
    routeArea,
    remaining: state.activeTrip.approachTicks - nextTick,
    ...(wreckSighted ? { wreckSighted } : {}),
  };
  state.operations.set(args.operationId, {
    operationId: args.operationId,
    operationType: 'travel_advance',
    state: 'COMPLETE',
    requestHash,
    deltaHash: hashPayload(result),
    request,
    result,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  });
  state.updatedAt = args.nowMs;
  await projectCaptainView(state, projections, args.nowMs);
  return { ok: true, state, result };
}

export function claimEncounter(
  state: CaptainState,
  args: { encounterId: string; routeArea: string; nowMs: number; expiresAt: number },
): CaptainResult {
  if (state.activeEncounterId && state.activeEncounterId !== args.encounterId) {
    return { ok: false, error: 'already claimed', code: 'CLAIMED', state };
  }
  if (state.activeEncounterId === args.encounterId) {
    return { ok: true, state, result: { accepted: true, encounterId: args.encounterId } };
  }
  if (state.lifecycle !== 'TRAVELLING' || !state.activeTrip) {
    return { ok: false, error: 'not travelling', code: 'REJECTED', state };
  }
  if (state.activeTrip.routeArea !== args.routeArea) {
    return { ok: false, error: 'wrong route area', code: 'REJECTED', state };
  }
  if (economicallyLocked(state)) {
    return { ok: false, error: 'economically locked', code: 'LOCKED', state };
  }

  state.activeEncounterId = args.encounterId;
  state.claimExpiresAt = args.expiresAt;
  state.lifecycle = 'ENCOUNTER_CLAIMED';
  state.updatedAt = args.nowMs;
  return { ok: true, state, result: { accepted: true, encounterId: args.encounterId } };
}

export function releaseEncounterClaim(
  state: CaptainState,
  args: { encounterId: string; nowMs: number },
): CaptainResult {
  if (state.activeEncounterId !== args.encounterId) {
    return { ok: true, state, result: { released: false, reason: 'not_held' } };
  }
  if (state.lifecycle === 'IN_ENCOUNTER' || state.lifecycle === 'SETTLING') {
    return { ok: false, error: 'encounter bound', code: 'BOUND', state };
  }
  state.activeEncounterId = null;
  state.claimExpiresAt = null;
  state.lifecycle = 'TRAVELLING';
  state.updatedAt = args.nowMs;
  return { ok: true, state, result: { released: true, encounterId: args.encounterId } };
}

export function bindEncounter(
  state: CaptainState,
  args: { encounterId: string; nowMs: number },
): CaptainResult {
  if (state.activeEncounterId !== args.encounterId) {
    return { ok: false, error: 'encounter not claimed', code: 'REJECTED', state };
  }
  if (state.lifecycle !== 'ENCOUNTER_CLAIMED' && state.lifecycle !== 'IN_ENCOUNTER') {
    return { ok: false, error: 'not claimed', code: 'REJECTED', state };
  }
  state.lifecycle = 'IN_ENCOUNTER';
  state.claimExpiresAt = null;
  state.updatedAt = args.nowMs;
  return { ok: true, state, result: { bound: true, encounterId: args.encounterId } };
}

export function applyEncounterSettlement(
  state: CaptainState,
  args: {
    encounterId: string;
    deltaHash: string;
    credits: number;
    cargo: Array<{ good: CommodityId; qty: number }>;
    hull: number;
    shields: number[];
    lifecycleAfter: CaptainLifecycle;
    nowMs: number;
    combatProfileAfter?: number;
    tradeProfileAfter?: number;
  },
): CaptainResult {
  const opId = `settle-${args.encounterId}`;
  const existing = state.operations.get(opId);
  if (existing) {
    if (existing.deltaHash !== args.deltaHash) {
      return { ok: false, error: 'settlement delta hash mismatch', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { applied: true } };
  }
  if (state.activeEncounterId !== args.encounterId && state.lifecycle !== 'SETTLING') {
    // allow if already settling same encounter
    if (state.lifecycle !== 'IN_ENCOUNTER' && state.lifecycle !== 'ENCOUNTER_CLAIMED') {
      return { ok: false, error: 'not in this encounter', code: 'REJECTED', state };
    }
  }

  state.lifecycle = 'SETTLING';
  state.credits = args.credits;
  state.hull = args.hull;
  state.shields = args.shields[0] ?? 0;
  for (const lot of args.cargo) {
    if (lot.qty > 0) {
      const prev = state.cargo.get(lot.good);
      state.cargo.set(lot.good, {
        good: lot.good,
        qty: lot.qty,
        avgCost: prev?.avgCost ?? 0,
      });
    }
  }
  // Drop goods no longer present
  for (const good of [...state.cargo.keys()]) {
    if (!args.cargo.some((c) => c.good === good && c.qty > 0)) {
      state.cargo.delete(good);
    }
  }
  if (args.combatProfileAfter !== undefined) {
    state.combatProfile = clampScore(args.combatProfileAfter);
  }
  if (args.tradeProfileAfter !== undefined) {
    state.tradeProfile = clampScore(args.tradeProfileAfter);
  }
  if (args.lifecycleAfter === 'AWAITING_RECOVERY') {
    beginEscapePodRecovery(state, {
      encounterId: args.encounterId,
      recoveryDueAt: args.nowMs + PHASE0_TUNING.escapePodRecoveryMs,
      nowMs: args.nowMs,
    });
  } else if (args.lifecycleAfter === 'DEAD') {
    state.lifecycle = 'DEAD';
    state.activeEncounterId = null;
    state.activeTrip = null;
  } else {
    state.lifecycle = args.lifecycleAfter;
    if (args.lifecycleAfter === 'TRAVELLING' || args.lifecycleAfter === 'ACTIVE') {
      state.activeEncounterId = null;
      state.claimExpiresAt = null;
    }
  }
  state.updatedAt = args.nowMs;
  const result = { applied: true, encounterId: args.encounterId, lifecycle: state.lifecycle };
  state.operations.set(opId, {
    operationId: opId,
    operationType: 'claim',
    state: 'COMPLETE',
    requestHash: args.deltaHash,
    deltaHash: args.deltaHash,
    request: { encounterId: args.encounterId },
    result,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  });
  return { ok: true, state, result };
}

export function applyPoliceAndBounty(
  state: CaptainState,
  args: {
    operationId: string;
    policeDelta: number;
    creditsAward: number;
    nowMs: number;
    postRecoveryNeutral?: boolean;
  },
): CaptainResult {
  const existing = state.operations.get(args.operationId);
  const requestHash = hashPayload(args);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { applied: true } };
  }
  state.policeRecord = applyPoliceRecord(
    state.policeRecord,
    args.policeDelta,
    args.postRecoveryNeutral ?? false,
  );
  state.credits += args.creditsAward;
  state.updatedAt = args.nowMs;
  const result = {
    policeRecord: state.policeRecord,
    activeBounty: activeBounty(state.policeRecord),
    credits: state.credits,
  };
  state.operations.set(args.operationId, {
    operationId: args.operationId,
    operationType: 'claim',
    state: 'COMPLETE',
    requestHash,
    deltaHash: hashPayload(result),
    request: { ...args },
    result,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  });
  return { ok: true, state, result };
}

function crimeKindFromPoliceEvents(events: readonly string[], policePenalty: number): string {
  if (events.includes('police_destroyed')) return 'destroy_police';
  if (events.includes('attack_police')) return 'attack_police';
  if (events.some((e) => e.startsWith('flee'))) return 'flee_inspection';
  if (policePenalty === PHASE0_TUNING.crimeDestroyPolice) return 'destroy_police';
  if (policePenalty === PHASE0_TUNING.crimeAttackPolice) return 'attack_police';
  return 'flee_inspection';
}

function captainCombatantSnapshot(state: CaptainState): CombatantSnapshot {
  return combatantFromCaptain({
    captainId: state.captainId,
    hull: state.hull,
    maxHull: state.maxHull,
    shields: state.shields > 0 ? [state.shields] : [],
    credits: state.credits,
    cargo: [...state.cargo.values()].map((c) => ({ good: c.good, qty: c.qty })),
    combatProfile: state.combatProfile,
    tradeProfile: state.tradeProfile,
    policeRecord: state.policeRecord,
    hasEscapePod: state.hasEscapePod,
  });
}

/**
 * Player response during an active police patrol encounter (Captain DO only).
 */
export async function respondPoliceEncounter(
  state: CaptainState,
  projections: ProjectionPort,
  args: {
    operationId: string;
    response: PoliceResponse;
    nowMs: number;
  },
): Promise<CaptainResult> {
  const request = { response: args.response };
  const requestHash = hashPayload({ ...request, operationId: args.operationId });
  const existing = state.operations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { operationId: args.operationId } };
  }

  const encounter = state.activePoliceEncounter;
  if (!encounter || state.lifecycle !== 'IN_ENCOUNTER') {
    return { ok: false, error: 'no active police encounter', code: 'REJECTED', state };
  }

  const rng = new RulesetRng(state.policeRngSeed, state.policeRngDrawPosition);
  const captainSnap = captainCombatantSnapshot(state);
  const round = resolvePoliceRound({
    contact: encounter.contact,
    phase: encounter.phase,
    captain: captainSnap,
    police: encounter.policeSnapshot,
    response: args.response,
    politicsId: encounter.politicsId,
    rng,
  });
  state.policeRngDrawPosition = rng.drawPosition();

  // Confiscation
  for (const lot of round.confiscated) {
    state.cargo.delete(lot.good);
  }
  // Fine — credits may go negative (same convention as other economic mutations).
  if (round.fine > 0) {
    state.credits -= round.fine;
  }
  // Police record penalty from resolvePoliceRound is a positive severity magnitude.
  if (round.policePenalty !== 0) {
    state.policeRecord = applyPoliceRecord(state.policeRecord, -round.policePenalty);
    encounter.pendingCrimes.push({
      kind: crimeKindFromPoliceEvents(round.events, round.policePenalty),
      policeDelta: -round.policePenalty,
    });
  }

  // Combat damage
  if (round.attack) {
    if (round.attack.defenderId === state.captainId) {
      state.hull = round.attack.hullAfter;
      state.shields = round.attack.shieldsAfter[0] ?? 0;
    } else if (round.attack.defenderId === encounter.policeSnapshot.captainId) {
      encounter.policeSnapshot = {
        ...encounter.policeSnapshot,
        hull: round.attack.hullAfter,
        shields: [...round.attack.shieldsAfter],
      };
    }
  }

  let destroyedSelf = false;
  if (round.attack?.destroyed && round.attack.defenderId === state.captainId) {
    destroyedSelf = true;
    if (state.hasEscapePod) {
      beginEscapePodRecovery(state, {
        encounterId: encounter.policeEncounterId,
        recoveryDueAt: args.nowMs + PHASE0_TUNING.escapePodRecoveryMs,
        nowMs: args.nowMs,
      });
    } else {
      state.lifecycle = 'DEAD';
      state.activeTrip = null;
      state.activeEncounterId = null;
    }
  }

  // History projection when the encounter ends (including captain destruction).
  let projectionNeeded = false;
  if (round.ended) {
    const crimes = encounter.pendingCrimes.map((c, i) => ({
      id: `${encounter.policeEncounterId}:${c.kind}:${i}`,
      encounter_id: encounter.policeEncounterId,
      kind: c.kind,
      actor_id: state.captainId,
      target_id: 'police',
      police_delta: c.policeDelta,
      created_at: args.nowMs,
    }));
    const resultHash = hashPayload({
      endReason: round.endReason,
      events: round.events,
      fine: round.fine,
      policePenalty: round.policePenalty,
      confiscated: round.confiscated,
      lifecycle: state.lifecycle,
    });
    const payloadJson = JSON.stringify({
      contact: encounter.contact,
      endReason: round.endReason,
      events: round.events,
      fine: round.fine,
      policeRecord: state.policeRecord,
    });
    state.pendingPoliceProjection = {
      operationId: args.operationId,
      encounterId: encounter.policeEncounterId,
      systemId: encounter.systemId,
      routeArea: encounter.routeArea,
      resultHash,
      payloadJson,
      crimes,
      createdAt: args.nowMs,
    };
    projectionNeeded = true;
    state.activePoliceEncounter = null;
    if (!destroyedSelf && state.lifecycle === 'IN_ENCOUNTER') {
      if (state.activeTrip && state.approachTick < state.activeTrip.approachTicks) {
        state.lifecycle = 'TRAVELLING';
      } else {
        state.lifecycle = 'ACTIVE';
        state.activeTrip = null;
      }
    }
  } else {
    encounter.phase = round.phaseAfter;
    state.lifecycle = 'IN_ENCOUNTER';
  }

  state.updatedAt = args.nowMs;
  const result: Record<string, unknown> = {
    operationId: args.operationId,
    ended: round.ended,
    endReason: round.endReason,
    phaseAfter: round.phaseAfter,
    fine: round.fine,
    confiscated: round.confiscated,
    policePenalty: round.policePenalty,
    fleeSuccess: round.fleeSuccess,
    attack: round.attack,
    events: round.events,
    lifecycle: state.lifecycle,
    policeRecord: state.policeRecord,
    credits: state.credits,
    hull: state.hull,
    shields: state.shields,
  };
  state.operations.set(args.operationId, {
    operationId: args.operationId,
    operationType: 'police',
    state: 'COMPLETE',
    requestHash,
    deltaHash: hashPayload(result),
    request: { ...request },
    result,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  });

  if (projectionNeeded && state.pendingPoliceProjection && projections.projectEncounter) {
    const pending = state.pendingPoliceProjection;
    const projected = await projections.projectEncounter({
      encounter_id: pending.encounterId,
      system_id: pending.systemId,
      route_area: pending.routeArea,
      result_hash: pending.resultHash,
      payload_json: pending.payloadJson,
      created_at: pending.createdAt,
    }, pending.crimes);
    if (projected.ok) {
      state.pendingPoliceProjection = null;
    } else {
      return { ok: false, error: projected.error ?? 'projection failed', code: 'RETRY', state };
    }
  }

  await projectCaptainView(state, projections, args.nowMs);
  return { ok: true, state, result };
}

export async function retryPoliceProjection(
  state: CaptainState,
  projections: ProjectionPort,
  args: { operationId: string; nowMs: number },
): Promise<CaptainResult> {
  const pending = state.pendingPoliceProjection;
  if (!pending || pending.operationId !== args.operationId) {
    return { ok: true, state, result: { projected: true, skipped: true } };
  }
  if (!projections.projectEncounter) {
    return { ok: false, error: 'no encounter projection port', code: 'RETRY', state };
  }
  const projected = await projections.projectEncounter({
    encounter_id: pending.encounterId,
    system_id: pending.systemId,
    route_area: pending.routeArea,
    result_hash: pending.resultHash,
    payload_json: pending.payloadJson,
    created_at: pending.createdAt,
  }, pending.crimes);
  if (!projected.ok) {
    return { ok: false, error: projected.error ?? 'projection failed', code: 'RETRY', state };
  }
  state.pendingPoliceProjection = null;
  state.updatedAt = args.nowMs;
  return { ok: true, state, result: { projected: true } };
}

export function upsertRelationship(
  state: CaptainState,
  next: RelationshipState,
  nowMs: number,
): CaptainResult {
  if (state.kind !== 'npc') {
    return { ok: false, error: 'only NPCs store numeric relationships', code: 'REJECTED', state };
  }
  state.relationships.set(next.otherCaptainId, next);
  state.updatedAt = nowMs;
  return { ok: true, state, result: { hostilityScore: next.hostilityScore, facts: next.facts } };
}

export function getRelationship(state: CaptainState, otherCaptainId: string, nowMs: number): RelationshipState {
  const prior = state.relationships.get(otherCaptainId);
  if (!prior) return emptyRelationship(otherCaptainId, nowMs);
  const decayed = decayHostility(prior, nowMs);
  if (decayed !== prior) state.relationships.set(otherCaptainId, decayed);
  return decayed;
}

export function retireCaptain(state: CaptainState, args: { operationId: string; nowMs: number }): CaptainResult {
  const requestHash = hashPayload({ captainId: state.captainId, op: 'retire' });
  const existing = state.operations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { retired: true } };
  }
  if (
    state.lifecycle !== 'ACTIVE'
    || state.pendingTrade
    || state.activeEncounterId
  ) {
    return { ok: false, error: 'cannot retire now', code: 'LOCKED', state };
  }
  state.lifecycle = 'RETIRED';
  state.updatedAt = args.nowMs;
  const result = { retired: true };
  state.operations.set(args.operationId, {
    operationId: args.operationId,
    operationType: 'claim',
    state: 'COMPLETE',
    requestHash,
    deltaHash: hashPayload(result),
    request: { retire: true },
    result,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  });
  return { ok: true, state, result };
}

/** Begin AWAITING_RECOVERY after destruction with escape pod. */
export function beginEscapePodRecovery(
  state: CaptainState,
  args: { encounterId: string; recoveryDueAt: number; nowMs: number },
): CaptainResult {
  const opId = `pod-${args.encounterId}`;
  const existing = state.operations.get(opId);
  if (existing) return { ok: true, state, result: existing.result ?? { awaiting: true } };
  state.lifecycle = 'AWAITING_RECOVERY';
  state.recoveryDueAt = args.recoveryDueAt;
  const flea = shipById(0);
  state.shipTypeId = flea.id;
  state.shipType = flea.name;
  state.hull = flea.hullStrength;
  state.maxHull = flea.hullStrength;
  state.shields = 0;
  state.fuel = flea.fuelTanks;
  state.cargoBays = flea.cargoBays;
  state.cargo.clear();
  state.activeTrip = null;
  state.activeEncounterId = null;
  state.updatedAt = args.nowMs;
  const result = { awaiting: true, recoveryDueAt: args.recoveryDueAt };
  state.operations.set(opId, {
    operationId: opId,
    operationType: 'claim',
    state: 'COMPLETE',
    requestHash: hashPayload(args),
    deltaHash: hashPayload(result),
    request: { ...args },
    result,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  });
  return { ok: true, state, result };
}

/**
 * Complete rescue or automated clone recovery → RECOVERING then ACTIVE with basic ship
 * at a safe system (design §9.1).
 */
export function completeRecovery(
  state: CaptainState,
  args: {
    operationId: string;
    safeSystemId: string;
    source: 'rescue' | 'automated';
    nowMs: number;
    /** Wanted captains reset to -30 when bounty was satisfied via destruction. */
    resetPoliceToNeutralBoundary?: boolean;
  },
): CaptainResult {
  const requestHash = hashPayload(args);
  const existing = state.operations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { recovered: true } };
  }
  if (state.lifecycle !== 'AWAITING_RECOVERY' && state.lifecycle !== 'RECOVERING') {
    return { ok: false, error: 'not awaiting recovery', code: 'REJECTED', state };
  }
  state.lifecycle = 'RECOVERING';
  state.systemId = args.safeSystemId;
  const flea = shipById(0);
  state.shipTypeId = flea.id;
  state.shipType = flea.name;
  state.hull = flea.hullStrength;
  state.maxHull = flea.hullStrength;
  state.shields = 0;
  state.fuel = flea.fuelTanks;
  state.cargoBays = flea.cargoBays;
  state.cargo.clear();
  state.hasEscapePod = false; // package consumed; must re-acquire
  state.recoveryDueAt = null;
  if (args.resetPoliceToNeutralBoundary) {
    state.policeRecord = -30;
  }
  state.lifecycle = 'ACTIVE';
  state.updatedAt = args.nowMs;
  const result = { recovered: true, source: args.source, systemId: state.systemId };
  state.operations.set(args.operationId, {
    operationId: args.operationId,
    operationType: 'claim',
    state: 'COMPLETE',
    requestHash,
    deltaHash: hashPayload(result),
    request: { ...args },
    result,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  });
  return { ok: true, state, result };
}

export function forceApproachForPlaytest(
  state: CaptainState,
  args: {
    destinationSystemId: string;
    routeArea: string;
    nowMs: number;
  },
): CaptainResult {
  state.systemId = args.destinationSystemId;
  state.lifecycle = 'TRAVELLING';
  state.activeTrip = {
    tripId: `force-${args.nowMs}`,
    seed: args.nowMs,
    rulesetVersion: RULESET_VERSION,
    approachTicks: 15,
    routeArea: args.routeArea,
    destinationSystemId: args.destinationSystemId,
  };
  state.approachTick = 1;
  state.activeEncounterId = null;
  state.claimExpiresAt = null;
  state.updatedAt = args.nowMs;
  return {
    ok: true,
    state,
    result: { forced: true, routeArea: args.routeArea },
  };
}

export function installEscapePod(state: CaptainState, args: { operationId: string; nowMs: number; cost?: number }): CaptainResult {
  const cost = args.cost ?? ESCAPE_POD_PRICE;
  const requestHash = hashPayload({ installEscapePod: true, cost });
  const existing = state.operations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { installed: true } };
  }
  if (state.lifecycle !== 'ACTIVE' || economicallyLocked(state)) {
    return { ok: false, error: 'cannot buy equipment now', code: 'LOCKED', state };
  }
  if (state.hasEscapePod) {
    return { ok: false, error: 'already installed', code: 'REJECTED', state };
  }
  if (state.credits < cost) {
    return { ok: false, error: 'insufficient credits', code: 'REJECTED', state };
  }
  state.credits -= cost;
  state.hasEscapePod = true;
  state.updatedAt = args.nowMs;
  const result = { installed: true, credits: state.credits, cost };
  state.operations.set(args.operationId, {
    operationId: args.operationId,
    operationType: 'equipment',
    state: 'COMPLETE',
    requestHash,
    deltaHash: hashPayload(result),
    request: { cost },
    result,
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  });
  return { ok: true, state, result };
}

/** Refuel at dock using baseline fuelPurchaseCost (design §12.1 / §14.5). */
export async function refuelShip(
  state: CaptainState,
  projections: ProjectionPort,
  args: { operationId: string; units?: number; nowMs: number },
): Promise<CaptainResult> {
  const ship = shipById(state.shipTypeId);
  const want = args.units ?? (ship.fuelTanks - state.fuel);
  const units = Math.max(0, Math.min(want, ship.fuelTanks - state.fuel));
  const cost = fuelPurchaseCost(state.shipTypeId, state.fuel, units);
  const request = { captainId: state.captainId, units, cost };
  const requestHash = hashPayload(request);
  const existing = state.operations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { refueled: true } };
  }
  if (state.lifecycle !== 'ACTIVE' || economicallyLocked(state) || state.activeEncounterId) {
    return { ok: false, error: 'cannot refuel now', code: 'LOCKED', state };
  }
  if (units <= 0) {
    return { ok: false, error: 'tanks full', code: 'REJECTED', state };
  }
  if (state.credits < cost) {
    return { ok: false, error: 'insufficient credits', code: 'REJECTED', state };
  }

  state.credits -= cost;
  state.fuel += units;
  state.updatedAt = args.nowMs;
  const result = { refueled: true, units, cost, fuel: state.fuel, credits: state.credits };
  const projectionHash = hashPayload({ operationId: args.operationId, ...request, result });
  state.pendingDockOp = {
    operationId: args.operationId,
    operationType: 'refuel',
    state: 'PROJECTING_TO_D1',
    requestHash,
    projectionHash,
    result,
  };
  const projected = await flushDockProjection(state, projections, args.nowMs);
  if (!projected.ok) {
    state.operations.set(args.operationId, {
      operationId: args.operationId,
      operationType: 'refuel',
      state: 'PROJECTING_TO_D1',
      requestHash,
      deltaHash: projectionHash,
      request,
      result: null,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
    });
    return { ok: false, error: projected.error ?? 'projection failed', code: 'RETRY', state };
  }
  return completeDockAfterProjection(state, args.operationId, 'refuel', requestHash, request, args.nowMs);
}

/** Repair hull at dock using baseline repairCost. */
export async function repairShip(
  state: CaptainState,
  projections: ProjectionPort,
  args: { operationId: string; hullPoints?: number; nowMs: number },
): Promise<CaptainResult> {
  const want = args.hullPoints ?? (state.maxHull - state.hull);
  const units = Math.max(0, Math.min(want, state.maxHull - state.hull));
  const cost = repairCost(state.shipTypeId, state.hull, units);
  const request = { captainId: state.captainId, hullPoints: units, cost };
  const requestHash = hashPayload(request);
  const existing = state.operations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { repaired: true } };
  }
  if (state.lifecycle !== 'ACTIVE' || economicallyLocked(state) || state.activeEncounterId) {
    return { ok: false, error: 'cannot repair now', code: 'LOCKED', state };
  }
  if (units <= 0) {
    return { ok: false, error: 'hull full', code: 'REJECTED', state };
  }
  if (state.credits < cost) {
    return { ok: false, error: 'insufficient credits', code: 'REJECTED', state };
  }

  state.credits -= cost;
  state.hull += units;
  state.updatedAt = args.nowMs;
  const result = { repaired: true, hullPoints: units, cost, hull: state.hull, credits: state.credits };
  const projectionHash = hashPayload({ operationId: args.operationId, ...request, result });
  state.pendingDockOp = {
    operationId: args.operationId,
    operationType: 'repair',
    state: 'PROJECTING_TO_D1',
    requestHash,
    projectionHash,
    result,
  };
  const projected = await flushDockProjection(state, projections, args.nowMs);
  if (!projected.ok) {
    state.operations.set(args.operationId, {
      operationId: args.operationId,
      operationType: 'repair',
      state: 'PROJECTING_TO_D1',
      requestHash,
      deltaHash: projectionHash,
      request,
      result: null,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
    });
    return { ok: false, error: projected.error ?? 'projection failed', code: 'RETRY', state };
  }
  return completeDockAfterProjection(state, args.operationId, 'repair', requestHash, request, args.nowMs);
}

/**
 * Buy a better purchasable ship at dock (baseline shipPurchasePrice + trade-in).
 * Tech-level gate uses systemTechLevel when provided.
 */
export async function upgradeShip(
  state: CaptainState,
  projections: ProjectionPort,
  args: {
    operationId: string;
    shipTypeId: number;
    nowMs: number;
    systemTechLevel?: number;
    traderSkill?: number;
  },
): Promise<CaptainResult> {
  const next = shipById(args.shipTypeId);
  const tech = args.systemTechLevel ?? 5;
  const traderSkill = args.traderSkill ?? 0;
  if (!next.purchasable || next.minTechLevel > tech) {
    return { ok: false, error: 'ship not available', code: 'REJECTED', state };
  }
  if (args.shipTypeId === state.shipTypeId) {
    return { ok: false, error: 'already own this ship', code: 'REJECTED', state };
  }
  if (cargoUsed(state) > next.cargoBays) {
    return { ok: false, error: 'cargo exceeds new ship capacity', code: 'REJECTED', state };
  }

  const purchase = shipPurchasePrice(next.basePrice, traderSkill);
  const tradeIn = shipTradeInValue(
    state.shipTypeId,
    state.hull,
    state.fuel,
    { weapons: [], shields: [], gadgets: [] },
  );
  const netCost = Math.max(0, purchase - tradeIn);
  const request = {
    captainId: state.captainId,
    shipTypeId: args.shipTypeId,
    purchase,
    tradeIn,
    netCost,
  };
  const requestHash = hashPayload(request);
  const existing = state.operations.get(args.operationId);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: 'operation_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, result: existing.result ?? { upgraded: true } };
  }
  if (state.lifecycle !== 'ACTIVE' || economicallyLocked(state) || state.activeEncounterId) {
    return { ok: false, error: 'cannot upgrade now', code: 'LOCKED', state };
  }
  if (state.credits < netCost) {
    return { ok: false, error: 'insufficient credits', code: 'REJECTED', state };
  }

  state.credits -= netCost;
  state.shipTypeId = next.id;
  state.shipType = next.name;
  state.maxHull = next.hullStrength;
  state.hull = next.hullStrength;
  state.fuel = next.fuelTanks;
  state.cargoBays = next.cargoBays;
  state.shields = 0;
  state.hasEscapePod = false; // equipment lost with ship swap (design §9.3)
  state.updatedAt = args.nowMs;

  const result = {
    upgraded: true,
    shipType: next.name,
    shipTypeId: next.id,
    netCost,
    credits: state.credits,
  };
  const projectionHash = hashPayload({ operationId: args.operationId, ...request, result });
  state.pendingDockOp = {
    operationId: args.operationId,
    operationType: 'ship_upgrade',
    state: 'PROJECTING_TO_D1',
    requestHash,
    projectionHash,
    result,
  };
  const projected = await flushDockProjection(state, projections, args.nowMs);
  if (!projected.ok) {
    state.operations.set(args.operationId, {
      operationId: args.operationId,
      operationType: 'ship_upgrade',
      state: 'PROJECTING_TO_D1',
      requestHash,
      deltaHash: projectionHash,
      request,
      result: null,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
    });
    return { ok: false, error: projected.error ?? 'projection failed', code: 'RETRY', state };
  }
  return completeDockAfterProjection(state, args.operationId, 'ship_upgrade', requestHash, request, args.nowMs);
}

export async function retryDockProjection(
  state: CaptainState,
  projections: ProjectionPort,
  args: { operationId: string; nowMs: number },
): Promise<CaptainResult> {
  const pending = state.pendingDockOp;
  if (!pending || pending.operationId !== args.operationId) {
    const existing = state.operations.get(args.operationId);
    if (existing?.state === 'COMPLETE') {
      return { ok: true, state, result: existing.result ?? { operationId: args.operationId } };
    }
    return { ok: false, error: 'no pending dock op', code: 'REJECTED', state };
  }
  const projected = await flushDockProjection(state, projections, args.nowMs);
  if (!projected.ok) {
    return { ok: false, error: projected.error ?? 'projection failed', code: 'RETRY', state };
  }
  return completeDockAfterProjection(
    state,
    pending.operationId,
    pending.operationType,
    pending.requestHash,
    { retry: true },
    args.nowMs,
  );
}

async function flushDockProjection(
  state: CaptainState,
  projections: ProjectionPort,
  nowMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const pending = state.pendingDockOp;
  if (!pending || pending.state !== 'PROJECTING_TO_D1') {
    return { ok: false, error: 'no pending dock projection' };
  }
  const opRes = await projections.projectOperation({
    operation_id: pending.operationId,
    operation_type: pending.operationType,
    projection_hash: pending.projectionHash,
    payload_json: JSON.stringify(pending.result),
    created_at: nowMs,
  });
  if (!opRes.ok) return opRes;
  return projectCaptainView(state, projections, nowMs);
}

function completeDockAfterProjection(
  state: CaptainState,
  operationId: string,
  operationType: CaptainOperationType,
  requestHash: string,
  request: Record<string, unknown>,
  nowMs: number,
): CaptainResult {
  const pending = state.pendingDockOp;
  if (!pending) {
    return { ok: false, error: 'missing pending dock op', code: 'REJECTED', state };
  }
  const result = pending.result;
  state.pendingDockOp = null;
  state.operations.set(operationId, {
    operationId,
    operationType,
    state: 'COMPLETE',
    requestHash,
    deltaHash: hashPayload(result),
    request,
    result,
    createdAt: nowMs,
    updatedAt: nowMs,
  });
  state.updatedAt = nowMs;
  return { ok: true, state, result };
}

/** Internal encounter bootstrap snapshot — never exposed via public player APIs. */
export function privateCaptainSnapshot(state: CaptainState) {
  return {
    captainId: state.captainId,
    kind: state.kind,
    handle: state.handle,
    proxyMode: state.proxyMode,
    hull: state.hull,
    maxHull: state.maxHull,
    shields: state.shields > 0 ? [state.shields] : ([] as number[]),
    credits: state.credits,
    cargo: [...state.cargo.values()].map((c) => ({ good: c.good, qty: c.qty })),
    combatProfile: state.combatProfile,
    tradeProfile: state.tradeProfile,
    policeRecord: state.policeRecord,
    hasEscapePod: state.hasEscapePod,
    relationships: [...state.relationships.values()],
  };
}

export function publicCaptainView(state: CaptainState) {
  return {
    id: state.captainId,
    handle: state.handle,
    systemId: state.systemId,
    status: state.lifecycle,
    shipType: state.shipType,
    shipTypeId: state.shipTypeId,
    hull: state.hull,
    maxHull: state.maxHull,
    shields: state.shields,
    fuel: state.fuel,
    fuelTanks: shipById(state.shipTypeId).fuelTanks,
    policeRecord: state.policeRecord,
    activeBounty: activeBounty(state.policeRecord),
    publicDisposition: publicDisposition(state.combatProfile, state.tradeProfile),
    lifecycleState: state.lifecycle,
    credits: state.credits,
    cargo: [...state.cargo.values()],
    approachTick: state.approachTick,
    activeEncounterId: state.activeEncounterId,
    activePoliceEncounterId: state.activePoliceEncounter?.policeEncounterId ?? null,
    policeContact: state.activePoliceEncounter?.contact ?? null,
    policePhase: state.activePoliceEncounter?.phase ?? null,
    hasEscapePod: state.hasEscapePod,
    // controller kind intentionally omitted from public view
  };
}

async function projectCaptainView(
  state: CaptainState,
  projections: ProjectionPort,
  nowMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const view = publicCaptainView(state);
  return projections.projectCaptain({
    id: view.id,
    handle: view.handle,
    system_id: view.systemId,
    status: view.status,
    ship_type: view.shipType,
    police_record: view.policeRecord,
    active_bounty: view.activeBounty,
    public_disposition: view.publicDisposition,
    lifecycle_state: view.lifecycleState,
    credits: view.credits,
    updated_at: nowMs,
  });
}

/**
 * Two-captain claim protocol coordinator (design §4.4).
 * Returns encounter id only when both accept; otherwise releases any partial claim.
 */
export function attemptPairClaim(args: {
  encounterId: string;
  routeArea: string;
  nowMs: number;
  claimCaptain: (captainId: string, encounterId: string, expiresAt: number) => { ok: boolean };
  releaseCaptain: (captainId: string, encounterId: string) => void;
  captainAId: string;
  captainBId: string;
}): { ok: true; encounterId: string } | { ok: false; reason: string } {
  const expiresAt = args.nowMs + PHASE0_TUNING.encounterClaimTimeoutMs;
  const a = args.claimCaptain(args.captainAId, args.encounterId, expiresAt);
  const b = args.claimCaptain(args.captainBId, args.encounterId, expiresAt);
  if (a.ok && b.ok) return { ok: true, encounterId: args.encounterId };
  if (a.ok) args.releaseCaptain(args.captainAId, args.encounterId);
  if (b.ok) args.releaseCaptain(args.captainBId, args.encounterId);
  return { ok: false, reason: 'partial_or_rejected_claim' };
}
