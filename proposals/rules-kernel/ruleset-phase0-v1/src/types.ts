import type { CommodityId, Difficulty } from '@sto/original-baseline-rules';

export type ProfileBand = 'passive' | 'neutral' | 'aggressive';
export type HostilityBand = 'permanent_friend' | 'favourable' | 'neutral' | 'hostile' | 'permanent_grudge';
export type PoliceStandingBand = 'attack_on_sight' | 'wanted' | 'ordinary' | 'trusted';

export type CaptainActionType =
  | 'ATTACK'
  | 'FLEE'
  | 'HAIL'
  | 'IGNORE'
  | 'DEMAND'
  | 'TRADE_OFFER'
  | 'ACCEPT_TRADE'
  | 'SURRENDER'
  | 'COMPLY'
  | 'SURRENDER_CLAIM';

export type EncounterPhase = 'CONTACT' | 'NEGOTIATION' | 'COMBAT' | 'TERMINAL';
export type InternalEncounterLifecycle =
  | EncounterPhase
  | 'SURRENDER_RESOLUTION'
  | 'SETTLING'
  | 'PROJECTING_TO_D1'
  | 'COMPLETE';

export type CaptainLifecycle =
  | 'ACTIVE'
  | 'TRAVELLING'
  | 'ENCOUNTER_CLAIMED'
  | 'IN_ENCOUNTER'
  | 'SETTLING'
  | 'AWAITING_RECOVERY'
  | 'RECOVERING'
  | 'RETIRED'
  | 'DEAD';

export type BehaviourClass = 'aggressive' | 'neutral' | 'passive';

export interface CargoLot {
  readonly good: CommodityId;
  readonly qty: number;
}

export interface CargoTransfer {
  readonly good: CommodityId;
  readonly qty: number;
}

export interface BilateralExchange {
  /** Assets flowing from A to B. */
  readonly aToB: {
    readonly credits: number;
    readonly cargo: readonly CargoTransfer[];
  };
  /** Assets flowing from B to A. */
  readonly bToA: {
    readonly credits: number;
    readonly cargo: readonly CargoTransfer[];
  };
}

export interface DemandSpec {
  readonly credits: number;
  readonly cargo: readonly CargoTransfer[];
}

export interface SurrenderClaim {
  readonly credits: number;
  readonly cargo: readonly CargoTransfer[];
}

export interface CaptainAction {
  readonly actionId: string;
  readonly roundNo: number;
  readonly type: CaptainActionType;
  readonly messageKey?: string;
  readonly tradeOffer?: BilateralExchange;
  readonly acceptProposalHash?: string;
  readonly demand?: DemandSpec;
  readonly surrenderClaim?: SurrenderClaim;
}

export interface CombatantSnapshot {
  readonly captainId: string;
  readonly shipSize: number;
  readonly hull: number;
  readonly maxHull: number;
  readonly shields: readonly number[];
  readonly totalWeaponPower: number;
  readonly pilot: number;
  readonly fighter: number;
  readonly engineer: number;
  readonly hasEscapePod: boolean;
  readonly policeRecord: number;
  readonly combatProfile: number;
  readonly tradeProfile: number;
  readonly credits: number;
  readonly cargo: readonly CargoLot[];
  readonly difficulty: Difficulty;
}

export interface PendingTradeOffer {
  readonly proposerId: string;
  readonly exchange: BilateralExchange;
  readonly proposalHash: string;
}

export interface RoundResolution {
  readonly phaseAfter: EncounterPhase | 'SURRENDER_RESOLUTION' | 'TERMINAL';
  readonly ended: boolean;
  readonly endReason?: string;
  readonly attacks: readonly AttackResult[];
  readonly fleeResults: readonly FleeResult[];
  readonly transfers: readonly SettlementTransfer[];
  readonly demandOutcomes: readonly DemandOutcome[];
  readonly pendingOffers: readonly PendingTradeOffer[];
  readonly pendingDemand: PendingDemand | null;
  readonly surrenderVictorId: string | null;
  readonly messages: readonly { captainId: string; messageKey?: string }[];
  readonly events: readonly string[];
}

export interface AttackResult {
  readonly attackerId: string;
  readonly defenderId: string;
  readonly hit: boolean;
  readonly rawDamage: number;
  readonly hullDamage: number;
  readonly shieldsAfter: readonly number[];
  readonly hullAfter: number;
  readonly destroyed: boolean;
}

export interface FleeResult {
  readonly captainId: string;
  readonly success: boolean;
}

export interface SettlementTransfer {
  readonly kind: 'demand' | 'trade' | 'surrender_claim';
  readonly fromId: string;
  readonly toId: string;
  readonly credits: number;
  readonly cargo: readonly CargoTransfer[];
}

export interface DemandOutcome {
  readonly demanderId: string;
  readonly targetId: string;
  readonly result: 'COMPLIED' | 'NOT_COMPLIED';
}

export interface PendingDemand {
  readonly demanderId: string;
  readonly demand: DemandSpec;
}

export type PoliceContactType = 'PASS' | 'INSPECTION' | 'SURRENDER_ORDER' | 'ATTACK_ON_SIGHT';
export type PoliceResponse = 'COMPLY' | 'FLEE' | 'ATTACK' | 'SURRENDER';
export type PolicePhase = 'CONTACT' | 'COMBAT' | 'TERMINAL';

export interface MarketGoodState {
  readonly good: CommodityId;
  readonly equilibriumPrice: number;
  readonly stock: number;
  readonly targetStock: number;
  readonly pressureBps: number;
  readonly updatedAt: number;
}

export interface ProgressiveQuote {
  readonly good: CommodityId;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly unitPrices: readonly number[];
  readonly total: number;
  readonly finalStock: number;
  readonly finalPressureBps: number;
}
