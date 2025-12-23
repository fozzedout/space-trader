import { describe, it, expect } from "vitest";
import { GOODS, getGoodDefinition, getAllGoodIds } from "./goods";
import { TechLevel } from "./types";

describe("Goods", () => {
  it("should have at least one good defined", () => {
    expect(GOODS.length).toBeGreaterThan(0);
  });

  it("should have unique good IDs", () => {
    const ids = GOODS.map((g) => g.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("should have valid good properties", () => {
    for (const good of GOODS) {
      expect(good.id).toBeTruthy();
      expect(good.name).toBeTruthy();
      expect(good.basePrice).toBeGreaterThan(0);
      expect(good.weight).toBeGreaterThan(0);
      expect(good.volatility).toBeGreaterThanOrEqual(0);
      expect(good.volatility).toBeLessThanOrEqual(1);
      expect(good.productionTech).toBeGreaterThanOrEqual(1); // Minimum is AGRICULTURAL (1)
      expect(good.productionTech).toBeLessThanOrEqual(7);
      expect(good.consumptionTech).toBeGreaterThanOrEqual(1); // Minimum is AGRICULTURAL (1)
      expect(good.consumptionTech).toBeLessThanOrEqual(7);
    }
  });

  it("should find good by ID", () => {
    const good = getGoodDefinition("food");
    expect(good).toBeDefined();
    expect(good?.id).toBe("food");
  });

  it("should return undefined for non-existent good", () => {
    const good = getGoodDefinition("nonexistent-good" as any);
    expect(good).toBeUndefined();
  });

  it("should return all good IDs", () => {
    const ids = getAllGoodIds();
    expect(ids.length).toBe(GOODS.length);
    expect(ids).toContain("food");
  });

  it("should have goods with different tech requirements", () => {
    const productionTechs = GOODS.map((g) => g.productionTech);
    const consumptionTechs = GOODS.map((g) => g.consumptionTech);

    // Should have variety in tech levels
    expect(new Set(productionTechs).size).toBeGreaterThan(1);
    expect(new Set(consumptionTechs).size).toBeGreaterThan(1);
  });

  it("should have goods with reasonable price ranges", () => {
    const prices = GOODS.map((g) => g.basePrice);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    expect(minPrice).toBeGreaterThan(0);
    expect(maxPrice).toBeGreaterThan(minPrice);
  });

  it("should have food as a basic good", () => {
    const food = getGoodDefinition("food");
    expect(food).toBeDefined();
    expect(food?.productionTech).toBe(TechLevel.AGRICULTURAL);
    expect(food?.consumptionTech).toBe(TechLevel.AGRICULTURAL);
  });

  it("should have high-tech goods", () => {
    const computers = getGoodDefinition("computers");
    expect(computers).toBeDefined();
    expect(computers?.productionTech).toBe(TechLevel.HI_TECH);
  });
});

