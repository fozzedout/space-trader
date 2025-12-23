/**
 * Role-based pricing system for the economy
 * Implements the role matrix from ECONOMY_EXPECTATIONS.md
 */

import { GoodId, TechLevel, WorldType } from "./types";
import { getGoodDefinition } from "./goods";
import { DeterministicRNG } from "./deterministic-rng";

export type GoodRole = "SP" | "P" | "N" | "C" | "SC";

/**
 * Baseline goods that should always have some consumer demand
 */
const BASELINE_GOODS: Set<GoodId> = new Set([
  "food",
  "textiles",
  "metals",
  "luxuries",
  "medicines", // Once enabled by tech
]);

/**
 * Role multiplier defaults (from Section 5.2)
 */
const ROLE_MULTIPLIERS: Record<GoodRole, { default: number; min: number; max: number }> = {
  SP: { default: 0.55, min: 0.45, max: 0.65 }, // Increased from 0.60 to create larger spreads
  P: { default: 0.75, min: 0.65, max: 0.85 }, // Increased from 0.80
  N: { default: 1.00, min: 0.90, max: 1.10 },
  C: { default: 1.50, min: 1.40, max: 1.70 }, // Increased from 1.40 to create larger spreads
  SC: { default: 2.00, min: 1.80, max: 2.20 }, // Increased from 1.80
};

/**
 * Role matrix: WorldType -> GoodId -> Role
 * From Section 6 of ECONOMY_EXPECTATIONS.md
 */
const ROLE_MATRIX: Record<WorldType, Partial<Record<GoodId, GoodRole>>> = {
  [WorldType.AGRICULTURAL]: {
    food: "SP",
    textiles: "SP",
    metals: "C",
    luxuries: "C",
    weapons: "C", // Only if consumable (TL2+)
    medicines: "SC", // Major consumer - health is critical
    machinery: "C", // Only if consumable (TL4+)
  },
  [WorldType.MINING]: {
    metals: "SP",
    food: "SC",
    textiles: "C",
    luxuries: "C",
    machinery: "C",
    medicines: "SC", // SC for hazard work
    weapons: "C",
  },
  [WorldType.INDUSTRIAL]: {
    machinery: "SP",
    weapons: "SP", // Can be P/SP
    metals: "P",
    food: "SC",
    textiles: "C",
    luxuries: "C",
    medicines: "SC", // Major consumer - industrial workforce demand
    electronics: "C", // At TL6+
    computers: "C", // At TL7
  },
  [WorldType.HIGH_TECH]: {
    electronics: "SP",
    narcotics: "SP", // Can be P/SP
    computers: "SP", // TL7 only
    metals: "C",
    machinery: "C",
    food: "C",
    textiles: "C",
    luxuries: "C",
    medicines: "SC", // Major consumer - advanced healthcare
    weapons: "C",
  },
  [WorldType.TRADE_HUB]: {
    food: "P",
    textiles: "P",
    metals: "N", // Can be P or N
    luxuries: "C",
    machinery: "C",
    medicines: "SC", // Major consumer - trade hub health services
    weapons: "C",
    electronics: "C",
    narcotics: "C",
    computers: "C",
  },
  [WorldType.RESORT]: {
    luxuries: "P", // Can be SP if resorts are main producers
    food: "SC",
    textiles: "C",
    medicines: "SC", // Major consumer - public health, tourism
    electronics: "C", // At TL6+
    computers: "C", // At TL7
    narcotics: "SC", // At TL6+
  },
};

/**
 * Get the base role for a good in a world type (before tech masking)
 */
export function getBaseRole(worldType: WorldType, goodId: GoodId): GoodRole {
  const role = ROLE_MATRIX[worldType]?.[goodId];
  return role || "N";
}

/**
 * Apply tech masking to a role
 * From Section 5.3: If system cannot consume, C/SC -> N. If cannot produce, P/SP -> N.
 */
export function applyTechMasking(
  role: GoodRole,
  canProduce: boolean,
  canConsume: boolean
): GoodRole {
  if (!canConsume && (role === "C" || role === "SC")) {
    return "N";
  }
  if (!canProduce && (role === "P" || role === "SP")) {
    return "N";
  }
  return role;
}

/**
 * Apply baseline demand overlay
 * From Section 7.3: Baseline goods get upgraded from N to C with probability, or get +Δ multiplier
 */
export function applyBaselineDemandOverlay(
  role: GoodRole,
  goodId: GoodId,
  canConsume: boolean,
  rng: DeterministicRNG
): GoodRole {
  if (!canConsume || !BASELINE_GOODS.has(goodId)) {
    return role;
  }
  
  // If role is N and it's a baseline good, upgrade to C with 30% probability
  if (role === "N") {
    if (rng.randomFloat(0, 1) < 0.3) {
      return "C";
    }
  }
  
  return role;
}

/**
 * Apply trade hub spread narrowing
 * From Section 7.4: Trade hubs have narrower spreads
 */
export function applyTradeHubNarrowing(
  role: GoodRole,
  worldType: WorldType,
  multiplier: number
): number {
  if (worldType !== WorldType.TRADE_HUB) {
    return multiplier;
  }
  
  // Narrow the spread: P/SP move up, C/SC move down
  if (role === "P" || role === "SP") {
    return multiplier + 0.10; // Less cheap
  }
  if (role === "C" || role === "SC") {
    return multiplier - 0.10; // Less expensive
  }
  return multiplier;
}

/**
 * Get the price multiplier for a good in a system
 * Implements the full price generation model from Section 7
 */
export function getPriceMultiplier(
  worldType: WorldType,
  techLevel: TechLevel,
  goodId: GoodId,
  rng: DeterministicRNG
): number {
  const good = getGoodDefinition(goodId);
  if (!good) return 1.0;
  
  // Check tech gating
  const canProduce = techLevel >= good.productionTech;
  const canConsume = techLevel >= good.consumptionTech;
  
  // All systems can buy/sell all goods, but pricing reflects ability to consume/produce
  // If can't consume: very low price (producer price, not worth selling to)
  // If can't produce: higher price (consumer price, worth selling to)
  // If can do both: use normal role-based pricing
  // If can do neither: very low price (not worth selling to, but market exists)
  
  // Get base role from matrix
  let role = getBaseRole(worldType, goodId);
  
  // Apply tech masking - but ensure markets always exist
  // If can't consume, force to producer role (low price)
  // If can't produce, force to consumer role (high price)
  if (!canConsume && !canProduce) {
    // Can't do either - very low price (not worth selling to, but market exists)
    role = "SP"; // Special Producer = lowest price
  } else if (!canConsume) {
    // Can't consume - treat as producer (low price, not worth selling to)
    if (role === "C" || role === "SC") {
      role = "P"; // Force to producer price
    }
  } else if (!canProduce) {
    // Can't produce - treat as consumer (high price, worth selling to)
    if (role === "P" || role === "SP") {
      role = "C"; // Force to consumer price
    }
  } else {
    // Can do both - apply normal tech masking
    role = applyTechMasking(role, canProduce, canConsume);
  }
  
  // Apply baseline demand overlay
  role = applyBaselineDemandOverlay(role, goodId, canConsume, rng);
  
  // Get base multiplier for role (with randomization within range)
  const roleDef = ROLE_MULTIPLIERS[role];
  const multiplier = rng.randomFloat(roleDef.min, roleDef.max);
  
  // Apply trade hub narrowing
  let finalMultiplier = applyTradeHubNarrowing(role, worldType, multiplier);
  
  // Apply volatility noise with clamp to prevent role inversion
  // From Section 7.1(3): finalMultiplier ∈ [m_role × (1 - 0.5v), m_role × (1 + 0.5v)]
  const volatilityNoise = rng.randomFloat(-good.volatility, good.volatility);
  const volatilityClamp = 0.5 * good.volatility;
  const minMultiplier = finalMultiplier * (1 - volatilityClamp);
  const maxMultiplier = finalMultiplier * (1 + volatilityClamp);
  finalMultiplier = finalMultiplier * (1 + volatilityNoise);
  finalMultiplier = Math.max(minMultiplier, Math.min(maxMultiplier, finalMultiplier));
  
  // Final clamp to absolute min/max (Section 7.1(5))
  finalMultiplier = Math.max(0.25, Math.min(3.00, finalMultiplier));
  
  return finalMultiplier;
}

