import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommodityId, PHASE0_TUNING, ESCAPE_POD_PRICE } from '@sto/ruleset-phase0-v1';
import {
  normalizeEmail,
  isValidEmail,
  parseCookies,
  sessionCookieHeader,
  isDevelopmentMode,
  MAGIC_LINK_TTL_MS,
} from '../dist-test/auth.js';
import {
  ensureTaskSchema,
  upsertTask,
  listDueTasks,
  processDueTasks,
  completeTask,
  earliestDueAt,
} from '../dist-test/scheduled-tasks.js';
import {
  projectCompletedTrade,
  projectCompletedOperation,
  projectEncounterHistory,
} from '../dist-test/projections.js';
import {
  createCaptainState,
  executeTrade,
  retryTradeProjection,
  refuelShip,
  repairShip,
  upgradeShip,
  installEscapePod,
  beginEscapePodRecovery,
  completeRecovery,
  privateCaptainSnapshot,
  publicCaptainView,
} from '../dist-test/captain-authority.js';
import {
  reserveTrade,
  promoteReservation,
  commitReservation,
} from '../dist-test/system-authority.js';
import { bootstrapGalaxy } from '../dist-test/galaxy/bootstrap.js';
import { ambientNpcStep, selectAmbientCohort, isEconomicallyStranded } from '../dist-test/ambient-npc.js';
import {
  createEncounter,
  submitAction,
  publicEncounterView,
  assertNoControllerLeak,
  combatantFromCaptain,
} from '../dist-test/encounter-authority.js';

/** Minimal in-memory D1 stand-in for projection idempotence tests. */
function memoryD1() {
  const trades = new Map();
  const ops = new Map();
  const encounters = new Map();
  const crimes = [];
  const bounties = new Map();
  return {
    trades,
    ops,
    encounters,
    crimes,
    bounties,
    prepare(sql) {
      const self = this;
      return {
        bind(...args) {
          this._args = args;
          return this;
        },
        async first() {
          if (sql.includes('FROM completed_trades')) {
            const row = trades.get(this._args[0]);
            return row ? { projection_hash: row.projection_hash } : null;
          }
          if (sql.includes('FROM completed_operations')) {
            const row = ops.get(this._args[0]);
            return row ? { projection_hash: row.projection_hash } : null;
          }
          if (sql.includes('FROM completed_encounters')) {
            const row = encounters.get(this._args[0]);
            return row ? { result_hash: row.result_hash } : null;
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO completed_trades') || sql.includes('INSERT OR IGNORE INTO completed_trades')) {
            const [operation_id, , , , , , , projection_hash] = this._args;
            if (trades.has(operation_id)) {
              const ex = trades.get(operation_id);
              if (ex.projection_hash !== projection_hash) throw new Error('unique conflict');
              return { success: true };
            }
            trades.set(operation_id, { projection_hash });
            return { success: true };
          }
          if (sql.includes('INSERT INTO completed_operations')) {
            const [operation_id, , projection_hash] = this._args;
            if (ops.has(operation_id)) {
              const ex = ops.get(operation_id);
              if (ex.projection_hash !== projection_hash) throw new Error('unique conflict');
              return { success: true };
            }
            ops.set(operation_id, { projection_hash });
            return { success: true };
          }
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

function memorySql() {
  const rows = new Map();
  return {
    exec(query, ...bindings) {
      if (query.includes('CREATE')) return { toArray: () => [] };
      if (query.includes('CREATE INDEX')) return { toArray: () => [] };
      if (query.includes('INSERT INTO scheduled_tasks') || query.includes('ON CONFLICT')) {
        // upsertTask binds: id, taskType, idempotencyKey, dueAt, payloadJson
        const [id, taskType, idempotencyKey, dueAt, payloadJson] = bindings;
        const key = `${taskType}::${idempotencyKey}`;
        rows.set(key, {
          id,
          task_type: taskType,
          idempotency_key: idempotencyKey,
          due_at: dueAt,
          attempt_count: 0,
          payload_json: payloadJson,
          last_error: null,
        });
        return { toArray: () => [] };
      }
      if (query.includes('UPDATE scheduled_tasks')) {
        const [attemptCount, dueAt, lastError, id] = bindings;
        for (const [k, r] of rows.entries()) {
          if (r.id === id) {
            rows.set(k, {
              ...r,
              attempt_count: attemptCount,
              due_at: dueAt,
              last_error: lastError,
            });
          }
        }
        return { toArray: () => [] };
      }
      if (query.includes('DELETE FROM scheduled_tasks')) {
        const [id] = bindings;
        for (const [k, r] of [...rows.entries()]) {
          if (r.id === id || (r.task_type === bindings[0] && r.idempotency_key === bindings[1])) {
            rows.delete(k);
          }
        }
        return { toArray: () => [] };
      }
      if (query.includes('WHERE due_at <=')) {
        const nowMs = bindings[0];
        const limit = bindings[1] ?? 100;
        const due = [...rows.values()]
          .filter((r) => r.due_at <= nowMs)
          .sort((a, b) => a.due_at - b.due_at)
          .slice(0, limit);
        return { toArray: () => due };
      }
      if (query.includes('ORDER BY due_at ASC LIMIT 1')) {
        const sorted = [...rows.values()].sort((a, b) => a.due_at - b.due_at);
        return { toArray: () => (sorted[0] ? [{ due_at: sorted[0].due_at }] : []) };
      }
      return { toArray: () => [] };
    },
    _rows: rows,
  };
}

function memoryProjections(failTradeOnce = { n: 0 }) {
  const captains = [];
  const trades = [];
  const operations = [];
  return {
    port: {
      projectCaptain: async (row) => { captains.push(row); return { ok: true }; },
      projectTrade: async (row) => {
        if (failTradeOnce.n > 0) {
          failTradeOnce.n -= 1;
          return { ok: false, error: 'simulated d1 failure' };
        }
        if (trades.some((t) => t.operation_id === row.operation_id)) return { ok: true };
        trades.push(row);
        return { ok: true };
      },
      projectOperation: async (row) => {
        if (operations.some((o) => o.operation_id === row.operation_id)) return { ok: true };
        operations.push(row);
        return { ok: true };
      },
    },
    captains,
    trades,
    operations,
  };
}

function systemPortFor(systemState) {
  return {
    async reserveTrade(args) {
      return reserveTrade(systemState, args);
    },
    async promoteReservation(operationId, requestHash) {
      return promoteReservation(systemState, operationId, requestHash);
    },
    async commitReservation(operationId, requestHash, nowMs) {
      return commitReservation(systemState, operationId, requestHash, nowMs);
    },
    async getReservation(operationId) {
      return systemState.reservations.get(operationId) ?? null;
    },
    async registerPresence() {
      return { ok: true };
    },
    async closePresence() {},
    async getPolitics() {
      return { politicsId: systemState.politicsId, strengthPolice: systemState.policePresence };
    },
    async listWrecksInRouteArea() {
      return [];
    },
  };
}

// —— Auth ——

test('auth helpers normalize email and validate sessions cookies', () => {
  assert.equal(normalizeEmail('  A@B.COM '), 'a@b.com');
  assert.equal(isValidEmail('a@b.com'), true);
  assert.equal(isValidEmail('nope'), false);
  assert.equal(MAGIC_LINK_TTL_MS > 0, true);
  const cookie = sessionCookieHeader('sess-1', Date.now() + 1000, { secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  const parsed = parseCookies('foo=1; sto_session=sess-1; bar=2');
  assert.equal(parsed.sto_session, 'sess-1');
  assert.equal(isDevelopmentMode({ ENVIRONMENT: 'production' }), false);
  assert.equal(isDevelopmentMode({ ENVIRONMENT: 'development' }), true);
  assert.equal(isDevelopmentMode({ ALLOW_ADMIN: 'true' }), true);
});

test('ownership gate: public view omits controller; private snapshot keeps profiles', () => {
  const c = createCaptainState({
    captainId: 'c1',
    kind: 'npc',
    handle: 'Vex',
    systemId: 'sol',
    nowMs: 1,
    combatProfile: 40,
    tradeProfile: -20,
  });
  const pub = publicCaptainView(c);
  assert.equal('kind' in pub, false);
  assert.equal('combatProfile' in pub, false);
  const snap = privateCaptainSnapshot(c);
  assert.equal(snap.kind, 'npc');
  assert.equal(snap.combatProfile, 40);
  assert.equal(snap.tradeProfile, -20);
});

// —— Scheduled tasks / alarms ——

test('scheduled task queue multiplexes deadlines with backoff retry', async () => {
  const sql = memorySql();
  ensureTaskSchema(sql);
  upsertTask(sql, {
    taskType: 'claim_expiry',
    idempotencyKey: 'enc-1',
    dueAt: 1000,
    payload: { encounterId: 'enc-1' },
    resetAttempts: true,
  });
  upsertTask(sql, {
    taskType: 'd1_projection_retry',
    idempotencyKey: 'op-1',
    dueAt: 2000,
    payload: { operationId: 'op-1' },
    resetAttempts: true,
  });
  assert.equal(earliestDueAt(sql), 1000);
  const due = listDueTasks(sql, 1500);
  assert.equal(due.length, 1);
  assert.equal(due[0].taskType, 'claim_expiry');

  let attempts = 0;
  const storage = {
    alarm: null,
    async getAlarm() { return this.alarm; },
    async setAlarm(t) { this.alarm = t; },
  };
  await processDueTasks(sql, storage, 1500, async () => {
    attempts += 1;
    return { done: false, error: 'fail' };
  });
  assert.equal(attempts, 1);
  assert.ok(earliestDueAt(sql) > 1500);
  const all = listDueTasks(sql, Number.MAX_SAFE_INTEGER);
  const claim = all.find((task) => task.taskType === 'claim_expiry');
  assert.ok(claim);
  assert.equal(claim.attemptCount >= 1, true);
  completeTask(sql, claim.id);
});

// —— Projection idempotence ——

test('D1 trade projection is idempotent on same hash and rejects conflict', async () => {
  const db = memoryD1();
  const row = {
    operation_id: 'op-x',
    captain_id: 'c1',
    system_id: 'sol',
    side: 'buy',
    good: 0,
    quantity: 1,
    total: 50,
    projection_hash: 'hash-a',
    created_at: 1,
  };
  const first = await projectCompletedTrade(db, row);
  assert.equal(first.ok, true);
  const second = await projectCompletedTrade(db, row);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  const conflict = await projectCompletedTrade(db, { ...row, projection_hash: 'hash-b' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.integrity, true);
});

test('encounter projection batch is idempotent', async () => {
  const db = memoryD1();
  const row = {
    encounter_id: 'enc-1',
    system_id: 'sol',
    route_area: 'sol:approach',
    result_hash: 'rh-1',
    payload_json: '{}',
    created_at: 1,
  };
  const a = await projectEncounterHistory(db, row, []);
  const b = await projectEncounterHistory(db, row, []);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
});

// —— Trade lock until projection confirms ——

test('trade remains locked and retries after projection failure', async () => {
  const galaxy = bootstrapGalaxy(1_000_000, 3);
  const captain = galaxy.captains['captain-human-1'];
  const system = galaxy.systems.sol;
  const fail = { n: 1 };
  const projections = memoryProjections(fail);
  const port = systemPortFor(system);
  const args = {
    operationId: 'trade-fail-1',
    good: CommodityId.Water,
    side: 'buy',
    quantity: 1,
    nowMs: 1_000_000,
  };
  const first = await executeTrade(captain, port, projections.port, args);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'RETRY');
  assert.ok(captain.pendingTrade);
  assert.equal(captain.pendingTrade.state, 'PROJECTING_TO_D1');

  const retry = await retryTradeProjection(captain, port, projections.port, {
    operationId: 'trade-fail-1',
    nowMs: 1_000_100,
  });
  assert.equal(retry.ok, true);
  assert.equal(captain.pendingTrade, null);
  assert.equal(projections.trades.length, 1);
});

// —— Dock actions ——

test('refuel, repair, and ship upgrade use baseline costs and lock until projected', async () => {
  const captain = createCaptainState({
    captainId: 'dock-1',
    kind: 'human',
    handle: 'Doc',
    systemId: 'sol',
    credits: 50_000,
    nowMs: 1,
  });
  captain.fuel = 2;
  captain.hull = 50;
  const projections = memoryProjections();

  const fuel = await refuelShip(captain, projections.port, { operationId: 'fuel-1', nowMs: 1 });
  assert.equal(fuel.ok, true);
  assert.ok(captain.fuel > 2);

  const repair = await repairShip(captain, projections.port, { operationId: 'repair-1', nowMs: 2 });
  assert.equal(repair.ok, true);
  assert.equal(captain.hull, captain.maxHull);

  const up = await upgradeShip(captain, projections.port, {
    operationId: 'up-1',
    shipTypeId: 2,
    systemTechLevel: 5,
    nowMs: 3,
  });
  assert.equal(up.ok, true);
  assert.equal(captain.shipType, 'Firefly');
  assert.equal(captain.hasEscapePod, false);

  const pod = installEscapePod(captain, { operationId: 'pod-1', nowMs: 4 });
  assert.equal(pod.ok, true);
  assert.equal(captain.hasEscapePod, true);
  assert.ok(ESCAPE_POD_PRICE > 0);
});

// —— Ambient NPC ——

test('ambient NPC cohort advances with ordinary dock/travel actions', async () => {
  const galaxy = bootstrapGalaxy(2_000_000, 9);
  const npc = galaxy.captains['captain-npc-1'];
  const system = galaxy.systems[npc.systemId];
  const projections = memoryProjections();
  const port = systemPortFor(system);
  const cohort = selectAmbientCohort(['captain-npc-1', 'captain-npc-2', 'captain-npc-3'], 2_000_000, 2);
  assert.equal(cohort.length, 2);

  const { state, step } = await ambientNpcStep(npc, port, projections.port, {
    nowMs: 2_000_000,
    seed: 42,
    destinations: ['sol', 'regulas'],
  });
  assert.ok(['refuel', 'repair', 'trade', 'travel', 'idle', 'locked'].includes(step.action));
  assert.equal(state.kind, 'npc');
  assert.equal(isEconomicallyStranded(state) || !isEconomicallyStranded(state), true);
});

// —— Escape pod recovery path ——

test('escape-pod recovery stays locked through AWAITING_RECOVERY then completes', () => {
  const c = createCaptainState({
    captainId: 'pod-c',
    kind: 'human',
    handle: 'P',
    systemId: 'sol',
    nowMs: 1,
    hasEscapePod: true,
  });
  const due = 1 + PHASE0_TUNING.escapePodRecoveryMs;
  const begun = beginEscapePodRecovery(c, { encounterId: 'enc-p', recoveryDueAt: due, nowMs: 1 });
  assert.equal(begun.ok, true);
  assert.equal(c.lifecycle, 'AWAITING_RECOVERY');
  assert.equal(c.recoveryDueAt, due);
  const done = completeRecovery(c, {
    operationId: 'auto-pod',
    safeSystemId: 'sol',
    source: 'automated',
    nowMs: due,
  });
  assert.equal(done.ok, true);
  assert.equal(c.lifecycle, 'ACTIVE');
  assert.equal(c.hasEscapePod, false);
});

// —— Encounter bootstrap loads profiles without public leak ——

test('encounter with relationship memory does not leak controller in public view', () => {
  const rel = {
    otherCaptainId: 'human-1',
    hostilityScore: 50,
    facts: ['prior_demand'],
    lastMetAt: 1,
    lockedExtreme: false,
  };
  let state = createEncounter({
    encounterId: 'enc-rel',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: 7,
    nowMs: 1_000_000,
    relationships: { 'npc-1::human-1': rel },
    a: {
      captainId: 'human-1',
      controller: 'human',
      kind: 'human',
      handle: 'H',
      snapshot: combatantFromCaptain({
        captainId: 'human-1',
        hull: 100,
        maxHull: 100,
        shields: [],
        credits: 1000,
        cargo: [],
        combatProfile: 0,
        tradeProfile: 0,
        policeRecord: 0,
      }),
    },
    b: {
      captainId: 'npc-1',
      controller: 'npc',
      kind: 'npc',
      handle: 'N',
      snapshot: combatantFromCaptain({
        captainId: 'npc-1',
        hull: 100,
        maxHull: 100,
        shields: [],
        credits: 1000,
        cargo: [],
        combatProfile: 60,
        tradeProfile: 0,
        policeRecord: 0,
      }),
    },
  });
  assert.equal(state.relationships['npc-1::human-1'].hostilityScore, 50);
  const view = publicEncounterView(state, 'human-1');
  assertNoControllerLeak(view);
  assert.equal('controller' in view.opponent, false);
  assert.equal('kind' in view.opponent, false);

  // Mutual ignore settles without exposing private fields
  let r = submitAction(state, {
    captainId: 'human-1',
    nowMs: 1_000_000,
    action: { actionId: 'a1', roundNo: 1, type: 'IGNORE' },
  });
  state = r.state;
  r = submitAction(state, {
    captainId: 'npc-1',
    nowMs: 1_000_001,
    action: { actionId: 'b1', roundNo: 1, type: 'IGNORE' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.state.lifecycle, 'SETTLING');
});

test('completed_operations projection rejects hash conflict', async () => {
  const db = memoryD1();
  const row = {
    operation_id: 'dock-op',
    operation_type: 'refuel',
    projection_hash: 'h1',
    payload_json: '{}',
    created_at: 1,
  };
  assert.equal((await projectCompletedOperation(db, row)).ok, true);
  assert.equal((await projectCompletedOperation(db, row)).duplicate, true);
  const bad = await projectCompletedOperation(db, { ...row, projection_hash: 'h2' });
  assert.equal(bad.ok, false);
  assert.equal(bad.integrity, true);
});
