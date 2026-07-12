import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommodityId } from '@sto/ruleset-phase0-v1';
import {
  createEncounter,
  submitAction,
  combatantFromCaptain,
  allSecondaryEffectsAcked,
  relationshipAckKey,
} from '../dist-test/encounter-authority.js';
import { deliverSettlement } from '../dist-test/settlement-delivery.js';

function piracyEncounter() {
  let state = createEncounter({
    encounterId: 'enc-settle-retry',
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
  return state;
}

test('settlement retries police/apply after primary settle already acked', async () => {
  const state = piracyEncounter();
  assert.equal(state.lifecycle, 'SETTLING');
  assert.ok(state.settlementEffects);
  assert.ok((state.settlementEffects.policeDeltas.raider ?? 0) < 0);
  assert.ok(state.settlementEffectAcks);

  const policeCalls = [];
  const settleCalls = [];
  let policeFailRemaining = 1;

  const ports = {
    async settleCaptain({ captainId }) {
      settleCalls.push(captainId);
      return true;
    },
    async applyPolice({ captainId, body }) {
      policeCalls.push({ captainId, body });
      if (policeFailRemaining > 0) {
        policeFailRemaining -= 1;
        return false;
      }
      return true;
    },
    async upsertRelationship() {
      return true;
    },
    async addWreck() {
      return true;
    },
  };

  const first = await deliverSettlement(state, 3, ports);
  assert.equal(first, false);
  assert.equal(state.participants.a.settlementState, 'acked');
  assert.equal(state.settlementEffectAcks.policeAcked.raider, undefined);
  assert.equal(allSecondaryEffectsAcked(state), false);
  assert.notEqual(state.lifecycle, 'PROJECTING_TO_D1');
  assert.notEqual(state.lifecycle, 'COMPLETE');
  assert.ok(settleCalls.includes('raider'));
  assert.ok(policeCalls.some((c) => c.captainId === 'raider'));

  const settleCountAfterFirst = settleCalls.length;
  const policeCountAfterFirst = policeCalls.length;

  const second = await deliverSettlement(state, 4, ports);
  assert.equal(second, true);
  assert.equal(state.participants.a.settlementState, 'acked');
  assert.equal(state.participants.b.settlementState, 'acked');
  assert.equal(state.settlementEffectAcks.policeAcked.raider, true);
  assert.equal(allSecondaryEffectsAcked(state), true);
  assert.equal(state.lifecycle, 'PROJECTING_TO_D1');
  // Primary settle for raider must not be re-POSTed; police must be retried.
  assert.ok(!settleCalls.slice(settleCountAfterFirst).includes('raider'));
  assert.ok(policeCalls.length > policeCountAfterFirst);
  assert.ok(policeCalls.filter((c) => c.captainId === 'raider').length >= 2);
});

test('settlement retries relationship upsert independently of primary settle', async () => {
  const state = piracyEncounter();
  assert.ok(state.settlementEffects.relationshipUpdates.length > 0);
  const rel = state.settlementEffects.relationshipUpdates[0];
  const key = relationshipAckKey(rel.npcCaptainId, rel.otherCaptainId);

  let relFailRemaining = 1;
  const relCalls = [];

  const ports = {
    async settleCaptain() {
      return true;
    },
    async applyPolice() {
      return true;
    },
    async upsertRelationship({ npcCaptainId }) {
      relCalls.push(npcCaptainId);
      if (relFailRemaining > 0) {
        relFailRemaining -= 1;
        return false;
      }
      return true;
    },
    async addWreck() {
      return true;
    },
  };

  const first = await deliverSettlement(state, 3, ports);
  assert.equal(first, false);
  assert.equal(state.settlementEffectAcks.relationshipAcked[key], undefined);
  assert.equal(allSecondaryEffectsAcked(state), false);
  assert.notEqual(state.lifecycle, 'COMPLETE');

  const second = await deliverSettlement(state, 4, ports);
  assert.equal(second, true);
  assert.equal(state.settlementEffectAcks.relationshipAcked[key], true);
  assert.equal(state.lifecycle, 'PROJECTING_TO_D1');
  assert.ok(relCalls.length >= 2);
});
