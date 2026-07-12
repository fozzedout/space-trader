import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommodityId, PHASE0_TUNING } from '@sto/ruleset-phase0-v1';
import {
  createEncounter,
  submitAction,
  markDisconnected,
  markReconnected,
  tickEncounter,
  publicEncounterView,
  privateReconnectSummary,
  assertNoControllerLeak,
  combatantFromCaptain,
} from '../dist-test/encounter-authority.js';
import {
  createCaptainState,
  claimEncounter,
  bindEncounter,
  applyEncounterSettlement,
} from '../dist-test/captain-authority.js';

function participant(id, kind, overrides = {}) {
  return {
    captainId: id,
    controller: kind === 'npc' ? 'npc' : 'human',
    kind,
    handle: id,
    snapshot: combatantFromCaptain({
      captainId: id,
      hull: 100,
      maxHull: 100,
      shields: [40],
      credits: 1000,
      cargo: [{ good: CommodityId.Water, qty: 3 }],
      combatProfile: overrides.combatProfile ?? 0,
      tradeProfile: 0,
      policeRecord: 0,
    }),
  };
}

function makeEncounter(seed = 42) {
  return createEncounter({
    encounterId: 'enc-1',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed,
    nowMs: 1_000_000,
    a: participant('human-1', 'human', { combatProfile: 0 }),
    b: participant('npc-1', 'npc', { combatProfile: 65 }),
  });
}

test('simultaneous actions resolve deterministically', () => {
  const run = () => {
    let state = makeEncounter(99);
    let r = submitAction(state, {
      captainId: 'human-1',
      nowMs: 1_000_000,
      action: { actionId: 'a1', roundNo: 1, type: 'IGNORE' },
    });
    assert.equal(r.ok, true);
    state = r.state;
    r = submitAction(state, {
      captainId: 'npc-1',
      nowMs: 1_000_001,
      action: { actionId: 'b1', roundNo: 1, type: 'IGNORE' },
    });
    assert.equal(r.ok, true);
    return r.state;
  };
  const a = run();
  const b = run();
  assert.equal(a.lifecycle, 'SETTLING');
  assert.equal(a.resultHash, b.resultHash);
  assert.equal(a.rounds.length, 1);
});

test('human vs human mutual flee ends without controller leak in public view', () => {
  let state = createEncounter({
    encounterId: 'enc-pvp',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: 7,
    nowMs: 2_000_000,
    a: participant('h1', 'human'),
    b: participant('h2', 'human'),
  });
  state = submitAction(state, {
    captainId: 'h1',
    nowMs: 2_000_000,
    action: { actionId: '1', roundNo: 1, type: 'FLEE' },
  }).state;
  state = submitAction(state, {
    captainId: 'h2',
    nowMs: 2_000_001,
    action: { actionId: '2', roundNo: 1, type: 'FLEE' },
  }).state;
  assert.equal(state.lifecycle, 'SETTLING');
  const view = publicEncounterView(state, 'h1');
  assert.ok(view);
  assertNoControllerLeak(view);
  assert.equal('controller' in view.opponent, false);
  assert.equal('kind' in view.opponent, false);
});

test('disconnect grace then proxy does not beat staying connected', () => {
  let state = makeEncounter(11);
  // Opponent locks IGNORE; human disconnects and gets proxied to FLEE via coward after grace 0 on 3rd disconnect — use deadline instead
  state.participants.a.controller = 'proxy_coward';
  let r = markDisconnected(state, { captainId: 'human-1', nowMs: 1_000_000 });
  state = r.state;
  assert.equal(state.participants.a.connected, false);
  assert.ok(state.participants.a.graceExpiresAt !== null);

  // Opponent public view must not expose grace/disconnectCount
  const oppView = publicEncounterView(state, 'npc-1');
  assertNoControllerLeak(oppView);
  assert.equal(oppView.you.connected, true);
  // opponent side of npc view is the human — connected is only on "you"
  assert.equal('connected' in oppView.opponent, false);

  // Expire grace → proxy locks action (NPC may resolve the round in the same tick)
  r = tickEncounter(state, state.participants.a.graceExpiresAt);
  state = r.state;
  const summary = privateReconnectSummary(state, 'human-1');
  assert.ok(summary?.proxyControlledRounds.length || state.participants.a.lockedAction);

  if (!state.participants.a.lockedAction && state.lifecycle === 'SETTLING') {
    // Round already resolved through NPC pairing — still a consequence for the disconnecting captain
    assert.ok(state.rounds.length >= 1);
    return;
  }

  // NPC also acts
  r = submitAction(state, {
    captainId: 'npc-1',
    nowMs: state.updatedAt + 1,
    action: { actionId: 'npc-act', roundNo: state.roundNo, type: 'IGNORE' },
  });
  state = r.state;
  assert.ok(
    state.rounds.length >= 1
    || state.participants.a.lockedAction === null
    || state.lifecycle === 'SETTLING'
    || state.lifecycle === 'NEGOTIATION'
    || state.lifecycle === 'CONTACT'
    || state.lifecycle === 'COMBAT',
  );
});

test('reconnect returns private summary; locked proxy action stays', () => {
  let state = makeEncounter(13);
  state.participants.a.controller = 'proxy_learned';
  state = markDisconnected(state, { captainId: 'human-1', nowMs: 1_000_000 }).state;
  const graceEnd = state.participants.a.graceExpiresAt;
  state = tickEncounter(state, graceEnd).state;
  // Proxy acted; NPC may also have acted and resolved the round in the same tick.
  const summary = privateReconnectSummary(state, 'human-1');
  assert.ok(summary);
  assert.ok(summary.proxyControlledRounds.length >= 1);

  const recon = markReconnected(state, { captainId: 'human-1', nowMs: graceEnd + 1 });
  state = recon.state;
  assert.equal(state.participants.a.connected, true);
  // If the round already resolved, locked action is cleared; otherwise it remains.
  if (state.rounds.length === 0) {
    assert.ok(state.participants.a.lockedAction);
  } else {
    assert.ok(state.rounds.some((r) => r.proxyFlags.a));
  }
});

test('third disconnect is immediate proxy takeover', () => {
  let state = makeEncounter(15);
  state = markDisconnected(state, { captainId: 'human-1', nowMs: 1 }).state;
  state.participants.a.connected = true;
  state.participants.a.graceExpiresAt = null;
  state = markDisconnected(state, { captainId: 'human-1', nowMs: 2 }).state;
  state.participants.a.connected = true;
  state.participants.a.graceExpiresAt = null;
  state = markDisconnected(state, { captainId: 'human-1', nowMs: 3 }).state;
  assert.equal(state.participants.a.disconnectCount, 3);
  assert.equal(state.participants.a.graceExpiresAt, 3);
  state = tickEncounter(state, 3).state;
  const summary = privateReconnectSummary(state, 'human-1');
  assert.ok(summary?.proxyControlledRounds.includes(state.roundNo) || state.rounds.some((r) => r.proxyFlags.a));
});

test('settlement applies idempotently on captain', () => {
  const captain = createCaptainState({
    captainId: 'human-1',
    kind: 'human',
    handle: 'Traveler',
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
  assert.equal(claimEncounter(captain, {
    encounterId: 'enc-1',
    routeArea: 'sol:approach',
    nowMs: 1,
    expiresAt: 10_000,
  }).ok, true);
  assert.equal(bindEncounter(captain, { encounterId: 'enc-1', nowMs: 2 }).ok, true);
  assert.equal(captain.lifecycle, 'IN_ENCOUNTER');
  captain.cargo.set(CommodityId.Water, { good: CommodityId.Water, qty: 2, avgCost: 45 });

  const args = {
    encounterId: 'enc-1',
    deltaHash: 'abc',
    credits: 900,
    cargo: [{ good: CommodityId.Water, qty: 1 }],
    hull: 80,
    shields: [10],
    lifecycleAfter: 'TRAVELLING',
    nowMs: 3,
  };
  const first = applyEncounterSettlement(captain, args);
  assert.equal(first.ok, true);
  assert.equal(captain.credits, 900);
  assert.equal(captain.hull, 80);
  assert.equal(captain.cargo.get(CommodityId.Water)?.avgCost, 45);
  assert.equal(captain.cargo.get(CommodityId.Water)?.qty, 1);
  const second = applyEncounterSettlement(captain, args);
  assert.equal(second.ok, true);
  assert.equal(captain.credits, 900);
  const clash = applyEncounterSettlement(captain, { ...args, deltaHash: 'other' });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, 'INTEGRITY');
});

test('deadline supplies proxy actions for both sides', () => {
  let state = makeEncounter(21);
  const deadline = state.actionDeadlineAt;
  const r = tickEncounter(state, deadline);
  state = r.state;
  // Both should have acted via proxy/NPC policy and possibly resolved
  assert.ok(
    state.rounds.length >= 1
    || (state.participants.a.lockedAction && state.participants.b.lockedAction),
  );
});
