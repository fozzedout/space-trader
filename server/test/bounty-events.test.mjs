import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleDestruction } from '@sto/ruleset-phase0-v1';
import { projectEncounterHistory } from '../dist-test/projections.js';
import {
  createEncounter,
  combatantFromCaptain,
} from '../dist-test/encounter-authority.js';
import { deriveSettlementEffects } from '../dist-test/settlement-effects.js';

function memoryD1() {
  const encounters = new Map();
  const crimes = [];
  const bounties = new Map();
  return {
    encounters,
    crimes,
    bounties,
    prepare(sql) {
      return {
        bind(...args) {
          this._args = args;
          return this;
        },
        async first() {
          if (sql.includes('FROM completed_encounters')) {
            const row = encounters.get(this._args[0]);
            return row ? { result_hash: row.result_hash } : null;
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO completed_encounters')) {
            const [encounter_id, , , result_hash] = this._args;
            encounters.set(encounter_id, { result_hash });
            return { success: true };
          }
          if (sql.includes('INSERT OR IGNORE INTO crime_events')) {
            crimes.push(this._args);
            return { success: true };
          }
          if (sql.includes('INSERT OR IGNORE INTO bounty_events')) {
            const [id, encounter_id, killer_id, victim_id, bounty_paid, lawful, created_at] = this._args;
            if (!bounties.has(id)) {
              bounties.set(id, { id, encounter_id, killer_id, victim_id, bounty_paid, lawful, created_at });
            }
            return { success: true };
          }
          return { success: true };
        },
        _args: [],
      };
    },
    async batch(stmts) {
      for (const s of stmts) await s.run();
    },
  };
}

/** Mirror encounter-do: single victim → killer is the other participant. */
function bountyProjectionFromEffects(encounterId, participants, effects, nowMs) {
  if (!effects.bounty || effects.destroyedCaptainIds.length !== 1) return null;
  const victimId = effects.destroyedCaptainIds[0];
  const killerId = participants.a.captainId === victimId
    ? participants.b.captainId
    : participants.a.captainId;
  return {
    id: `${encounterId}:bounty`,
    encounter_id: encounterId,
    killer_id: killerId,
    victim_id: victimId,
    bounty_paid: effects.bounty.bountyPaid,
    lawful: effects.bounty.lawful ? 1 : 0,
    created_at: nowMs,
  };
}

function destroyedEncounter(args) {
  const state = createEncounter({
    encounterId: args.encounterId,
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: 7,
    nowMs: 1,
    a: {
      captainId: args.killerId,
      controller: 'human',
      kind: 'human',
      handle: 'Hunter',
      snapshot: combatantFromCaptain({
        captainId: args.killerId,
        hull: 100,
        maxHull: 100,
        shields: [50],
        credits: 1000,
        cargo: [],
        combatProfile: 65,
        tradeProfile: 0,
        policeRecord: args.killerPolice,
        hasEscapePod: false,
      }),
    },
    b: {
      captainId: args.victimId,
      controller: 'npc',
      kind: 'npc',
      handle: 'Victim',
      snapshot: combatantFromCaptain({
        captainId: args.victimId,
        hull: 1,
        maxHull: 100,
        shields: [0],
        credits: 10,
        cargo: [],
        combatProfile: 0,
        tradeProfile: 0,
        policeRecord: args.victimPolice,
      }),
    },
  });
  // Deterministic terminal state — avoid RNG combat loops for projection tests.
  state.participants.b.snapshot.hull = 0;
  state.lifecycle = 'SETTLING';
  state.rounds = [{
    roundNo: 1,
    actions: {
      a: { actionId: 'a1', roundNo: 1, type: 'ATTACK' },
      b: { actionId: 'b1', roundNo: 1, type: 'FLEE' },
    },
    proxyFlags: { a: false, b: false },
    result: {
      events: ['destroyed'],
      transfers: [],
      hullA: 100,
      hullB: 0,
    },
  }];
  return state;
}

test('lawful bounty-hunting kill projects bounty_events row', async () => {
  const settlement = settleDestruction({
    killerId: 'hunter',
    victimId: 'wanted',
    killerPoliceRecordBefore: 0,
    victimPoliceRecordBefore: -50,
    killerInitiatedUnprovoked: true,
  });
  assert.equal(settlement.lawful, true);
  assert.ok(settlement.bountyPaid > 0);

  const state = destroyedEncounter({
    encounterId: 'enc-bounty-lawful',
    killerId: 'hunter',
    victimId: 'wanted',
    killerPolice: 0,
    victimPolice: -50,
  });
  const effects = deriveSettlementEffects({ state, nowMs: 100 });
  assert.ok(effects.bounty);
  assert.equal(effects.bounty.lawful, true);
  assert.ok(effects.bounty.bountyPaid > 0);
  assert.deepEqual(effects.destroyedCaptainIds, ['wanted']);

  const bounty = bountyProjectionFromEffects(state.encounterId, state.participants, effects, 100);
  assert.ok(bounty);
  assert.equal(bounty.killer_id, 'hunter');
  assert.equal(bounty.victim_id, 'wanted');

  const db = memoryD1();
  const projected = await projectEncounterHistory(db, {
    encounter_id: state.encounterId,
    system_id: 'sol',
    route_area: 'sol:approach',
    result_hash: 'rh-lawful',
    payload_json: '{}',
    created_at: 100,
  }, [], bounty);
  assert.equal(projected.ok, true);
  assert.equal(projected.duplicate, false);
  assert.equal(db.bounties.size, 1);
  const stored = db.bounties.get(`${state.encounterId}:bounty`);
  assert.ok(stored);
  assert.equal(stored.killer_id, 'hunter');
  assert.equal(stored.victim_id, 'wanted');
  assert.equal(stored.bounty_paid, effects.bounty.bountyPaid);
  assert.equal(stored.lawful, 1);
});

test('unlawful kill projects bounty_events with lawful false and bounty_paid 0', async () => {
  const settlement = settleDestruction({
    killerId: 'raider',
    victimId: 'civilian',
    killerPoliceRecordBefore: 0,
    victimPoliceRecordBefore: 0,
    killerInitiatedUnprovoked: true,
  });
  assert.equal(settlement.lawful, false);
  assert.equal(settlement.bountyPaid, 0);

  const state = destroyedEncounter({
    encounterId: 'enc-bounty-unlawful',
    killerId: 'raider',
    victimId: 'civilian',
    killerPolice: 0,
    victimPolice: 0,
  });
  const effects = deriveSettlementEffects({ state, nowMs: 100 });
  assert.ok(effects.bounty);
  assert.equal(effects.bounty.lawful, false);
  assert.equal(effects.bounty.bountyPaid, 0);

  const bounty = bountyProjectionFromEffects(state.encounterId, state.participants, effects, 100);
  const db = memoryD1();
  const projected = await projectEncounterHistory(db, {
    encounter_id: state.encounterId,
    system_id: 'sol',
    route_area: 'sol:approach',
    result_hash: 'rh-unlawful',
    payload_json: '{}',
    created_at: 100,
  }, [], bounty);
  assert.equal(projected.ok, true);
  const stored = db.bounties.get(`${state.encounterId}:bounty`);
  assert.ok(stored);
  assert.equal(stored.killer_id, 'raider');
  assert.equal(stored.victim_id, 'civilian');
  assert.equal(stored.bounty_paid, 0);
  assert.equal(stored.lawful, 0);
});

test('bounty_events projection is idempotent on retry', async () => {
  const db = memoryD1();
  const row = {
    encounter_id: 'enc-bounty-retry',
    system_id: 'sol',
    route_area: 'sol:approach',
    result_hash: 'rh-retry',
    payload_json: '{}',
    created_at: 1,
  };
  const bounty = {
    id: 'enc-bounty-retry:bounty',
    encounter_id: 'enc-bounty-retry',
    killer_id: 'hunter',
    victim_id: 'wanted',
    bounty_paid: 500,
    lawful: 1,
    created_at: 1,
  };
  const first = await projectEncounterHistory(db, row, [], bounty);
  const second = await projectEncounterHistory(db, row, [], bounty);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(db.bounties.size, 1);
});
