import {
  CommodityDefinition,
  CommodityId,
  EquipmentDefinition,
  PoliticsDefinition,
  ShieldDefinition,
  ShipTypeDefinition,
  SpecialResource,
  SystemStatus,
  WeaponDefinition,
} from './types.js';

export const TECH_LEVEL_NAMES = [
  'Pre-agricultural', 'Agricultural', 'Medieval', 'Renaissance',
  'Early Industrial', 'Industrial', 'Post-industrial', 'Hi-tech',
] as const;

export const COMMODITIES: readonly CommodityDefinition[] = [
  { id: CommodityId.Water, name: 'Water', techProduction: 0, techUsage: 0, techTopProduction: 2, priceLowTech: 30, priceIncrease: 3, variance: 4, doublePriceStatus: SystemStatus.Drought, cheapResource: SpecialResource.SweetwaterOceans, expensiveResource: SpecialResource.Desert, minTradePrice: 30, maxTradePrice: 50, roundOff: 1, illegal: false },
  { id: CommodityId.Furs, name: 'Furs', techProduction: 0, techUsage: 0, techTopProduction: 0, priceLowTech: 250, priceIncrease: 10, variance: 10, doublePriceStatus: SystemStatus.Cold, cheapResource: SpecialResource.RichFauna, expensiveResource: SpecialResource.Lifeless, minTradePrice: 230, maxTradePrice: 280, roundOff: 5, illegal: false },
  { id: CommodityId.Food, name: 'Food', techProduction: 1, techUsage: 0, techTopProduction: 1, priceLowTech: 100, priceIncrease: 5, variance: 5, doublePriceStatus: SystemStatus.CropFailure, cheapResource: SpecialResource.RichSoil, expensiveResource: SpecialResource.PoorSoil, minTradePrice: 90, maxTradePrice: 160, roundOff: 5, illegal: false },
  { id: CommodityId.Ore, name: 'Ore', techProduction: 2, techUsage: 2, techTopProduction: 3, priceLowTech: 350, priceIncrease: 20, variance: 10, doublePriceStatus: SystemStatus.War, cheapResource: SpecialResource.MineralRich, expensiveResource: SpecialResource.MineralPoor, minTradePrice: 350, maxTradePrice: 420, roundOff: 10, illegal: false },
  { id: CommodityId.Games, name: 'Games', techProduction: 3, techUsage: 1, techTopProduction: 6, priceLowTech: 250, priceIncrease: -10, variance: 5, doublePriceStatus: SystemStatus.Boredom, cheapResource: SpecialResource.ArtisticPopulace, expensiveResource: null, minTradePrice: 160, maxTradePrice: 270, roundOff: 5, illegal: false },
  { id: CommodityId.Firearms, name: 'Firearms', techProduction: 3, techUsage: 1, techTopProduction: 5, priceLowTech: 1250, priceIncrease: -75, variance: 100, doublePriceStatus: SystemStatus.War, cheapResource: SpecialResource.WarlikePopulace, expensiveResource: null, minTradePrice: 600, maxTradePrice: 1100, roundOff: 25, illegal: true },
  { id: CommodityId.Medicine, name: 'Medicine', techProduction: 4, techUsage: 1, techTopProduction: 6, priceLowTech: 650, priceIncrease: -20, variance: 10, doublePriceStatus: SystemStatus.Plague, cheapResource: SpecialResource.SpecialHerbs, expensiveResource: null, minTradePrice: 400, maxTradePrice: 700, roundOff: 25, illegal: false },
  { id: CommodityId.Machines, name: 'Machines', techProduction: 4, techUsage: 3, techTopProduction: 5, priceLowTech: 900, priceIncrease: -30, variance: 5, doublePriceStatus: SystemStatus.LackOfWorkers, cheapResource: null, expensiveResource: null, minTradePrice: 600, maxTradePrice: 800, roundOff: 25, illegal: false },
  { id: CommodityId.Narcotics, name: 'Narcotics', techProduction: 5, techUsage: 0, techTopProduction: 5, priceLowTech: 3500, priceIncrease: -125, variance: 150, doublePriceStatus: SystemStatus.Boredom, cheapResource: SpecialResource.WeirdMushrooms, expensiveResource: null, minTradePrice: 2000, maxTradePrice: 3000, roundOff: 50, illegal: true },
  { id: CommodityId.Robots, name: 'Robots', techProduction: 6, techUsage: 4, techTopProduction: 7, priceLowTech: 5000, priceIncrease: -150, variance: 100, doublePriceStatus: SystemStatus.LackOfWorkers, cheapResource: null, expensiveResource: null, minTradePrice: 3500, maxTradePrice: 5000, roundOff: 100, illegal: false },
] as const;

export const POLITICS: readonly PoliticsDefinition[] = [
  { id: 0, name: 'Anarchy', reactionIllegal: 0, strengthPolice: 0, strengthPirates: 7, strengthTraders: 1, minTechLevel: 0, maxTechLevel: 5, bribeLevel: 7, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: CommodityId.Food },
  { id: 1, name: 'Capitalist State', reactionIllegal: 2, strengthPolice: 3, strengthPirates: 2, strengthTraders: 7, minTechLevel: 4, maxTechLevel: 7, bribeLevel: 1, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: CommodityId.Ore },
  { id: 2, name: 'Communist State', reactionIllegal: 6, strengthPolice: 6, strengthPirates: 4, strengthTraders: 4, minTechLevel: 1, maxTechLevel: 5, bribeLevel: 5, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: null },
  { id: 3, name: 'Confederacy', reactionIllegal: 5, strengthPolice: 4, strengthPirates: 3, strengthTraders: 5, minTechLevel: 1, maxTechLevel: 6, bribeLevel: 3, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: CommodityId.Games },
  { id: 4, name: 'Corporate State', reactionIllegal: 2, strengthPolice: 6, strengthPirates: 2, strengthTraders: 7, minTechLevel: 4, maxTechLevel: 7, bribeLevel: 2, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: CommodityId.Robots },
  { id: 5, name: 'Cybernetic State', reactionIllegal: 0, strengthPolice: 7, strengthPirates: 7, strengthTraders: 5, minTechLevel: 6, maxTechLevel: 7, bribeLevel: 0, drugsAllowed: false, firearmsAllowed: false, wantedCommodity: CommodityId.Ore },
  { id: 6, name: 'Democracy', reactionIllegal: 4, strengthPolice: 3, strengthPirates: 2, strengthTraders: 5, minTechLevel: 3, maxTechLevel: 7, bribeLevel: 2, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: CommodityId.Games },
  { id: 7, name: 'Dictatorship', reactionIllegal: 3, strengthPolice: 4, strengthPirates: 5, strengthTraders: 3, minTechLevel: 0, maxTechLevel: 7, bribeLevel: 2, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: null },
  { id: 8, name: 'Fascist State', reactionIllegal: 7, strengthPolice: 7, strengthPirates: 7, strengthTraders: 1, minTechLevel: 4, maxTechLevel: 7, bribeLevel: 0, drugsAllowed: false, firearmsAllowed: true, wantedCommodity: CommodityId.Machines },
  { id: 9, name: 'Feudal State', reactionIllegal: 1, strengthPolice: 1, strengthPirates: 6, strengthTraders: 2, minTechLevel: 0, maxTechLevel: 3, bribeLevel: 6, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: CommodityId.Firearms },
  { id: 10, name: 'Military State', reactionIllegal: 7, strengthPolice: 7, strengthPirates: 0, strengthTraders: 6, minTechLevel: 2, maxTechLevel: 7, bribeLevel: 0, drugsAllowed: false, firearmsAllowed: true, wantedCommodity: CommodityId.Robots },
  { id: 11, name: 'Monarchy', reactionIllegal: 3, strengthPolice: 4, strengthPirates: 3, strengthTraders: 4, minTechLevel: 0, maxTechLevel: 5, bribeLevel: 4, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: CommodityId.Medicine },
  { id: 12, name: 'Pacifist State', reactionIllegal: 7, strengthPolice: 2, strengthPirates: 1, strengthTraders: 5, minTechLevel: 0, maxTechLevel: 3, bribeLevel: 1, drugsAllowed: true, firearmsAllowed: false, wantedCommodity: null },
  { id: 13, name: 'Socialist State', reactionIllegal: 4, strengthPolice: 2, strengthPirates: 5, strengthTraders: 3, minTechLevel: 0, maxTechLevel: 5, bribeLevel: 6, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: null },
  { id: 14, name: 'State of Satori', reactionIllegal: 0, strengthPolice: 1, strengthPirates: 1, strengthTraders: 1, minTechLevel: 0, maxTechLevel: 1, bribeLevel: 0, drugsAllowed: false, firearmsAllowed: false, wantedCommodity: null },
  { id: 15, name: 'Technocracy', reactionIllegal: 1, strengthPolice: 6, strengthPirates: 3, strengthTraders: 6, minTechLevel: 4, maxTechLevel: 7, bribeLevel: 2, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: CommodityId.Water },
  { id: 16, name: 'Theocracy', reactionIllegal: 5, strengthPolice: 6, strengthPirates: 1, strengthTraders: 4, minTechLevel: 0, maxTechLevel: 4, bribeLevel: 0, drugsAllowed: true, firearmsAllowed: true, wantedCommodity: CommodityId.Narcotics },
] as const;

export const SHIP_TYPES: readonly ShipTypeDefinition[] = [
  { id: 0, name: 'Flea', cargoBays: 10, weaponSlots: 0, shieldSlots: 0, gadgetSlots: 0, crewQuarters: 1, fuelTanks: 20, minTechLevel: 4, fuelCostPerParsec: 1, basePrice: 2000, baseBounty: 5, occurrencePercent: 2, hullStrength: 25, policeMinimum: -1, pirateMinimum: -1, traderMinimum: 0, repairCostPerHull: 1, size: 0, purchasable: true },
  { id: 1, name: 'Gnat', cargoBays: 15, weaponSlots: 1, shieldSlots: 0, gadgetSlots: 1, crewQuarters: 1, fuelTanks: 14, minTechLevel: 5, fuelCostPerParsec: 2, basePrice: 10000, baseBounty: 50, occurrencePercent: 28, hullStrength: 100, policeMinimum: 0, pirateMinimum: 0, traderMinimum: 0, repairCostPerHull: 1, size: 1, purchasable: true },
  { id: 2, name: 'Firefly', cargoBays: 20, weaponSlots: 1, shieldSlots: 1, gadgetSlots: 1, crewQuarters: 1, fuelTanks: 17, minTechLevel: 5, fuelCostPerParsec: 3, basePrice: 25000, baseBounty: 75, occurrencePercent: 20, hullStrength: 100, policeMinimum: 0, pirateMinimum: 0, traderMinimum: 0, repairCostPerHull: 1, size: 1, purchasable: true },
  { id: 3, name: 'Mosquito', cargoBays: 15, weaponSlots: 2, shieldSlots: 1, gadgetSlots: 1, crewQuarters: 1, fuelTanks: 13, minTechLevel: 5, fuelCostPerParsec: 5, basePrice: 30000, baseBounty: 100, occurrencePercent: 20, hullStrength: 100, policeMinimum: 0, pirateMinimum: 1, traderMinimum: 0, repairCostPerHull: 1, size: 1, purchasable: true },
  { id: 4, name: 'Bumblebee', cargoBays: 25, weaponSlots: 1, shieldSlots: 2, gadgetSlots: 2, crewQuarters: 2, fuelTanks: 15, minTechLevel: 5, fuelCostPerParsec: 7, basePrice: 60000, baseBounty: 125, occurrencePercent: 15, hullStrength: 100, policeMinimum: 1, pirateMinimum: 1, traderMinimum: 0, repairCostPerHull: 1, size: 2, purchasable: true },
  { id: 5, name: 'Beetle', cargoBays: 50, weaponSlots: 0, shieldSlots: 1, gadgetSlots: 1, crewQuarters: 3, fuelTanks: 14, minTechLevel: 5, fuelCostPerParsec: 10, basePrice: 80000, baseBounty: 50, occurrencePercent: 3, hullStrength: 50, policeMinimum: -1, pirateMinimum: -1, traderMinimum: 0, repairCostPerHull: 1, size: 2, purchasable: true },
  { id: 6, name: 'Hornet', cargoBays: 20, weaponSlots: 3, shieldSlots: 2, gadgetSlots: 1, crewQuarters: 2, fuelTanks: 16, minTechLevel: 6, fuelCostPerParsec: 15, basePrice: 100000, baseBounty: 200, occurrencePercent: 6, hullStrength: 150, policeMinimum: 2, pirateMinimum: 3, traderMinimum: 1, repairCostPerHull: 2, size: 3, purchasable: true },
  { id: 7, name: 'Grasshopper', cargoBays: 30, weaponSlots: 2, shieldSlots: 2, gadgetSlots: 3, crewQuarters: 3, fuelTanks: 15, minTechLevel: 6, fuelCostPerParsec: 15, basePrice: 150000, baseBounty: 300, occurrencePercent: 2, hullStrength: 150, policeMinimum: 3, pirateMinimum: 4, traderMinimum: 2, repairCostPerHull: 3, size: 3, purchasable: true },
  { id: 8, name: 'Termite', cargoBays: 60, weaponSlots: 1, shieldSlots: 3, gadgetSlots: 2, crewQuarters: 3, fuelTanks: 13, minTechLevel: 7, fuelCostPerParsec: 20, basePrice: 225000, baseBounty: 300, occurrencePercent: 2, hullStrength: 200, policeMinimum: 4, pirateMinimum: 5, traderMinimum: 3, repairCostPerHull: 4, size: 4, purchasable: true },
  { id: 9, name: 'Wasp', cargoBays: 35, weaponSlots: 3, shieldSlots: 2, gadgetSlots: 2, crewQuarters: 3, fuelTanks: 14, minTechLevel: 7, fuelCostPerParsec: 20, basePrice: 300000, baseBounty: 500, occurrencePercent: 2, hullStrength: 200, policeMinimum: 5, pirateMinimum: 6, traderMinimum: 4, repairCostPerHull: 5, size: 4, purchasable: true },
  { id: 10, name: 'Space monster', cargoBays: 0, weaponSlots: 3, shieldSlots: 0, gadgetSlots: 0, crewQuarters: 1, fuelTanks: 1, minTechLevel: 8, fuelCostPerParsec: 1, basePrice: 500000, baseBounty: 0, occurrencePercent: 0, hullStrength: 500, policeMinimum: 8, pirateMinimum: 8, traderMinimum: 8, repairCostPerHull: 1, size: 4, purchasable: false },
  { id: 11, name: 'Dragonfly', cargoBays: 0, weaponSlots: 2, shieldSlots: 3, gadgetSlots: 2, crewQuarters: 1, fuelTanks: 1, minTechLevel: 8, fuelCostPerParsec: 1, basePrice: 500000, baseBounty: 0, occurrencePercent: 0, hullStrength: 10, policeMinimum: 8, pirateMinimum: 8, traderMinimum: 8, repairCostPerHull: 1, size: 1, purchasable: false },
  { id: 12, name: 'Mantis', cargoBays: 0, weaponSlots: 3, shieldSlots: 1, gadgetSlots: 3, crewQuarters: 3, fuelTanks: 1, minTechLevel: 8, fuelCostPerParsec: 1, basePrice: 500000, baseBounty: 0, occurrencePercent: 0, hullStrength: 300, policeMinimum: 8, pirateMinimum: 8, traderMinimum: 8, repairCostPerHull: 1, size: 2, purchasable: false },
  { id: 13, name: 'Scarab', cargoBays: 20, weaponSlots: 2, shieldSlots: 0, gadgetSlots: 0, crewQuarters: 2, fuelTanks: 1, minTechLevel: 8, fuelCostPerParsec: 1, basePrice: 500000, baseBounty: 0, occurrencePercent: 0, hullStrength: 400, policeMinimum: 8, pirateMinimum: 8, traderMinimum: 8, repairCostPerHull: 1, size: 3, purchasable: false },
  { id: 14, name: 'Bottle', cargoBays: 0, weaponSlots: 0, shieldSlots: 0, gadgetSlots: 0, crewQuarters: 0, fuelTanks: 1, minTechLevel: 8, fuelCostPerParsec: 1, basePrice: 100, baseBounty: 0, occurrencePercent: 0, hullStrength: 10, policeMinimum: 8, pirateMinimum: 8, traderMinimum: 8, repairCostPerHull: 1, size: 1, purchasable: false },
] as const;

export const WEAPONS: readonly WeaponDefinition[] = [
  { id: 0, name: 'Pulse laser', power: 15, price: 2000, minTechLevel: 5, occurrencePercent: 50, purchasable: true },
  { id: 1, name: 'Beam laser', power: 25, price: 12500, minTechLevel: 6, occurrencePercent: 35, purchasable: true },
  { id: 2, name: 'Military laser', power: 35, price: 35000, minTechLevel: 7, occurrencePercent: 15, purchasable: true },
  { id: 3, name: "Morgan's laser", power: 85, price: 50000, minTechLevel: 8, occurrencePercent: 0, purchasable: false },
] as const;

export const SHIELDS: readonly ShieldDefinition[] = [
  { id: 0, name: 'Energy shield', power: 100, price: 5000, minTechLevel: 5, occurrencePercent: 70, purchasable: true },
  { id: 1, name: 'Reflective shield', power: 200, price: 20000, minTechLevel: 6, occurrencePercent: 30, purchasable: true },
  { id: 2, name: 'Lightning shield', power: 350, price: 45000, minTechLevel: 8, occurrencePercent: 0, purchasable: false },
] as const;

export const GADGETS: readonly EquipmentDefinition[] = [
  { id: 0, name: '5 extra cargo bays', price: 2500, minTechLevel: 4, occurrencePercent: 35, purchasable: true },
  { id: 1, name: 'Auto-repair system', price: 7500, minTechLevel: 5, occurrencePercent: 20, purchasable: true },
  { id: 2, name: 'Navigating system', price: 15000, minTechLevel: 6, occurrencePercent: 20, purchasable: true },
  { id: 3, name: 'Targeting system', price: 25000, minTechLevel: 6, occurrencePercent: 20, purchasable: true },
  { id: 4, name: 'Cloaking device', price: 100000, minTechLevel: 7, occurrencePercent: 5, purchasable: true },
  { id: 5, name: 'Fuel compactor', price: 30000, minTechLevel: 8, occurrencePercent: 0, purchasable: false },
] as const;

export const ESCAPE_POD_PRICE = 2000;
export const MAX_SKILL = 10;
export const SKILL_BONUS = 3;
export const CLOAK_BONUS = 2;
