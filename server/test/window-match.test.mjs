import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PHASE0_TUNING, windowsOverlapping } from '@sto/ruleset-phase0-v1';
import { bootstrapGalaxy } from '../dist-test/galaxy/bootstrap.js';
import {
  matchWindow,
  registerPresence,
  markClaimed,
} from '../dist-test/system-authority.js';
import {
  claimEncounter,
  releaseEncounterClaim,
  privateCaptainSnapshot,
} from '../dist-test/captain-authority.js';
import {
  scheduleTask,
  listDueTasks,
  ensureTaskSchema,
} from '../dist-test/scheduled-tasks.js';
import { claimAndStartEncounter } from '../dist-test/encounter-claim.js';

function memorySql() {
  const rows = new Map();
  return {
    exec(query, ...bindings) {
      if (query.includes('CREATE')) return { toArray: () => [] };
      if (query.includes('CREATE INDEX')) return { toArray: () => [] };
      if (query.includes('INSERT INTO scheduled_tasks') || query.includes('ON CONFLICT')) {
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

/** Schedule window_match tasks the same way System DO /presence does. */
function schedulePresenceWindowMatches(sql, body) {
  for (const tick of windowsOverlapping(body.occupancyStartedAt, body.occupancyEndsAt)) {
    scheduleTask(sql, {
      taskType: 'window_match',
      idempotencyKey: `${body.routeArea}:${tick}`,
      dueAt: (tick + 1) * PHASE0_TUNING.travelWindowMs,
      payload: { routeArea: body.routeArea, globalTick: tick },
    });
  }
}

/**
 * Window-match task handling path (mirrors System DO handleTask for window_match),
 * without going through the Worker POST /systems/:id/match route.
 */
async function runWindowMatchTask(env, system, { routeArea, globalTick, nowMs }) {
  const matched = matchWindow(system, { routeArea, globalTick, nowMs });
  const claimed = [];
  if (matched.ok && matched.pairs) {
    for (const pair of matched.pairs) {
      const outcome = await claimAndStartEncounter(env, system.systemId, pair, nowMs, {
        markClaim: (captainId, encounterId) => {
          markClaimed(system, captainId, encounterId);
        },
      });
      claimed.push({ pair, ...outcome });
    }
  }
  return { matched, claimed };
}

function mockEnv(captainsById, startedEncounters) {
  const stubFor = (captainId) => ({
    async fetch(request) {
      const url = new URL(request.url);
      const captain = captainsById[captainId];
      const nowMs = Number(request.headers.get('x-now-ms') ?? Date.now());
      if (url.pathname === '/claim' && request.method === 'POST') {
        const body = await request.json();
        const result = claimEncounter(captain, { ...body, nowMs });
        return Response.json({ ok: result.ok });
      }
      if (url.pathname === '/claim/release' && request.method === 'POST') {
        const body = await request.json();
        releaseEncounterClaim(captain, { ...body, nowMs });
        return Response.json({ ok: true });
      }
      if (url.pathname === '/internal/snapshot') {
        return Response.json({ ok: true, snapshot: privateCaptainSnapshot(captain) });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  });
  return {
    CAPTAIN: {
      idFromName: (name) => ({ name }),
      get: (id) => stubFor(id.name),
    },
    SYSTEM: {
      idFromName: (name) => ({ name }),
      get: () => ({
        async fetch() {
          throw new Error('System DO must mark claims locally — no self-fetch');
        },
      }),
    },
    ENCOUNTER: {
      idFromName: (name) => ({ name }),
      get: (id) => ({
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === '/start' && request.method === 'POST') {
            const body = await request.json();
            if (!startedEncounters.has(body.encounterId)) {
              startedEncounters.set(body.encounterId, body);
            }
            return Response.json({ ok: true });
          }
          return Response.json({ ok: false }, { status: 404 });
        },
      }),
    },
  };
}

function putTravelling(captain, routeArea, destinationSystemId) {
  captain.lifecycle = 'TRAVELLING';
  captain.activeTrip = {
    tripId: `trip-${captain.captainId}`,
    seed: 1,
    rulesetVersion: 'ruleset-phase0-v1',
    approachTicks: 15,
    routeArea,
    destinationSystemId,
  };
  captain.activeEncounterId = null;
  captain.claimExpiresAt = null;
}

test('presence registration schedules window_match at window close', () => {
  const sql = memorySql();
  ensureTaskSchema(sql);
  const occupancyStartedAt = 10_000_000;
  const occupancyEndsAt = occupancyStartedAt + PHASE0_TUNING.travelWindowMs;
  const routeArea = 'sol:approach';
  schedulePresenceWindowMatches(sql, { routeArea, occupancyStartedAt, occupancyEndsAt });

  const ticks = windowsOverlapping(occupancyStartedAt, occupancyEndsAt);
  assert.ok(ticks.length >= 1);
  const dueAtClose = listDueTasks(sql, (ticks[0] + 1) * PHASE0_TUNING.travelWindowMs);
  const matchTasks = dueAtClose.filter((t) => t.taskType === 'window_match');
  assert.equal(matchTasks.length, ticks.length);
  for (const tick of ticks) {
    const task = matchTasks.find((t) => t.idempotencyKey === `${routeArea}:${tick}`);
    assert.ok(task);
    assert.equal(task.dueAt, (tick + 1) * PHASE0_TUNING.travelWindowMs);
    const payload = JSON.parse(task.payloadJson);
    assert.equal(payload.routeArea, routeArea);
    assert.equal(payload.globalTick, tick);
  }

  // Re-register same window is idempotent (no duplicate tasks).
  schedulePresenceWindowMatches(sql, { routeArea, occupancyStartedAt, occupancyEndsAt });
  assert.equal(
    [...sql._rows.values()].filter((r) => r.task_type === 'window_match').length,
    ticks.length,
  );
});

test('window_match task path claims encounter without manual /match', async () => {
  const galaxy = bootstrapGalaxy(10_000_000, 13);
  const system = galaxy.systems.sol;
  const a = galaxy.captains['captain-human-1'];
  const b = galaxy.captains['captain-npc-1'];
  const routeArea = 'sol:approach';
  const nowMs = 10_000_000;
  const occupancyStartedAt = nowMs;
  const occupancyEndsAt = nowMs + PHASE0_TUNING.travelWindowMs;
  const ticks = windowsOverlapping(occupancyStartedAt, occupancyEndsAt);
  const globalTick = ticks[0];

  putTravelling(a, routeArea, 'sol');
  putTravelling(b, routeArea, 'sol');

  for (const captain of [a, b]) {
    registerPresence(system, {
      captainId: captain.captainId,
      routeArea,
      approachTick: 1,
      occupancyStartedAt,
      occupancyEndsAt,
      encounterId: null,
      status: 'present',
      matchable: true,
    });
  }

  const sql = memorySql();
  schedulePresenceWindowMatches(sql, { routeArea, occupancyStartedAt, occupancyEndsAt });
  const due = listDueTasks(sql, (globalTick + 1) * PHASE0_TUNING.travelWindowMs);
  const task = due.find((t) => t.taskType === 'window_match' && t.idempotencyKey === `${routeArea}:${globalTick}`);
  assert.ok(task, 'window_match task must be due at window close');

  const startedEncounters = new Map();
  const env = mockEnv({ [a.captainId]: a, [b.captainId]: b }, startedEncounters);
  const payload = JSON.parse(task.payloadJson);

  // Invoke the alarm task path — never call Worker /systems/:id/match.
  const first = await runWindowMatchTask(env, system, {
    routeArea: payload.routeArea,
    globalTick: payload.globalTick,
    nowMs: task.dueAt,
  });
  assert.equal(first.matched.ok, true);
  assert.ok(first.matched.pairs.length >= 1);
  assert.ok(first.claimed.some((c) => c.ok));
  assert.equal(startedEncounters.size, 1);
  assert.equal(a.lifecycle, 'ENCOUNTER_CLAIMED');
  assert.equal(b.lifecycle, 'ENCOUNTER_CLAIMED');
  assert.equal(a.activeEncounterId, b.activeEncounterId);
  assert.ok(a.activeEncounterId);

  // Second fire (manual scan + alarm) must not double-claim or start another encounter.
  const second = await runWindowMatchTask(env, system, {
    routeArea: payload.routeArea,
    globalTick: payload.globalTick,
    nowMs: task.dueAt + 1,
  });
  assert.deepEqual(second.matched.pairs, first.matched.pairs);
  assert.equal(startedEncounters.size, 1);
  assert.equal(a.activeEncounterId, [...startedEncounters.keys()][0]);
  assert.equal(b.activeEncounterId, a.activeEncounterId);
});
