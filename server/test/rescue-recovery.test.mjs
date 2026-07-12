import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommodityId, PHASE0_TUNING, createWreck } from '@sto/ruleset-phase0-v1';
import {
  createCaptainState,
  beginEscapePodRecovery,
  completeRecovery,
} from '../dist-test/captain-authority.js';
import {
  createSystemState,
  addWreck,
  rescueEscapePod,
} from '../dist-test/system-authority.js';
import {
  scheduleTask,
  listDueTasks,
  processDueTasks,
} from '../dist-test/scheduled-tasks.js';

function memorySql() {
  const rows = new Map();
  return {
    exec(query, ...bindings) {
      if (query.includes('CREATE')) return { toArray: () => [] };
      if (query.includes('CREATE INDEX')) return { toArray: () => [] };
      if (query.includes('INSERT INTO scheduled_tasks') || query.includes('ON CONFLICT')) {
        const [id, taskType, idempotencyKey, dueAt, payloadJson] = bindings;
        const key = `${taskType}::${idempotencyKey}`;
        const existing = rows.get(key);
        rows.set(key, {
          id,
          task_type: taskType,
          idempotency_key: idempotencyKey,
          due_at: dueAt,
          attempt_count: existing?.attempt_count ?? 0,
          payload_json: payloadJson,
          last_error: null,
        });
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
      if (query.includes('DELETE FROM scheduled_tasks')) {
        const id = bindings[0];
        for (const [key, row] of rows) {
          if (row.id === id) rows.delete(key);
        }
        return { toArray: () => [] };
      }
      if (query.includes('UPDATE scheduled_tasks')) {
        const [attemptCount, dueAt, lastError, id] = bindings;
        for (const row of rows.values()) {
          if (row.id === id) {
            row.attempt_count = attemptCount;
            row.due_at = dueAt;
            row.last_error = lastError;
          }
        }
        return { toArray: () => [] };
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

/**
 * Mirrors System DO completeRescuedCaptainRecovery + /wrecks/rescue post-rescue path.
 */
async function runSystemRescuePath(system, sql, env, { wreckId, rescuerId, nowMs }) {
  const result = rescueEscapePod(system, { wreckId, rescuerId, nowMs });
  if (!result.ok) return result;

  const captain = env.CAPTAIN.get(env.CAPTAIN.idFromName(result.rescuedCaptainId));
  const res = await captain.fetch(new Request('https://captain/recovery/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
    body: JSON.stringify({
      operationId: `rescue-${wreckId}`,
      safeSystemId: system.systemId,
      source: 'rescue',
    }),
  }));
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = { ok: false, error: 'non-json' };
  }
  if (!res.ok || !body.ok) {
    scheduleTask(sql, {
      taskType: 'rescue_recovery_retry',
      idempotencyKey: wreckId,
      dueAt: nowMs + 1_000,
      payload: {
        wreckId,
        captainId: result.rescuedCaptainId,
        systemId: system.systemId,
      },
    });
  }
  return { ok: true, rescuedCaptainId: result.rescuedCaptainId, recoveryOk: !!(res.ok && body.ok) };
}

/** Mirrors System DO handleTask for rescue_recovery_retry. */
async function runRescueRecoveryRetryTask(env, task, nowMs) {
  const payload = JSON.parse(task.payloadJson);
  const captain = env.CAPTAIN.get(env.CAPTAIN.idFromName(payload.captainId));
  const res = await captain.fetch(new Request('https://captain/recovery/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
    body: JSON.stringify({
      operationId: `rescue-${payload.wreckId}`,
      safeSystemId: payload.systemId,
      source: 'rescue',
    }),
  }));
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = { ok: false };
  }
  return (res.ok && body.ok)
    ? { done: true }
    : { done: false, error: body.error ?? 'rescue recovery incomplete' };
}

function fixture() {
  const captain = createCaptainState({
    captainId: 'human-rescue-1',
    kind: 'human',
    handle: 'Stranded',
    systemId: 'sol',
    nowMs: 1,
    hasEscapePod: true,
  });
  beginEscapePodRecovery(captain, {
    encounterId: 'enc-r',
    recoveryDueAt: 1 + PHASE0_TUNING.escapePodRecoveryMs,
    nowMs: 1,
  });
  const system = createSystemState({
    systemId: 'sol',
    name: 'Sol',
    techLevel: 5,
    politicsId: 6,
    size: 3,
    goods: [{ good: CommodityId.Water, equilibriumPrice: 40, targetStock: 20 }],
    nowMs: 1,
  });
  addWreck(system, createWreck({
    wreckId: 'wreck-rescue-1',
    routeArea: 'sol:approach',
    cargo: [],
    nowMs: 1,
    escapePodCaptainId: captain.captainId,
    hasCloneBackup: true,
  }));
  return { captain, system };
}

function mockEnv(captain, { failFirst = false } = {}) {
  let attempts = 0;
  return {
    CAPTAIN: {
      idFromName(id) { return id; },
      get(id) {
        return {
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname !== '/recovery/complete') {
              return new Response(JSON.stringify({ ok: false, error: 'unexpected' }), { status: 404 });
            }
            attempts += 1;
            if (failFirst && attempts === 1) {
              return new Response(JSON.stringify({ ok: false, error: 'transient' }), {
                status: 500,
                headers: { 'content-type': 'application/json' },
              });
            }
            const body = await request.json();
            const nowMs = Number(request.headers.get('x-now-ms') ?? Date.now());
            const result = completeRecovery(captain, { ...body, nowMs });
            return new Response(JSON.stringify({
              ok: result.ok,
              error: result.error,
              captain: { lifecycle: captain.lifecycle, systemId: captain.systemId },
            }), {
              status: result.ok ? 200 : 400,
              headers: { 'content-type': 'application/json' },
            });
          },
        };
      },
    },
    _attempts: () => attempts,
  };
}

test('successful rescue completes captain recovery in one pass', async () => {
  const { captain, system } = fixture();
  const sql = memorySql();
  const env = mockEnv(captain);

  assert.equal(captain.lifecycle, 'AWAITING_RECOVERY');
  const outcome = await runSystemRescuePath(system, sql, env, {
    wreckId: 'wreck-rescue-1',
    rescuerId: 'rescuer-1',
    nowMs: 2,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.recoveryOk, true);
  assert.equal(captain.lifecycle, 'ACTIVE');
  assert.equal(captain.systemId, 'sol');
  assert.equal(listDueTasks(sql, 10_000).length, 0);
  assert.equal(system.wrecks.get('wreck-rescue-1').podState, 'COMPLETE');
});

test('failed captain recovery schedules retry that later completes', async () => {
  const { captain, system } = fixture();
  const sql = memorySql();
  const env = mockEnv(captain, { failFirst: true });
  const storage = {
    async setAlarm() {},
    async deleteAlarm() {},
  };

  const outcome = await runSystemRescuePath(system, sql, env, {
    wreckId: 'wreck-rescue-1',
    rescuerId: 'rescuer-1',
    nowMs: 2,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.recoveryOk, false);
  assert.equal(captain.lifecycle, 'AWAITING_RECOVERY');
  assert.equal(system.wrecks.get('wreck-rescue-1').podState, 'COMPLETE');

  const due = listDueTasks(sql, 2 + 1_000);
  assert.equal(due.length, 1);
  assert.equal(due[0].taskType, 'rescue_recovery_retry');
  assert.equal(due[0].idempotencyKey, 'wreck-rescue-1');

  const processed = await processDueTasks(
    sql,
    storage,
    2 + 1_000,
    async (task) => runRescueRecoveryRetryTask(env, task, 2 + 1_000),
  );
  assert.equal(processed.processed, 1);
  assert.equal(captain.lifecycle, 'ACTIVE');
  assert.equal(captain.systemId, 'sol');
  assert.equal(listDueTasks(sql, 100_000).length, 0);
  assert.equal(env._attempts(), 2);
});
