export type Difficulty = 0 | 1 | 2 | 3 | 4;
export type TechLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type SystemSize = 0 | 1 | 2 | 3 | 4;

export enum CommodityId {
  Water = 0,
  Furs = 1,
  Food = 2,
  Ore = 3,
  Games = 4,
  Firearms = 5,
  Medicine = 6,
  Machines = 7,
  Narcotics = 8,
  Robots = 9,
}

export enum SystemStatus {
  Uneventful = 0,
  War = 1,
  Plague = 2,
  Drought = 3,
  Boredom = 4,
  Cold = 5,
  CropFailure = 6,
  LackOfWorkers = 7,
}

export enum SpecialResource {
  None = 0,
  MineralRich = 1,
  MineralPoor = 2,
  Desert = 3,
  SweetwaterOceans = 4,
  RichSoil = 5,
  PoorSoil = 6,
  RichFauna = 7,
  Lifeless = 8,
  WeirdMushrooms = 9,
  SpecialHerbs = 10,
  ArtisticPopulace = 11,
  WarlikePopulace = 12,
}

export interface CommodityDefinition {
  readonly id: CommodityId;
  readonly name: string;
  readonly techProduction: TechLevel;
  readonly techUsage: TechLevel;
  readonly techTopProduction: TechLevel;
  readonly priceLowTech: number;
  readonly priceIncrease: number;
  readonly variance: number;
  readonly doublePriceStatus: SystemStatus;
  readonly cheapResource: SpecialResource | null;
  readonly expensiveResource: SpecialResource | null;
  readonly minTradePrice: number;
  readonly maxTradePrice: number;
  readonly roundOff: number;
  readonly illegal: boolean;
}

export interface PoliticsDefinition {
  readonly id: number;
  readonly name: string;
  readonly reactionIllegal: number;
  readonly strengthPolice: number;
  readonly strengthPirates: number;
  readonly strengthTraders: number;
  readonly minTechLevel: TechLevel;
  readonly maxTechLevel: TechLevel;
  readonly bribeLevel: number;
  readonly drugsAllowed: boolean;
  readonly firearmsAllowed: boolean;
  readonly wantedCommodity: CommodityId | null;
}

export interface ShipTypeDefinition {
  readonly id: number;
  readonly name: string;
  readonly cargoBays: number;
  readonly weaponSlots: number;
  readonly shieldSlots: number;
  readonly gadgetSlots: number;
  readonly crewQuarters: number;
  readonly fuelTanks: number;
  readonly minTechLevel: number;
  readonly fuelCostPerParsec: number;
  readonly basePrice: number;
  readonly baseBounty: number;
  readonly occurrencePercent: number;
  readonly hullStrength: number;
  readonly policeMinimum: number;
  readonly pirateMinimum: number;
  readonly traderMinimum: number;
  readonly repairCostPerHull: number;
  readonly size: number;
  readonly purchasable: boolean;
}

export interface EquipmentDefinition {
  readonly id: number;
  readonly name: string;
  readonly price: number;
  readonly minTechLevel: number;
  readonly occurrencePercent: number;
  readonly purchasable: boolean;
}

export interface WeaponDefinition extends EquipmentDefinition {
  readonly power: number;
}

export interface ShieldDefinition extends EquipmentDefinition {
  readonly power: number;
}

export interface MarketContext {
  readonly techLevel: TechLevel;
  readonly politicsId: number;
  readonly size: SystemSize;
  readonly status: SystemStatus;
  readonly resource: SpecialResource;
  readonly difficulty: Difficulty;
}

export interface RandomSource {
  nextInt(maxExclusive: number): number;
}

export interface CrewSkills {
  readonly pilot: number;
  readonly fighter: number;
  readonly trader: number;
  readonly engineer: number;
}

export interface GadgetFlags {
  readonly navigatingSystem?: boolean;
  readonly cloakingDevice?: boolean;
  readonly targetingSystem?: boolean;
  readonly autoRepairSystem?: boolean;
}

export interface InstalledEquipmentValue {
  readonly weapons: readonly number[];
  readonly shields: readonly number[];
  readonly gadgets: readonly number[];
}
