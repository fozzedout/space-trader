import { Difficulty, RandomSource } from './types.js';

const trunc = Math.trunc;

/** Original hit test: fleeing doubles the defender's random dodge term. */
export function attackHits(
  attackerFighter: number,
  defenderShipSize: number,
  defenderPilot: number,
  defenderFleeing: boolean,
  rng: RandomSource,
): boolean {
  const attackRoll = rng.nextInt(Math.max(1, attackerFighter + defenderShipSize));
  const dodgeRoll = rng.nextInt(Math.max(1, 5 + trunc(defenderPilot / 2)));
  return attackRoll >= (defenderFleeing ? 2 : 1) * dodgeRoll;
}

export function weaponDamage(totalWeaponPower: number, attackerEngineer: number, rng: RandomSource): number {
  if (totalWeaponPower <= 0) return 0;
  const maximumExclusive = Math.max(1, trunc(totalWeaponPower * (100 + 2 * attackerEngineer) / 100));
  return rng.nextInt(maximumExclusive);
}

/**
 * Original hull mitigation and per-hit cap. maxHullStrength is the ship's
 * maximum hull, not its current remaining hull.
 */
export function reduceHullDamage(
  rawHullDamage: number,
  defenderEngineer: number,
  maxHullStrength: number,
  difficulty: Difficulty,
  rng: RandomSource,
): number {
  let damage = Math.max(0, rawHullDamage - rng.nextInt(Math.max(1, defenderEngineer)));
  const divisor = difficulty === 0 ? 4 : difficulty === 1 ? 3 : difficulty === 2 ? 2 : 1;
  const cap = divisor === 1 ? maxHullStrength : Math.max(1, trunc(maxHullStrength / divisor));
  damage = Math.min(damage, cap);
  return Math.max(0, damage);
}

export function commanderFleeSucceeds(playerPilot: number, opponentPilot: number, difficulty: Difficulty, rng: RandomSource): boolean {
  if (difficulty === 0) return true;
  const left = (rng.nextInt(7) + trunc(playerPilot / 3)) * 2;
  const right = rng.nextInt(Math.max(1, opponentPilot)) * (2 + difficulty);
  return left >= right;
}

export function opponentFleeSucceeds(playerPilot: number, opponentPilot: number, rng: RandomSource): boolean {
  return rng.nextInt(Math.max(1, playerPilot)) * 4 <= rng.nextInt(Math.max(1, 7 + trunc(opponentPilot / 3))) * 2;
}

export function absorbWithShields(damage: number, shieldStrengths: readonly number[]): { remainingDamage: number; shields: number[] } {
  let remaining = Math.max(0, damage);
  const shields = [...shieldStrengths];
  for (let i = 0; i < shields.length && remaining > 0; i += 1) {
    const available = Math.max(0, shields[i] ?? 0);
    const absorbed = Math.min(available, remaining);
    shields[i] = available - absorbed;
    remaining -= absorbed;
  }
  return { remainingDamage: remaining, shields };
}

export function scoopChanceDenominator(difficulty: Difficulty): number {
  return difficulty <= 1 ? 1 : difficulty === 2 ? 2 : difficulty === 3 ? 3 : 4;
}
