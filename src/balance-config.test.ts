/**
 * Balance config: good production multipliers and related invariants.
 */

import { describe, it, expect } from "vitest";
import { getGoodProductionMultiplier } from "./balance-config";

describe("getGoodProductionMultiplier", () => {
  it("luxuries is 0.95 (−5%)", () => {
    expect(getGoodProductionMultiplier("luxuries")).toBe(0.95);
  });

  it("food is 1.38", () => {
    expect(getGoodProductionMultiplier("food")).toBe(1.38);
  });

  it("electronics is 1.265", () => {
    expect(getGoodProductionMultiplier("electronics")).toBe(1.265);
  });

  it("unknown good defaults to 1.0", () => {
    expect(getGoodProductionMultiplier("unknown" as "food")).toBe(1.0);
  });
});
