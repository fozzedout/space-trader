import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveCaptainIdForAccount,
  deactivateCaptainMapping,
  succeedIfTerminalCaptain,
  allocateSuccessorCaptain,
  isTerminalCaptainLifecycle,
  claimOrResolveHumanCaptain,
} from '../dist-test/auth.js';
import { resolveActiveHumanCaptain } from '../dist-test/human-captain.js';
import {
  createCaptainState,
  retireCaptain,
  applyEncounterSettlement,
  publicCaptainView,
} from '../dist-test/captain-authority.js';
import { CommodityId } from '@sto/ruleset-phase0-v1';

/** In-memory D1 stand-in covering captain_controller_private succession queries. */
function memoryAuthD1() {
  /** @type {Map<string, { captain_id: string; kind: string; account_id: string | null; updated_at: number; active: number }>} */
  const controllers = new Map();
  return {
    controllers,
    prepare(sql) {
      const self = this;
      return {
        _args: [],
        bind(...args) {
          this._args = args;
          return this;
        },
        async first() {
          if (sql.includes('FROM captain_controller_private') && sql.includes('account_id = ?') && sql.includes('active = 1')) {
            const accountId = this._args[0];
            const rows = [...controllers.values()]
              .filter((r) => r.account_id === accountId && r.kind === 'human' && r.active === 1)
              .sort((a, b) => b.updated_at - a.updated_at);
            return rows[0] ? { captain_id: rows[0].captain_id } : null;
          }
          if (sql.includes('FROM captain_controller_private') && sql.includes('WHERE captain_id = ?')) {
            const row = controllers.get(this._args[0]);
            return row
              ? { captain_id: row.captain_id, account_id: row.account_id, active: row.active }
              : null;
          }
          return null;
        },
        async run() {
          if (sql.includes('UPDATE captain_controller_private SET active = 0')) {
            const [nowMs, captainId] = this._args;
            const row = controllers.get(captainId);
            if (row) {
              row.active = 0;
              row.updated_at = nowMs;
            }
            return { success: true, meta: { changes: row ? 1 : 0 } };
          }
          if (sql.includes('UPDATE captain_controller_private SET account_id')) {
            const [accountId, nowMs, captainId] = this._args;
            const row = controllers.get(captainId);
            if (row) {
              row.account_id = accountId;
              row.updated_at = nowMs;
              row.active = 1;
            }
            return { success: true, meta: { changes: row ? 1 : 0 } };
          }
          if (sql.includes('INSERT INTO captain_controller_private') || sql.includes('INSERT OR REPLACE INTO captain_controller_private')) {
            // allocateSuccessorCaptain: (?, 'human', ?, ?, 1) → captainId, accountId, updatedAt
            // claimOrReplace / tests may also bind kind and/or active
            let captainId;
            let kind = 'human';
            let accountId;
            let updatedAt;
            let active = 1;
            if (sql.includes("'human'") && this._args.length === 3) {
              [captainId, accountId, updatedAt] = this._args;
            } else if (this._args.length === 4 && sql.includes("'human'")) {
              [captainId, accountId, updatedAt, active] = this._args;
            } else if (this._args.length >= 5) {
              [captainId, kind, accountId, updatedAt, active] = this._args;
            } else {
              [captainId, kind, accountId, updatedAt] = this._args;
            }
            controllers.set(captainId, {
              captain_id: captainId,
              kind,
              account_id: accountId,
              updated_at: updatedAt,
              active: active ?? 1,
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
    },
  };
}

test('isTerminalCaptainLifecycle recognizes RETIRED and DEAD only', () => {
  assert.equal(isTerminalCaptainLifecycle('RETIRED'), true);
  assert.equal(isTerminalCaptainLifecycle('DEAD'), true);
  assert.equal(isTerminalCaptainLifecycle('ACTIVE'), false);
  assert.equal(isTerminalCaptainLifecycle('TRAVELLING'), false);
  assert.equal(isTerminalCaptainLifecycle('IN_ENCOUNTER'), false);
});

test('ACTIVE captain resolution does not churn captainId', async () => {
  const db = memoryAuthD1();
  const accountId = 'acct-1';
  const captainId = 'captain-human-alive';
  await db.prepare(
    `INSERT INTO captain_controller_private (captain_id, kind, account_id, updated_at, active)
     VALUES (?, 'human', ?, ?, 1)`,
  ).bind(captainId, accountId, 1000, 1).run();

  assert.equal(await resolveCaptainIdForAccount(db, accountId), captainId);

  const again = await succeedIfTerminalCaptain(db, {
    accountId,
    captainId,
    lifecycleState: 'ACTIVE',
    nowMs: 2000,
  });
  assert.equal(again.succeeded, false);
  assert.equal(again.captainId, captainId);
  assert.equal(await resolveCaptainIdForAccount(db, accountId), captainId);

  const travelling = await succeedIfTerminalCaptain(db, {
    accountId,
    captainId,
    lifecycleState: 'TRAVELLING',
    nowMs: 3000,
  });
  assert.equal(travelling.succeeded, false);
  assert.equal(travelling.captainId, captainId);
});

test('retirement succession yields a fresh ACTIVE captain with no carried assets', async () => {
  const db = memoryAuthD1();
  const accountId = 'acct-retire';
  const oldId = 'captain-human-old';
  await db.prepare(
    `INSERT INTO captain_controller_private (captain_id, kind, account_id, updated_at, active)
     VALUES (?, 'human', ?, ?, 1)`,
  ).bind(oldId, accountId, 1000, 1).run();

  const old = createCaptainState({
    captainId: oldId,
    kind: 'human',
    handle: 'OldHand',
    systemId: 'sol',
    credits: 99_999,
    nowMs: 1,
    combatProfile: 40,
    tradeProfile: -20,
  });
  old.cargo.set(CommodityId.Ore, { good: CommodityId.Ore, qty: 12, avgCost: 100 });
  const retired = retireCaptain(old, { operationId: 'ret-1', nowMs: 2 });
  assert.equal(retired.ok, true);
  assert.equal(old.lifecycle, 'RETIRED');
  assert.equal(publicCaptainView(old).lifecycleState, 'RETIRED');

  const succession = await succeedIfTerminalCaptain(db, {
    accountId,
    captainId: oldId,
    lifecycleState: old.lifecycle,
    nowMs: 3000,
  });
  assert.equal(succession.succeeded, true);
  assert.notEqual(succession.captainId, oldId);
  assert.match(succession.captainId, /^captain-human-/);

  assert.equal(await resolveCaptainIdForAccount(db, accountId), succession.captainId);
  assert.equal(db.controllers.get(oldId).active, 0);

  const fresh = createCaptainState({
    captainId: succession.captainId,
    kind: 'human',
    handle: 'player',
    systemId: 'sol',
    credits: 12_000,
    nowMs: 3000,
  });
  assert.equal(fresh.lifecycle, 'ACTIVE');
  assert.equal(fresh.credits, 12_000);
  assert.equal(fresh.credits !== old.credits, true);
  assert.equal(fresh.cargo.size, 0);
  assert.equal(fresh.combatProfile, 0);
  assert.equal(fresh.tradeProfile, 0);
  assert.notEqual(fresh.combatProfile, old.combatProfile);
});

test('DEAD via applyEncounterSettlement produces the same successor behaviour', async () => {
  const db = memoryAuthD1();
  const accountId = 'acct-dead';
  const oldId = 'captain-human-dead';
  await db.prepare(
    `INSERT INTO captain_controller_private (captain_id, kind, account_id, updated_at, active)
     VALUES (?, 'human', ?, ?, 1)`,
  ).bind(oldId, accountId, 1000, 1).run();

  const captain = createCaptainState({
    captainId: oldId,
    kind: 'human',
    handle: 'Doomed',
    systemId: 'sol',
    credits: 5000,
    nowMs: 1,
  });
  captain.lifecycle = 'IN_ENCOUNTER';
  captain.activeEncounterId = 'enc-fatal';
  const settled = applyEncounterSettlement(captain, {
    encounterId: 'enc-fatal',
    deltaHash: 'hash-1',
    credits: 0,
    cargo: [],
    hull: 0,
    shields: [],
    lifecycleAfter: 'DEAD',
    nowMs: 10,
  });
  assert.equal(settled.ok, true);
  assert.equal(captain.lifecycle, 'DEAD');

  const succession = await succeedIfTerminalCaptain(db, {
    accountId,
    captainId: oldId,
    lifecycleState: captain.lifecycle,
    nowMs: 20,
  });
  assert.equal(succession.succeeded, true);
  assert.notEqual(succession.captainId, oldId);
  assert.equal(await resolveCaptainIdForAccount(db, accountId), succession.captainId);
  assert.equal(db.controllers.get(oldId).active, 0);

  const again = await claimOrResolveHumanCaptain(db, accountId, 30);
  assert.equal(again, succession.captainId);
});

test('deactivateCaptainMapping frees the account for allocateSuccessorCaptain', async () => {
  const db = memoryAuthD1();
  const accountId = 'acct-alloc';
  const oldId = 'captain-old';
  await db.prepare(
    `INSERT INTO captain_controller_private (captain_id, kind, account_id, updated_at, active)
     VALUES (?, 'human', ?, ?, 1)`,
  ).bind(oldId, accountId, 1, 1).run();

  await deactivateCaptainMapping(db, oldId, 50);
  assert.equal(await resolveCaptainIdForAccount(db, accountId), null);

  const next = await allocateSuccessorCaptain(db, accountId, oldId, 60);
  assert.notEqual(next, oldId);
  assert.equal(await resolveCaptainIdForAccount(db, accountId), next);
});

/**
 * Mock CAPTAIN namespace: serves /view from in-memory states and /bootstrap by
 * creating a fresh ACTIVE captain (mirrors Captain DO behaviour enough for succession).
 */
function mockCaptainEnv(db, captainsById) {
  return {
    DB: db,
    CAPTAIN: {
      idFromName(id) { return id; },
      get(id) {
        return {
          async fetch(request) {
            const url = new URL(request.url);
            const nowMs = Number(request.headers.get('x-now-ms') ?? Date.now());
            if (url.pathname === '/view' && request.method === 'GET') {
              const captain = captainsById[id];
              if (!captain) {
                return new Response(JSON.stringify({ ok: false }), { status: 404 });
              }
              return new Response(JSON.stringify({
                ok: true,
                captain: publicCaptainView(captain),
              }), { headers: { 'content-type': 'application/json' } });
            }
            if (url.pathname === '/bootstrap' && request.method === 'POST') {
              const body = await request.json();
              const fresh = createCaptainState({
                captainId: body.captainId,
                kind: 'human',
                handle: body.handle,
                systemId: body.systemId,
                credits: body.credits ?? 12_000,
                nowMs,
              });
              captainsById[body.captainId] = fresh;
              return new Response(JSON.stringify({
                ok: true,
                captain: publicCaptainView(fresh),
              }), { headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify({ ok: false }), { status: 404 });
          },
        };
      },
    },
  };
}

test('resolveActiveHumanCaptain succeeds past RETIRED without magic-link verify', async () => {
  const db = memoryAuthD1();
  const accountId = 'acct-me-path';
  const oldId = 'captain-human-retired-me';
  await db.prepare(
    `INSERT INTO captain_controller_private (captain_id, kind, account_id, updated_at, active)
     VALUES (?, 'human', ?, ?, 1)`,
  ).bind(oldId, accountId, 1000, 1).run();

  const old = createCaptainState({
    captainId: oldId,
    kind: 'human',
    handle: 'OldHand',
    systemId: 'sol',
    credits: 50_000,
    nowMs: 1,
  });
  assert.equal(retireCaptain(old, { operationId: 'ret-me', nowMs: 2 }).ok, true);
  assert.equal(old.lifecycle, 'RETIRED');

  const captainsById = { [oldId]: old };
  const env = mockCaptainEnv(db, captainsById);

  const resolved = await resolveActiveHumanCaptain(env, {
    accountId,
    email: 'pilot@example.com',
    captainId: oldId,
    nowMs: 3000,
  });
  assert.equal(resolved.ok, true);
  assert.notEqual(resolved.captainId, oldId);
  assert.equal(await resolveCaptainIdForAccount(db, accountId), resolved.captainId);
  assert.equal(db.controllers.get(oldId).active, 0);

  const fresh = captainsById[resolved.captainId];
  assert.ok(fresh);
  assert.equal(fresh.lifecycle, 'ACTIVE');
  assert.equal(fresh.credits, 12_000);
  assert.equal(fresh.cargo.size, 0);

  // Same path again (as /auth/me would) must not churn the new ACTIVE captain.
  const again = await resolveActiveHumanCaptain(env, {
    accountId,
    email: 'pilot@example.com',
    captainId: resolved.captainId,
    nowMs: 4000,
  });
  assert.equal(again.ok, true);
  assert.equal(again.captainId, resolved.captainId);
});
