import { PHASE0_TUNING } from './config.js';
import { RulesetRng, weightedPick } from './prng.js';
import { isWanted, profileBand } from './profiles.js';
import { hostilityBand } from './relationships.js';
import { isClearlyOutmatched } from './strength.js';
import { canonicalizeExchange } from './trade-offer.js';
import type { RelationshipState } from './relationships.js';
import type {
  BilateralExchange,
  CaptainAction,
  CombatantSnapshot,
  EncounterPhase,
  PendingTradeOffer,
  SurrenderClaim,
} from './types.js';

export interface DecideInput {
  readonly phase: EncounterPhase | 'SURRENDER_RESOLUTION';
  readonly self: CombatantSnapshot;
  readonly other: CombatantSnapshot;
  readonly relationship: RelationshipState | null;
  readonly pendingOffers: readonly PendingTradeOffer[];
  readonly pendingDemandDemanderId: string | null;
  readonly surrenderVictorId: string | null;
  readonly roundNo: number;
  readonly rng: RulesetRng;
  /** Visible public info only — never private scores of the other captain. */
  readonly otherPublicDisposition: 'passive' | 'neutral' | 'aggressive';
}

export interface DecideResult {
  readonly action: CaptainAction;
}

function action(
  type: CaptainAction['type'],
  roundNo: number,
  extra: Partial<CaptainAction> = {},
): CaptainAction {
  return {
    actionId: `npc-${roundNo}-${type}`,
    roundNo,
    type,
    ...extra,
  };
}

function fairTradeOffer(self: CombatantSnapshot, other: CombatantSnapshot, markupBps: number): BilateralExchange | null {
  const selfGood = self.cargo.find((c) => c.qty > 0);
  if (!selfGood) {
    if (self.credits < 50) return null;
    const credits = Math.min(self.credits, 100 + Math.trunc(self.credits / 20));
    return canonicalizeExchange({
      aToB: { credits, cargo: [] },
      bToA: { credits: 0, cargo: [{ good: 0, qty: 1 }] },
    });
  }
  const qty = Math.max(1, Math.min(3, selfGood.qty));
  const base = 50 * qty;
  const price = Math.max(1, Math.round((base * (10_000 + markupBps)) / 10_000));
  // Offer our cargo for credits (caller normalizes roles via encounter resolver).
  return canonicalizeExchange({
    aToB: { credits: 0, cargo: [{ good: selfGood.good, qty }] },
    bToA: { credits: price, cargo: [] },
  });
}

function demandSpec(self: CombatantSnapshot, other: CombatantSnapshot, fractionBps: number) {
  const credits = Math.trunc((other.credits * fractionBps) / 10_000);
  const cargo = other.cargo.slice(0, 1).map((c) => ({
    good: c.good,
    qty: Math.max(1, Math.trunc((c.qty * fractionBps) / 10_000)),
  })).filter((c) => c.qty > 0);
  return { credits: Math.max(0, credits), cargo };
}

/**
 * Ordinary NPC priority policy (design §19.1).
 * Deterministic given encounter state, profiles, relationship, seed, and RNG position.
 */
export function decideOrdinaryNpc(input: DecideInput): DecideResult {
  const { phase, self, other, relationship, roundNo, rng } = input;
  const combatBand = profileBand(self.combatProfile);
  const tradeBand = profileBand(self.tradeProfile);
  const hostility = relationship ? hostilityBand(relationship.hostilityScore) : 'neutral';
  const outmatched = isClearlyOutmatched(self, other);

  if (phase === 'SURRENDER_RESOLUTION') {
    if (input.surrenderVictorId !== self.captainId) {
      return { action: action('IGNORE', roundNo) };
    }
    const fractionBps = hostility === 'permanent_friend'
      ? 0
      : PHASE0_TUNING.npcSurrenderClaimFractionBps[combatBand];
    const claim = buildSurrenderClaim(other, fractionBps);
    return { action: action('SURRENDER_CLAIM', roundNo, { surrenderClaim: claim }) };
  }

  // 1. Permanent friendship
  if (hostility === 'permanent_friend') {
    if (phase === 'COMBAT') {
      return { action: action(outmatched ? 'FLEE' : 'SURRENDER', roundNo) };
    }
    const pending = input.pendingOffers.find((o) => o.proposerId === other.captainId);
    if (pending && phase === 'NEGOTIATION') {
      return { action: action('ACCEPT_TRADE', roundNo, { acceptProposalHash: pending.proposalHash }) };
    }
    const markup = PHASE0_TUNING.npcTradeMarkupBps[tradeBand];
    const offer = fairTradeOffer(self, other, markup);
    if (offer && rng.nextInt(100) < 60) {
      return { action: action('TRADE_OFFER', roundNo, { tradeOffer: offer, messageKey: 'friend_trade' }) };
    }
    return { action: action(rng.nextInt(2) === 0 ? 'HAIL' : 'IGNORE', roundNo, { messageKey: 'friend_hail' }) };
  }

  // 2. Permanent grudge
  if (hostility === 'permanent_grudge') {
    if (outmatched) return { action: action(phase === 'COMBAT' ? 'FLEE' : 'IGNORE', roundNo) };
    if (phase === 'COMBAT') return { action: action('ATTACK', roundNo) };
    return { action: action('ATTACK', roundNo, { messageKey: 'grudge_attack' }) };
  }

  // 3. Wanted target hunting
  if (isWanted(other.policeRecord) && !isWanted(self.policeRecord) && !outmatched) {
    if (phase === 'COMBAT') return { action: action('ATTACK', roundNo) };
    if (rng.nextInt(100) < 70) return { action: action('ATTACK', roundNo, { messageKey: 'bounty_hunt' }) };
  }
  if (isWanted(other.policeRecord) && isWanted(self.policeRecord) && !outmatched) {
    if (phase === 'COMBAT') return { action: action('ATTACK', roundNo) };
    if (rng.nextInt(100) < 50) return { action: action('ATTACK', roundNo) };
  }

  // Combat phase behaviour (rule 7)
  if (phase === 'COMBAT') {
    if (outmatched || combatBand === 'passive') {
      return { action: action(rng.nextInt(100) < 60 ? 'FLEE' : 'SURRENDER', roundNo) };
    }
    if (combatBand === 'aggressive') return { action: action('ATTACK', roundNo) };
    return { action: action(outmatched ? 'FLEE' : 'ATTACK', roundNo) };
  }

  // Comply with pending demand if passive and demand targets us
  if (input.pendingDemandDemanderId === other.captainId && combatBand === 'passive') {
    return { action: action('COMPLY', roundNo) };
  }

  // 4. Hostile relationship
  if (hostility === 'hostile') {
    const weights = PHASE0_TUNING.npcHostileActionWeights[combatBand];
    const pick = weightedPick(weights, rng);
    if (pick === 'demand') {
      const fraction = PHASE0_TUNING.npcDemandCreditsFractionBps[combatBand];
      return {
        action: action('DEMAND', roundNo, {
          demand: demandSpec(self, other, fraction),
          messageKey: 'hostile_demand',
        }),
      };
    }
    return { action: action(pick.toUpperCase() as CaptainAction['type'], roundNo) };
  }

  // 5. Favourable
  if (hostility === 'favourable') {
    if (isWanted(other.policeRecord) && !outmatched && rng.nextInt(100) < 40) {
      return { action: action('ATTACK', roundNo) };
    }
    const pick = weightedPick(PHASE0_TUNING.npcFavourableActionWeights, rng);
    if (pick === 'tradeOffer') {
      const offer = fairTradeOffer(self, other, PHASE0_TUNING.npcTradeMarkupBps[tradeBand]);
      if (offer) return { action: action('TRADE_OFFER', roundNo, { tradeOffer: offer }) };
    }
    return { action: action(pick === 'hail' ? 'HAIL' : 'IGNORE', roundNo) };
  }

  // 6. Neutral — trade vs combat profile weights
  const pending = input.pendingOffers.find((o) => o.proposerId === other.captainId);
  if (pending && tradeBand !== 'passive' && rng.nextInt(100) < (tradeBand === 'aggressive' ? 40 : 55)) {
    return { action: action('ACCEPT_TRADE', roundNo, { acceptProposalHash: pending.proposalHash }) };
  }

  const weights: Record<string, number> = { ...PHASE0_TUNING.npcNeutralActionWeights };
  if (tradeBand === 'aggressive') weights.tradeOffer = (weights.tradeOffer ?? 0) + 15;
  if (tradeBand === 'passive') weights.tradeOffer = Math.max(0, (weights.tradeOffer ?? 0) - 20);
  if (combatBand === 'aggressive') {
    weights.attack = (weights.attack ?? 0) + 15;
    weights.demand = (weights.demand ?? 0) + 10;
  }
  if (combatBand === 'passive') {
    weights.flee = (weights.flee ?? 0) + 20;
    weights.attack = 0;
    weights.demand = 0;
  }
  const pick = weightedPick(weights, rng);
  if (pick === 'tradeOffer') {
    const offer = fairTradeOffer(self, other, PHASE0_TUNING.npcTradeMarkupBps[tradeBand]);
    if (offer) return { action: action('TRADE_OFFER', roundNo, { tradeOffer: offer }) };
    return { action: action('HAIL', roundNo) };
  }
  if (pick === 'demand') {
    return {
      action: action('DEMAND', roundNo, {
        demand: demandSpec(self, other, PHASE0_TUNING.npcDemandCreditsFractionBps[combatBand]),
      }),
    };
  }
  return { action: action(pick.toUpperCase() as CaptainAction['type'], roundNo) };
}

function buildSurrenderClaim(victim: CombatantSnapshot, fractionBps: number): SurrenderClaim {
  if (fractionBps <= 0) return { credits: 0, cargo: [] };
  const credits = Math.trunc((victim.credits * fractionBps) / 10_000);
  const cargo = victim.cargo.map((c) => ({
    good: c.good,
    qty: Math.trunc((c.qty * fractionBps) / 10_000),
  })).filter((c) => c.qty > 0);
  return { credits, cargo };
}

/** Learned proxy policy from profile bands (design §6.3). */
export function decideLearnedProxy(input: DecideInput): DecideResult {
  const band = profileBand(input.self.combatProfile);
  const { phase, roundNo, rng } = input;
  if (phase === 'SURRENDER_RESOLUTION') {
    const fraction = PHASE0_TUNING.npcSurrenderClaimFractionBps[band];
    return {
      action: action('SURRENDER_CLAIM', roundNo, {
        surrenderClaim: buildSurrenderClaim(input.other, fraction),
      }),
    };
  }
  if (phase === 'COMBAT') {
    if (band === 'aggressive') return { action: action('ATTACK', roundNo) };
    if (band === 'passive') {
      return { action: action(isClearlyOutmatched(input.self, input.other) || rng.nextInt(100) < 70 ? 'FLEE' : 'SURRENDER', roundNo) };
    }
    return { action: action(isClearlyOutmatched(input.self, input.other) ? 'FLEE' : 'ATTACK', roundNo) };
  }
  if (band === 'aggressive') {
    return {
      action: action(rng.nextInt(100) < 55 ? 'DEMAND' : 'ATTACK', roundNo, {
        demand: demandSpec(input.self, input.other, PHASE0_TUNING.npcDemandCreditsFractionBps.aggressive),
      }),
    };
  }
  if (band === 'passive') {
    return { action: action(rng.nextInt(100) < 60 ? 'FLEE' : 'IGNORE', roundNo) };
  }
  const pending = input.pendingOffers.find((o) => o.proposerId === input.other.captainId);
  if (pending) return { action: action('ACCEPT_TRADE', roundNo, { acceptProposalHash: pending.proposalHash }) };
  return { action: action(rng.nextInt(100) < 50 ? 'HAIL' : 'IGNORE', roundNo) };
}

/** Generic coward proxy (design §6.3). */
export function decideCowardProxy(input: DecideInput): DecideResult {
  const { phase, roundNo } = input;
  if (phase === 'SURRENDER_RESOLUTION') {
    return { action: action('SURRENDER_CLAIM', roundNo, { surrenderClaim: { credits: 0, cargo: [] } }) };
  }
  if (phase === 'COMBAT') {
    return { action: action('FLEE', roundNo, { messageKey: 'coward_flee' }) };
  }
  return { action: action('FLEE', roundNo, { messageKey: 'coward_flee' }) };
}

export type ControllerPolicy = 'ordinary_npc' | 'learned_proxy' | 'coward_proxy';

export function decide(
  policy: ControllerPolicy,
  input: DecideInput,
): DecideResult {
  if (policy === 'learned_proxy') return decideLearnedProxy(input);
  if (policy === 'coward_proxy') return decideCowardProxy(input);
  return decideOrdinaryNpc(input);
}
