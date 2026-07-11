export interface ScoreBand {
  readonly name: string;
  readonly minimum: number;
}

export const ORIGINAL_POLICE_BANDS: readonly ScoreBand[] = [
  { name: 'Psycho', minimum: -100 },
  { name: 'Villain', minimum: -70 },
  { name: 'Criminal', minimum: -30 },
  { name: 'Crook', minimum: -10 },
  { name: 'Dubious', minimum: -5 },
  { name: 'Clean', minimum: 0 },
  { name: 'Lawful', minimum: 5 },
  { name: 'Trusted', minimum: 10 },
  { name: 'Liked', minimum: 25 },
  { name: 'Hero', minimum: 75 },
] as const;

export const ORIGINAL_REPUTATION_BANDS: readonly ScoreBand[] = [
  { name: 'Harmless', minimum: 0 },
  { name: 'Mostly harmless', minimum: 10 },
  { name: 'Poor', minimum: 20 },
  { name: 'Average', minimum: 40 },
  { name: 'Above average', minimum: 80 },
  { name: 'Competent', minimum: 150 },
  { name: 'Dangerous', minimum: 300 },
  { name: 'Deadly', minimum: 600 },
  { name: 'Elite', minimum: 1500 },
] as const;

function bandFor(score: number, bands: readonly ScoreBand[]): ScoreBand {
  let selected = bands[0]!;
  for (const band of bands) {
    if (score >= band.minimum) selected = band;
  }
  return selected;
}

export function originalPoliceBand(score: number): ScoreBand {
  return bandFor(score, ORIGINAL_POLICE_BANDS);
}

export function originalReputationBand(score: number): ScoreBand {
  return bandFor(score, ORIGINAL_REPUTATION_BANDS);
}

/** Original bounty calculation applied to EnemyShipPrice. */
export function originalShipBounty(enemyShipPrice: number): number {
  const raw = Math.trunc(enemyShipPrice / 200);
  const rounded = Math.trunc(raw / 25) * 25;
  return Math.max(25, Math.min(2500, rounded));
}
