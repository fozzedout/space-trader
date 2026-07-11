import { Difficulty, RandomSource } from './types.js';

export type OriginalEncounterKind = 'pirate' | 'police' | 'trader' | 'none';

export interface OriginalEncounterWeights {
  readonly difficulty: Difficulty;
  readonly isFlea: boolean;
  readonly pirateStrength: number;
  readonly policeStrength: number;
  readonly traderStrength: number;
  readonly alreadyRaided?: boolean;
}

/**
 * Original ordinary encounter classifier for one travel click. It omits
 * quest/special encounters, cloaking and post-selection opponent behaviour.
 */
export function originalEncounterKind(
  weights: OriginalEncounterWeights,
  rng: RandomSource,
): OriginalEncounterKind {
  let roll = rng.nextInt(44 - 2 * weights.difficulty);
  if (weights.isFlea) roll *= 2;

  if (roll < weights.pirateStrength && !weights.alreadyRaided) return 'pirate';
  if (roll < weights.pirateStrength + weights.policeStrength) return 'police';
  if (roll < weights.pirateStrength + weights.policeStrength + weights.traderStrength) return 'trader';
  return 'none';
}

/** Original criminal-record multiplier used by the travel encounter roll. */
export function originalPoliceEncounterStrength(baseStrength: number, policeRecord: number): number {
  if (policeRecord < -70) return 3 * baseStrength;
  if (policeRecord < -30) return 2 * baseStrength;
  return baseStrength;
}
