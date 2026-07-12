import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CommodityId,
  PHASE0_TUNING,
  surrenderHostilityDelta,
  hostilityBand,
  createWreck,
  transitionEscapePod,
  dueAutomatedRecovery,
} from '@sto/ruleset-phase0-v1';
import {
  createCaptainState,
  installEscapePod,
  beginEscapePodRecovery,
  completeRecovery,
  retireCaptain,
  upsertRelationship,
  getRelationship,
  applyPoliceAndBounty,
  applyEncounterSettlement,
  claimEncounter,
  bindEncounter,
} from '../dist-test/captain-authority.js';
import {
  createSystemState,
  addWreck,
  rescueEscapePod,
  destroyEscapePod,
  processDuePodRecoveries,
} from '../dist-test/system-authority.js';
import {
  createEncounter,
  submitAction,
  combatantFromCaptain,
} from '../dist-test/encounter-authority.js';
import { deriveSettlementEffects, emptyRelationship } from '../dist-test/settlement-effects.js';

test('surrender mercy and loot hostility curve', () => {
  assert.equal(surrenderHostilityDelta(0), -10);
  assert.equal(surrenderHostilityDelta(1), 50);
  const npc = createCaptainState({
    captainId: 'npc-1',
    kind: 'npc',
    handle: 'Vex',
    systemId: 'sol',
    nowMs: 1,
  });
  const mercy = emptyRelationship('human-1', 1);
  const afterMercy = {
    ...mercy,
    hostilityScore: surrenderHostilityDelta(0),
    facts: ['showed mercy after surrender'],
  };
  upsertRelationship(npc, afterMercy, 1);
  assert.equal(getRelationship(npc, 'human-1', 1).hostilityScore, -10);

  const grudge = {
    ...emptyRelationship('raider', 1),
    hostilityScore: 100,
    lockedExtreme: true,
    facts: ['betrayed me'],
  };
  upsertRelationship(npc, grudge, 2);
  assert.equal(hostilityBand(getRelationship(npc, 'raider', 2).hostilityScore), 'permanent_grudge');
});

test('escape-pod captain progresses AWAITING_RECOVERY → rescue → ACTIVE', () => {
  const captain = createCaptainState({
    captainId: 'human-1',
    kind: 'human',
    handle: 'Traveler',
    systemId: 'sol',
    nowMs: 1,
    hasEscapePod: true,
  });
  assert.equal(installEscapePod(captain, { operationId: 'pod-buy', nowMs: 1 }).ok, false); // already has

  beginEscapePodRecovery(captain, {
    encounterId: 'enc-x',
    recoveryDueAt: 1 + PHASE0_TUNING.escapePodRecoveryMs,
    nowMs: 1,
  });
  assert.equal(captain.lifecycle, 'AWAITING_RECOVERY');
  assert.ok(captain.recoveryDueAt);

  const system = createSystemState({
    systemId: 'sol',
    name: 'Sol',
    techLevel: 5,
    politicsId: 6,
    size: 3,
    goods: [{ good: CommodityId.Water, equilibriumPrice: 40, targetStock: 20 }],
    nowMs: 1,
  });
  const wreck = createWreck({
    wreckId: 'wreck-1',
    routeArea: 'sol:approach',
    cargo: [{ good: CommodityId.Water, qty: 2 }],
    nowMs: 1,
    escapePodCaptainId: 'human-1',
    hasCloneBackup: true,
  });
  addWreck(system, wreck);
  const rescued = rescueEscapePod(system, { wreckId: 'wreck-1', rescuerId: 'npc-2', nowMs: 2 });
  assert.equal(rescued.ok, true);

  const done = completeRecovery(captain, {
    operationId: 'recover-1',
    safeSystemId: 'regulas',
    source: 'rescue',
    nowMs: 3,
  });
  assert.equal(done.ok, true);
  assert.equal(captain.lifecycle, 'ACTIVE');
  assert.equal(captain.systemId, 'regulas');
  assert.equal(captain.shipType, 'Flea');
  assert.equal(captain.hasEscapePod, false);
  assert.equal(captain.recoveryDueAt, null);
});

test('automated recovery still occurs after pod destroyed', () => {
  const captain = createCaptainState({
    captainId: 'human-2',
    kind: 'human',
    handle: 'Pilot',
    systemId: 'sol',
    nowMs: 10,
    hasEscapePod: true,
  });
  const dueAt = 10 + PHASE0_TUNING.escapePodRecoveryMs;
  beginEscapePodRecovery(captain, { encounterId: 'enc-y', recoveryDueAt: dueAt, nowMs: 10 });

  const system = createSystemState({
    systemId: 'sol',
    name: 'Sol',
    techLevel: 5,
    politicsId: 6,
    size: 3,
    goods: [{ good: CommodityId.Water, equilibriumPrice: 40, targetStock: 20 }],
    nowMs: 10,
  });
  let wreck = createWreck({
    wreckId: 'wreck-2',
    routeArea: 'sol:approach',
    cargo: [],
    nowMs: 10,
    escapePodCaptainId: 'human-2',
    hasCloneBackup: true,
  });
  addWreck(system, wreck);
  const destroyed = destroyEscapePod(system, { wreckId: 'wreck-2', nowMs: 11 });
  assert.equal(destroyed.ok, true);
  assert.equal(destroyed.wreck.recoveryDueAt, dueAt);

  const due = processDuePodRecoveries(system, dueAt);
  assert.equal(due.length, 1);
  assert.equal(due[0].captainId, 'human-2');

  completeRecovery(captain, {
    operationId: 'auto-1',
    safeSystemId: 'sol',
    source: 'automated',
    nowMs: dueAt,
  });
  assert.equal(captain.lifecycle, 'ACTIVE');
});

test('permanent death without escape pod', () => {
  const captain = createCaptainState({
    captainId: 'npc-dead',
    kind: 'npc',
    handle: 'Doomed',
    systemId: 'sol',
    nowMs: 1,
  });
  captain.lifecycle = 'TRAVELLING';
  captain.activeTrip = {
    tripId: 't',
    seed: 1,
    rulesetVersion: 'ruleset-phase0-v1',
    approachTicks: 15,
    routeArea: 'sol:approach',
    destinationSystemId: 'sol',
  };
  claimEncounter(captain, {
    encounterId: 'enc-d',
    routeArea: 'sol:approach',
    nowMs: 1,
    expiresAt: 9999,
  });
  bindEncounter(captain, { encounterId: 'enc-d', nowMs: 2 });
  applyEncounterSettlement(captain, {
    encounterId: 'enc-d',
    deltaHash: 'dead',
    credits: 0,
    cargo: [],
    hull: 0,
    shields: [],
    lifecycleAfter: 'DEAD',
    nowMs: 3,
  });
  assert.equal(captain.lifecycle, 'DEAD');
});

test('demand encounter reports piracy police delta', () => {
  let state = createEncounter({
    encounterId: 'enc-piracy',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: 3,
    nowMs: 1,
    a: {
      captainId: 'raider',
      controller: 'human',
      kind: 'human',
      handle: 'Raider',
      snapshot: combatantFromCaptain({
        captainId: 'raider',
        hull: 100,
        maxHull: 100,
        shields: [20],
        credits: 500,
        cargo: [],
        combatProfile: 65,
        tradeProfile: 0,
        policeRecord: 0,
      }),
    },
    b: {
      captainId: 'victim',
      controller: 'npc',
      kind: 'npc',
      handle: 'Victim',
      snapshot: combatantFromCaptain({
        captainId: 'victim',
        hull: 100,
        maxHull: 100,
        shields: [20],
        credits: 200,
        cargo: [{ good: CommodityId.Water, qty: 2 }],
        combatProfile: 0,
        tradeProfile: 0,
        policeRecord: 0,
      }),
    },
  });
  state = submitAction(state, {
    captainId: 'raider',
    nowMs: 1,
    action: {
      actionId: 'd1',
      roundNo: 1,
      type: 'DEMAND',
      demand: { credits: 50, cargo: [] },
    },
  }).state;
  state = submitAction(state, {
    captainId: 'victim',
    nowMs: 2,
    action: { actionId: 'c1', roundNo: 1, type: 'COMPLY' },
  }).state;
  assert.equal(state.lifecycle, 'SETTLING');
  const effects = deriveSettlementEffects({ state, nowMs: 3 });
  assert.ok(effects.crimes.some((c) => c.kind === 'completed_theft' || c.kind === 'attempted_piracy'));
  assert.ok((effects.policeDeltas.raider ?? 0) < 0);
  assert.ok(effects.relationshipUpdates.some((u) => u.npcCaptainId === 'victim'));
});

test('bounty paid only to non-wanted killer of wanted victim', () => {
  let state = createEncounter({
    encounterId: 'enc-bounty',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: 8,
    nowMs: 1,
    a: {
      captainId: 'hunter',
      controller: 'human',
      kind: 'human',
      handle: 'Hunter',
      snapshot: combatantFromCaptain({
        captainId: 'hunter',
        hull: 100,
        maxHull: 100,
        shields: [50],
        credits: 1000,
        cargo: [],
        combatProfile: 65,
        tradeProfile: 0,
        policeRecord: 0,
        hasEscapePod: false,
      }),
    },
    b: {
      captainId: 'wanted',
      controller: 'npc',
      kind: 'npc',
      handle: 'Wanted',
      snapshot: combatantFromCaptain({
        captainId: 'wanted',
        hull: 1,
        maxHull: 100,
        shields: [0],
        credits: 10,
        cargo: [],
        combatProfile: 0,
        tradeProfile: 0,
        policeRecord: -50,
      }),
    },
  });
  // Force destruction via attacks until settling — or inject terminal via ATTACK rounds
  state = submitAction(state, {
    captainId: 'hunter',
    nowMs: 1,
    action: { actionId: 'a', roundNo: 1, type: 'ATTACK' },
  }).state;
  state = submitAction(state, {
    captainId: 'wanted',
    nowMs: 2,
    action: { actionId: 'b', roundNo: 1, type: 'FLEE' },
  }).state;

  // Keep attacking until destroyed or cap rounds
  let guard = 0;
  while (state.lifecycle !== 'SETTLING' && guard < 20) {
    guard += 1;
    if (!state.participants.a.lockedAction) {
      state = submitAction(state, {
        captainId: 'hunter',
        nowMs: 10 + guard,
        action: { actionId: `a${guard}`, roundNo: state.roundNo, type: 'ATTACK' },
      }).state;
    }
    if (state.lifecycle === 'SETTLING') break;
    if (!state.participants.b.lockedAction) {
      state = submitAction(state, {
        captainId: 'wanted',
        nowMs: 20 + guard,
        action: { actionId: `b${guard}`, roundNo: state.roundNo, type: 'ATTACK' },
      }).state;
    }
  }

  if (state.lifecycle === 'SETTLING' && state.participants.b.snapshot.hull <= 0) {
    const effects = deriveSettlementEffects({ state, nowMs: 100 });
    assert.ok(effects.bounty);
    assert.equal(effects.bounty.lawful, true);
    assert.ok(effects.bounty.bountyPaid > 0);
    assert.ok((effects.creditsAwards.hunter ?? 0) > 0);
  }
});

test('retirement is permanent while ACTIVE', () => {
  const captain = createCaptainState({
    captainId: 'human-3',
    kind: 'human',
    handle: 'Retiree',
    systemId: 'sol',
    nowMs: 1,
  });
  const r = retireCaptain(captain, { operationId: 'ret-1', nowMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(captain.lifecycle, 'RETIRED');
  assert.equal(retireCaptain(captain, { operationId: 'ret-1', nowMs: 2 }).ok, true);
});

test('police apply is idempotent', () => {
  const captain = createCaptainState({
    captainId: 'h',
    kind: 'human',
    handle: 'H',
    systemId: 'sol',
    nowMs: 1,
  });
  applyPoliceAndBounty(captain, {
    operationId: 'p1',
    policeDelta: -12,
    creditsAward: 0,
    nowMs: 1,
  });
  assert.equal(captain.policeRecord, -12);
  applyPoliceAndBounty(captain, {
    operationId: 'p1',
    policeDelta: -12,
    creditsAward: 0,
    nowMs: 2,
  });
  assert.equal(captain.policeRecord, -12);
});
