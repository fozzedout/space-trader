import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CommodityId,
  POLITICS,
  RulesetRng,
  createWreck,
  shouldTriggerPoliceContact,
} from '@sto/ruleset-phase0-v1';
import {
  createCaptainState,
  startTravel,
  advanceTravel,
} from '../dist-test/captain-authority.js';
import {
  createSystemState,
  registerPresence,
  closePresence,
  addWreck,
  listWrecksInRouteArea,
} from '../dist-test/system-authority.js';

function memoryProjections() {
  return {
    async projectCaptain() { return { ok: true }; },
    async projectTrade() { return { ok: true }; },
    async projectOperation() { return { ok: true }; },
  };
}

function systemPortFor(systemState) {
  return {
    async reserveTrade() {
      return { ok: false, error: 'unused', code: 'REJECTED' };
    },
    async promoteReservation() {
      return { ok: false, error: 'unused', code: 'REJECTED' };
    },
    async commitReservation() {
      return { ok: false, error: 'unused', code: 'REJECTED' };
    },
    async getReservation() {
      return null;
    },
    async registerPresence(args) {
      return registerPresence(systemState, {
        ...args,
        encounterId: null,
        status: 'present',
      });
    },
    async closePresence(captainId) {
      await closePresence(systemState, captainId);
    },
    async getPolitics() {
      const strengthPolice = POLITICS[systemState.politicsId]?.strengthPolice ?? systemState.policePresence;
      return { politicsId: systemState.politicsId, strengthPolice };
    },
    async listWrecksInRouteArea(routeArea) {
      return listWrecksInRouteArea(systemState, routeArea);
    },
  };
}

function findSeedThatDoesNotTrigger(policeRecord, presence) {
  for (let i = 1; i < 50_000; i += 1) {
    const seed = (0x9e3779b9 * i) >>> 0 || 1;
    if (!shouldTriggerPoliceContact(policeRecord, presence, new RulesetRng(seed))) return seed;
  }
  throw new Error('no non-triggering police seed');
}

test('listWrecksInRouteArea filters by route area', () => {
  const system = createSystemState({
    systemId: 'regulas',
    name: 'Regulas',
    techLevel: 4,
    politicsId: 1,
    size: 2,
    goods: [{ good: CommodityId.Water, equilibriumPrice: 40, targetStock: 20 }],
    nowMs: 1,
  });
  addWreck(system, createWreck({
    wreckId: 'wreck-here',
    routeArea: 'regulas:approach',
    cargo: [{ good: CommodityId.Water, qty: 1 }],
    nowMs: 1,
  }));
  addWreck(system, createWreck({
    wreckId: 'wreck-elsewhere',
    routeArea: 'sol:approach',
    cargo: [{ good: CommodityId.Water, qty: 1 }],
    nowMs: 1,
  }));
  const here = listWrecksInRouteArea(system, 'regulas:approach');
  assert.equal(here.length, 1);
  assert.equal(here[0].wreckId, 'wreck-here');
});

test('advanceTravel surfaces wreckSighted only when routeArea matches', async () => {
  const system = createSystemState({
    systemId: 'regulas',
    name: 'Regulas',
    techLevel: 4,
    politicsId: 1,
    size: 2,
    goods: [{ good: CommodityId.Water, equilibriumPrice: 40, targetStock: 20 }],
    nowMs: 1,
  });
  const presence = POLITICS[1].strengthPolice;
  const seed = findSeedThatDoesNotTrigger(0, presence);

  addWreck(system, createWreck({
    wreckId: 'wreck-regulas-1',
    routeArea: 'regulas:approach',
    cargo: [],
    nowMs: 1,
    escapePodCaptainId: 'victim-1',
    hasCloneBackup: true,
  }));
  addWreck(system, createWreck({
    wreckId: 'wreck-sol-1',
    routeArea: 'sol:approach',
    cargo: [{ good: CommodityId.Ore, qty: 3 }],
    nowMs: 1,
  }));

  const captain = createCaptainState({
    captainId: 'captain-sight-1',
    kind: 'human',
    handle: 'Scout',
    systemId: 'sol',
    credits: 10_000,
    nowMs: 1_000_000,
  });
  captain.policeRngSeed = seed;
  captain.policeRngDrawPosition = 0;

  const port = systemPortFor(system);
  const projections = memoryProjections();
  const start = await startTravel(captain, port, projections, {
    operationId: 'travel-sight-start',
    destinationSystemId: 'regulas',
    seed: 42,
    nowMs: 1_000_000,
  });
  assert.equal(start.ok, true);
  assert.equal(captain.activeTrip.routeArea, 'regulas:approach');

  const adv = await advanceTravel(captain, port, projections, {
    operationId: 'travel-sight-adv',
    nowMs: 1_000_500,
  });
  assert.equal(adv.ok, true);
  assert.equal(captain.lifecycle, 'TRAVELLING');
  assert.ok(adv.result.wreckSighted);
  assert.equal(adv.result.wreckSighted.wreckId, 'wreck-regulas-1');
  assert.equal(adv.result.wreckSighted.hasEscapePod, true);
  assert.equal(adv.result.wreckSighted.podState, 'AVAILABLE');

  // Same captain advancing through a different system's approach must not see the regulas wreck.
  const solSystem = createSystemState({
    systemId: 'sol',
    name: 'Sol',
    techLevel: 5,
    politicsId: 1,
    size: 3,
    goods: [{ good: CommodityId.Water, equilibriumPrice: 40, targetStock: 20 }],
    nowMs: 1,
  });
  addWreck(solSystem, createWreck({
    wreckId: 'wreck-regulas-1',
    routeArea: 'regulas:approach',
    cargo: [],
    nowMs: 1,
    escapePodCaptainId: 'victim-1',
    hasCloneBackup: true,
  }));

  const other = createCaptainState({
    captainId: 'captain-sight-2',
    kind: 'human',
    handle: 'Other',
    systemId: 'regulas',
    credits: 10_000,
    nowMs: 2_000_000,
  });
  other.policeRngSeed = seed;
  other.policeRngDrawPosition = 0;
  const solPort = systemPortFor(solSystem);
  const startSol = await startTravel(other, solPort, projections, {
    operationId: 'travel-sight-sol-start',
    destinationSystemId: 'sol',
    seed: 7,
    nowMs: 2_000_000,
  });
  assert.equal(startSol.ok, true);
  assert.equal(other.activeTrip.routeArea, 'sol:approach');

  const advSol = await advanceTravel(other, solPort, projections, {
    operationId: 'travel-sight-sol-adv',
    nowMs: 2_000_500,
  });
  assert.equal(advSol.ok, true);
  assert.equal(advSol.result.wreckSighted, undefined);
  assert.equal(other.lifecycle, 'TRAVELLING');
});
