/**
 * Balance Configuration
 * Centralized configuration for economic parameters that can be adjusted dynamically
 */

export interface BalanceConfig {
  priceElasticity: number;
  minProfitMargin: number;
  maxPriceChangePerTick: number;
  maxPriceMultiplier: number;
  minPriceMultiplier: number;
  // New parameters for improved economic model
  meanReversionStrength: number;      // 0.01-0.05 (1-5% per tick toward base price)
  marketDepthFactor: number;          // 0.3-1.0 (volatility scaling based on market size)
  transactionImpactMultiplier: number; // 0.01-0.1 (immediate price impact from trades)
  inventoryDampingThreshold: number;  // 0.1-0.2 (buffer zone size for extreme inventory)
  sigmoidSteepness: number;           // 2-5 (non-linear response curve shape)
}

let balanceConfig: BalanceConfig = {
  priceElasticity: 0.05, // Reduced from 0.1 to make prices less sensitive to inventory changes
  minProfitMargin: 0.001, // 0.1% minimum - allows many small profitable trades (only 3% buy tax, no sell tax)
  maxPriceChangePerTick: 0.001,
  maxPriceMultiplier: 10.0,
  minPriceMultiplier: 0.1,
  // New defaults
  meanReversionStrength: 0.05,       // 5% per tick toward base price (increased to pull prices back faster)
  marketDepthFactor: 0.5,            // Medium market depth effect
  transactionImpactMultiplier: 0.05, // 5% impact from trades
  inventoryDampingThreshold: 0.15,   // 15% buffer zones
  sigmoidSteepness: 3.0,             // Moderate sigmoid curve
};

export function getBalanceConfig(): BalanceConfig {
  return { ...balanceConfig };
}

export function updateBalanceConfig(updates: Partial<BalanceConfig>): void {
  balanceConfig = { ...balanceConfig, ...updates };
  // Balance config updated silently (no logging)
}

export function getPriceElasticity(): number {
  return balanceConfig.priceElasticity;
}

export function getMinProfitMargin(): number {
  return balanceConfig.minProfitMargin;
}

export function getMaxPriceChangePerTick(): number {
  return balanceConfig.maxPriceChangePerTick;
}

export function getMaxPriceMultiplier(): number {
  return balanceConfig.maxPriceMultiplier;
}

export function getMinPriceMultiplier(): number {
  return balanceConfig.minPriceMultiplier;
}

export function getMeanReversionStrength(): number {
  return balanceConfig.meanReversionStrength;
}

export function getMarketDepthFactor(): number {
  return balanceConfig.marketDepthFactor;
}

export function getTransactionImpactMultiplier(): number {
  return balanceConfig.transactionImpactMultiplier;
}

export function getInventoryDampingThreshold(): number {
  return balanceConfig.inventoryDampingThreshold;
}

export function getSigmoidSteepness(): number {
  return balanceConfig.sigmoidSteepness;
}
