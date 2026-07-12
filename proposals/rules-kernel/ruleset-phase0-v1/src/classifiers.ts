import type { BehaviourClass } from './types.js';
import { isRationalWithdrawal } from './strength.js';
import type { CombatantSnapshot } from './types.js';
import { moveBehaviourScore } from './profiles.js';
import {
  applyHostilityDelta,
  pushFact,
  surrenderHostilityDelta,
  type RelationshipState,
} from './relationships.js';
import { PHASE0_TUNING } from './config.js';

export interface ClassifiedChoice {
  readonly behaviour: BehaviourClass;
  readonly reason: string;
}

/**
 * Contextual behaviour classification (design §7.3).
 * Proxy-controlled choices must not be passed in for human profile training.
 */
export function classifyAction(args: {
  readonly actionType: string;
  readonly initiatedConflict: boolean;
  readonly escalated: boolean;
  readonly returningFire: boolean;
  readonly self: CombatantSnapshot;
  readonly other: CombatantSnapshot;
  readonly inCombat: boolean;
}): ClassifiedChoice {
  const { actionType } = args;
  if (actionType === 'DEMAND') {
    return { behaviour: 'aggressive', reason: 'coercive_demand' };
  }
  if (actionType === 'ATTACK') {
    if (args.returningFire && !args.initiatedConflict) {
      return { behaviour: 'neutral', reason: 'return_fire' };
    }
    if (args.initiatedConflict || args.escalated) {
      return { behaviour: 'aggressive', reason: 'initiate_or_escalate' };
    }
    return { behaviour: 'aggressive', reason: 'attack' };
  }
  if (actionType === 'FLEE' || actionType === 'SURRENDER') {
    if (args.inCombat && isRationalWithdrawal(args.self, args.other)) {
      return { behaviour: 'neutral', reason: 'rational_withdrawal' };
    }
    return { behaviour: 'passive', reason: actionType.toLowerCase() };
  }
  if (actionType === 'COMPLY') {
    return { behaviour: 'passive', reason: 'comply' };
  }
  if (actionType === 'TRADE_OFFER' || actionType === 'ACCEPT_TRADE') {
    return { behaviour: 'neutral', reason: 'trade' };
  }
  if (actionType === 'IGNORE' || actionType === 'HAIL') {
    return { behaviour: 'neutral', reason: actionType.toLowerCase() };
  }
  return { behaviour: 'neutral', reason: 'other' };
}

export function applyBehaviourChoices(
  currentScore: number,
  choices: readonly ClassifiedChoice[],
  humanControlled: boolean,
): number {
  if (!humanControlled) return currentScore;
  let score = currentScore;
  for (const choice of choices) {
    score = moveBehaviourScore(score, choice.behaviour);
  }
  return score;
}

export function classifyRelationshipDelta(args: {
  readonly state: RelationshipState;
  readonly nowMs: number;
  readonly attackedFriend: boolean;
  readonly rescued: boolean;
  readonly surrenderRemovedFraction?: number;
  readonly demanded: boolean;
  readonly tradedFavourably: boolean;
  readonly ignored: boolean;
}): RelationshipState {
  let state = args.state;
  if (args.attackedFriend) {
    return {
      ...state,
      hostilityScore: 100,
      lockedExtreme: true,
      lastMetAt: args.nowMs,
      facts: pushFact(state.facts, 'betrayed me'),
    };
  }
  if (args.rescued) {
    state = applyHostilityDelta(state, -PHASE0_TUNING.hostilityMajor, args.nowMs);
    return { ...state, facts: pushFact(state.facts, 'rescued my escape pod') };
  }
  if (args.surrenderRemovedFraction !== undefined) {
    const delta = surrenderHostilityDelta(args.surrenderRemovedFraction);
    const fact = args.surrenderRemovedFraction <= 0 ? 'showed mercy after surrender' : 'looted my surrender';
    state = applyHostilityDelta(state, delta, args.nowMs);
    return { ...state, facts: pushFact(state.facts, fact) };
  }
  if (args.demanded) {
    state = applyHostilityDelta(state, PHASE0_TUNING.hostilityMajor, args.nowMs);
    return { ...state, facts: pushFact(state.facts, 'demanded tribute') };
  }
  if (args.tradedFavourably) {
    state = applyHostilityDelta(state, -PHASE0_TUNING.hostilityMinor, args.nowMs);
    return { ...state, facts: pushFact(state.facts, 'gave me a favourable deal') };
  }
  if (args.ignored) {
    // gradual drift toward neutral is handled by decay; no immediate swing
    return { ...state, lastMetAt: args.nowMs };
  }
  return state;
}
