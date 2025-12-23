/**
 * Core types for the galaxy-scale market simulator
 */

export type SystemId = number; // 0-255
export type ShipId = string;
export type GoodId = string;
export type Timestamp = number; // milliseconds since epoch

export enum GovernmentType {
  ANARCHY = "anarchy",
  CORPORATE = "corporate",
  DEMOCRACY = "democracy",
  DICTATORSHIP = "dictatorship",
  FEUDAL = "feudal",
  MULTI_GOVERNMENT = "multi_government",
}

export enum TechLevel {
  AGRICULTURAL = 1,
  MEDIEVAL = 2,
  RENAISSANCE = 3,
  EARLY_INDUSTRIAL = 4,
  INDUSTRIAL = 5,
  POST_INDUSTRIAL = 6,
  HI_TECH = 7,
}

export enum WorldType {
  AGRICULTURAL = "agricultural", // Focuses on food, textiles
  INDUSTRIAL = "industrial", // Focuses on metals, machinery
  HIGH_TECH = "high_tech", // Focuses on electronics, computers
  MINING = "mining", // Focuses on metals, raw materials
  TRADE_HUB = "trade_hub", // Balanced, no strong specialization
  RESORT = "resort", // High consumption of everything, produces luxuries
}

export interface SystemState {
  id: SystemId;
  name: string;
  population: number; // millions
  techLevel: TechLevel;
  worldType: WorldType; // Economic specialization
  government: GovernmentType;
  seed: string; // RNG seed for deterministic simulation
  lastTickTime: Timestamp;
  currentTick: number;
  x: number; // 2D spatial coordinate
  y: number; // 2D spatial coordinate
}

export interface MarketState {
  goodId: GoodId;
  basePrice: number; // base price at tech level 0
  supply: number; // current supply in station
  demand: number; // current demand rate (units per tick)
  production: number; // production rate (units per tick)
  consumption: number; // consumption rate (units per tick)
  price: number; // current market price
  inventory: number; // current inventory at station
}

export type ShipPhase = 
  | "at_station" // Ship is at station and can trade
  | "departing" // Ship is leaving planet's influence (~10s)
  | "in_hyperspace" // Ship is traveling between systems
  | "arriving" // Ship is flying from spawn point to station (~60s)
  | "resting" // NPC is resting at station (5-60 minutes) - ignored in tick calculations
  | "sleeping"; // NPC is sleeping at station (up to 12 hours) - ignored in tick calculations

export type LaserMount = "front" | "rear" | "left" | "right";
export type LaserType = "pulse" | "beam" | "military";

export interface ShipArmaments {
  lasers: Record<LaserMount, LaserType | null>;
  missiles: number;
  ecm: boolean;
  energyBomb: boolean;
}

export interface ShipState {
  id: ShipId;
  name: string;
  currentSystem: SystemId | null;
  destinationSystem: SystemId | null;
  phase: ShipPhase;
  positionX: number | null; // ship position in SU relative to station
  positionY: number | null; // ship position in SU relative to station
  arrivalStartX: number | null; // arrival spawn point X in SU
  arrivalStartY: number | null; // arrival spawn point Y in SU
  departureStartTime: Timestamp | null; // When departure phase started
  hyperspaceStartTime: Timestamp | null; // When hyperspace travel started
  arrivalStartTime: Timestamp | null; // When arrival phase started
  arrivalCompleteTime: Timestamp | null; // When ship reaches station
  restStartTime: Timestamp | null; // When rest/sleep started
  restEndTime: Timestamp | null; // When rest/sleep ends
  cargo: Map<GoodId, number>; // good -> quantity
  purchasePrices: Map<GoodId, number>; // good -> purchase price per unit (for profit calculation)
  credits: number;
  isNPC: boolean;
  seed: string; // RNG seed for deterministic behavior
  armaments: ShipArmaments;
  fuelLy: number;
  fuelCapacityLy: number;
  hullIntegrity: number;
  hullMax: number;
  originSystem: SystemId | null; // System ship departed from (for arrival metadata)
  originPriceInfo: Array<[GoodId, number]> | null; // Prices from origin system (for arrival effects)
  chosenDestinationSystemId: SystemId | null; // Planned profitable destination when cargo was purchased
  expectedMarginAtChoiceTime: number | null; // Expected profit margin (%) when destination was chosen
  // Lifecycle tracking for NPC culling
  immobileTicks: number; // Consecutive ticks where trader cannot afford fuel to cheapest neighbor
  lastSuccessfulTradeTick: number; // Last tick where a successful buy+sell cycle completed
  decisionCount: number; // Total number of trading decisions made (for stagnation tracking)
  lastCargoPurchaseTick: number | null; // Tick when cargo was last purchased (for max hold time)
}

export interface SystemSnapshot {
  state: SystemState;
  markets: Map<GoodId, MarketState>;
  shipsInSystem: ShipId[];
}

export interface TradeEvent {
  timestamp: Timestamp;
  shipId: ShipId;
  systemId: SystemId;
  goodId: GoodId;
  quantity: number;
  price: number;
  type: "buy" | "sell";
}

export interface ShipArrivalEvent {
  timestamp: Timestamp;
  shipId: ShipId;
  fromSystem: SystemId;
  toSystem: SystemId;
  cargo: Map<GoodId, number>;
  priceInfo: Map<GoodId, number>; // prices from origin system
}
