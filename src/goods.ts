/**
 * Goods catalog and market definitions
 */

import { GoodId, TechLevel, WorldType } from "./types";

export interface GoodDefinition {
  id: GoodId;
  name: string;
  basePrice: number; // price at tech level 0
  weight: number; // cargo space per unit
  volatility: number; // price volatility factor (0-1)
  productionTech: TechLevel; // minimum tech level to produce
  consumptionTech: TechLevel; // minimum tech level to consume
}

export const GOODS: GoodDefinition[] = [
  { id: "food", name: "Food", basePrice: 10, weight: 1, volatility: 0.1, productionTech: TechLevel.AGRICULTURAL, consumptionTech: TechLevel.AGRICULTURAL },
  { id: "textiles", name: "Textiles", basePrice: 20, weight: 1, volatility: 0.15, productionTech: TechLevel.AGRICULTURAL, consumptionTech: TechLevel.AGRICULTURAL },
  { id: "metals", name: "Metals", basePrice: 50, weight: 2, volatility: 0.2, productionTech: TechLevel.MEDIEVAL, consumptionTech: TechLevel.MEDIEVAL },
  { id: "machinery", name: "Machinery", basePrice: 200, weight: 5, volatility: 0.25, productionTech: TechLevel.EARLY_INDUSTRIAL, consumptionTech: TechLevel.EARLY_INDUSTRIAL },
  { id: "electronics", name: "Electronics", basePrice: 500, weight: 2, volatility: 0.3, productionTech: TechLevel.POST_INDUSTRIAL, consumptionTech: TechLevel.POST_INDUSTRIAL },
  { id: "computers", name: "Computers", basePrice: 1000, weight: 1, volatility: 0.35, productionTech: TechLevel.HI_TECH, consumptionTech: TechLevel.HI_TECH },
  { id: "luxuries", name: "Luxuries", basePrice: 300, weight: 1, volatility: 0.4, productionTech: TechLevel.RENAISSANCE, consumptionTech: TechLevel.RENAISSANCE },
  { id: "medicines", name: "Medicines", basePrice: 30, weight: 1, volatility: 0.2, productionTech: TechLevel.INDUSTRIAL, consumptionTech: TechLevel.RENAISSANCE },
  { id: "weapons", name: "Weapons", basePrice: 800, weight: 3, volatility: 0.5, productionTech: TechLevel.INDUSTRIAL, consumptionTech: TechLevel.MEDIEVAL },
  { id: "narcotics", name: "Narcotics", basePrice: 2000, weight: 1, volatility: 0.6, productionTech: TechLevel.POST_INDUSTRIAL, consumptionTech: TechLevel.POST_INDUSTRIAL },
];

export function getGoodDefinition(goodId: GoodId): GoodDefinition | undefined {
  return GOODS.find(g => g.id === goodId);
}

export function getAllGoodIds(): GoodId[] {
  return GOODS.map(g => g.id);
}

/**
 * Check if a good is specialized for a world type
 */
export function isSpecializedGood(goodId: GoodId, worldType: WorldType): boolean {
  const good = getGoodDefinition(goodId);
  if (!good) return false;

  switch (worldType) {
    case WorldType.AGRICULTURAL:
      return goodId === "food" || goodId === "textiles";
    case WorldType.INDUSTRIAL:
      return goodId === "machinery" || goodId === "metals" || goodId === "weapons";
    case WorldType.HIGH_TECH:
      return goodId === "electronics" || goodId === "computers" || goodId === "narcotics";
    case WorldType.MINING:
      return goodId === "metals";
    case WorldType.RESORT:
      return goodId === "luxuries"; // Resorts produce luxuries
    case WorldType.TRADE_HUB:
      return false; // No specialization
    default:
      return false;
  }
}

