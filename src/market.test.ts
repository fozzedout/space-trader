import { describe, expect, it } from "vitest";
import { GOODS } from "./goods.js";
import { Market } from "./market.js";

describe("Market price formation", () => {
  it("prices at base when inventory is on target", () => {
    const m = new Market("food", 100);
    expect(m.price).toBeCloseTo(GOODS.food.basePrice);
  });

  it("price rises on shortage and falls on surplus", () => {
    const m = new Market("food", 100);
    m.inventory = 20;
    const shortagePrice = m.price;
    m.inventory = 200;
    const surplusPrice = m.price;
    expect(shortagePrice).toBeGreaterThan(GOODS.food.basePrice);
    expect(surplusPrice).toBeLessThan(GOODS.food.basePrice);
  });

  it("price is bounded at extremes", () => {
    const m = new Market("food", 100);
    m.inventory = 0;
    // Empty market: price = base * (1 + elasticity), capped by maxPriceMult.
    const expectedMax = Math.min(1 + GOODS.food.priceElasticity, GOODS.food.maxPriceMult);
    expect(m.price).toBeCloseTo(GOODS.food.basePrice * expectedMax);
    m.inventory = 1e9;
    // Glutted market: clamped at the floor.
    expect(m.price).toBeCloseTo(GOODS.food.basePrice * GOODS.food.minPriceMult);
  });

  it("buying moves the price up immediately (no lag, no smoothing)", () => {
    const m = new Market("food", 100);
    const before = m.price;
    m.executeBuy(50);
    expect(m.price).toBeGreaterThan(before);
    expect(m.inventory).toBe(50);
  });

  it("large trades pay their own price impact (midpoint pricing)", () => {
    const m = new Market("food", 100);
    const bulkCost = m.quoteBuy(50);
    const spotCost = m.price * 50;
    expect(bulkCost).toBeGreaterThan(spotCost); // buying drains stock -> dearer
    const bulkRevenue = m.quoteSell(50);
    const spotRevenue = m.price * 50;
    expect(bulkRevenue).toBeLessThan(spotRevenue); // selling floods stock -> cheaper
  });

  it("rejects buying more than inventory", () => {
    const m = new Market("food", 100);
    expect(() => m.executeBuy(101)).toThrow();
  });
});
