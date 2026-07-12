import { PHASE0_TUNING } from './config.js';
import { clampScore } from './profiles.js';
import type { HostilityBand } from './types.js';

export interface RelationshipState {
  readonly otherCaptainId: string;
  readonly hostilityScore: number;
  readonly facts: readonly string[];
  readonly lastMetAt: number;
  readonly lockedExtreme: boolean;
}

export function hostilityBand(score: number): HostilityBand {
  const s = clampScore(score);
  if (s <= -100) return 'permanent_friend';
  if (s <= -31) return 'favourable';
  if (s >= 100) return 'permanent_grudge';
  if (s >= 31) return 'hostile';
  return 'neutral';
}

export function applyHostilityDelta(state: RelationshipState, delta: number, nowMs: number): RelationshipState {
  if (state.lockedExtreme) return { ...state, lastMetAt: nowMs };
  const next = clampScore(state.hostilityScore + Math.trunc(delta));
  const locked = next <= -100 || next >= 100;
  return {
    ...state,
    hostilityScore: next,
    lastMetAt: nowMs,
    lockedExtreme: locked,
  };
}

export function applyBetrayal(state: RelationshipState, nowMs: number): RelationshipState {
  return {
    ...state,
    hostilityScore: 100,
    lastMetAt: nowMs,
    lockedExtreme: true,
    facts: pushFact(state.facts, 'betrayed me'),
  };
}

export function pushFact(facts: readonly string[], fact: string, limit = 5): string[] {
  const next = [fact, ...facts.filter((f) => f !== fact)];
  return next.slice(0, limit);
}

/** Design §8.3: after grace, one point per day toward zero. */
export function decayHostility(state: RelationshipState, nowMs: number): RelationshipState {
  if (state.lockedExtreme) return state;
  const elapsed = nowMs - state.lastMetAt;
  if (elapsed <= PHASE0_TUNING.hostilityDecayGraceMs) return state;
  const days = Math.floor((elapsed - PHASE0_TUNING.hostilityDecayGraceMs) / 86_400_000);
  if (days <= 0) return state;
  let score = state.hostilityScore;
  const step = PHASE0_TUNING.hostilityDecayPerDay;
  for (let i = 0; i < days && score !== 0; i += 1) {
    if (score > 0) score = Math.max(0, score - step);
    else score = Math.min(0, score + step);
  }
  return { ...state, hostilityScore: score };
}

/** Design §5.4 surrender hostility curve for NPC victims. */
export function surrenderHostilityDelta(removedFraction: number): number {
  if (removedFraction <= 0) return PHASE0_TUNING.surrenderMercyHostility;
  const fraction = Math.max(0, Math.min(1, removedFraction));
  return Math.ceil(5 + 45 * fraction);
}

export function accessibleSurrenderValue(
  carriedCredits: number,
  cargo: readonly { good: number; qty: number }[],
  referencePrices: ReadonlyMap<number, number>,
): number {
  let total = Math.max(0, carriedCredits);
  for (const lot of cargo) {
    const price = referencePrices.get(lot.good) ?? 0;
    total += price * lot.qty;
  }
  return total;
}

export function claimedReferenceValue(
  claim: { credits: number; cargo: readonly { good: number; qty: number }[] },
  referencePrices: ReadonlyMap<number, number>,
): number {
  let total = Math.max(0, claim.credits);
  for (const lot of claim.cargo) {
    total += (referencePrices.get(lot.good) ?? 0) * lot.qty;
  }
  return total;
}

export function removedFraction(claimed: number, accessible: number): number {
  return claimed / Math.max(1, accessible);
}
