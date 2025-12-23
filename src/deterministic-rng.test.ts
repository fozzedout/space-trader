import { describe, it, expect } from "vitest";
import { DeterministicRNG } from "./deterministic-rng";

describe("DeterministicRNG", () => {
  it("should produce the same sequence with the same seed", () => {
    const rng1 = new DeterministicRNG("test-seed");
    const rng2 = new DeterministicRNG("test-seed");

    const values1 = Array.from({ length: 10 }, () => rng1.random());
    const values2 = Array.from({ length: 10 }, () => rng2.random());

    expect(values1).toEqual(values2);
  });

  it("should produce different sequences with different seeds", () => {
    const rng1 = new DeterministicRNG("seed-1");
    const rng2 = new DeterministicRNG("seed-2");

    const values1 = Array.from({ length: 10 }, () => rng1.random());
    const values2 = Array.from({ length: 10 }, () => rng2.random());

    expect(values1).not.toEqual(values2);
  });

  it("should generate random numbers in [0, 1)", () => {
    const rng = new DeterministicRNG("test");
    const values = Array.from({ length: 1000 }, () => rng.random());

    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("should generate random integers in range [min, max]", () => {
    const rng = new DeterministicRNG("test");
    const values = Array.from({ length: 100 }, () => rng.randomInt(5, 10));

    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(10);
    }
  });

  it("should generate random floats in range [min, max)", () => {
    const rng = new DeterministicRNG("test");
    const values = Array.from({ length: 100 }, () => rng.randomFloat(5, 10));

    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThan(10);
    }
  });

  it("should derive new RNG with additional seed", () => {
    const rng1 = new DeterministicRNG("base-seed");
    const rng2 = rng1.derive("additional");

    // Derived RNG should be deterministic
    const rng3 = new DeterministicRNG("base-seed");
    const rng4 = rng3.derive("additional");

    const value1 = rng2.random();
    const value2 = rng4.random();

    expect(value1).toBe(value2);
  });

  it("should pick random choice from array", () => {
    const rng = new DeterministicRNG("test");
    const array = ["a", "b", "c", "d", "e"];
    const choice = rng.randomChoice(array);

    expect(array).toContain(choice);
  });

  it("should shuffle array deterministically", () => {
    const rng1 = new DeterministicRNG("test");
    const rng2 = new DeterministicRNG("test");
    const array = [1, 2, 3, 4, 5];

    const shuffled1 = rng1.shuffle(array);
    const shuffled2 = rng2.shuffle(array);

    expect(shuffled1).toEqual(shuffled2);
    expect(shuffled1).toHaveLength(array.length);
    expect(shuffled1.sort()).toEqual(array.sort());
  });

  it("should make weighted random choice", () => {
    const rng = new DeterministicRNG("test");
    const items = [
      { item: "a", weight: 1 },
      { item: "b", weight: 2 },
      { item: "c", weight: 3 },
    ];

    // Run multiple times to ensure it works
    for (let i = 0; i < 10; i++) {
      const choice = rng.weightedChoice(items);
      expect(["a", "b", "c"]).toContain(choice);
    }
  });

  it("should handle edge cases in weighted choice", () => {
    const rng = new DeterministicRNG("test");
    const items = [{ item: "only", weight: 1 }];

    expect(rng.weightedChoice(items)).toBe("only");
  });

  it("should maintain determinism across multiple operations", () => {
    const seed = "complex-test";
    const rng1 = new DeterministicRNG(seed);
    const rng2 = new DeterministicRNG(seed);

    // Perform various operations
    const results1 = [
      rng1.random(),
      rng1.randomInt(0, 100),
      rng1.randomFloat(0, 100),
      rng1.randomChoice(["a", "b", "c"]),
      rng1.shuffle([1, 2, 3, 4, 5]),
    ];

    const results2 = [
      rng2.random(),
      rng2.randomInt(0, 100),
      rng2.randomFloat(0, 100),
      rng2.randomChoice(["a", "b", "c"]),
      rng2.shuffle([1, 2, 3, 4, 5]),
    ];

    expect(results1).toEqual(results2);
  });
});

