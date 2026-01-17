/**
 * Core types for the galaxy-scale market simulator
 */

export type SystemId = number; // 0-255
export type ShipId = string;
export type GoodId = string;
export type Timestamp = number; // milliseconds since epoch

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
  request?: MarketRequest | null; // optional restock request with delivery bonus
}

export interface MarketRequest {
  bonusPerUnit: number;
  remainingUnits: number;
}

export type ShipPhase = 
  | "at_station" // Ship is at station and can trade
  | "traveling"; // Ship is traveling between systems

export interface ShipState {
  id: ShipId;
  name: string;
  currentSystem: SystemId | null;
  destinationSystem: SystemId | null;
  phase: ShipPhase;
  cargo: Map<GoodId, number>; // good -> quantity
  purchasePrices: Map<GoodId, number>; // good -> purchase price per unit (for profit calculation)
  credits: number;
  isNPC: boolean;
  seed: string; // RNG seed for deterministic behavior
  travelStartTime: Timestamp | null; // When travel started (for traveling phase)
  lastTradeTick: number; // Last tick where a trade occurred (for culling)
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

