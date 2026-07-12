import { PHASE0_TUNING, RULESET_VERSION } from './config.js';
import { RulesetRng, fnv1a32, shuffleDeterministic } from './prng.js';

export interface TravelSequence {
  readonly tripId: string;
  readonly seed: number;
  readonly rulesetVersion: typeof RULESET_VERSION;
  readonly approachTicks: number;
  readonly routeArea: string;
  readonly destinationSystemId: string;
}

export function generateTravelSequence(args: {
  readonly tripId: string;
  readonly seed: number;
  readonly destinationSystemId: string;
  readonly routeArea: string;
}): TravelSequence {
  const rng = new RulesetRng(args.seed);
  const approachTicks = rng.nextInRange(PHASE0_TUNING.approachTicksMin, PHASE0_TUNING.approachTicksMax);
  return {
    tripId: args.tripId,
    seed: args.seed,
    rulesetVersion: RULESET_VERSION,
    approachTicks,
    routeArea: args.routeArea,
    destinationSystemId: args.destinationSystemId,
  };
}

export function globalTick(unixTimeMs: number, travelWindowMs = PHASE0_TUNING.travelWindowMs): number {
  return Math.floor(unixTimeMs / travelWindowMs);
}

export function presenceKey(routeArea: string, tick: number): string {
  return `${routeArea}:${tick}`;
}

export interface OccupancyInterval {
  readonly captainId: string;
  readonly routeArea: string;
  readonly startedAt: number;
  readonly endsAt: number;
  readonly travelGroupId?: string;
  /** When true, this captain is the externally matchable member of a travel group. */
  readonly matchable?: boolean;
  readonly claimed?: boolean;
}

export function windowsOverlapping(
  startedAt: number,
  endsAt: number,
  travelWindowMs = PHASE0_TUNING.travelWindowMs,
): number[] {
  const first = globalTick(startedAt, travelWindowMs);
  const last = globalTick(Math.max(startedAt, endsAt - 1), travelWindowMs);
  const out: number[] = [];
  for (let t = first; t <= last; t += 1) out.push(t);
  return out;
}

export interface EncounterPair {
  readonly encounterId: string;
  readonly captainAId: string;
  readonly captainBId: string;
  readonly routeArea: string;
  readonly globalTick: number;
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function deriveEncounterId(
  systemId: string,
  routeArea: string,
  tick: number,
  captainAId: string,
  captainBId: string,
): string {
  const [a, b] = orderedPair(captainAId, captainBId);
  const raw = `${systemId}|${routeArea}|${tick}|${a}|${b}|${RULESET_VERSION}`;
  return `enc-${fnv1a32(raw).toString(16)}`;
}

/**
 * Deterministic non-overlapping one-on-one pairing for a closed global window
 * (design §4.3). Companion group members are never paired against each other;
 * only the matchable captain is externally eligible.
 */
export function matchEncounterPairs(args: {
  readonly systemId: string;
  readonly routeArea: string;
  readonly globalTick: number;
  readonly eligible: readonly OccupancyInterval[];
}): EncounterPair[] {
  const byGroup = new Map<string, OccupancyInterval[]>();
  const singles: OccupancyInterval[] = [];

  for (const row of args.eligible) {
    if (row.claimed) continue;
    if (row.travelGroupId) {
      const list = byGroup.get(row.travelGroupId) ?? [];
      list.push(row);
      byGroup.set(row.travelGroupId, list);
      continue;
    }
    singles.push(row);
  }

  const matchable: OccupancyInterval[] = [...singles];
  for (const members of byGroup.values()) {
    const external = members.find((m) => m.matchable !== false && m.matchable !== undefined)
      ?? members.find((m) => m.matchable !== false);
    // Design: companion NPC removed from independent matching; human remains matchable.
    const human = members.find((m) => m.matchable === true);
    if (human) matchable.push(human);
    else if (external) matchable.push(external);
  }

  const sorted = [...matchable].sort((a, b) => (a.captainId < b.captainId ? -1 : a.captainId > b.captainId ? 1 : 0));
  const seed = fnv1a32(`${args.systemId}+${args.routeArea}+${args.globalTick}+${RULESET_VERSION}`);
  const shuffled = shuffleDeterministic(sorted, new RulesetRng(seed));

  const pairs: EncounterPair[] = [];
  const used = new Set<string>();
  for (let i = 0; i + 1 < shuffled.length; i += 1) {
    const left = shuffled[i]!;
    if (used.has(left.captainId)) continue;
    let partner: OccupancyInterval | null = null;
    for (let j = i + 1; j < shuffled.length; j += 1) {
      const cand = shuffled[j]!;
      if (used.has(cand.captainId)) continue;
      if (left.travelGroupId && left.travelGroupId === cand.travelGroupId) continue;
      partner = cand;
      break;
    }
    if (!partner) continue;
    used.add(left.captainId);
    used.add(partner.captainId);
    const [a, b] = orderedPair(left.captainId, partner.captainId);
    pairs.push({
      encounterId: deriveEncounterId(args.systemId, args.routeArea, args.globalTick, a, b),
      captainAId: a,
      captainBId: b,
      routeArea: args.routeArea,
      globalTick: args.globalTick,
    });
  }
  return pairs;
}

export function hostileEncounterWeightBps(hasCompanion: boolean): number {
  return hasCompanion ? PHASE0_TUNING.companionHostileWeightFactorBps : 10_000;
}
