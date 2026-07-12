import { PHASE0_TUNING } from './config.js';
import type { CombatantSnapshot } from './types.js';

export interface StrengthComponents {
  readonly weaponScore: number;
  readonly shieldScore: number;
  readonly hullScore: number;
  readonly mobilityScore: number;
  readonly total: number;
}

/**
 * Encounter-specific strength assessment used only for rational-withdrawal
 * and NPC outmatch decisions (design §7.4). Never shown to players.
 */
export function assessStrength(combatant: CombatantSnapshot): StrengthComponents {
  const weaponScore = combatant.totalWeaponPower * 10 + combatant.fighter * 5;
  const shieldScore = combatant.shields.reduce((sum, s) => sum + Math.max(0, s), 0);
  const hullScore = Math.max(0, combatant.hull) + Math.trunc(combatant.maxHull / 4);
  const mobilityScore = combatant.pilot * 8 + Math.max(0, 4 - combatant.shipSize) * 10;
  const total = weaponScore + shieldScore + hullScore + mobilityScore + combatant.engineer * 3;
  return { weaponScore, shieldScore, hullScore, mobilityScore, total };
}

/** True when self is clearly outmatched by other (design §19.1 / §21). */
export function isClearlyOutmatched(self: CombatantSnapshot, other: CombatantSnapshot): boolean {
  const selfStrength = assessStrength(self).total;
  const otherStrength = Math.max(1, assessStrength(other).total);
  const ratioBps = Math.trunc((selfStrength * 10_000) / otherStrength);
  return ratioBps < PHASE0_TUNING.outmatchStrengthThresholdBps;
}

/** True when fleeing/surrendering is considered rational for profile classification. */
export function isRationalWithdrawal(self: CombatantSnapshot, other: CombatantSnapshot): boolean {
  return isClearlyOutmatched(self, other);
}
