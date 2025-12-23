/**
 * Deterministic RNG using seedrandom for reproducible simulations
 */

// @ts-ignore - seedrandom types may not be perfect for this build setup
import seedrandom from "seedrandom";

export class DeterministicRNG {
  private rng: ReturnType<typeof seedrandom>;

  constructor(seed: string) {
    this.rng = seedrandom(seed);
  }

  /**
   * Generate a new RNG instance with a derived seed
   */
  derive(additionalSeed: string): DeterministicRNG {
    return new DeterministicRNG(`${this.rng()}-${additionalSeed}`);
  }

  /**
   * Random number in [0, 1)
   */
  random(): number {
    return this.rng();
  }

  /**
   * Random integer in [min, max] (inclusive)
   */
  randomInt(min: number, max: number): number {
    return Math.floor(this.rng() * (max - min + 1)) + min;
  }

  /**
   * Random float in [min, max)
   */
  randomFloat(min: number, max: number): number {
    return this.rng() * (max - min) + min;
  }

  /**
   * Random element from array
   */
  randomChoice<T>(array: T[]): T {
    return array[this.randomInt(0, array.length - 1)];
  }

  /**
   * Shuffle array (Fisher-Yates)
   */
  shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /**
   * Weighted random choice
   */
  weightedChoice<T>(items: Array<{ item: T; weight: number }>): T {
    if (items.length === 0) {
      throw new Error("weightedChoice called with empty array");
    }
    
    const totalWeight = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
    if (totalWeight <= 0) {
      // If all weights are invalid, just return first item
      return items[0].item;
    }
    
    let random = this.rng() * totalWeight;
    
    for (const { item, weight } of items) {
      random -= Math.max(0, weight);
      if (random <= 0) {
        return item;
      }
    }
    
    return items[items.length - 1].item;
  }
}
