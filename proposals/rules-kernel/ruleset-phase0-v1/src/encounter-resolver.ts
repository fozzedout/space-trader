import {
  absorbWithShields,
  attackHits,
  commanderFleeSucceeds,
  opponentFleeSucceeds,
  reduceHullDamage,
  weaponDamage,
} from '@sto/original-baseline-rules';
import type {
  AttackResult,
  BilateralExchange,
  CaptainAction,
  CombatantSnapshot,
  DemandOutcome,
  DemandSpec,
  EncounterPhase,
  FleeResult,
  PendingDemand,
  PendingTradeOffer,
  RoundResolution,
  SettlementTransfer,
  SurrenderClaim,
} from './types.js';
import { proposalHash, canonicalizeExchange, holdingsCover, reverseExchange } from './trade-offer.js';
import type { RulesetRng } from './prng.js';

const CONTACT_ACTIONS = new Set([
  'ATTACK', 'FLEE', 'HAIL', 'IGNORE', 'DEMAND', 'TRADE_OFFER',
]);
const NEGOTIATION_ACTIONS = new Set([
  'ATTACK', 'FLEE', 'HAIL', 'IGNORE', 'DEMAND', 'TRADE_OFFER', 'ACCEPT_TRADE', 'COMPLY', 'SURRENDER',
]);
const COMBAT_ACTIONS = new Set(['ATTACK', 'FLEE', 'SURRENDER']);

export function legalActionsForPhase(phase: EncounterPhase, allowSurrender = true): ReadonlySet<string> {
  if (phase === 'CONTACT') return CONTACT_ACTIONS;
  if (phase === 'NEGOTIATION') {
    if (allowSurrender) return NEGOTIATION_ACTIONS;
    const without = new Set(NEGOTIATION_ACTIONS);
    without.delete('SURRENDER');
    return without;
  }
  if (phase === 'COMBAT') {
    if (allowSurrender) return COMBAT_ACTIONS;
    return new Set(['ATTACK', 'FLEE']);
  }
  return new Set();
}

export function phaseFallback(phase: EncounterPhase): CaptainActionTypeFallback {
  if (phase === 'COMBAT') return 'FLEE';
  return 'IGNORE';
}

type CaptainActionTypeFallback = 'IGNORE' | 'FLEE' | 'SURRENDER';

export function coerceLegalAction(
  phase: EncounterPhase,
  action: CaptainAction | null,
  canFlee: boolean,
  canSurrender: boolean,
): CaptainAction {
  const legal = legalActionsForPhase(phase, canSurrender);
  if (action && legal.has(action.type)) {
    if (action.type === 'TRADE_OFFER' && action.tradeOffer) {
      try {
        canonicalizeExchange(action.tradeOffer);
        return action;
      } catch {
        /* fall through */
      }
    }
    if (action.type === 'DEMAND' && action.demand) {
      if (action.demand.credits >= 0 && action.demand.cargo.every((c) => c.qty >= 0)) return action;
    } else if (action.type !== 'TRADE_OFFER' && action.type !== 'DEMAND' && action.type !== 'ACCEPT_TRADE') {
      return action;
    } else if (action.type === 'ACCEPT_TRADE' && action.acceptProposalHash) {
      return action;
    }
  }

  let fallback: CaptainActionTypeFallback = phaseFallback(phase);
  if (fallback === 'FLEE' && !canFlee) fallback = canSurrender ? 'SURRENDER' : 'IGNORE';
  if (fallback === 'SURRENDER' && !canSurrender) fallback = 'IGNORE';
  return {
    actionId: action?.actionId ?? `fallback-${phase}`,
    roundNo: action?.roundNo ?? 0,
    type: fallback,
  };
}

function cargoMap(combatant: CombatantSnapshot): Map<number, number> {
  return new Map(combatant.cargo.map((c) => [c.good, c.qty]));
}

function canFulfilDemand(target: CombatantSnapshot, demand: DemandSpec): boolean {
  return holdingsCover(target.credits, cargoMap(target), demand.credits, demand.cargo);
}

function canFulfilOutgoing(
  captain: CombatantSnapshot,
  credits: number,
  cargo: readonly { good: number; qty: number }[],
): boolean {
  return holdingsCover(captain.credits, cargoMap(captain), credits, cargo);
}

function resolveAttack(
  attacker: CombatantSnapshot,
  defender: CombatantSnapshot,
  defenderFleeing: boolean,
  rng: RulesetRng,
): AttackResult {
  const hit = attackHits(attacker.fighter, defender.shipSize, defender.pilot, defenderFleeing, rng);
  if (!hit) {
    return {
      attackerId: attacker.captainId,
      defenderId: defender.captainId,
      hit: false,
      rawDamage: 0,
      hullDamage: 0,
      shieldsAfter: [...defender.shields],
      hullAfter: defender.hull,
      destroyed: false,
    };
  }
  const raw = weaponDamage(attacker.totalWeaponPower, attacker.engineer, rng);
  const absorbed = absorbWithShields(raw, defender.shields);
  const hullDamage = reduceHullDamage(
    absorbed.remainingDamage,
    defender.engineer,
    defender.maxHull,
    defender.difficulty,
    rng,
  );
  const hullAfter = Math.max(0, defender.hull - hullDamage);
  return {
    attackerId: attacker.captainId,
    defenderId: defender.captainId,
    hit: true,
    rawDamage: raw,
    hullDamage,
    shieldsAfter: absorbed.shields,
    hullAfter,
    destroyed: hullAfter <= 0,
  };
}

function resolveFlee(
  fleer: CombatantSnapshot,
  pursuer: CombatantSnapshot,
  fleerIsCommanderSide: boolean,
  rng: RulesetRng,
): FleeResult {
  const success = fleerIsCommanderSide
    ? commanderFleeSucceeds(fleer.pilot, pursuer.pilot, fleer.difficulty, rng)
    : opponentFleeSucceeds(pursuer.pilot, fleer.pilot, rng);
  return { captainId: fleer.captainId, success };
}

export interface EncounterRoundInput {
  readonly phase: EncounterPhase;
  readonly a: CombatantSnapshot;
  readonly b: CombatantSnapshot;
  readonly actionA: CaptainAction | null;
  readonly actionB: CaptainAction | null;
  readonly pendingOffers: readonly PendingTradeOffer[];
  readonly pendingDemand: PendingDemand | null;
  readonly rng: RulesetRng;
  /** When false, flee uses opponentFleeSucceeds for both (symmetric PvP). Default true uses commander formula for A. */
  readonly aUsesCommanderFlee?: boolean;
}

function offerFrom(
  proposerId: string,
  aId: string,
  exchange: BilateralExchange,
): PendingTradeOffer {
  const normalized = proposerId === aId ? canonicalizeExchange(exchange) : reverseExchange(exchange);
  return {
    proposerId,
    exchange: normalized,
    proposalHash: proposalHash(normalized),
  };
}

/**
 * Simultaneous hidden-action round resolver (design §5.4).
 * Participant A/B ordering is fixed by caller; outcomes are role-symmetric where required.
 */
export function resolveCaptainRound(input: EncounterRoundInput): RoundResolution {
  const { phase, a, b, pendingOffers, pendingDemand, rng } = input;
  const actionA = coerceLegalAction(phase, input.actionA, true, true);
  const actionB = coerceLegalAction(phase, input.actionB, true, true);
  const aCommanderFlee = input.aUsesCommanderFlee !== false;

  const events: string[] = [];
  const attacks: AttackResult[] = [];
  const fleeResults: FleeResult[] = [];
  const transfers: SettlementTransfer[] = [];
  const demandOutcomes: DemandOutcome[] = [];
  const messages: { captainId: string; messageKey?: string }[] = [];
  let nextOffers = [...pendingOffers];
  let nextDemand = pendingDemand;
  let surrenderVictorId: string | null = null;
  let phaseAfter: RoundResolution['phaseAfter'] = phase;
  let ended = false;
  let endReason: string | undefined;

  const typeA = actionA.type;
  const typeB = actionB.type;

  const revokeOffersBy = (captainId: string) => {
    nextOffers = nextOffers.filter((o) => o.proposerId !== captainId);
  };

  if (actionA.messageKey) messages.push({ captainId: a.captainId, messageKey: actionA.messageKey });
  if (actionB.messageKey) messages.push({ captainId: b.captainId, messageKey: actionB.messageKey });

  // Priority 1: surrender
  const aSurrenders = typeA === 'SURRENDER';
  const bSurrenders = typeB === 'SURRENDER';
  if (aSurrenders && bSurrenders) {
    revokeOffersBy(a.captainId);
    revokeOffersBy(b.captainId);
    events.push('mutual_surrender');
    return done('TERMINAL', true, 'mutual_surrender');
  }
  if (aSurrenders && typeB !== 'ATTACK') {
    revokeOffersBy(a.captainId);
    events.push('surrender_a');
    surrenderVictorId = b.captainId;
    return done('SURRENDER_RESOLUTION', false);
  }
  if (bSurrenders && typeA !== 'ATTACK') {
    revokeOffersBy(b.captainId);
    events.push('surrender_b');
    surrenderVictorId = a.captainId;
    return done('SURRENDER_RESOLUTION', false);
  }
  if (aSurrenders && typeB === 'ATTACK') {
    revokeOffersBy(a.captainId);
    events.push('surrender_before_attack');
    surrenderVictorId = b.captainId;
    return done('SURRENDER_RESOLUTION', false);
  }
  if (bSurrenders && typeA === 'ATTACK') {
    revokeOffersBy(b.captainId);
    events.push('surrender_before_attack');
    surrenderVictorId = a.captainId;
    return done('SURRENDER_RESOLUTION', false);
  }

  // Priority 2: escape
  const aFlees = typeA === 'FLEE';
  const bFlees = typeB === 'FLEE';
  if (aFlees && bFlees) {
    fleeResults.push({ captainId: a.captainId, success: true }, { captainId: b.captainId, success: true });
    events.push('mutual_flee');
    return done('TERMINAL', true, 'mutual_flee');
  }

  if (aFlees || bFlees) {
    const fleer = aFlees ? a : b;
    const other = aFlees ? b : a;
    const otherAction = aFlees ? actionB : actionA;
    const flee = resolveFlee(fleer, other, aFlees ? aCommanderFlee : !aCommanderFlee, rng);
    fleeResults.push(flee);

    if (otherAction.type === 'ATTACK') {
      if (flee.success) {
        events.push('flee_success_cancels_attack');
        return done('TERMINAL', true, 'flee_success');
      }
      revokeOffersBy(fleer.captainId);
      const atk = resolveAttack(other, fleer, true, rng);
      attacks.push(atk);
      events.push('flee_failed_attack');
      phaseAfter = 'COMBAT';
      if (atk.destroyed) return done('TERMINAL', true, 'destroyed');
      return done(phaseAfter, false);
    }

    if (flee.success) {
      events.push('flee_success');
      return done('TERMINAL', true, 'flee_success');
    }

    revokeOffersBy(fleer.captainId);

    // Failed flee vs non-attack: stay in phase; demand/offer may remain
    if (otherAction.type === 'DEMAND' && otherAction.demand) {
      nextDemand = { demanderId: other.captainId, demand: otherAction.demand };
      events.push('demand_pending_after_failed_flee');
      phaseAfter = phase === 'CONTACT' ? 'NEGOTIATION' : phase;
    }
    if (otherAction.type === 'TRADE_OFFER' && otherAction.tradeOffer) {
      nextOffers = [offerFrom(other.captainId, a.captainId, otherAction.tradeOffer)];
      phaseAfter = phase === 'CONTACT' ? 'NEGOTIATION' : phase;
    }
    if (otherAction.type === 'HAIL') {
      phaseAfter = 'NEGOTIATION';
    }
    if (otherAction.type === 'IGNORE') {
      revokeOffersBy(other.captainId);
      return done('TERMINAL', true, 'disengage');
    }
    events.push('flee_failed');
    return done(phaseAfter === 'CONTACT' ? 'NEGOTIATION' : phaseAfter, false);
  }

  // Priority 3: attacks
  const aAttacks = typeA === 'ATTACK';
  const bAttacks = typeB === 'ATTACK';
  if (aAttacks || bAttacks) {
    revokeOffersBy(a.captainId);
    revokeOffersBy(b.captainId);
    nextDemand = null;
    if (aAttacks && bAttacks) {
      // Both from pre-round state
      const atkA = resolveAttack(a, b, false, rng);
      const atkB = resolveAttack(b, a, false, rng);
      attacks.push(atkA, atkB);
      events.push('mutual_attack');
      if (atkA.destroyed || atkB.destroyed) return done('TERMINAL', true, 'destroyed');
      return done('COMBAT', false);
    }
    const attacker = aAttacks ? a : b;
    const defender = aAttacks ? b : a;
    const atk = resolveAttack(attacker, defender, false, rng);
    attacks.push(atk);
    events.push('attack');
    if (atk.destroyed) return done('TERMINAL', true, 'destroyed');
    return done('COMBAT', false);
  }

  // Priority 4: demand compliance / trade acceptance
  if ((typeA === 'DEMAND' && typeB === 'COMPLY') || (typeB === 'DEMAND' && typeA === 'COMPLY')) {
    const demander = typeA === 'DEMAND' ? a : b;
    const target = typeA === 'DEMAND' ? b : a;
    const demand = (typeA === 'DEMAND' ? actionA.demand : actionB.demand)!;
    if (canFulfilDemand(target, demand)) {
      transfers.push({
        kind: 'demand',
        fromId: target.captainId,
        toId: demander.captainId,
        credits: demand.credits,
        cargo: demand.cargo,
      });
      demandOutcomes.push({ demanderId: demander.captainId, targetId: target.captainId, result: 'COMPLIED' });
      events.push('demand_complied');
      return done('TERMINAL', true, 'demand_transfer');
    }
    demandOutcomes.push({ demanderId: demander.captainId, targetId: target.captainId, result: 'NOT_COMPLIED' });
    events.push('demand_not_complied');
    nextDemand = { demanderId: demander.captainId, demand };
    return done('NEGOTIATION', false);
  }

  if (typeA === 'COMPLY' || typeB === 'COMPLY') {
    const complier = typeA === 'COMPLY' ? a : b;
    const other = typeA === 'COMPLY' ? b : a;
    const demand = pendingDemand && pendingDemand.demanderId === other.captainId
      ? pendingDemand.demand
      : null;
    if (!demand) {
      // invalid COMPLY → deterministic phase fallback (IGNORE in NEGOTIATION): disengage
      events.push('comply_without_demand');
      return done('TERMINAL', true, 'disengage');
    } else if (canFulfilDemand(complier, demand)) {
      transfers.push({
        kind: 'demand',
        fromId: complier.captainId,
        toId: other.captainId,
        credits: demand.credits,
        cargo: demand.cargo,
      });
      demandOutcomes.push({ demanderId: other.captainId, targetId: complier.captainId, result: 'COMPLIED' });
      return done('TERMINAL', true, 'demand_transfer');
    } else {
      demandOutcomes.push({ demanderId: other.captainId, targetId: complier.captainId, result: 'NOT_COMPLIED' });
      return done('NEGOTIATION', false);
    }
  }

  // Mutual TRADE_OFFER same exchange
  if (typeA === 'TRADE_OFFER' && typeB === 'TRADE_OFFER' && actionA.tradeOffer && actionB.tradeOffer) {
    const offerA = offerFrom(a.captainId, a.captainId, actionA.tradeOffer);
    const offerB = offerFrom(b.captainId, a.captainId, actionB.tradeOffer);
    if (offerA.proposalHash === offerB.proposalHash) {
      const ex = offerA.exchange;
      if (
        canFulfilOutgoing(a, ex.aToB.credits, ex.aToB.cargo)
        && canFulfilOutgoing(b, ex.bToA.credits, ex.bToA.cargo)
      ) {
        transfers.push(
          { kind: 'trade', fromId: a.captainId, toId: b.captainId, credits: ex.aToB.credits, cargo: ex.aToB.cargo },
          { kind: 'trade', fromId: b.captainId, toId: a.captainId, credits: ex.bToA.credits, cargo: ex.bToA.cargo },
        );
        events.push('mutual_trade_commit');
        return done('TERMINAL', true, 'trade');
      }
    }
    nextOffers = [offerA, offerB];
    events.push('trade_offers_differ');
    return done('NEGOTIATION', false);
  }

  // ACCEPT_TRADE vs pending / simultaneous
  const tryAccept = (
    acceptor: CombatantSnapshot,
    acceptorAction: CaptainAction,
    proposer: CombatantSnapshot,
    proposerAction: CaptainAction,
  ): boolean => {
    if (acceptorAction.type !== 'ACCEPT_TRADE' || !acceptorAction.acceptProposalHash) return false;
    const revoked = ['ATTACK', 'FLEE', 'IGNORE', 'DEMAND', 'SURRENDER', 'TRADE_OFFER'].includes(proposerAction.type);
    if (revoked && proposerAction.type !== 'HAIL') {
      // proposer replaced/revoked
      if (proposerAction.type === 'TRADE_OFFER') return false;
      return false;
    }
    const pending = pendingOffers.find(
      (o) => o.proposerId === proposer.captainId && o.proposalHash === acceptorAction.acceptProposalHash,
    );
    if (!pending) return false;
    const ex = pending.exchange;
    // pending.exchange is always normalized with A=participant a
    const aOut = ex.aToB;
    const bOut = ex.bToA;
    if (!canFulfilOutgoing(a, aOut.credits, aOut.cargo) || !canFulfilOutgoing(b, bOut.credits, bOut.cargo)) {
      return false;
    }
    transfers.push(
      { kind: 'trade', fromId: a.captainId, toId: b.captainId, credits: aOut.credits, cargo: aOut.cargo },
      { kind: 'trade', fromId: b.captainId, toId: a.captainId, credits: bOut.credits, cargo: bOut.cargo },
    );
    events.push('trade_accepted');
    return true;
  };

  if (typeA === 'ACCEPT_TRADE' && tryAccept(a, actionA, b, actionB)) {
    return done('TERMINAL', true, 'trade');
  }
  if (typeB === 'ACCEPT_TRADE' && tryAccept(b, actionB, a, actionA)) {
    return done('TERMINAL', true, 'trade');
  }
  if (typeA === 'ACCEPT_TRADE' && typeB === 'ACCEPT_TRADE') {
    // both accept same pending canonical exchange only
    events.push('dual_accept_stale');
    return done('NEGOTIATION', false);
  }

  // Priority 5: unresolved demands and trade proposals
  if (typeA === 'DEMAND' && typeB === 'DEMAND') {
    revokeOffersBy(a.captainId);
    revokeOffersBy(b.captainId);
    events.push('mutual_demand');
    demandOutcomes.push(
      { demanderId: a.captainId, targetId: b.captainId, result: 'NOT_COMPLIED' },
      { demanderId: b.captainId, targetId: a.captainId, result: 'NOT_COMPLIED' },
    );
    return done('NEGOTIATION', false);
  }

  if (typeA === 'DEMAND' || typeB === 'DEMAND') {
    const demander = typeA === 'DEMAND' ? a : b;
    const otherAction = typeA === 'DEMAND' ? actionB : actionA;
    const demand = (typeA === 'DEMAND' ? actionA.demand : actionB.demand)!;
    revokeOffersBy(demander.captainId);
    nextDemand = { demanderId: demander.captainId, demand };
    events.push('demand_revealed');
    if (otherAction.type === 'IGNORE') {
      const ignorer = typeA === 'DEMAND' ? b : a;
      revokeOffersBy(ignorer.captainId);
      demandOutcomes.push({
        demanderId: demander.captainId,
        targetId: ignorer.captainId,
        result: 'NOT_COMPLIED',
      });
      events.push('demand_disengage');
      return done('TERMINAL', true, 'disengage');
    }
    if (otherAction.type === 'TRADE_OFFER' && otherAction.tradeOffer) {
      const other = typeA === 'DEMAND' ? b : a;
      nextOffers = [offerFrom(other.captainId, a.captainId, otherAction.tradeOffer)];
    }
    return done('NEGOTIATION', false);
  }

  if (typeA === 'TRADE_OFFER' || typeB === 'TRADE_OFFER') {
    if (typeA === 'TRADE_OFFER' && actionA.tradeOffer) {
      revokeOffersBy(a.captainId);
      nextOffers = [...nextOffers.filter((o) => o.proposerId !== a.captainId), offerFrom(a.captainId, a.captainId, actionA.tradeOffer)];
    }
    if (typeB === 'TRADE_OFFER' && actionB.tradeOffer) {
      revokeOffersBy(b.captainId);
      nextOffers = [...nextOffers.filter((o) => o.proposerId !== b.captainId), offerFrom(b.captainId, a.captainId, actionB.tradeOffer)];
    }
    const otherIgnore = (typeA === 'TRADE_OFFER' && typeB === 'IGNORE') || (typeB === 'TRADE_OFFER' && typeA === 'IGNORE');
    if (otherIgnore) {
      revokeOffersBy(typeA === 'IGNORE' ? a.captainId : b.captainId);
      events.push('trade_ignored');
      return done('TERMINAL', true, 'disengage');
    }
    events.push('trade_offer_pending');
    return done('NEGOTIATION', false);
  }

  // Priority 6: hail and disengagement
  if (typeA === 'IGNORE' || typeB === 'IGNORE') {
    if (typeA === 'IGNORE') revokeOffersBy(a.captainId);
    if (typeB === 'IGNORE') revokeOffersBy(b.captainId);
    events.push('disengage');
    return done('TERMINAL', true, 'disengage');
  }

  if (typeA === 'HAIL' || typeB === 'HAIL') {
    events.push('hail');
    return done('NEGOTIATION', false);
  }

  return done(phase === 'CONTACT' ? 'NEGOTIATION' : phase, false);

  function done(
    nextPhase: RoundResolution['phaseAfter'],
    isEnded: boolean,
    reason?: string,
  ): RoundResolution {
    return {
      phaseAfter: nextPhase,
      ended: isEnded,
      ...(reason !== undefined ? { endReason: reason } : {}),
      attacks,
      fleeResults,
      transfers,
      demandOutcomes,
      pendingOffers: nextOffers,
      pendingDemand: nextDemand,
      surrenderVictorId,
      messages,
      events,
    };
  }
}

export function resolveSurrenderClaim(
  victorId: string,
  victim: CombatantSnapshot,
  claim: SurrenderClaim | null,
): SettlementTransfer | null {
  if (!claim) return null;
  const credits = Math.max(0, Math.min(claim.credits, victim.credits));
  const available = cargoMap(victim);
  const cargo = [];
  for (const lot of claim.cargo) {
    const have = available.get(lot.good) ?? 0;
    const take = Math.max(0, Math.min(lot.qty, have));
    if (take > 0) cargo.push({ good: lot.good, qty: take });
  }
  if (credits === 0 && cargo.length === 0) return null;
  return {
    kind: 'surrender_claim',
    fromId: victim.captainId,
    toId: victorId,
    credits,
    cargo,
  };
}
