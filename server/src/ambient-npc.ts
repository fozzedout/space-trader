/**
 * Deterministic ambient NPC activity (design §8.7).
 * Uses ordinary captain commands under the same constraints as humans.
 */

import {
  CommodityId,
  PHASE0_TUNING,
  RulesetRng,
  SHIP_TYPES,
  fuelPurchaseCost,
  repairCost,
  scoreForBand,
  randomFixedProfileBand,
} from '@sto/ruleset-phase0-v1';
import type { CaptainState } from './captain-authority.js';
import { executeTrade, startTravel, advanceTravel, refuelShip, repairShip } from './captain-authority.js';
import type { SystemState } from './system-authority.js';
import type { SystemPort, ProjectionPort } from './captain-authority.js';

export interface AmbientStepResult {
  captainId: string;
  action: string;
  detail?: Record<string, unknown>;
}

function shipTypeId(name: string): number {
  const found = SHIP_TYPES.find((s) => s.name === name);
  return found?.id ?? 1;
}

/**
 * One ambient step for a single NPC. Deterministic given captain state + seed.
 */
export async function ambientNpcStep(
  state: CaptainState,
  system: SystemPort,
  projections: ProjectionPort,
  args: { nowMs: number; seed: number; destinations: string[] },
): Promise<{ state: CaptainState; step: AmbientStepResult }> {
  if (state.kind !== 'npc') {
    return { state, step: { captainId: state.captainId, action: 'skip_non_npc' } };
  }
  if (state.lifecycle === 'DEAD' || state.lifecycle === 'RETIRED' || state.lifecycle === 'AWAITING_RECOVERY') {
    return { state, step: { captainId: state.captainId, action: 'inactive' } };
  }
  if (state.pendingTrade || state.activeEncounterId) {
    return { state, step: { captainId: state.captainId, action: 'locked' } };
  }

  const rng = new RulesetRng(args.seed ^ (state.captainId.length * 2654435761));

  if (state.lifecycle === 'TRAVELLING' && state.activeTrip) {
    const adv = await advanceTravel(state, system, projections, {
      operationId: `ambient-adv-${state.captainId}-${state.approachTick}-${args.nowMs}`,
      nowMs: args.nowMs,
    });
    return {
      state: adv.state,
      step: { captainId: state.captainId, action: 'advance', detail: adv.ok ? adv.result : { error: adv.error } },
    };
  }

  if (state.lifecycle !== 'ACTIVE') {
    return { state, step: { captainId: state.captainId, action: 'skip_lifecycle' } };
  }

  const typeId = shipTypeId(state.shipType);
  const ship = SHIP_TYPES[typeId]!;

  // Prefer recovery actions when stranded economically
  if (state.fuel < ship.fuelTanks) {
    const need = ship.fuelTanks - state.fuel;
    const cost = fuelPurchaseCost(typeId, state.fuel, need);
    if (cost > 0 && state.credits >= cost) {
      const r = await refuelShip(state, projections, {
        operationId: `ambient-fuel-${state.captainId}-${args.nowMs}`,
        units: need,
        nowMs: args.nowMs,
      });
      return {
        state: r.state,
        step: { captainId: state.captainId, action: 'refuel', detail: r.ok ? r.result : { error: r.error } },
      };
    }
  }

  if (state.hull < state.maxHull) {
    const need = state.maxHull - state.hull;
    const cost = repairCost(typeId, state.hull, need);
    if (cost > 0 && state.credits >= cost) {
      const r = await repairShip(state, projections, {
        operationId: `ambient-repair-${state.captainId}-${args.nowMs}`,
        hullPoints: need,
        nowMs: args.nowMs,
      });
      return {
        state: r.state,
        step: { captainId: state.captainId, action: 'repair', detail: r.ok ? r.result : { error: r.error } },
      };
    }
  }

  // Occasional trade
  if (rng.nextInt(100) < 40) {
    const goods = [CommodityId.Water, CommodityId.Food, CommodityId.Ore, CommodityId.Games];
    const good = goods[rng.nextInt(goods.length)]!;
    const side: 'buy' | 'sell' = (state.cargo.get(good)?.qty ?? 0) > 0 && rng.nextInt(100) < 50
      ? 'sell'
      : 'buy';
    const qty = 1;
    const r = await executeTrade(state, system, projections, {
      operationId: `ambient-trade-${state.captainId}-${args.nowMs}-${good}-${side}`,
      good,
      side,
      quantity: qty,
      nowMs: args.nowMs,
    });
    if (r.ok) {
      return { state: r.state, step: { captainId: state.captainId, action: 'trade', detail: r.result } };
    }
  }

  // Travel when fuel available
  if (state.fuel > 0 && args.destinations.length > 0) {
    const dests = args.destinations.filter((d) => d !== state.systemId);
    if (dests.length > 0) {
      const dest = dests[rng.nextInt(dests.length)]!;
      const r = await startTravel(state, system, projections, {
        operationId: `ambient-travel-${state.captainId}-${args.nowMs}`,
        destinationSystemId: dest,
        seed: rng.nextInt(1_000_000_000) || 1,
        nowMs: args.nowMs,
      });
      return {
        state: r.state,
        step: { captainId: state.captainId, action: 'travel', detail: r.ok ? r.result : { error: r.error } },
      };
    }
  }

  return { state, step: { captainId: state.captainId, action: 'idle' } };
}

/** Select a rotating cohort of NPC ids for this ambient tick. */
export function selectAmbientCohort(
  npcIds: string[],
  nowMs: number,
  cohortSize = 4,
): string[] {
  if (npcIds.length === 0) return [];
  const sorted = [...npcIds].sort();
  const window = Math.floor(nowMs / PHASE0_TUNING.recoveryPeriodMs);
  const start = window % sorted.length;
  const out: string[] = [];
  for (let i = 0; i < Math.min(cohortSize, sorted.length); i += 1) {
    out.push(sorted[(start + i) % sorted.length]!);
  }
  return out;
}

export function isEconomicallyStranded(state: CaptainState): boolean {
  if (state.kind !== 'npc') return false;
  if (state.lifecycle === 'DEAD' || state.lifecycle === 'RETIRED') return true;
  const typeId = shipTypeId(state.shipType);
  const ship = SHIP_TYPES[typeId]!;
  const fuelCost = fuelPurchaseCost(typeId, state.fuel, 1);
  const canFuel = state.fuel > 0 || (fuelCost > 0 && state.credits >= fuelCost);
  const hasCargo = [...state.cargo.values()].some((c) => c.qty > 0);
  return !canFuel && !hasCargo && state.credits < fuelCost;
}

/** Used by world bootstrap / population maintenance. */
export function nextNpcProfile(seed: number): { combatProfile: number; tradeProfile: number } {
  const rng = new RulesetRng(seed);
  return {
    combatProfile: scoreForBand(randomFixedProfileBand(rng)),
    tradeProfile: scoreForBand(randomFixedProfileBand(rng)),
  };
}

export type { SystemState };
