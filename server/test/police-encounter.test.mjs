import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CommodityId,
  PHASE0_TUNING,
  RulesetRng,
  selectPoliceContactType,
  shouldTriggerPoliceContact,
  POLITICS,
} from '@sto/ruleset-phase0-v1';
import {
  createCaptainState,
  startTravel,
  advanceTravel,
  respondPoliceEncounter,
  beginEscapePodRecovery,
} from '../dist-test/captain-authority.js';
import {
  createSystemState,
  registerPresence,
  closePresence,
} from '../dist-test/system-authority.js';
import {
  isPublicCaptainRoute,
  publicDurableObjectRouteGate,
} from '../dist-test/public-routes.js';

function memoryProjections() {
  const captains = [];
  const encounters = [];
  return {
    captains,
    encounters,
    async projectCaptain(row) {
      captains.push(row);
      return { ok: true };
    },
    async projectTrade() {
      return { ok: true };
    },
    async projectOperation() {
      return { ok: true };
    },
    async projectEncounter(row, crimes) {
      encounters.push({ row, crimes });
      return { ok: true };
    },
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
      return [...systemState.wrecks.values()].filter((w) => w.routeArea === routeArea);
    },
  };
}

function travellingCaptain(overrides = {}) {
  const nowMs = overrides.nowMs ?? 1_000_000;
  const captain = createCaptainState({
    captainId: overrides.captainId ?? 'captain-police-1',
    kind: 'human',
    handle: 'Runner',
    systemId: 'sol',
    credits: overrides.credits ?? 10_000,
    nowMs,
    hasEscapePod: overrides.hasEscapePod ?? false,
  });
  if (overrides.policeRecord !== undefined) captain.policeRecord = overrides.policeRecord;
  if (overrides.policeRngSeed !== undefined) captain.policeRngSeed = overrides.policeRngSeed;
  if (overrides.policeRngDrawPosition !== undefined) {
    captain.policeRngDrawPosition = overrides.policeRngDrawPosition;
  }
  return captain;
}

function findSeedThatTriggers(policeRecord, presence, wantTrigger) {
  for (let i = 1; i < 50_000; i += 1) {
    const seed = (0x9e3779b9 * i) >>> 0 || 1;
    const hit = shouldTriggerPoliceContact(policeRecord, presence, new RulesetRng(seed));
    if (hit === wantTrigger) return seed;
  }
  throw new Error(`no seed for trigger=${wantTrigger}`);
}

function startPoliceEncounter(captain, opts = {}) {
  const nowMs = opts.nowMs ?? 2_000_000;
  const contact = opts.contact ?? 'INSPECTION';
  captain.lifecycle = 'IN_ENCOUNTER';
  captain.activeTrip = {
    tripId: 'trip-1',
    seed: 1,
    rulesetVersion: 'ruleset-phase0-v1',
    destinationSystemId: 'regulas',
    routeArea: 'regulas:approach',
    approachTicks: 18,
  };
  captain.approachTick = 3;
  captain.systemId = 'regulas';
  captain.activePoliceEncounter = {
    policeEncounterId: opts.policeEncounterId ?? `police-${captain.captainId}-${nowMs}`,
    contact,
    phase: opts.phase ?? 'CONTACT',
    politicsId: opts.politicsId ?? 5, // Cybernetic — narcotics illegal
    policeSnapshot: opts.policeSnapshot ?? {
      captainId: 'police',
      shipSize: 1,
      hull: opts.policeHull ?? 100,
      maxHull: 100,
      shields: [40],
      totalWeaponPower: opts.policeWeaponPower ?? 25,
      pilot: opts.policePilot ?? 5,
      fighter: opts.policeFighter ?? 5,
      engineer: 5,
      hasEscapePod: false,
      policeRecord: 0,
      combatProfile: 0,
      tradeProfile: 0,
      credits: 0,
      cargo: [],
      difficulty: 2,
    },
    systemId: 'regulas',
    routeArea: 'regulas:approach',
    createdAt: nowMs,
    actionDeadlineAt: nowMs + 8_000,
    pendingCrimes: [],
  };
  return nowMs;
}

test('attack_on_sight band always yields ATTACK_ON_SIGHT when a check triggers', () => {
  const presence = 5;
  const seed = findSeedThatTriggers(-100, presence, true);
  const rng = new RulesetRng(seed);
  assert.equal(shouldTriggerPoliceContact(-100, presence, rng), true);
  assert.equal(selectPoliceContactType(-100, presence, rng), 'ATTACK_ON_SIGHT');
});

test('COMPLY during INSPECTION confiscates illegal cargo, fines, ends, no police penalty', async () => {
  const captain = travellingCaptain();
  captain.cargo.set(CommodityId.Narcotics, { good: CommodityId.Narcotics, qty: 3, avgCost: 100 });
  captain.cargo.set(CommodityId.Water, { good: CommodityId.Water, qty: 2, avgCost: 10 });
  const nowMs = startPoliceEncounter(captain, { contact: 'INSPECTION' });
  const projections = memoryProjections();
  const creditsBefore = captain.credits;
  const result = await respondPoliceEncounter(captain, projections, {
    operationId: 'police-comply-1',
    response: 'COMPLY',
    nowMs,
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.ended, true);
  assert.equal(result.result.policePenalty, 0);
  assert.equal(result.result.fine, 3 * PHASE0_TUNING.inspectionFinePerIllegalUnit);
  assert.equal(captain.credits, creditsBefore - result.result.fine);
  assert.equal(captain.cargo.has(CommodityId.Narcotics), false);
  assert.equal(captain.cargo.get(CommodityId.Water)?.qty, 2);
  assert.equal(captain.policeRecord, 0);
  assert.equal(captain.activePoliceEncounter, null);
  assert.equal(captain.lifecycle, 'TRAVELLING');
  assert.equal(projections.encounters.length, 1);
});

test('FLEE success from inspection ends with flee penalty and no confiscation', async () => {
  const captain = travellingCaptain({ policeRngSeed: 1 });
  captain.cargo.set(CommodityId.Narcotics, { good: CommodityId.Narcotics, qty: 2, avgCost: 50 });
  // High pilot + weak police pilot → flee succeeds for many seeds; search one.
  let found = null;
  for (let seed = 1; seed < 5_000; seed += 1) {
    const c = travellingCaptain({ policeRngSeed: seed });
    c.cargo.set(CommodityId.Narcotics, { good: CommodityId.Narcotics, qty: 2, avgCost: 50 });
    // Boost pilot via combatant defaults are fixed at 5; rely on rng for flee.
    const now = startPoliceEncounter(c, {
      contact: 'INSPECTION',
      policePilot: 0,
      policeSnapshot: {
        captainId: 'police',
        shipSize: 1,
        hull: 100,
        maxHull: 100,
        shields: [],
        totalWeaponPower: 10,
        pilot: 0,
        fighter: 1,
        engineer: 1,
        hasEscapePod: false,
        policeRecord: 0,
        combatProfile: 0,
        tradeProfile: 0,
        credits: 0,
        cargo: [],
        difficulty: 2,
      },
    });
    const projections = memoryProjections();
    const result = await respondPoliceEncounter(c, projections, {
      operationId: `flee-${seed}`,
      response: 'FLEE',
      nowMs: now,
    });
    if (result.ok && result.result.fleeSuccess === true && result.result.ended) {
      found = { c, result, projections };
      break;
    }
  }
  assert.ok(found, 'expected a flee-success seed');
  assert.equal(found.result.result.fine, 0);
  assert.equal(found.result.result.confiscated.length, 0);
  assert.equal(found.result.result.policePenalty, PHASE0_TUNING.crimeFleeInspection);
  assert.equal(found.c.policeRecord, -PHASE0_TUNING.crimeFleeInspection);
  assert.equal(found.c.cargo.has(CommodityId.Narcotics), true);
  assert.equal(found.c.activePoliceEncounter, null);
});

test('destroying police applies crimeDestroyPolice and no credit reward', async () => {
  const captain = travellingCaptain({ credits: 5_000 });
  const nowMs = startPoliceEncounter(captain, {
    contact: 'INSPECTION',
    phase: 'COMBAT',
    policeHull: 1,
    policeSnapshot: {
      captainId: 'police',
      shipSize: 0,
      hull: 1,
      maxHull: 1,
      shields: [],
      totalWeaponPower: 1,
      pilot: 0,
      fighter: 0,
      engineer: 0,
      hasEscapePod: false,
      policeRecord: 0,
      combatProfile: 0,
      tradeProfile: 0,
      credits: 0,
      cargo: [],
      difficulty: 2,
    },
  });
  const creditsBefore = captain.credits;
  const recordBefore = captain.policeRecord;
  let destroyed = null;
  for (let seed = 1; seed < 8_000; seed += 1) {
    const c = travellingCaptain({ credits: 5_000, policeRngSeed: seed });
    startPoliceEncounter(c, {
      contact: 'INSPECTION',
      phase: 'COMBAT',
      policeSnapshot: {
        captainId: 'police',
        shipSize: 0,
        hull: 1,
        maxHull: 1,
        shields: [],
        totalWeaponPower: 1,
        pilot: 0,
        fighter: 0,
        engineer: 0,
        hasEscapePod: false,
        policeRecord: 0,
        combatProfile: 0,
        tradeProfile: 0,
        credits: 0,
        cargo: [],
        difficulty: 2,
      },
    });
    const projections = memoryProjections();
    const result = await respondPoliceEncounter(c, projections, {
      operationId: `atk-${seed}`,
      response: 'ATTACK',
      nowMs: nowMs + seed,
    });
    if (result.ok && result.result.endReason === 'police_destroyed') {
      destroyed = { c, result, projections, creditsBefore: 5_000, recordBefore: 0 };
      break;
    }
  }
  assert.ok(destroyed, 'expected police_destroyed outcome');
  assert.equal(destroyed.result.result.policePenalty, PHASE0_TUNING.crimeDestroyPolice);
  assert.equal(destroyed.c.policeRecord, recordBefore - PHASE0_TUNING.crimeDestroyPolice);
  assert.equal(destroyed.c.credits, creditsBefore);
  assert.equal(destroyed.c.activePoliceEncounter, null);
  assert.equal(destroyed.c.lifecycle, 'TRAVELLING');
  assert.ok(destroyed.projections.encounters[0].crimes.some((c) => c.kind === 'destroy_police'));
});

test('police destroying captain with escape pod → AWAITING_RECOVERY', async () => {
  let found = null;
  for (let seed = 1; seed < 8_000; seed += 1) {
    const c = travellingCaptain({ hasEscapePod: true, policeRngSeed: seed });
    c.hull = 1;
    c.maxHull = 1;
    startPoliceEncounter(c, {
      contact: 'ATTACK_ON_SIGHT',
      phase: 'COMBAT',
      policeSnapshot: {
        captainId: 'police',
        shipSize: 1,
        hull: 200,
        maxHull: 200,
        shields: [50],
        totalWeaponPower: 80,
        pilot: 10,
        fighter: 10,
        engineer: 10,
        hasEscapePod: false,
        policeRecord: 0,
        combatProfile: 0,
        tradeProfile: 0,
        credits: 0,
        cargo: [],
        difficulty: 2,
      },
    });
    const projections = memoryProjections();
    const result = await respondPoliceEncounter(c, projections, {
      operationId: `pod-${seed}`,
      response: 'FLEE',
      nowMs: 3_000_000 + seed,
    });
    if (result.ok && result.result.attack?.destroyed && result.result.attack.defenderId === c.captainId) {
      found = { c, result };
      break;
    }
  }
  assert.ok(found, 'expected captain destroyed via failed flee return fire');
  assert.equal(found.c.lifecycle, 'AWAITING_RECOVERY');
  assert.ok(found.c.recoveryDueAt);
  assert.equal(found.c.activePoliceEncounter, null);
});

test('police destroying captain without escape pod → DEAD', async () => {
  let found = null;
  for (let seed = 1; seed < 8_000; seed += 1) {
    const c = travellingCaptain({ hasEscapePod: false, policeRngSeed: seed });
    c.hull = 1;
    c.maxHull = 1;
    startPoliceEncounter(c, {
      contact: 'ATTACK_ON_SIGHT',
      phase: 'COMBAT',
      policeSnapshot: {
        captainId: 'police',
        shipSize: 1,
        hull: 200,
        maxHull: 200,
        shields: [50],
        totalWeaponPower: 80,
        pilot: 10,
        fighter: 10,
        engineer: 10,
        hasEscapePod: false,
        policeRecord: 0,
        combatProfile: 0,
        tradeProfile: 0,
        credits: 0,
        cargo: [],
        difficulty: 2,
      },
    });
    const projections = memoryProjections();
    const result = await respondPoliceEncounter(c, projections, {
      operationId: `dead-${seed}`,
      response: 'FLEE',
      nowMs: 4_000_000 + seed,
    });
    if (result.ok && result.result.attack?.destroyed && result.result.attack.defenderId === c.captainId) {
      found = { c, result };
      break;
    }
  }
  assert.ok(found, 'expected permanent death');
  assert.equal(found.c.lifecycle, 'DEAD');
  assert.equal(found.c.activePoliceEncounter, null);
});

test('police/respond is idempotent under operationId retry', async () => {
  const captain = travellingCaptain();
  captain.cargo.set(CommodityId.Narcotics, { good: CommodityId.Narcotics, qty: 1, avgCost: 10 });
  const nowMs = startPoliceEncounter(captain, { contact: 'INSPECTION' });
  const projections = memoryProjections();
  const args = { operationId: 'police-idem-1', response: 'COMPLY', nowMs };
  const first = await respondPoliceEncounter(captain, projections, args);
  assert.equal(first.ok, true);
  const credits = captain.credits;
  const record = captain.policeRecord;
  const second = await respondPoliceEncounter(captain, projections, args);
  assert.equal(second.ok, true);
  assert.deepEqual(second.result, first.result);
  assert.equal(captain.credits, credits);
  assert.equal(captain.policeRecord, record);
  assert.equal(projections.encounters.length, 1);
});

test('/captains/:id/police/respond is on the public allowlist gate', () => {
  assert.equal(isPublicCaptainRoute('POST', 'police/respond'), true);
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/captains/c1/police/respond', {
      method: 'POST',
      body: '{}',
    })),
    null,
  );
  // Internal police/apply remains blocked
  assert.equal(isPublicCaptainRoute('POST', 'police/apply'), false);
});

test('advanceTravel with non-triggering police roll behaves as ordinary travel', async () => {
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
  const seed = findSeedThatTriggers(0, presence, false);
  const captain = travellingCaptain({ policeRngSeed: seed, policeRngDrawPosition: 0 });
  const port = systemPortFor(system);
  const projections = memoryProjections();
  const start = await startTravel(captain, port, projections, {
    operationId: 'travel-start-1',
    destinationSystemId: 'regulas',
    seed: 99,
    nowMs: 1_000_000,
  });
  assert.equal(start.ok, true);
  const drawBefore = captain.policeRngDrawPosition;
  const adv = await advanceTravel(captain, port, projections, {
    operationId: 'travel-adv-1',
    nowMs: 1_000_500,
  });
  assert.equal(adv.ok, true);
  assert.equal(adv.result.policeEncounterId, undefined);
  assert.equal(adv.result.policeContact, undefined);
  assert.equal(captain.lifecycle, 'TRAVELLING');
  assert.equal(captain.activePoliceEncounter, null);
  assert.ok(captain.policeRngDrawPosition > drawBefore);
  assert.ok(system.presence.has(captain.captainId) || [...system.presence.values()].some((p) => p.status === 'present'));
});

test('advanceTravel triggers ATTACK_ON_SIGHT for record -100 when check fires', async () => {
  const system = createSystemState({
    systemId: 'regulas',
    name: 'Regulas',
    techLevel: 4,
    politicsId: 1,
    size: 2,
    goods: [{ good: CommodityId.Water, equilibriumPrice: 40, targetStock: 20 }],
    nowMs: 1,
    policePresence: 5,
  });
  // Force strength via politics — Capitalist strengthPolice is 3; still enough.
  const presence = POLITICS[1].strengthPolice;
  const seed = findSeedThatTriggers(-100, presence, true);
  const captain = travellingCaptain({
    policeRecord: -100,
    policeRngSeed: seed,
    policeRngDrawPosition: 0,
  });
  const port = systemPortFor(system);
  const projections = memoryProjections();
  await startTravel(captain, port, projections, {
    operationId: 'travel-start-aos',
    destinationSystemId: 'regulas',
    seed: 11,
    nowMs: 5_000_000,
  });
  // Consume the trigger draw by replaying: startTravel doesn't touch police rng.
  const adv = await advanceTravel(captain, port, projections, {
    operationId: 'travel-adv-aos',
    nowMs: 5_000_500,
  });
  assert.equal(adv.ok, true);
  assert.equal(adv.result.policeContact, 'ATTACK_ON_SIGHT');
  assert.ok(adv.result.policeEncounterId);
  assert.equal(captain.lifecycle, 'IN_ENCOUNTER');
  assert.equal(captain.activePoliceEncounter?.contact, 'ATTACK_ON_SIGHT');
  assert.equal(system.presence.get(captain.captainId)?.status === 'present', false);
});

// Keep beginEscapePodRecovery import used for type parity with phase04 style.
test('beginEscapePodRecovery helper still available for police destruction path', () => {
  const c = travellingCaptain({ hasEscapePod: true });
  beginEscapePodRecovery(c, {
    encounterId: 'police-x',
    recoveryDueAt: 100,
    nowMs: 1,
  });
  assert.equal(c.lifecycle, 'AWAITING_RECOVERY');
});
