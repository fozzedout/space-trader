import { RandomSource } from './types.js';

/** STO Phase 0 PRNG v1. This is versioned STO infrastructure, not the Palm RNG. */
export class XorShift32 implements RandomSource {
  private state: number;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x6d2b79f5;
  }

  nextUint32(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError('maxExclusive must be a positive safe integer');
    }
    return Math.floor((this.nextUint32() / 0x1_0000_0000) * maxExclusive);
  }

  snapshot(): number {
    return this.state;
  }
}
