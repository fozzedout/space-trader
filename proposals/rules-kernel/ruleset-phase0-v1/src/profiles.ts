import { PHASE0_TUNING } from './config.js';
import type { BehaviourClass, ProfileBand } from './types.js';

export function clampScore(score: number, min = -100, max = 100): number {
  return Math.max(min, Math.min(max, Math.trunc(score)));
}

export function profileBand(score: number): ProfileBand {
  const s = clampScore(score);
  if (s <= -31) return 'passive';
  if (s >= 31) return 'aggressive';
  return 'neutral';
}

export function publicDisposition(combatProfile: number, tradeProfile: number): ProfileBand {
  const avg = Math.trunc((clampScore(combatProfile) + clampScore(tradeProfile)) / 2);
  return profileBand(avg);
}

/** Design §7.2 score movement. */
export function moveBehaviourScore(current: number, choice: BehaviourClass): number {
  const score = clampScore(current);
  let delta = 0;
  if (score > 0) {
    delta = choice === 'aggressive' ? 1 : choice === 'neutral' ? -1 : -2;
  } else if (score === 0) {
    delta = choice === 'aggressive' ? 1 : choice === 'neutral' ? 0 : -1;
  } else {
    delta = choice === 'aggressive' ? 2 : choice === 'neutral' ? 1 : -1;
  }
  return clampScore(score + delta);
}

export function randomFixedProfileBand(rng: { nextInt(n: number): number }): ProfileBand {
  const roll = rng.nextInt(3);
  return roll === 0 ? 'passive' : roll === 1 ? 'neutral' : 'aggressive';
}

/** Map a band to a representative midpoint score for fixed NPC profiles. */
export function scoreForBand(band: ProfileBand): number {
  if (band === 'passive') return -65;
  if (band === 'aggressive') return 65;
  return 0;
}

export function isWanted(policeRecord: number): boolean {
  return clampScore(policeRecord) <= -31;
}

export function policeStandingBand(policeRecord: number): 'attack_on_sight' | 'wanted' | 'ordinary' | 'trusted' {
  const s = clampScore(policeRecord);
  if (s <= -100) return 'attack_on_sight';
  if (s <= -31) return 'wanted';
  if (s >= 31) return 'trusted';
  return 'ordinary';
}

export function wantedSeverity(policeRecord: number): number {
  const s = clampScore(policeRecord);
  if (s > -31) return 0;
  return Math.max(1, Math.min(70, -30 - s));
}

export function activeBounty(policeRecord: number): number {
  const severity = wantedSeverity(policeRecord);
  if (severity <= 0) return 0;
  return PHASE0_TUNING.baseWantedBounty + severity * PHASE0_TUNING.bountyPerSeverityPoint;
}
