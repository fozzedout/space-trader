import {
  RULESET_VERSION,
  PHASE0_TUNING,
  RulesetRng,
  resolveCaptainRound,
  resolveSurrenderClaim,
  decide,
  publicDisposition,
  coerceLegalAction,
  type CaptainAction,
  type CombatantSnapshot,
  type EncounterPhase,
  type PendingDemand,
  type PendingTradeOffer,
  type RoundResolution,
  type ControllerPolicy,
  CommodityId,
} from '@sto/ruleset-phase0-v1';
import { hashPayload } from './hash.js';
import { deriveSettlementEffects } from './settlement-effects.js';

export type EncounterLifecycle =
  | 'CONTACT'
  | 'NEGOTIATION'
  | 'COMBAT'
  | 'SURRENDER_RESOLUTION'
  | 'TERMINAL'
  | 'SETTLING'
  | 'PROJECTING_TO_D1'
  | 'COMPLETE';

export type ParticipantController = 'human' | 'npc' | 'proxy_learned' | 'proxy_coward';

export interface EncounterParticipant {
  captainId: string;
  /** Private server field — never included in public payloads. */
  controller: ParticipantController;
  /** Underlying kind for NPC policy vs human proxy; private. */
  kind: 'human' | 'npc';
  handle: string;
  connected: boolean;
  disconnectCount: number;
  graceExpiresAt: number | null;
  lockedAction: CaptainAction | null;
  snapshot: CombatantSnapshot;
  settlementState: 'pending' | 'acked' | 'complete';
  privateSummary: ReconnectSummary | null;
}

export interface ReconnectSummary {
  proxyControlledRounds: number[];
  actionsTaken: Array<{ roundNo: number; type: string; messageKey?: string }>;
  damageDealt: number;
  damageReceived: number;
  cargoCreditChanges: string[];
  cannedMessages: string[];
  currentPhase: EncounterLifecycle;
}

export interface EncounterRoundRecord {
  roundNo: number;
  actions: { a: CaptainAction; b: CaptainAction };
  /** Whether each action was supplied by proxy (private audit only). */
  proxyFlags: { a: boolean; b: boolean };
  result: RoundResolution;
}

export interface EncounterState {
  encounterId: string;
  systemId: string;
  routeArea: string;
  seed: number;
  rulesetVersion: typeof RULESET_VERSION;
  lifecycle: EncounterLifecycle;
  phase: EncounterPhase | 'SURRENDER_RESOLUTION';
  roundNo: number;
  rngDrawPosition: number;
  participants: Record<'a' | 'b', EncounterParticipant>;
  pendingOffers: PendingTradeOffer[];
  pendingDemand: PendingDemand | null;
  surrenderVictorId: string | null;
  rounds: EncounterRoundRecord[];
  actionDeadlineAt: number | null;
  resultHash: string | null;
  settlementDeltas: EncounterSettlementDelta[] | null;
  settlementEffects: import('./settlement-effects.js').SettlementEffects | null;
  /**
   * Independent ack flags for secondary settlement writes (police / relationship / wreck).
   * Primary per-captain settle ack lives on `participants.*.settlementState`.
   */
  settlementEffectAcks: SettlementEffectAcks | null;
  /** NPC relationship memory keyed by `${npcId}::${otherId}` — private. */
  relationships: Record<string, import('@sto/ruleset-phase0-v1').RelationshipState>;
  createdAt: number;
  updatedAt: number;
}

export interface SettlementEffectAcks {
  /** Per captainId: police/apply succeeded (or was not owed). */
  policeAcked: Record<string, boolean>;
  /** Per `${npcCaptainId}::${otherCaptainId}`: relationship/upsert succeeded. */
  relationshipAcked: Record<string, boolean>;
  /** Wreck creation succeeded (or no wreck was owed). */
  wreckAcked: boolean;
}

export interface EncounterSettlementDelta {
  captainId: string;
  deltaHash: string;
  creditsDelta: number;
  cargo: Array<{ good: CommodityId; qtyDelta: number }>;
  hull: number;
  shields: number[];
  lifecycleAfter: 'TRAVELLING' | 'ACTIVE' | 'AWAITING_RECOVERY' | 'DEAD';
  destroyed: boolean;
}

export interface PublicEncounterView {
  encounterId: string;
  phase: EncounterLifecycle;
  roundNo: number;
  rulesetVersion: typeof RULESET_VERSION;
  you: {
    captainId: string;
    handle: string;
    connected: boolean;
    hasLockedAction: boolean;
    hull: number;
    shields: number[];
    credits: number;
    publicDisposition: string;
  };
  opponent: {
    captainId: string;
    handle: string;
    hull: number;
    shields: number[];
    publicDisposition: string;
    shipSize: number;
    policeRecord: number;
  };
  pendingOfferHashes: string[];
  surrenderVictorId: string | null;
  actionDeadlineAt: number | null;
}

const ACTION_DEADLINE_MS = 30_000;

export function createEncounter(args: {
  encounterId: string;
  systemId: string;
  routeArea: string;
  seed: number;
  nowMs: number;
  a: Omit<EncounterParticipant, 'lockedAction' | 'settlementState' | 'privateSummary' | 'graceExpiresAt' | 'disconnectCount' | 'connected'> & {
    connected?: boolean;
  };
  b: Omit<EncounterParticipant, 'lockedAction' | 'settlementState' | 'privateSummary' | 'graceExpiresAt' | 'disconnectCount' | 'connected'> & {
    connected?: boolean;
  };
  relationships?: Record<string, import('@sto/ruleset-phase0-v1').RelationshipState>;
}): EncounterState {
  const mk = (p: typeof args.a): EncounterParticipant => ({
    ...p,
    connected: p.connected ?? true,
    disconnectCount: 0,
    graceExpiresAt: null,
    lockedAction: null,
    settlementState: 'pending',
    privateSummary: null,
  });
  return {
    encounterId: args.encounterId,
    systemId: args.systemId,
    routeArea: args.routeArea,
    seed: args.seed,
    rulesetVersion: RULESET_VERSION,
    lifecycle: 'CONTACT',
    phase: 'CONTACT',
    roundNo: 1,
    rngDrawPosition: 0,
    participants: { a: mk(args.a), b: mk(args.b) },
    pendingOffers: [],
    pendingDemand: null,
    surrenderVictorId: null,
    rounds: [],
    actionDeadlineAt: args.nowMs + ACTION_DEADLINE_MS,
    resultHash: null,
    settlementDeltas: null,
    settlementEffects: null,
    settlementEffectAcks: null,
    relationships: args.relationships ?? {},
    createdAt: args.nowMs,
    updatedAt: args.nowMs,
  };
}

function sideOf(state: EncounterState, captainId: string): 'a' | 'b' | null {
  if (state.participants.a.captainId === captainId) return 'a';
  if (state.participants.b.captainId === captainId) return 'b';
  return null;
}

function otherSide(side: 'a' | 'b'): 'a' | 'b' {
  return side === 'a' ? 'b' : 'a';
}

/** Public payload for a participant. Never includes controller kind or grace/proxy internals. */
export function publicEncounterView(state: EncounterState, viewerId: string): PublicEncounterView | null {
  const side = sideOf(state, viewerId);
  if (!side) return null;
  const you = state.participants[side];
  const opp = state.participants[otherSide(side)];
  return {
    encounterId: state.encounterId,
    phase: state.lifecycle,
    roundNo: state.roundNo,
    rulesetVersion: state.rulesetVersion,
    you: {
      captainId: you.captainId,
      handle: you.handle,
      connected: you.connected,
      hasLockedAction: you.lockedAction !== null,
      hull: you.snapshot.hull,
      shields: [...you.snapshot.shields],
      credits: you.snapshot.credits,
      publicDisposition: publicDisposition(you.snapshot.combatProfile, you.snapshot.tradeProfile),
    },
    opponent: {
      captainId: opp.captainId,
      handle: opp.handle,
      hull: opp.snapshot.hull,
      shields: [...opp.snapshot.shields],
      publicDisposition: publicDisposition(opp.snapshot.combatProfile, opp.snapshot.tradeProfile),
      shipSize: opp.snapshot.shipSize,
      policeRecord: opp.snapshot.policeRecord,
    },
    pendingOfferHashes: state.pendingOffers.map((o) => o.proposalHash),
    surrenderVictorId: state.surrenderVictorId,
    actionDeadlineAt: state.actionDeadlineAt,
  };
}

/** Fail if a public payload contains controller/private disconnect fields. */
export function assertNoControllerLeak(payload: unknown): void {
  const walk = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        key === 'controller'
        || key === 'kind'
        || key === 'graceExpiresAt'
        || key === 'disconnectCount'
        || key === 'proxyFlags'
        || key === 'privateSummary'
      ) {
        throw new Error(`controller/private field leaked at ${path}.${key}`);
      }
      walk(child, `${path}.${key}`);
    }
  };
  walk(payload, '$');
}

export type EncounterCommandResult =
  | { ok: true; state: EncounterState; resolved?: RoundResolution; view?: ReturnType<typeof publicEncounterView>; summary?: ReconnectSummary | null }
  | { ok: false; error: string; code: string; state: EncounterState };

function ensureSummary(p: EncounterParticipant, phase: EncounterLifecycle): ReconnectSummary {
  if (!p.privateSummary) {
    p.privateSummary = {
      proxyControlledRounds: [],
      actionsTaken: [],
      damageDealt: 0,
      damageReceived: 0,
      cargoCreditChanges: [],
      cannedMessages: [],
      currentPhase: phase,
    };
  }
  p.privateSummary.currentPhase = phase;
  return p.privateSummary;
}

export function submitAction(
  state: EncounterState,
  args: { captainId: string; action: CaptainAction; nowMs: number },
): EncounterCommandResult {
  if (state.lifecycle === 'TERMINAL' || state.lifecycle === 'SETTLING' || state.lifecycle === 'COMPLETE' || state.lifecycle === 'PROJECTING_TO_D1') {
    return { ok: false, error: 'encounter closed', code: 'CLOSED', state };
  }
  const side = sideOf(state, args.captainId);
  if (!side) return { ok: false, error: 'not a participant', code: 'FORBIDDEN', state };
  const p = state.participants[side];
  if (!p.connected && p.kind === 'human') {
    return { ok: false, error: 'disconnected', code: 'DISCONNECTED', state };
  }
  if (state.phase === 'SURRENDER_RESOLUTION') {
    if (state.surrenderVictorId !== args.captainId && args.action.type !== 'SURRENDER_CLAIM') {
      // non-victor has no action
      return { ok: false, error: 'no action for surrendered captain', code: 'REJECTED', state };
    }
  }

  const phase = state.phase === 'SURRENDER_RESOLUTION' ? 'NEGOTIATION' : state.phase;
  const legal = coerceLegalAction(phase as EncounterPhase, args.action, true, true);
  if (p.lockedAction && p.lockedAction.actionId === legal.actionId) {
    // idempotent same action_id
    if (hashPayload(p.lockedAction) !== hashPayload(legal)) {
      return { ok: false, error: 'action_id reuse with different content', code: 'INTEGRITY', state };
    }
    return { ok: true, state, view: publicEncounterView(state, args.captainId) };
  }
  if (p.lockedAction) {
    return { ok: false, error: 'action already locked', code: 'LOCKED', state };
  }

  p.lockedAction = { ...legal, roundNo: state.roundNo };
  state.updatedAt = args.nowMs;
  return maybeResolveRound(state, args.nowMs);
}

export function markDisconnected(
  state: EncounterState,
  args: { captainId: string; nowMs: number },
): EncounterCommandResult {
  const side = sideOf(state, args.captainId);
  if (!side) return { ok: false, error: 'not a participant', code: 'FORBIDDEN', state };
  const p = state.participants[side];
  if (p.kind !== 'human') return { ok: true, state };
  if (!p.connected) return { ok: true, state };

  p.connected = false;
  p.disconnectCount += 1;
  const grace = graceMsForDisconnect(p.disconnectCount);
  p.graceExpiresAt = grace === 0 ? args.nowMs : args.nowMs + grace;
  // Opponent must not observe this — no public fields changed except we keep connected private to you-view only
  state.updatedAt = args.nowMs;
  if (grace === 0) {
    return applyProxyIfNeeded(state, args.nowMs);
  }
  return { ok: true, state, view: publicEncounterView(state, args.captainId) };
}

export function markReconnected(
  state: EncounterState,
  args: { captainId: string; nowMs: number },
): EncounterCommandResult {
  const side = sideOf(state, args.captainId);
  if (!side) return { ok: false, error: 'not a participant', code: 'FORBIDDEN', state };
  const p = state.participants[side];
  p.connected = true;
  p.graceExpiresAt = null;
  state.updatedAt = args.nowMs;
  return {
    ok: true,
    state,
    view: publicEncounterView(state, args.captainId),
    summary: p.privateSummary,
  };
}

export function privateReconnectSummary(state: EncounterState, captainId: string): ReconnectSummary | null {
  const side = sideOf(state, captainId);
  if (!side) return null;
  return state.participants[side].privateSummary;
}

function graceMsForDisconnect(count: number): number {
  if (count <= 1) return PHASE0_TUNING.disconnectGraceMs;
  if (count === 2) return Math.floor(PHASE0_TUNING.disconnectGraceMs / 2);
  return 0;
}

export function tickEncounter(state: EncounterState, nowMs: number): EncounterCommandResult {
  if (state.lifecycle === 'COMPLETE' || state.lifecycle === 'SETTLING' || state.lifecycle === 'PROJECTING_TO_D1') {
    return { ok: true, state };
  }

  // Grace expiry → proxy
  for (const side of ['a', 'b'] as const) {
    const p = state.participants[side];
    if (!p.connected && p.graceExpiresAt !== null && nowMs >= p.graceExpiresAt && !p.lockedAction) {
      p.graceExpiresAt = null;
      applyProxyAction(state, side, nowMs);
    }
  }

  // NPCs without a client act as soon as the opposing captain has locked (or alone on deadline).
  const aLocked = state.participants.a.lockedAction !== null;
  const bLocked = state.participants.b.lockedAction !== null;
  for (const side of ['a', 'b'] as const) {
    const p = state.participants[side];
    const otherLocked = side === 'a' ? bLocked : aLocked;
    if (!p.lockedAction && p.kind === 'npc' && otherLocked) {
      applyProxyAction(state, side, nowMs);
    }
  }

  // Deadline → controller policy supplies action
  if (state.actionDeadlineAt !== null && nowMs >= state.actionDeadlineAt) {
    for (const side of ['a', 'b'] as const) {
      const p = state.participants[side];
      if (!p.lockedAction) applyProxyAction(state, side, nowMs);
    }
  }

  return maybeResolveRound(state, nowMs);
}

function applyProxyIfNeeded(state: EncounterState, nowMs: number): EncounterCommandResult {
  for (const side of ['a', 'b'] as const) {
    const p = state.participants[side];
    if (!p.connected && !p.lockedAction) applyProxyAction(state, side, nowMs);
  }
  return maybeResolveRound(state, nowMs);
}

function applyProxyAction(state: EncounterState, side: 'a' | 'b', nowMs: number): void {
  const self = state.participants[side];
  const other = state.participants[otherSide(side)];
  if (self.lockedAction) return;

  // Human disconnected → use proxy mode; NPC always uses ordinary policy when auto-acting
  let policy: ControllerPolicy;
  if (self.kind === 'npc') policy = 'ordinary_npc';
  else if (self.controller === 'proxy_coward') policy = 'coward_proxy';
  else policy = 'learned_proxy';

  const rng = new RulesetRng(state.seed, state.rngDrawPosition);
  const phase = state.phase === 'SURRENDER_RESOLUTION' ? 'SURRENDER_RESOLUTION' : state.phase;
  const relKey = `${self.captainId}::${other.captainId}`;
  const relationship = self.kind === 'npc' ? (state.relationships[relKey] ?? null) : null;
  const decision = decide(policy, {
    phase,
    self: self.snapshot,
    other: other.snapshot,
    relationship,
    pendingOffers: state.pendingOffers,
    pendingDemandDemanderId: state.pendingDemand?.demanderId ?? null,
    surrenderVictorId: state.surrenderVictorId,
    roundNo: state.roundNo,
    rng,
    otherPublicDisposition: publicDisposition(other.snapshot.combatProfile, other.snapshot.tradeProfile),
  });
  state.rngDrawPosition = rng.drawPosition();

  const phaseForLegal = state.phase === 'SURRENDER_RESOLUTION' ? 'NEGOTIATION' : state.phase;
  self.lockedAction = coerceLegalAction(phaseForLegal as EncounterPhase, decision.action, true, true);
  self.lockedAction = { ...self.lockedAction, roundNo: state.roundNo, actionId: `proxy-${state.roundNo}-${side}` };

  const summary = ensureSummary(self, state.lifecycle);
  summary.proxyControlledRounds.push(state.roundNo);
  summary.actionsTaken.push({
    roundNo: state.roundNo,
    type: self.lockedAction.type,
    ...(self.lockedAction.messageKey !== undefined ? { messageKey: self.lockedAction.messageKey } : {}),
  });
  if (self.lockedAction.messageKey) summary.cannedMessages.push(self.lockedAction.messageKey);
  state.updatedAt = nowMs;
}

function maybeResolveRound(state: EncounterState, nowMs: number): EncounterCommandResult {
  const { a, b } = state.participants;

  // Surrender claim resolution is sequential (victor only)
  if (state.phase === 'SURRENDER_RESOLUTION') {
    const victorSide = state.surrenderVictorId === a.captainId ? 'a' : state.surrenderVictorId === b.captainId ? 'b' : null;
    if (!victorSide) {
      return finishTerminal(state, nowMs, 'mutual_or_invalid_surrender');
    }
    const victor = state.participants[victorSide];
    if (!victor.lockedAction) return { ok: true, state, view: publicEncounterView(state, victor.captainId) };
    const victim = state.participants[otherSide(victorSide)];
    const claim = victor.lockedAction.type === 'SURRENDER_CLAIM' ? victor.lockedAction.surrenderClaim ?? null : null;
    const transfer = resolveSurrenderClaim(victor.captainId, victim.snapshot, claim);
    const resolution: RoundResolution = {
      phaseAfter: 'TERMINAL',
      ended: true,
      endReason: 'surrender_claim',
      attacks: [],
      fleeResults: [],
      transfers: transfer ? [transfer] : [],
      demandOutcomes: [],
      pendingOffers: [],
      pendingDemand: null,
      surrenderVictorId: victor.captainId,
      messages: [],
      events: ['surrender_claim'],
    };
    state.rounds.push({
      roundNo: state.roundNo,
      actions: {
        a: a.lockedAction ?? { actionId: 'none', roundNo: state.roundNo, type: 'IGNORE' },
        b: b.lockedAction ?? { actionId: 'none', roundNo: state.roundNo, type: 'IGNORE' },
      },
      proxyFlags: {
        a: (a.privateSummary?.proxyControlledRounds.includes(state.roundNo) ?? false),
        b: (b.privateSummary?.proxyControlledRounds.includes(state.roundNo) ?? false),
      },
      result: resolution,
    });
    applyResolutionToSnapshots(state, resolution);
    return finishTerminal(state, nowMs, 'surrender_claim');
  }

  if (!a.lockedAction || !b.lockedAction) {
    return { ok: true, state };
  }

  const rng = new RulesetRng(state.seed, state.rngDrawPosition);
  const resolution = resolveCaptainRound({
    phase: state.phase as EncounterPhase,
    a: a.snapshot,
    b: b.snapshot,
    actionA: a.lockedAction,
    actionB: b.lockedAction,
    pendingOffers: state.pendingOffers,
    pendingDemand: state.pendingDemand,
    rng,
  });
  state.rngDrawPosition = rng.drawPosition();

  state.rounds.push({
    roundNo: state.roundNo,
    actions: { a: a.lockedAction, b: b.lockedAction },
    proxyFlags: {
      a: a.privateSummary?.proxyControlledRounds.includes(state.roundNo) ?? false,
      b: b.privateSummary?.proxyControlledRounds.includes(state.roundNo) ?? false,
    },
    result: resolution,
  });

  applyResolutionToSnapshots(state, resolution);
  state.pendingOffers = [...resolution.pendingOffers];
  state.pendingDemand = resolution.pendingDemand;
  if (resolution.surrenderVictorId) state.surrenderVictorId = resolution.surrenderVictorId;

  a.lockedAction = null;
  b.lockedAction = null;

  if (resolution.ended || resolution.phaseAfter === 'TERMINAL') {
    return finishTerminal(state, nowMs, resolution.endReason ?? 'ended');
  }

  if (resolution.phaseAfter === 'SURRENDER_RESOLUTION') {
    state.phase = 'SURRENDER_RESOLUTION';
    state.lifecycle = 'SURRENDER_RESOLUTION';
    state.roundNo += 1;
    state.actionDeadlineAt = nowMs + ACTION_DEADLINE_MS;
    state.updatedAt = nowMs;
    return { ok: true, state, resolved: resolution };
  }

  state.phase = resolution.phaseAfter as EncounterPhase;
  state.lifecycle = resolution.phaseAfter as EncounterLifecycle;
  state.roundNo += 1;
  state.actionDeadlineAt = nowMs + ACTION_DEADLINE_MS;
  state.updatedAt = nowMs;
  return { ok: true, state, resolved: resolution };
}

function applyResolutionToSnapshots(state: EncounterState, resolution: RoundResolution): void {
  for (const atk of resolution.attacks) {
    const defSide = state.participants.a.captainId === atk.defenderId ? 'a' : 'b';
    const atkSide = otherSide(defSide);
    const def = state.participants[defSide];
    const attacker = state.participants[atkSide];
    def.snapshot = {
      ...def.snapshot,
      hull: atk.hullAfter,
      shields: [...atk.shieldsAfter],
    };
    const defSummary = ensureSummary(def, state.lifecycle);
    const atkSummary = ensureSummary(attacker, state.lifecycle);
    defSummary.damageReceived += atk.hullDamage;
    atkSummary.damageDealt += atk.hullDamage;
  }

  for (const transfer of resolution.transfers) {
    const fromSide = state.participants.a.captainId === transfer.fromId ? 'a' : 'b';
    const toSide = otherSide(fromSide);
    const from = state.participants[fromSide];
    const to = state.participants[toSide];
    from.snapshot = {
      ...from.snapshot,
      credits: from.snapshot.credits - transfer.credits,
      cargo: applyCargoDelta(from.snapshot.cargo, transfer.cargo, -1),
    };
    to.snapshot = {
      ...to.snapshot,
      credits: to.snapshot.credits + transfer.credits,
      cargo: applyCargoDelta(to.snapshot.cargo, transfer.cargo, +1),
    };
    const note = `${transfer.kind}:${transfer.credits}c+${transfer.cargo.map((c) => `${c.qty}x${c.good}`).join(',')}`;
    ensureSummary(from, state.lifecycle).cargoCreditChanges.push(`-${note}`);
    ensureSummary(to, state.lifecycle).cargoCreditChanges.push(`+${note}`);
  }
}

function applyCargoDelta(
  cargo: CombatantSnapshot['cargo'],
  delta: readonly { good: number; qty: number }[],
  sign: 1 | -1,
): CombatantSnapshot['cargo'] {
  const map = new Map(cargo.map((c) => [c.good, c.qty]));
  for (const lot of delta) {
    const next = (map.get(lot.good) ?? 0) + sign * lot.qty;
    if (next <= 0) map.delete(lot.good);
    else map.set(lot.good, next);
  }
  return [...map.entries()].map(([good, qty]) => ({ good, qty }));
}

function finishTerminal(state: EncounterState, nowMs: number, reason: string): EncounterCommandResult {
  state.lifecycle = 'SETTLING';
  state.phase = 'CONTACT';
  state.actionDeadlineAt = null;
  state.settlementDeltas = buildSettlementDeltas(state);
  state.settlementEffects = deriveSettlementEffects({
    state,
    nowMs,
    relationships: state.relationships,
  });
  state.settlementEffectAcks = createSettlementEffectAcks(state.settlementEffects);
  state.resultHash = hashPayload({
    encounterId: state.encounterId,
    reason,
    rounds: state.rounds.map((r) => ({ roundNo: r.roundNo, events: r.result.events, end: r.result.endReason })),
    deltas: state.settlementDeltas,
    effectsHash: state.settlementEffects.effectsHash,
  });
  state.updatedAt = nowMs;
  return { ok: true, state };
}

export function createSettlementEffectAcks(
  effects: import('./settlement-effects.js').SettlementEffects | null,
): SettlementEffectAcks {
  if (!effects) {
    return { policeAcked: {}, relationshipAcked: {}, wreckAcked: true };
  }
  return {
    policeAcked: {},
    relationshipAcked: {},
    wreckAcked: effects.wreck == null,
  };
}

export function relationshipAckKey(npcCaptainId: string, otherCaptainId: string): string {
  return `${npcCaptainId}::${otherCaptainId}`;
}

export function policeApplyOwed(
  effects: import('./settlement-effects.js').SettlementEffects,
  captainId: string,
): boolean {
  const policeDelta = effects.policeDeltas[captainId] ?? 0;
  const award = effects.creditsAwards[captainId] ?? 0;
  return policeDelta !== 0 || award > 0;
}

export function allSecondaryEffectsAcked(state: EncounterState): boolean {
  const effects = state.settlementEffects;
  if (!effects) return true;
  const acks = state.settlementEffectAcks ?? createSettlementEffectAcks(effects);
  for (const delta of state.settlementDeltas ?? []) {
    if (policeApplyOwed(effects, delta.captainId) && !acks.policeAcked[delta.captainId]) {
      return false;
    }
  }
  for (const rel of effects.relationshipUpdates) {
    const key = relationshipAckKey(rel.npcCaptainId, rel.otherCaptainId);
    if (!acks.relationshipAcked[key]) return false;
  }
  if (effects.wreck != null && !acks.wreckAcked) return false;
  return true;
}

function maybeAdvanceToProjecting(state: EncounterState): void {
  if (
    state.participants.a.settlementState === 'acked'
    && state.participants.b.settlementState === 'acked'
    && allSecondaryEffectsAcked(state)
  ) {
    state.lifecycle = 'PROJECTING_TO_D1';
  }
}

function buildSettlementDeltas(state: EncounterState): EncounterSettlementDelta[] {
  const deltas: EncounterSettlementDelta[] = [];
  for (const side of ['a', 'b'] as const) {
    const p = state.participants[side];
    // Compare to initial would need baseline; deltas are absolute post-encounter state for captain apply.
    const destroyed = p.snapshot.hull <= 0;
    const delta: EncounterSettlementDelta = {
      captainId: p.captainId,
      deltaHash: '',
      creditsDelta: 0, // captain applies absolute snapshot fields for hull/cargo/credits
      cargo: p.snapshot.cargo.map((c) => ({ good: c.good as CommodityId, qtyDelta: c.qty })),
      hull: p.snapshot.hull,
      shields: [...p.snapshot.shields],
      lifecycleAfter: destroyed
        ? (p.snapshot.hasEscapePod ? 'AWAITING_RECOVERY' : 'DEAD')
        : 'TRAVELLING',
      destroyed,
    };
    // Encode absolute credits in creditsDelta field as absolute value via hash payload
    delta.deltaHash = hashPayload({
      encounterId: state.encounterId,
      captainId: p.captainId,
      credits: p.snapshot.credits,
      cargo: p.snapshot.cargo,
      hull: p.snapshot.hull,
      shields: p.snapshot.shields,
      lifecycleAfter: delta.lifecycleAfter,
    });
    deltas.push({
      ...delta,
      creditsDelta: p.snapshot.credits, // absolute credits after encounter for this slice
    });
  }
  return deltas;
}

export function markSettlementAcked(state: EncounterState, captainId: string): EncounterCommandResult {
  const side = sideOf(state, captainId);
  if (!side) return { ok: false, error: 'not a participant', code: 'FORBIDDEN', state };
  state.participants[side].settlementState = 'acked';
  maybeAdvanceToProjecting(state);
  return { ok: true, state };
}

export function markPoliceEffectAcked(state: EncounterState, captainId: string): EncounterCommandResult {
  if (!state.settlementEffectAcks) {
    state.settlementEffectAcks = createSettlementEffectAcks(state.settlementEffects);
  }
  state.settlementEffectAcks.policeAcked[captainId] = true;
  maybeAdvanceToProjecting(state);
  return { ok: true, state };
}

export function markRelationshipEffectAcked(
  state: EncounterState,
  npcCaptainId: string,
  otherCaptainId: string,
): EncounterCommandResult {
  if (!state.settlementEffectAcks) {
    state.settlementEffectAcks = createSettlementEffectAcks(state.settlementEffects);
  }
  state.settlementEffectAcks.relationshipAcked[relationshipAckKey(npcCaptainId, otherCaptainId)] = true;
  maybeAdvanceToProjecting(state);
  return { ok: true, state };
}

export function markWreckEffectAcked(state: EncounterState): EncounterCommandResult {
  if (!state.settlementEffectAcks) {
    state.settlementEffectAcks = createSettlementEffectAcks(state.settlementEffects);
  }
  state.settlementEffectAcks.wreckAcked = true;
  maybeAdvanceToProjecting(state);
  return { ok: true, state };
}

export function markEncounterComplete(state: EncounterState, nowMs: number): EncounterCommandResult {
  if (state.lifecycle !== 'PROJECTING_TO_D1' && state.lifecycle !== 'SETTLING') {
    return { ok: false, error: 'not ready', code: 'REJECTED', state };
  }
  state.lifecycle = 'COMPLETE';
  state.participants.a.settlementState = 'complete';
  state.participants.b.settlementState = 'complete';
  state.updatedAt = nowMs;
  return { ok: true, state };
}

export function combatantFromCaptain(args: {
  captainId: string;
  hull: number;
  maxHull: number;
  shields: number[];
  credits: number;
  cargo: Array<{ good: CommodityId; qty: number }>;
  combatProfile: number;
  tradeProfile: number;
  policeRecord: number;
  hasEscapePod?: boolean;
}): CombatantSnapshot {
  return {
    captainId: args.captainId,
    shipSize: 1,
    hull: args.hull,
    maxHull: args.maxHull,
    shields: args.shields,
    totalWeaponPower: 25,
    pilot: 5,
    fighter: 5,
    engineer: 5,
    hasEscapePod: args.hasEscapePod ?? false,
    policeRecord: args.policeRecord,
    combatProfile: args.combatProfile,
    tradeProfile: args.tradeProfile,
    credits: args.credits,
    cargo: args.cargo,
    difficulty: 2,
  };
}
