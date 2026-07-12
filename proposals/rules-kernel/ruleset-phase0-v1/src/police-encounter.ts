import {
  commodityAllowed,
  COMMODITIES,
  commanderFleeSucceeds,
  originalPoliceEncounterStrength,
  SHIP_TYPES,
} from '@sto/original-baseline-rules';
import type { CommodityId } from '@sto/original-baseline-rules';
import { PHASE0_TUNING } from './config.js';
import { RulesetRng, weightedPick } from './prng.js';
import { isWanted, policeStandingBand } from './profiles.js';
import type { CargoLot, PoliceContactType, PolicePhase, PoliceResponse } from './types.js';
import {
  absorbWithShields,
  attackHits,
  reduceHullDamage,
  weaponDamage,
} from '@sto/original-baseline-rules';
import type { CombatantSnapshot, AttackResult } from './types.js';

export const POLICE_COMBATANT_ID = 'police' as const;

/**
 * Roll whether a routine police-contact check happens this travel tick.
 * Base rate from PHASE0_TUNING.policeContactCheckProbabilityBps, scaled by
 * localPolicePresence (0–7) and criminal-record strength multiplier.
 */
export function shouldTriggerPoliceContact(
  policeRecord: number,
  localPolicePresence: number,
  rng: RulesetRng,
): boolean {
  const presence = Math.max(0, Math.min(7, Math.trunc(localPolicePresence)));
  const recordStrength = originalPoliceEncounterStrength(1, policeRecord);
  const effectiveBps = Math.min(
    10_000,
    Math.floor(
      (PHASE0_TUNING.policeContactCheckProbabilityBps * (presence + 1) * recordStrength) / 4,
    ),
  );
  return rng.nextInt(10_000) < effectiveBps;
}

/**
 * Fixed non-authoritative police opponent snapshot. Toughness tracks local
 * presence and player police record at the same fidelity as server combatantFromCaptain.
 */
export function policeCombatantSnapshot(
  localPolicePresence: number,
  playerPoliceRecord: number,
  rng: RulesetRng,
): CombatantSnapshot {
  const presence = Math.max(0, Math.min(7, Math.trunc(localPolicePresence)));
  const strength = originalPoliceEncounterStrength(Math.max(1, presence), playerPoliceRecord);
  const candidates = SHIP_TYPES.filter(
    (s) => s.purchasable && s.policeMinimum >= 0 && s.policeMinimum <= strength,
  );
  const ship = candidates.length > 0
    ? candidates[rng.nextInt(candidates.length)]!
    : SHIP_TYPES[1]!;
  const skill = Math.min(10, 3 + strength);
  return {
    captainId: POLICE_COMBATANT_ID,
    shipSize: ship.size,
    hull: ship.hullStrength,
    maxHull: ship.hullStrength,
    shields: ship.shieldSlots > 0 ? [Math.min(100, 15 * strength)] : [],
    totalWeaponPower: 15 + strength * 5,
    pilot: skill,
    fighter: skill,
    engineer: skill,
    hasEscapePod: false,
    policeRecord: 0,
    combatProfile: 0,
    tradeProfile: 0,
    credits: 0,
    cargo: [],
    difficulty: 2,
  };
}

export function selectPoliceContactType(
  policeRecord: number,
  localPolicePresence: number,
  rng: RulesetRng,
): PoliceContactType {
  const band = policeStandingBand(policeRecord);
  if (band === 'attack_on_sight') return 'ATTACK_ON_SIGHT';
  if (band === 'wanted') {
    // Prefer surrender orders when wanted and police presence is material.
    const weights = {
      SURRENDER_ORDER: PHASE0_TUNING.policeSurrenderOrderWeight + Math.max(0, localPolicePresence),
      INSPECTION: PHASE0_TUNING.policeInspectionWeight,
      PASS: Math.max(1, PHASE0_TUNING.policePassWeight - localPolicePresence),
    } as const;
    return weightedPick(weights, rng);
  }
  const weights = {
    PASS: PHASE0_TUNING.policePassWeight,
    INSPECTION: PHASE0_TUNING.policeInspectionWeight + Math.max(0, localPolicePresence),
  } as const;
  return weightedPick(weights, rng);
}

export function legalPoliceResponses(contact: PoliceContactType, phase: PolicePhase, policeRecord: number): PoliceResponse[] {
  if (phase === 'TERMINAL') return [];
  if (phase === 'COMBAT') {
    if (policeStandingBand(policeRecord) === 'attack_on_sight') return ['FLEE', 'ATTACK'];
    return ['ATTACK', 'FLEE', 'SURRENDER'];
  }
  if (contact === 'PASS') return [];
  if (contact === 'INSPECTION') return ['COMPLY', 'FLEE', 'ATTACK'];
  if (contact === 'SURRENDER_ORDER') return ['SURRENDER', 'FLEE', 'ATTACK'];
  return ['FLEE', 'ATTACK'];
}

export function defaultPoliceResponse(contact: PoliceContactType, phase: PolicePhase): PoliceResponse {
  if (phase === 'COMBAT' || contact === 'ATTACK_ON_SIGHT') return 'FLEE';
  if (contact === 'SURRENDER_ORDER') return 'SURRENDER';
  return 'COMPLY';
}

export interface IllegalCargoResult {
  readonly confiscated: readonly CargoLot[];
  readonly fine: number;
}

export function inspectCargo(
  cargo: readonly CargoLot[],
  politicsId: number,
): IllegalCargoResult {
  const confiscated: CargoLot[] = [];
  let fine = 0;
  for (const lot of cargo) {
    const def = COMMODITIES[lot.good];
    if (!def?.illegal) continue;
    if (commodityAllowed(lot.good as CommodityId, politicsId)) continue;
    confiscated.push(lot);
    fine += lot.qty * PHASE0_TUNING.inspectionFinePerIllegalUnit;
  }
  return { confiscated, fine };
}

export interface PoliceRoundInput {
  readonly contact: PoliceContactType;
  readonly phase: PolicePhase;
  readonly captain: CombatantSnapshot;
  readonly police: CombatantSnapshot;
  readonly response: PoliceResponse | null;
  readonly politicsId: number;
  readonly rng: RulesetRng;
}

export interface PoliceRoundResult {
  readonly phaseAfter: PolicePhase;
  readonly ended: boolean;
  readonly endReason?: string;
  readonly confiscated: readonly CargoLot[];
  readonly fine: number;
  readonly policePenalty: number;
  readonly attack?: AttackResult;
  readonly fleeSuccess?: boolean;
  readonly events: readonly string[];
}

export function resolvePoliceRound(input: PoliceRoundInput): PoliceRoundResult {
  const { contact, phase, captain, police, politicsId, rng } = input;
  const legal = legalPoliceResponses(contact, phase, captain.policeRecord);
  let response = input.response;
  if (!response || !legal.includes(response)) {
    response = defaultPoliceResponse(contact, phase);
  }

  if (contact === 'PASS' && phase === 'CONTACT') {
    return { phaseAfter: 'TERMINAL', ended: true, endReason: 'pass', confiscated: [], fine: 0, policePenalty: 0, events: ['pass'] };
  }

  if (phase === 'CONTACT') {
    if (response === 'COMPLY' && contact === 'INSPECTION') {
      const result = inspectCargo(captain.cargo, politicsId);
      return {
        phaseAfter: 'TERMINAL',
        ended: true,
        endReason: 'inspection_complete',
        confiscated: result.confiscated,
        fine: result.fine,
        policePenalty: 0,
        events: ['inspection_comply'],
      };
    }
    if (response === 'SURRENDER') {
      const result = inspectCargo(captain.cargo, politicsId);
      const fine = result.fine + PHASE0_TUNING.policeSurrenderFineBase;
      return {
        phaseAfter: 'TERMINAL',
        ended: true,
        endReason: 'police_surrender',
        confiscated: result.confiscated,
        fine,
        policePenalty: 0,
        events: ['police_surrender'],
      };
    }
    if (response === 'FLEE') {
      const success = commanderFleeSucceeds(captain.pilot, police.pilot, captain.difficulty, rng);
      const penalty = isWanted(captain.policeRecord)
        ? PHASE0_TUNING.crimeFleeInspection * 2
        : contact === 'INSPECTION'
          ? PHASE0_TUNING.crimeFleeInspection
          : PHASE0_TUNING.crimeFleeInspection * 2;
      if (success) {
        return {
          phaseAfter: 'TERMINAL',
          ended: true,
          endReason: 'flee_success',
          confiscated: [],
          fine: 0,
          policePenalty: penalty,
          fleeSuccess: true,
          events: ['flee_success'],
        };
      }
      return {
        phaseAfter: 'COMBAT',
        ended: false,
        confiscated: [],
        fine: 0,
        policePenalty: penalty,
        fleeSuccess: false,
        events: ['flee_failed_enter_combat'],
      };
    }
    // ATTACK
    return {
      phaseAfter: 'COMBAT',
      ended: false,
      confiscated: [],
      fine: 0,
      policePenalty: PHASE0_TUNING.crimeAttackPolice,
      events: ['attack_police'],
    };
  }

  // COMBAT
  if (response === 'SURRENDER') {
    const result = inspectCargo(captain.cargo, politicsId);
    return {
      phaseAfter: 'TERMINAL',
      ended: true,
      endReason: 'police_surrender',
      confiscated: result.confiscated,
      fine: result.fine + PHASE0_TUNING.policeSurrenderFineBase,
      policePenalty: 0,
      events: ['combat_surrender'],
    };
  }
  if (response === 'FLEE') {
    const success = commanderFleeSucceeds(captain.pilot, police.pilot, captain.difficulty, rng);
    if (success) {
      return {
        phaseAfter: 'TERMINAL',
        ended: true,
        endReason: 'flee_success',
        confiscated: [],
        fine: 0,
        policePenalty: 0,
        fleeSuccess: true,
        events: ['combat_flee_success'],
      };
    }
    // police return fire
    const hit = attackHits(police.fighter, captain.shipSize, captain.pilot, true, rng);
    if (!hit) {
      return {
        phaseAfter: 'COMBAT',
        ended: false,
        confiscated: [],
        fine: 0,
        policePenalty: 0,
        fleeSuccess: false,
        events: ['combat_flee_failed_miss'],
      };
    }
    const raw = weaponDamage(police.totalWeaponPower, police.engineer, rng);
    const absorbed = absorbWithShields(raw, captain.shields);
    const hullDamage = reduceHullDamage(
      absorbed.remainingDamage,
      captain.engineer,
      captain.maxHull,
      captain.difficulty,
      rng,
    );
    const hullAfter = Math.max(0, captain.hull - hullDamage);
    const attack: AttackResult = {
      attackerId: police.captainId,
      defenderId: captain.captainId,
      hit: true,
      rawDamage: raw,
      hullDamage,
      shieldsAfter: absorbed.shields,
      hullAfter,
      destroyed: hullAfter <= 0,
    };
    if (attack.destroyed) {
      return {
        phaseAfter: 'TERMINAL',
        ended: true,
        endReason: 'destroyed',
        confiscated: [],
        fine: 0,
        policePenalty: 0,
        attack,
        fleeSuccess: false,
        events: ['combat_flee_failed_hit'],
      };
    }
    return {
      phaseAfter: 'COMBAT',
      ended: false,
      confiscated: [],
      fine: 0,
      policePenalty: 0,
      attack,
      fleeSuccess: false,
      events: ['combat_flee_failed_hit'],
    };
  }

  // Captain attacks police
  const hit = attackHits(captain.fighter, police.shipSize, police.pilot, false, rng);
  if (!hit) {
    return {
      phaseAfter: 'COMBAT',
      ended: false,
      confiscated: [],
      fine: 0,
      policePenalty: 0,
      events: ['captain_miss'],
    };
  }
  const raw = weaponDamage(captain.totalWeaponPower, captain.engineer, rng);
  const absorbed = absorbWithShields(raw, police.shields);
  const hullDamage = reduceHullDamage(
    absorbed.remainingDamage,
    police.engineer,
    police.maxHull,
    police.difficulty,
    rng,
  );
  const hullAfter = Math.max(0, police.hull - hullDamage);
  const attack: AttackResult = {
    attackerId: captain.captainId,
    defenderId: police.captainId,
    hit: true,
    rawDamage: raw,
    hullDamage,
    shieldsAfter: absorbed.shields,
    hullAfter,
    destroyed: hullAfter <= 0,
  };
  if (attack.destroyed) {
    return {
      phaseAfter: 'TERMINAL',
      ended: true,
      endReason: 'police_destroyed',
      confiscated: [],
      fine: 0,
      policePenalty: PHASE0_TUNING.crimeDestroyPolice,
      attack,
      events: ['police_destroyed'],
    };
  }
  return {
    phaseAfter: 'COMBAT',
    ended: false,
    confiscated: [],
    fine: 0,
    policePenalty: 0,
    attack,
    events: ['captain_hit'],
  };
}
