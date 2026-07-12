import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isPublicCaptainRoute,
  isPublicSystemRoute,
  isPublicEncounterRoute,
  publicDurableObjectRouteGate,
} from '../dist-test/public-routes.js';

const INTERNAL_CAPTAIN_PATHS = [
  'encounter/settle',
  'police/apply',
  'recovery/complete',
  'claim',
  'claim/release',
  'encounter/bind',
  'relationship/upsert',
  'ambient/step',
  'playtest/force-approach',
  'internal/snapshot',
];

const INTERNAL_SYSTEM_PATHS = [
  'wrecks/add',
  'wrecks/destroy-pod',
  'wrecks/scoop',
  'presence',
  'presence/close',
  'claim/mark',
  'claim/release',
  'reserve',
  'promote',
  'commit',
  'bootstrap',
];

const INTERNAL_ENCOUNTER_PATHS = [
  'start',
  'tick',
];

async function assertGate404(urlPath, method, headers = {}) {
  const res = publicDurableObjectRouteGate(new Request(`https://worker.test${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'POST' ? '{}' : undefined,
  }));
  assert.ok(res, `expected 404 gate for ${method} ${urlPath}`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepEqual(body, { ok: false, error: 'not found' });
}

test('public captain allowlist: only view GET and player mutations', () => {
  assert.equal(isPublicCaptainRoute('GET', 'view'), true);
  assert.equal(isPublicCaptainRoute('GET', ''), true);
  assert.equal(isPublicCaptainRoute('POST', 'trade'), true);
  assert.equal(isPublicCaptainRoute('POST', 'travel/start'), true);
  assert.equal(isPublicCaptainRoute('POST', 'police/respond'), true);
  assert.equal(isPublicCaptainRoute('POST', 'encounter/settle'), false);
  assert.equal(isPublicCaptainRoute('GET', 'encounter/settle'), false);
});

test('public system allowlist: only market/wrecks GET and known POST handlers', () => {
  assert.equal(isPublicSystemRoute('GET', 'market'), true);
  assert.equal(isPublicSystemRoute('GET', ''), true);
  assert.equal(isPublicSystemRoute('GET', 'wrecks'), true);
  assert.equal(isPublicSystemRoute('POST', 'match'), true);
  assert.equal(isPublicSystemRoute('POST', 'wrecks/rescue'), true);
  assert.equal(isPublicSystemRoute('POST', 'wrecks/add'), false);
  assert.equal(isPublicSystemRoute('GET', 'wrecks/add'), false);
});

test('Worker public router gate 404s internal captain paths without session', async () => {
  for (const rest of INTERNAL_CAPTAIN_PATHS) {
    await assertGate404(`/captains/captain-human-1/${rest}`, 'POST');
  }
});

test('Worker public router gate 404s internal captain paths with session cookie', async () => {
  const cookie = { cookie: 'sto_session=valid-looking-session-token' };
  for (const rest of INTERNAL_CAPTAIN_PATHS) {
    await assertGate404(`/captains/captain-human-1/${rest}`, 'POST', cookie);
  }
});

test('Worker public router gate 404s internal system paths', async () => {
  for (const rest of INTERNAL_SYSTEM_PATHS) {
    await assertGate404(`/systems/sol/${rest}`, 'POST');
  }
  await assertGate404('/systems/sol/wrecks/add', 'POST', {
    cookie: 'sto_session=valid-looking-session-token',
  });
});

test('public encounter allowlist: only view/summary GET and player mutations', () => {
  assert.equal(isPublicEncounterRoute('GET', 'view'), true);
  assert.equal(isPublicEncounterRoute('GET', ''), true);
  assert.equal(isPublicEncounterRoute('GET', 'summary'), true);
  assert.equal(isPublicEncounterRoute('POST', 'action'), true);
  assert.equal(isPublicEncounterRoute('POST', 'disconnect'), true);
  assert.equal(isPublicEncounterRoute('POST', 'reconnect'), true);
  assert.equal(isPublicEncounterRoute('POST', 'start'), false);
  assert.equal(isPublicEncounterRoute('POST', 'tick'), false);
  assert.equal(isPublicEncounterRoute('GET', 'start'), false);
});

test('Worker public router gate 404s internal encounter paths without session', async () => {
  for (const rest of INTERNAL_ENCOUNTER_PATHS) {
    await assertGate404(`/encounters/enc-attacker/${rest}`, 'POST');
  }
});

test('Worker public router gate 404s internal encounter paths with session cookie', async () => {
  const cookie = { cookie: 'sto_session=valid-looking-session-token' };
  for (const rest of INTERNAL_ENCOUNTER_PATHS) {
    await assertGate404(`/encounters/enc-attacker/${rest}`, 'POST', cookie);
  }
});

test('Worker public router gate allows public captain and system routes through', () => {
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/captains/captain-human-1/view')),
    null,
  );
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/captains/captain-human-1/trade', {
      method: 'POST',
      body: '{}',
    })),
    null,
  );
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/captains/captain-human-1/police/respond', {
      method: 'POST',
      body: '{}',
    })),
    null,
  );
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/systems/sol/market')),
    null,
  );
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/systems/sol/wrecks')),
    null,
  );
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/systems/sol/match', {
      method: 'POST',
      body: '{}',
    })),
    null,
  );
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/encounters/enc-1/view')),
    null,
  );
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/encounters/enc-1/summary')),
    null,
  );
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/encounters/enc-1/action', {
      method: 'POST',
      body: '{}',
    })),
    null,
  );
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/encounters/enc-1/disconnect', {
      method: 'POST',
      body: '{}',
    })),
    null,
  );
  assert.equal(
    publicDurableObjectRouteGate(new Request('https://worker.test/encounters/enc-1/reconnect', {
      method: 'POST',
      body: '{}',
    })),
    null,
  );
});
