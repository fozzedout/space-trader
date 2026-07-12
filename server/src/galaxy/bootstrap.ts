import { CommodityId, scoreForBand, randomFixedProfileBand, RulesetRng } from '@sto/ruleset-phase0-v1';
import { createSystemState, type SystemState } from '../system-authority.js';
import { createCaptainState, type CaptainState } from '../captain-authority.js';

export const DEMO_SYSTEMS = [
  {
    systemId: 'sol',
    name: 'Sol',
    techLevel: 5,
    politicsId: 6,
    size: 3,
    goods: [
      { good: CommodityId.Water, equilibriumPrice: 45, targetStock: 40 },
      { good: CommodityId.Food, equilibriumPrice: 120, targetStock: 30 },
      { good: CommodityId.Ore, equilibriumPrice: 400, targetStock: 20 },
      { good: CommodityId.Games, equilibriumPrice: 200, targetStock: 15 },
      { good: CommodityId.Machines, equilibriumPrice: 700, targetStock: 10 },
    ],
  },
  {
    systemId: 'regulas',
    name: 'Regulas',
    techLevel: 4,
    politicsId: 1,
    size: 2,
    goods: [
      { good: CommodityId.Water, equilibriumPrice: 55, targetStock: 25 },
      { good: CommodityId.Food, equilibriumPrice: 90, targetStock: 35 },
      { good: CommodityId.Ore, equilibriumPrice: 350, targetStock: 28 },
      { good: CommodityId.Furs, equilibriumPrice: 260, targetStock: 18 },
      { good: CommodityId.Medicine, equilibriumPrice: 500, targetStock: 12 },
    ],
  },
] as const;

export interface GalaxySnapshot {
  systems: Record<string, SystemState>;
  captains: Record<string, CaptainState>;
}

export function bootstrapGalaxy(nowMs: number, seed = 1): GalaxySnapshot {
  const rng = new RulesetRng(seed);
  const systems: Record<string, SystemState> = {};
  for (const spec of DEMO_SYSTEMS) {
    systems[spec.systemId] = createSystemState({
      systemId: spec.systemId,
      name: spec.name,
      techLevel: spec.techLevel,
      politicsId: spec.politicsId,
      size: spec.size,
      goods: [...spec.goods],
      nowMs,
    });
  }

  const captains: Record<string, CaptainState> = {};
  captains['captain-human-1'] = createCaptainState({
    captainId: 'captain-human-1',
    kind: 'human',
    handle: 'Traveler',
    systemId: 'sol',
    credits: 12_000,
    nowMs,
  });

  const npcNames = ['Vex', 'Mara', 'Juno', 'Picket', 'Orin', 'Sable'];
  for (let i = 0; i < npcNames.length; i += 1) {
    const id = `captain-npc-${i + 1}`;
    const systemId = i % 2 === 0 ? 'sol' : 'regulas';
    captains[id] = createCaptainState({
      captainId: id,
      kind: 'npc',
      handle: npcNames[i]!,
      systemId,
      credits: 6_000 + rng.nextInt(4_000),
      nowMs,
      combatProfile: scoreForBand(randomFixedProfileBand(rng)),
      tradeProfile: scoreForBand(randomFixedProfileBand(rng)),
    });
    systems[systemId]!.docked.add(id);
  }
  systems.sol!.docked.add('captain-human-1');

  return { systems, captains };
}
