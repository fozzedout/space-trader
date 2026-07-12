import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommodityId, globalTick, PHASE0_TUNING } from '@sto/ruleset-phase0-v1';
import { bootstrapGalaxy } from '../dist-test/galaxy/bootstrap.js';
import {
  matchWindow,
  registerPresence,
  reserveTrade,
  promoteReservation,
  commitReservation,
} from '../dist-test/system-authority.js';
import {
  executeTrade,
  startTravel,
  advanceTravel,
  claimEncounter,
  releaseEncounterClaim,
  attemptPairClaim,
} from '../dist-test/captain-authority.js';

function memoryProjections() {
  const captains = [];
  const trades = [];
  const operations = [];
  return {
    port: {
      projectCaptain: async (row) => { captains.push(row); return { ok: true }; },
      projectTrade: async (row) => {
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
    async registerPresence(args) {
      return registerPresence(systemState, {
        ...args,
        encounterId: null,
        status: 'present',
      });
    },
    async closePresence(captainId) {
      const row = systemState.presence.get(captainId);
      if (row) systemState.presence.set(captainId, { ...row, status: 'closed' });
    },
    async getPolitics() {
      return { politicsId: systemState.politicsId, strengthPolice: systemState.policePresence };
    },
    async listWrecksInRouteArea(routeArea) {
      return [...systemState.wrecks.values()].filter((w) => w.routeArea === routeArea);
    },
  };
}

test('bootstrap creates two systems, human, and named NPCs', () => {
  const galaxy = bootstrapGalaxy(1_000_000, 42);
  assert.ok(galaxy.systems.sol);
  assert.ok(galaxy.systems.regulas);
  assert.equal(galaxy.captains['captain-human-1'].kind, 'human');
  const npcs = Object.values(galaxy.captains).filter((c) => c.kind === 'npc');
  assert.equal(npcs.length, 6);
  assert.ok(npcs.every((n) => n.handle.length > 0));
});

test('progressive trade is idempotent under operation_id retry', async () => {
  const galaxy = bootstrapGalaxy(1_000_000, 7);
  const captain = galaxy.captains['captain-human-1'];
  const system = galaxy.systems.sol;
  const projections = memoryProjections();
  const port = systemPortFor(system);
  const args = {
    operationId: 'trade-op-1',
    good: CommodityId.Water,
    side: 'buy',
    quantity: 3,
    nowMs: 1_000_000,
  };

  const first = await executeTrade(captain, port, projections.port, args);
  assert.equal(first.ok, true);
  const creditsAfter = captain.credits;
  const stockAfter = system.markets.get(CommodityId.Water).stock;

  const second = await executeTrade(captain, port, projections.port, args);
  assert.equal(second.ok, true);
  assert.equal(captain.credits, creditsAfter);
  assert.equal(system.markets.get(CommodityId.Water).stock, stockAfter);
  assert.equal(projections.trades.length, 1);

  const clash = await executeTrade(captain, port, projections.port, {
    ...args,
    quantity: 4,
  });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, 'INTEGRITY');
});

test('sell then buy cannot duplicate stock on replay', async () => {
  const galaxy = bootstrapGalaxy(2_000_000, 9);
  const captain = galaxy.captains['captain-human-1'];
  const system = galaxy.systems.sol;
  const projections = memoryProjections();
  const port = systemPortFor(system);

  const buy = await executeTrade(captain, port, projections.port, {
    operationId: 'buy-1',
    good: CommodityId.Food,
    side: 'buy',
    quantity: 2,
    nowMs: 2_000_000,
  });
  assert.equal(buy.ok, true);

  const sell = await executeTrade(captain, port, projections.port, {
    operationId: 'sell-1',
    good: CommodityId.Food,
    side: 'sell',
    quantity: 2,
    nowMs: 2_000_100,
  });
  assert.equal(sell.ok, true);
  const stock = system.markets.get(CommodityId.Food).stock;

  const sellAgain = await executeTrade(captain, port, projections.port, {
    operationId: 'sell-1',
    good: CommodityId.Food,
    side: 'sell',
    quantity: 2,
    nowMs: 2_000_200,
  });
  assert.equal(sellAgain.ok, true);
  assert.equal(system.markets.get(CommodityId.Food).stock, stock);
});

test('travel registers presence and docks after approach ticks', async () => {
  const galaxy = bootstrapGalaxy(3_000_000, 3);
  const captain = galaxy.captains['captain-human-1'];
  // Seed chosen so routine police checks do not fire across a full approach.
  captain.policeRngSeed = 147926629;
  captain.policeRngDrawPosition = 0;
  const dest = galaxy.systems.regulas;
  const projections = memoryProjections();
  const port = systemPortFor(dest);

  const start = await startTravel(captain, port, projections.port, {
    operationId: 'trip-1',
    destinationSystemId: 'regulas',
    seed: 99,
    nowMs: 3_000_000,
  });
  assert.equal(start.ok, true);
  assert.equal(captain.lifecycle, 'TRAVELLING');
  assert.ok(dest.presence.has(captain.captainId));

  let guard = 0;
  while (captain.lifecycle === 'TRAVELLING' && guard < 40) {
    guard += 1;
    const adv = await advanceTravel(captain, port, projections.port, {
      operationId: `adv-${guard}`,
      nowMs: 3_000_000 + guard * PHASE0_TUNING.travelWindowMs,
    });
    assert.equal(adv.ok, true);
  }
  assert.equal(captain.lifecycle, 'ACTIVE');
  assert.equal(captain.systemId, 'regulas');
});

test('startTravel leaves captain untouched when registerPresence fails', async () => {
  const galaxy = bootstrapGalaxy(3_100_000, 11);
  const captain = galaxy.captains['captain-human-1'];
  const dest = galaxy.systems.regulas;
  const projections = memoryProjections();
  const fuelBefore = captain.fuel;
  const lifecycleBefore = captain.lifecycle;
  const systemIdBefore = captain.systemId;
  const activeTripBefore = captain.activeTrip;

  let failPresence = true;
  const port = {
    ...systemPortFor(dest),
    async registerPresence(args) {
      if (failPresence) {
        return { ok: false, error: 'presence unavailable', code: 'RETRY' };
      }
      return systemPortFor(dest).registerPresence(args);
    },
  };

  const failed = await startTravel(captain, port, projections.port, {
    operationId: 'trip-fail-1',
    destinationSystemId: 'regulas',
    seed: 42,
    nowMs: 3_100_000,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'RETRY');
  assert.equal(captain.fuel, fuelBefore);
  assert.equal(captain.lifecycle, lifecycleBefore);
  assert.equal(captain.systemId, systemIdBefore);
  assert.equal(captain.activeTrip, activeTripBefore);
  assert.equal(captain.operations.has('trip-fail-1'), false);

  failPresence = false;
  const retry = await startTravel(captain, port, projections.port, {
    operationId: 'trip-fail-2',
    destinationSystemId: 'regulas',
    seed: 42,
    nowMs: 3_100_100,
  });
  assert.equal(retry.ok, true);
  assert.equal(captain.lifecycle, 'TRAVELLING');
  assert.equal(captain.systemId, 'regulas');
  assert.equal(captain.fuel, fuelBefore - 1);
  assert.ok(captain.activeTrip);
});

test('matching is deterministic and cannot double-match a captain', () => {
  const galaxy = bootstrapGalaxy(4_000_000, 5);
  const system = galaxy.systems.sol;
  const nowMs = 4_000_000;
  const routeArea = 'sol:approach';
  const tick = globalTick(nowMs);

  for (const id of ['captain-npc-1', 'captain-npc-3', 'captain-human-1', 'captain-npc-5']) {
    // npc-5 may be on regulas — force onto sol approach for the test
    registerPresence(system, {
      captainId: id,
      routeArea,
      approachTick: 1,
      occupancyStartedAt: nowMs,
      occupancyEndsAt: nowMs + PHASE0_TUNING.travelWindowMs,
      encounterId: null,
      status: 'present',
      matchable: true,
    });
  }

  const first = matchWindow(system, { routeArea, globalTick: tick, nowMs });
  const second = matchWindow(system, { routeArea, globalTick: tick, nowMs });
  assert.equal(first.ok, true);
  assert.deepEqual(first.pairs, second.pairs);
  assert.ok(first.pairs.length >= 1);

  const seen = new Set();
  for (const pair of first.pairs) {
    assert.ok(!seen.has(pair.captainAId));
    assert.ok(!seen.has(pair.captainBId));
    seen.add(pair.captainAId);
    seen.add(pair.captainBId);
  }
});

test('failed partial claim releases cleanly', () => {
  const galaxy = bootstrapGalaxy(5_000_000, 11);
  const a = galaxy.captains['captain-human-1'];
  const b = galaxy.captains['captain-npc-1'];
  // put both travelling on same route
  a.lifecycle = 'TRAVELLING';
  a.activeTrip = {
    tripId: 't',
    seed: 1,
    rulesetVersion: 'ruleset-phase0-v1',
    approachTicks: 15,
    routeArea: 'sol:approach',
    destinationSystemId: 'sol',
  };
  b.lifecycle = 'TRAVELLING';
  b.activeTrip = { ...a.activeTrip, tripId: 't2' };

  // B rejects by not travelling
  b.lifecycle = 'ACTIVE';
  b.activeTrip = null;

  const nowMs = 5_000_000;
  const outcome = attemptPairClaim({
    encounterId: 'enc-test',
    routeArea: 'sol:approach',
    nowMs,
    captainAId: a.captainId,
    captainBId: b.captainId,
    claimCaptain: (id, encounterId, expiresAt) => {
      const cap = id === a.captainId ? a : b;
      const res = claimEncounter(cap, {
        encounterId,
        routeArea: 'sol:approach',
        nowMs,
        expiresAt,
      });
      return { ok: res.ok };
    },
    releaseCaptain: (id, encounterId) => {
      const cap = id === a.captainId ? a : b;
      releaseEncounterClaim(cap, { encounterId, nowMs });
    },
  });

  assert.equal(outcome.ok, false);
  assert.equal(a.activeEncounterId, null);
  assert.equal(a.lifecycle, 'TRAVELLING');
  assert.equal(b.activeEncounterId, null);
});
