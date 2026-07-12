import { XorShift32 } from '@sto/original-baseline-rules';
import { PRNG_VERSION, RULESET_VERSION } from './config.js';

export { XorShift32 };
export type { RandomSource } from '@sto/original-baseline-rules';

export interface SeededRngMeta {
  readonly seed: number;
  readonly prngVersion: typeof PRNG_VERSION;
  readonly rulesetVersion: typeof RULESET_VERSION;
  readonly drawPosition: number;
}

/** Versioned deterministic PRNG handle used by trips and encounters. */
export class RulesetRng {
  readonly meta: SeededRngMeta;
  private readonly rng: XorShift32;
  private draws: number;

  constructor(seed: number, drawPosition = 0) {
    this.rng = new XorShift32(seed);
    this.draws = 0;
    for (let i = 0; i < drawPosition; i += 1) this.rng.nextUint32();
    this.draws = drawPosition;
    this.meta = {
      seed,
      prngVersion: PRNG_VERSION,
      rulesetVersion: RULESET_VERSION,
      drawPosition,
    };
  }

  nextInt(maxExclusive: number): number {
    this.draws += 1;
    return this.rng.nextInt(maxExclusive);
  }

  nextUint32(): number {
    this.draws += 1;
    return this.rng.nextUint32();
  }

  /** Inclusive range helper for weighted deterministic picks. */
  nextInRange(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive < minInclusive) throw new RangeError('invalid range');
    const span = maxInclusive - minInclusive + 1;
    return minInclusive + this.nextInt(span);
  }

  drawPosition(): number {
    return this.draws;
  }

  snapshotState(): number {
    return this.rng.snapshot();
  }

  fork(labelSalt: number): RulesetRng {
    const childSeed = (this.snapshotState() ^ (labelSalt >>> 0)) >>> 0;
    return new RulesetRng(childSeed || 1);
  }
}

/** Stable 32-bit FNV-1a hash for canonical strings. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic shuffle of a copy using Fisher–Yates with RulesetRng. */
export function shuffleDeterministic<T>(items: readonly T[], rng: RulesetRng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** Pick one key from a weight map; zero-weight keys are ignored. */
export function weightedPick<K extends string>(
  weights: Readonly<Partial<Record<K, number>>>,
  rng: RulesetRng,
): K {
  const entries = Object.entries(weights).filter(([, w]) => (w as number) > 0) as [K, number][];
  if (entries.length === 0) throw new Error('no positive weights');
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng.nextInt(total);
  for (const [key, weight] of entries) {
    if (roll < weight) return key;
    roll -= weight;
  }
  return entries[entries.length - 1]![0];
}
