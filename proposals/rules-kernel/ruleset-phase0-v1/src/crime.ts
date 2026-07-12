import { PHASE0_TUNING } from './config.js';
import { activeBounty, clampScore, isWanted, wantedSeverity } from './profiles.js';

export type CrimeKind =
  | 'attempted_piracy'
  | 'completed_theft'
  | 'unprovoked_attack'
  | 'unlawful_destruction'
  | 'escape_pod_attack'
  | 'lawful_return_fire'
  | 'wanted_target_destruction'
  | 'flee_inspection'
  | 'attack_police'
  | 'destroy_police';

export interface CrimeEvent {
  readonly kind: CrimeKind;
  readonly actorId: string;
  readonly targetId?: string;
  readonly valueTaken?: number;
  readonly removedFraction?: number;
  readonly policeDelta: number;
}

export interface DestructionLegalContext {
  readonly killerId: string;
  readonly victimId: string;
  /** Captured immediately before terminal destruction (design §11.4). */
  readonly killerPoliceRecordBefore: number;
  readonly victimPoliceRecordBefore: number;
  readonly killerInitiatedUnprovoked: boolean;
}

export interface BountySettlement {
  readonly bountyPaid: number;
  readonly killerPoliceDelta: number;
  readonly victimPoliceAfterIfSurvives: number | null;
  readonly lawful: boolean;
  readonly activity: 'bounty_hunting' | 'unlawful_kill' | 'none';
}

export function policeDeltaForCrime(kind: CrimeKind, valueTaken = 0, removedFraction = 0): number {
  switch (kind) {
    case 'attempted_piracy':
      return -PHASE0_TUNING.crimeAttemptedPiracy;
    case 'completed_theft': {
      const scaled = Math.ceil(
        PHASE0_TUNING.crimeCompletedTheftBase
        + (PHASE0_TUNING.crimeCompletedTheftMax - PHASE0_TUNING.crimeCompletedTheftBase) * Math.min(1, removedFraction),
      );
      return -Math.min(PHASE0_TUNING.crimeCompletedTheftMax, scaled + Math.trunc(valueTaken / 10_000));
    }
    case 'unprovoked_attack':
      return -PHASE0_TUNING.crimeUnprovokedAttack;
    case 'unlawful_destruction':
      return -PHASE0_TUNING.crimeUnlawfulDestruction;
    case 'escape_pod_attack':
      return -PHASE0_TUNING.crimeEscapePodAttack;
    case 'flee_inspection':
      return -PHASE0_TUNING.crimeFleeInspection;
    case 'attack_police':
      return -PHASE0_TUNING.crimeAttackPolice;
    case 'destroy_police':
      return -PHASE0_TUNING.crimeDestroyPolice;
    case 'lawful_return_fire':
    case 'wanted_target_destruction':
      return 0;
    default:
      return 0;
  }
}

export function applyPoliceDelta(record: number, delta: number): number {
  return clampScore(record + delta);
}

/** Design §11.5 bounty payment and rehabilitation. */
export function settleDestruction(ctx: DestructionLegalContext): BountySettlement {
  const victimWanted = isWanted(ctx.victimPoliceRecordBefore);
  const killerWanted = isWanted(ctx.killerPoliceRecordBefore);

  if (!victimWanted) {
    return {
      bountyPaid: 0,
      killerPoliceDelta: ctx.killerInitiatedUnprovoked
        ? policeDeltaForCrime('unlawful_destruction')
        : policeDeltaForCrime('unlawful_destruction'),
      victimPoliceAfterIfSurvives: null,
      lawful: false,
      activity: 'unlawful_kill',
    };
  }

  const severity = wantedSeverity(ctx.victimPoliceRecordBefore);
  const bounty = activeBounty(ctx.victimPoliceRecordBefore);
  const standardRehab = severity * PHASE0_TUNING.rehabStandingPerSeverity;

  if (killerWanted) {
    const rehab = Math.trunc((standardRehab * PHASE0_TUNING.wantedKillerRehabMultiplier) / 1_000);
    return {
      bountyPaid: 0,
      killerPoliceDelta: rehab,
      victimPoliceAfterIfSurvives: -30,
      lawful: true,
      activity: 'bounty_hunting',
    };
  }

  return {
    bountyPaid: bounty,
    killerPoliceDelta: standardRehab,
    victimPoliceAfterIfSurvives: -30,
    lawful: true,
    activity: 'bounty_hunting',
  };
}

/**
 * After escape-pod survival of a wanted captain whose bounty was satisfied,
 * any later criminal penalty of at least one point returns them to wanted (design §11.5).
 */
export function applyPostRecoveryCrime(policeRecord: number, delta: number): number {
  if (policeRecord === -30 && delta <= -1) {
    return Math.min(-31, applyPoliceDelta(policeRecord, delta));
  }
  return applyPoliceDelta(policeRecord, delta);
}

export function classifyEncounterCrimes(args: {
  readonly actorId: string;
  readonly targetId: string;
  readonly attemptedPiracy: boolean;
  readonly completedTheft: boolean;
  readonly valueTaken?: number;
  readonly removedFraction?: number;
  readonly unprovokedAttack: boolean;
  readonly returnFireOnly: boolean;
  readonly destroyedEscapePod: boolean;
}): CrimeEvent[] {
  const events: CrimeEvent[] = [];
  if (args.attemptedPiracy && !args.completedTheft) {
    events.push({
      kind: 'attempted_piracy',
      actorId: args.actorId,
      targetId: args.targetId,
      policeDelta: policeDeltaForCrime('attempted_piracy'),
    });
  }
  if (args.completedTheft) {
    events.push({
      kind: 'completed_theft',
      actorId: args.actorId,
      targetId: args.targetId,
      valueTaken: args.valueTaken ?? 0,
      removedFraction: args.removedFraction ?? 0,
      policeDelta: policeDeltaForCrime('completed_theft', args.valueTaken, args.removedFraction),
    });
  }
  if (args.unprovokedAttack) {
    events.push({
      kind: 'unprovoked_attack',
      actorId: args.actorId,
      targetId: args.targetId,
      policeDelta: policeDeltaForCrime('unprovoked_attack'),
    });
  }
  if (args.returnFireOnly) {
    events.push({
      kind: 'lawful_return_fire',
      actorId: args.actorId,
      targetId: args.targetId,
      policeDelta: 0,
    });
  }
  if (args.destroyedEscapePod) {
    events.push({
      kind: 'escape_pod_attack',
      actorId: args.actorId,
      targetId: args.targetId,
      policeDelta: policeDeltaForCrime('escape_pod_attack'),
    });
  }
  return events;
}
