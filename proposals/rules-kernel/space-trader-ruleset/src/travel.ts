import { Difficulty, RandomSource } from './types.js';

export const ORIGINAL_TRAVEL_CLICKS = 21;

export function wormholeTax(fuelCostPerParsec: number): number {
  return Math.max(0, Math.trunc(fuelCostPerParsec)) * 25;
}

export function debtInterest(debt: number): number {
  if (debt <= 0) return 0;
  return Math.max(1, Math.trunc(debt / 10));
}

export function insurancePremium(shipValue: number, noClaimDays: number): number {
  const discount = 100 - Math.min(Math.max(0, Math.trunc(noClaimDays)), 90);
  return Math.max(1, Math.trunc(Math.trunc(shipValue * 5 / 2000) * discount / 100));
}

export function travelRepair(engineerSkill: number, rng: RandomSource): number {
  return Math.trunc(rng.nextInt(Math.max(1, engineerSkill)) / 2);
}

export function decayOriginalPoliceRecord(score: number, days: number, difficulty: Difficulty): number {
  let result = score;
  for (let day = 1; day <= days; day += 1) {
    if (result > 0 && day % 3 === 0) result -= 1;
    if (result < -5) {
      const interval = difficulty <= 2 ? 1 : difficulty;
      if (day % interval === 0) result += 1;
    }
  }
  return result;
}
