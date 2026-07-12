import {
  RULESET_VERSION,
  PHASE0_TUNING,
  RulesetRng,
  classifyEncounterCrimes,
  settleDestruction,
  applyPoliceDelta,
  applyPostRecoveryCrime,
  classifyRelationshipDelta,
  classifyAction,
  applyBehaviourChoices,
  accessibleSurrenderValue,
  removedFraction,
  survivingCargo,
  createWreck,
  type RelationshipState,
  type CrimeEvent,
  type BountySettlement,
  type WreckDebris,
  type ClassifiedChoice,
  CommodityId,
} from '@sto/ruleset-phase0-v1';
import { hashPayload } from './hash.js';
import type { EncounterState, EncounterRoundRecord } from './encounter-authority.js';

export interface SettlementEffects {
  readonly encounterId: string;
  readonly rulesetVersion: typeof RULESET_VERSION;
  readonly effectsHash: string;
  readonly crimes: CrimeEvent[];
  readonly policeDeltas: Record<string, number>;
  readonly bounty: BountySettlement | null;
  readonly relationshipUpdates: Array<{
    npcCaptainId: string;
    otherCaptainId: string;
    next: RelationshipState;
  }>;
  readonly wreck: WreckDebris | null;
  readonly destroyedCaptainIds: string[];
  readonly creditsAwards: Record<string, number>;
  /** Post-encounter combat scores for human captains only. */
  readonly combatProfileAfter: Record<string, number>;
  /** Post-encounter trade scores for human captains only. */
  readonly tradeProfileAfter: Record<string, number>;
}

function emptyRelationship(otherCaptainId: string, nowMs: number): RelationshipState {
  return {
    otherCaptainId,
    hostilityScore: 0,
    facts: [],
    lastMetAt: nowMs,
    lockedExtreme: false,
  };
}

function logFlags(rounds: readonly EncounterRoundRecord[]) {
  let aDemanded = false;
  let bDemanded = false;
  let aAttacked = false;
  let bAttacked = false;
  let aInitiatedAttack = false;
  let bInitiatedAttack = false;
  let theftValue = 0;
  let theftFraction = 0;
  let completedTheftBy: string | null = null;
  let surrenderClaimBy: string | null = null;
  let traded = false;
  let firstAttacker: string | null = null;

  for (const round of rounds) {
    const { a, b } = round.actions;
    if (a.type === 'DEMAND') aDemanded = true;
    if (b.type === 'DEMAND') bDemanded = true;
    if (a.type === 'ATTACK') {
      aAttacked = true;
      if (!firstAttacker) {
        firstAttacker = 'a';
        aInitiatedAttack = true;
      }
    }
    if (b.type === 'ATTACK') {
      bAttacked = true;
      if (!firstAttacker) {
        firstAttacker = 'b';
        bInitiatedAttack = true;
      }
    }
    if (a.type === 'TRADE_OFFER' || b.type === 'TRADE_OFFER' || a.type === 'ACCEPT_TRADE' || b.type === 'ACCEPT_TRADE') {
      traded = true;
    }
    for (const t of round.result.transfers) {
      if (t.kind === 'demand' || t.kind === 'surrender_claim') {
        completedTheftBy = t.toId;
        theftValue += t.credits;
        for (const c of t.cargo) theftValue += c.qty * 50; // fallback unit value if no prices
        if (t.kind === 'surrender_claim') surrenderClaimBy = t.toId;
      }
      if (t.kind === 'trade') traded = true;
    }
  }
  return {
    aDemanded,
    bDemanded,
    aAttacked,
    bAttacked,
    aInitiatedAttack,
    bInitiatedAttack,
    theftValue,
    theftFraction,
    completedTheftBy,
    surrenderClaimBy,
    traded,
    firstAttacker,
  };
}

/**
 * Walk encounter rounds and apply human (non-proxy) behaviour choices to combat/trade profiles.
 * NPC profiles are fixed and never appear in the result maps.
 */
export function deriveBehaviourProfileUpdates(state: EncounterState): {
  combatProfileAfter: Record<string, number>;
  tradeProfileAfter: Record<string, number>;
} {
  const choicesByCaptain = new Map<string, ClassifiedChoice[]>();
  let firstAttacker: 'a' | 'b' | null = null;
  let aHasAttacked = false;
  let bHasAttacked = false;

  for (const round of state.rounds) {
    const inCombat = aHasAttacked || bHasAttacked;
    const priorFirst = firstAttacker;

    for (const side of ['a', 'b'] as const) {
      const action = round.actions[side];
      if (action.type === 'ATTACK' && firstAttacker === null) {
        firstAttacker = side;
      }
    }

    for (const side of ['a', 'b'] as const) {
      const participant = state.participants[side];
      if (participant.kind !== 'human') continue;
      if (round.proxyFlags[side]) continue;

      const otherSide = side === 'a' ? 'b' : 'a';
      const action = round.actions[side];
      const initiatedConflict = priorFirst === side || (priorFirst === null && firstAttacker === side);
      const returningFire =
        action.type === 'ATTACK'
        && priorFirst !== null
        && priorFirst !== side;
      const escalated =
        action.type === 'ATTACK'
        && inCombat
        && !returningFire
        && priorFirst === side;

      const choice = classifyAction({
        actionType: action.type,
        initiatedConflict: Boolean(initiatedConflict && action.type === 'ATTACK')
          || (action.type === 'DEMAND' && priorFirst === null),
        escalated,
        returningFire,
        self: participant.snapshot,
        other: state.participants[otherSide].snapshot,
        inCombat,
      });

      const list = choicesByCaptain.get(participant.captainId) ?? [];
      list.push(choice);
      choicesByCaptain.set(participant.captainId, list);
    }

    if (round.actions.a.type === 'ATTACK') aHasAttacked = true;
    if (round.actions.b.type === 'ATTACK') bHasAttacked = true;
  }

  const combatProfileAfter: Record<string, number> = {};
  const tradeProfileAfter: Record<string, number> = {};
  for (const side of ['a', 'b'] as const) {
    const participant = state.participants[side];
    if (participant.kind !== 'human') continue;
    const choices = choicesByCaptain.get(participant.captainId) ?? [];
    combatProfileAfter[participant.captainId] = applyBehaviourChoices(
      participant.snapshot.combatProfile,
      choices,
      true,
    );
    tradeProfileAfter[participant.captainId] = applyBehaviourChoices(
      participant.snapshot.tradeProfile,
      choices,
      true,
    );
  }
  return { combatProfileAfter, tradeProfileAfter };
}

/**
 * Derive crime, bounty, relationship, and wreck effects from a finished encounter
 * (design §11, §8, §9, §10). Pure; captains/systems apply idempotently.
 */
export function deriveSettlementEffects(args: {
  state: EncounterState;
  nowMs: number;
  relationships?: Record<string, RelationshipState | undefined>;
  referencePrices?: ReadonlyMap<number, number>;
  /** Initial credits/cargo before encounter for surrender fraction; defaults to end snapshot. */
  preSurrender?: Record<string, { credits: number; cargo: Array<{ good: number; qty: number }> }>;
}): SettlementEffects {
  const { state, nowMs } = args;
  const a = state.participants.a;
  const b = state.participants.b;
  const flags = logFlags(state.rounds);
  const prices = args.referencePrices ?? new Map<number, number>([
    [CommodityId.Water, 50],
    [CommodityId.Food, 100],
    [CommodityId.Ore, 400],
  ]);

  const crimes: CrimeEvent[] = [];
  const policeDeltas: Record<string, number> = { [a.captainId]: 0, [b.captainId]: 0 };

  const pushCrimes = (events: CrimeEvent[]) => {
    for (const e of events) {
      crimes.push(e);
      policeDeltas[e.actorId] = (policeDeltas[e.actorId] ?? 0) + e.policeDelta;
    }
  };

  // Demands / theft
  if (flags.aDemanded || flags.bDemanded || flags.completedTheftBy) {
    if (flags.aDemanded) {
      pushCrimes(classifyEncounterCrimes({
        actorId: a.captainId,
        targetId: b.captainId,
        attemptedPiracy: flags.completedTheftBy !== a.captainId,
        completedTheft: flags.completedTheftBy === a.captainId,
        valueTaken: flags.theftValue,
        removedFraction: flags.theftFraction,
        unprovokedAttack: false,
        returnFireOnly: false,
        destroyedEscapePod: false,
      }));
    }
    if (flags.bDemanded) {
      pushCrimes(classifyEncounterCrimes({
        actorId: b.captainId,
        targetId: a.captainId,
        attemptedPiracy: flags.completedTheftBy !== b.captainId,
        completedTheft: flags.completedTheftBy === b.captainId,
        valueTaken: flags.theftValue,
        removedFraction: flags.theftFraction,
        unprovokedAttack: false,
        returnFireOnly: false,
        destroyedEscapePod: false,
      }));
    }
  }

  if (flags.surrenderClaimBy && flags.theftValue > 0) {
    // non-zero surrender claim is coerced theft even if already counted
    const actor = flags.surrenderClaimBy;
    const target = actor === a.captainId ? b.captainId : a.captainId;
    if (!crimes.some((c) => c.actorId === actor && c.kind === 'completed_theft')) {
      pushCrimes(classifyEncounterCrimes({
        actorId: actor,
        targetId: target,
        attemptedPiracy: false,
        completedTheft: true,
        valueTaken: flags.theftValue,
        removedFraction: 1,
        unprovokedAttack: false,
        returnFireOnly: false,
        destroyedEscapePod: false,
      }));
    }
  }

  // Unprovoked attacks
  if (flags.aInitiatedAttack && !flags.bAttacked) {
    pushCrimes(classifyEncounterCrimes({
      actorId: a.captainId,
      targetId: b.captainId,
      attemptedPiracy: false,
      completedTheft: false,
      unprovokedAttack: true,
      returnFireOnly: false,
      destroyedEscapePod: false,
    }));
  }
  if (flags.bInitiatedAttack && !flags.aAttacked) {
    pushCrimes(classifyEncounterCrimes({
      actorId: b.captainId,
      targetId: a.captainId,
      attemptedPiracy: false,
      completedTheft: false,
      unprovokedAttack: true,
      returnFireOnly: false,
      destroyedEscapePod: false,
    }));
  }

  // Destruction / bounty — capture wanted status before applying crime deltas
  const aDestroyed = a.snapshot.hull <= 0;
  const bDestroyed = b.snapshot.hull <= 0;
  let bounty: BountySettlement | null = null;
  const creditsAwards: Record<string, number> = {};
  const destroyedCaptainIds: string[] = [];

  const resolveKill = (
    killerId: string,
    victimId: string,
    killerRecord: number,
    victimRecord: number,
    killerInitiated: boolean,
  ) => {
    destroyedCaptainIds.push(victimId);
    const settlement = settleDestruction({
      killerId,
      victimId,
      killerPoliceRecordBefore: killerRecord,
      victimPoliceRecordBefore: victimRecord,
      killerInitiatedUnprovoked: killerInitiated,
    });
    bounty = settlement;
    policeDeltas[killerId] = (policeDeltas[killerId] ?? 0) + settlement.killerPoliceDelta;
    if (settlement.bountyPaid > 0) {
      creditsAwards[killerId] = (creditsAwards[killerId] ?? 0) + settlement.bountyPaid;
    }
  };

  if (aDestroyed && !bDestroyed) {
    resolveKill(b.captainId, a.captainId, b.snapshot.policeRecord, a.snapshot.policeRecord, flags.bInitiatedAttack);
  } else if (bDestroyed && !aDestroyed) {
    resolveKill(a.captainId, b.captainId, a.snapshot.policeRecord, b.snapshot.policeRecord, flags.aInitiatedAttack);
  } else if (aDestroyed && bDestroyed) {
    destroyedCaptainIds.push(a.captainId, b.captainId);
  }

  // Relationships (NPC victims / NPC actors remembering the other)
  const relationshipUpdates: SettlementEffects['relationshipUpdates'] = [];
  const relKey = (npcId: string, otherId: string) => `${npcId}::${otherId}`;

  const updateNpcMemory = (
    npcId: string,
    otherId: string,
    patch: Parameters<typeof classifyRelationshipDelta>[0],
  ) => {
    const prior = args.relationships?.[relKey(npcId, otherId)] ?? emptyRelationship(otherId, nowMs);
    const next = classifyRelationshipDelta({ ...patch, state: prior, nowMs });
    relationshipUpdates.push({ npcCaptainId: npcId, otherCaptainId: otherId, next });
  };

  // Surrender fraction for NPC victim
  if (flags.surrenderClaimBy) {
    const victorId = flags.surrenderClaimBy;
    const victimId = victorId === a.captainId ? b.captainId : a.captainId;
    const victim = victimId === a.captainId ? a : b;
    if (victim.kind === 'npc') {
      const pre = args.preSurrender?.[victimId] ?? {
        credits: victim.snapshot.credits + flags.theftValue,
        cargo: [...victim.snapshot.cargo, ...[]],
      };
      const accessible = accessibleSurrenderValue(pre.credits, pre.cargo, prices);
      const claimed = flags.theftValue;
      const fraction = removedFraction(claimed, accessible);
      updateNpcMemory(victimId, victorId, {
        state: emptyRelationship(victorId, nowMs),
        nowMs,
        attackedFriend: false,
        rescued: false,
        surrenderRemovedFraction: fraction,
        demanded: false,
        tradedFavourably: false,
        ignored: false,
      });
    }
  }

  if (flags.aDemanded && b.kind === 'npc') {
    updateNpcMemory(b.captainId, a.captainId, {
      state: emptyRelationship(a.captainId, nowMs),
      nowMs,
      attackedFriend: false,
      rescued: false,
      demanded: true,
      tradedFavourably: false,
      ignored: false,
    });
  }
  if (flags.bDemanded && a.kind === 'npc') {
    updateNpcMemory(a.captainId, b.captainId, {
      state: emptyRelationship(b.captainId, nowMs),
      nowMs,
      attackedFriend: false,
      rescued: false,
      demanded: true,
      tradedFavourably: false,
      ignored: false,
    });
  }

  if (flags.traded) {
    if (a.kind === 'npc') {
      updateNpcMemory(a.captainId, b.captainId, {
        state: emptyRelationship(b.captainId, nowMs),
        nowMs,
        attackedFriend: false,
        rescued: false,
        demanded: false,
        tradedFavourably: true,
        ignored: false,
      });
    }
    if (b.kind === 'npc') {
      updateNpcMemory(b.captainId, a.captainId, {
        state: emptyRelationship(a.captainId, nowMs),
        nowMs,
        attackedFriend: false,
        rescued: false,
        demanded: false,
        tradedFavourably: true,
        ignored: false,
      });
    }
  }

  // Betrayal: attack on permanent friend
  for (const npc of [a, b]) {
    if (npc.kind !== 'npc') continue;
    const other = npc.captainId === a.captainId ? b : a;
    const prior = args.relationships?.[relKey(npc.captainId, other.captainId)];
    if (prior && prior.hostilityScore <= -100) {
      const npcAttacked = npc.captainId === a.captainId ? flags.bAttacked : flags.aAttacked;
      if (npcAttacked) {
        updateNpcMemory(npc.captainId, other.captainId, {
          state: prior,
          nowMs,
          attackedFriend: true,
          rescued: false,
          demanded: false,
          tradedFavourably: false,
          ignored: false,
        });
      }
    }
  }

  // Wreck from destruction
  let wreck: WreckDebris | null = null;
  const destroyed = [a, b].filter((p) => p.snapshot.hull <= 0);
  if (destroyed.length === 1) {
    const victim = destroyed[0]!;
    const rng = new RulesetRng(state.seed ^ 0x5e77_1e55, state.rngDrawPosition);
    const cargo = survivingCargo(victim.snapshot.cargo, rng);
    wreck = createWreck({
      wreckId: `wreck-${state.encounterId}-${victim.captainId}`,
      routeArea: state.routeArea,
      cargo,
      nowMs,
      ...(victim.snapshot.hasEscapePod
        ? { escapePodCaptainId: victim.captainId, hasCloneBackup: true }
        : {}),
    });
  }

  const effects: SettlementEffects = {
    encounterId: state.encounterId,
    rulesetVersion: RULESET_VERSION,
    effectsHash: '',
    crimes,
    policeDeltas,
    bounty,
    relationshipUpdates,
    wreck,
    destroyedCaptainIds,
    creditsAwards,
    ...deriveBehaviourProfileUpdates(state),
  };
  return {
    ...effects,
    effectsHash: hashPayload({
      encounterId: effects.encounterId,
      crimes: effects.crimes,
      policeDeltas: effects.policeDeltas,
      bounty: effects.bounty,
      relationships: effects.relationshipUpdates.map((u) => ({
        npc: u.npcCaptainId,
        other: u.otherCaptainId,
        score: u.next.hostilityScore,
      })),
      wreckId: effects.wreck?.wreckId ?? null,
      awards: effects.creditsAwards,
      combatProfiles: effects.combatProfileAfter,
      tradeProfiles: effects.tradeProfileAfter,
    }),
  };
}

export function applyPoliceRecord(current: number, delta: number, postRecoveryNeutral = false): number {
  if (postRecoveryNeutral && current === -30) {
    return applyPostRecoveryCrime(current, delta);
  }
  return applyPoliceDelta(current, delta);
}

export { emptyRelationship, PHASE0_TUNING };
