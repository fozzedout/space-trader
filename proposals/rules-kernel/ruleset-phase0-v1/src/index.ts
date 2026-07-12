export { RULESET_VERSION, PRNG_VERSION, PHASE0_TUNING } from './config.js';
export type { RulesetVersion, Phase0Tuning } from './config.js';

export * from './types.js';
export * from './prng.js';
export * from './profiles.js';
export * from './relationships.js';
export * from './market.js';
export * from './trade-offer.js';
export * from './strength.js';
export * from './encounter-resolver.js';
export * from './police-encounter.js';
export * from './npc-policy.js';
export * from './crime.js';
export * from './travel-matching.js';
export * from './wreck.js';
export * from './classifiers.js';
export { runAmbientEconomy, runScriptedEncounter } from './simulation/harness.js';
export type { EconomySimResult, EconomyCreditSnapshot, EncounterSimResult } from './simulation/harness.js';

/** Re-export commonly needed baseline symbols for consumers. */
export {
  COMMODITIES,
  POLITICS,
  SHIP_TYPES,
  WEAPONS,
  SHIELDS,
  GADGETS,
  CommodityId,
  XorShift32,
  ESCAPE_POD_PRICE,
  fuelPurchaseCost,
  repairCost,
  shipPurchasePrice,
  shipTradeInValue,
  equipmentPurchasePrice,
  originalPoliceEncounterStrength,
} from '@sto/original-baseline-rules';
