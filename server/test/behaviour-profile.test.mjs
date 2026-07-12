import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommodityId, publicDisposition } from '@sto/ruleset-phase0-v1';
import {
  createEncounter,
  submitAction,
  combatantFromCaptain,
} from '../dist-test/encounter-authority.js';
import {
  deriveSettlementEffects,
  deriveBehaviourProfileUpdates,
} from '../dist-test/settlement-effects.js';
import {
  createCaptainState,
  applyEncounterSettlement,
  publicCaptainView,
} from '../dist-test/captain-authority.js';
import { deliverSettlement } from '../dist-test/settlement-delivery.js';

function baseCombatant(id, overrides = {}) {
  return combatantFromCaptain({
    captainId: id,
    hull: 100,
    maxHull: 100,
    shields: [20],
    credits: 500,
    cargo: [],
    combatProfile: 0,
    tradeProfile: 0,
    policeRecord: 0,
    ...overrides,
  });
}

function attackThenFleeEncounter(opts = {}) {
  const humanCombat = opts.humanCombatProfile ?? 0;
  const humanTrade = opts.humanTradeProfile ?? 0;
  const npcCombat = opts.npcCombatProfile ?? 65;
  const npcTrade = opts.npcTradeProfile ?? 0;
  let state = createEncounter({
    encounterId: opts.encounterId ?? 'enc-profile',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: opts.seed ?? 7,
    nowMs: 1,
    a: {
      captainId: 'human-1',
      controller: 'human',
      kind: 'human',
      handle: 'Hero',
      snapshot: baseCombatant('human-1', {
        combatProfile: humanCombat,
        tradeProfile: humanTrade,
      }),
    },
    b: {
      captainId: 'npc-1',
      controller: 'npc',
      kind: 'npc',
      handle: 'Bandit',
      snapshot: baseCombatant('npc-1', {
        combatProfile: npcCombat,
        tradeProfile: npcTrade,
      }),
    },
  });
  return state;
}

test('human unprovoked ATTACK raises combatProfile after settlement', () => {
  let state = attackThenFleeEncounter({ encounterId: 'enc-agg' });
  state = submitAction(state, {
    captainId: 'human-1',
    nowMs: 1,
    action: { actionId: 'a1', roundNo: 1, type: 'ATTACK' },
  }).state;
  state = submitAction(state, {
    captainId: 'npc-1',
    nowMs: 2,
    action: { actionId: 'b1', roundNo: 1, type: 'FLEE' },
  }).state;

  // Continue until settling or enough rounds for effects
  let guard = 0;
  while (state.lifecycle !== 'SETTLING' && guard < 12) {
    guard += 1;
    if (!state.participants.a.lockedAction) {
      state = submitAction(state, {
        captainId: 'human-1',
        nowMs: 10 + guard,
        action: { actionId: `a${guard}`, roundNo: state.roundNo, type: 'ATTACK' },
      }).state;
    }
    if (state.lifecycle === 'SETTLING') break;
    if (!state.participants.b.lockedAction) {
      state = submitAction(state, {
        captainId: 'npc-1',
        nowMs: 20 + guard,
        action: { actionId: `b${guard}`, roundNo: state.roundNo, type: 'FLEE' },
      }).state;
    }
  }

  const before = state.participants.a.snapshot.combatProfile;
  assert.equal(before, 0);
  const effects = deriveSettlementEffects({ state, nowMs: 100 });
  assert.ok(effects.combatProfileAfter['human-1'] >= 1);
  assert.equal('npc-1' in effects.combatProfileAfter, false);
  assert.equal('npc-1' in effects.tradeProfileAfter, false);
});

test('human FLEE when not outmatched lowers combatProfile', () => {
  let state = createEncounter({
    encounterId: 'enc-passive',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: 2,
    nowMs: 1,
    a: {
      captainId: 'human-flee',
      controller: 'human',
      kind: 'human',
      handle: 'Chicken',
      snapshot: baseCombatant('human-flee', { combatProfile: 0, tradeProfile: 0 }),
    },
    b: {
      captainId: 'npc-peer',
      controller: 'npc',
      kind: 'npc',
      handle: 'Peer',
      // Equal strength → flee is not rational withdrawal
      snapshot: baseCombatant('npc-peer', { combatProfile: 0, tradeProfile: 0 }),
    },
  });
  state = submitAction(state, {
    captainId: 'human-flee',
    nowMs: 1,
    action: { actionId: 'a1', roundNo: 1, type: 'FLEE' },
  }).state;
  state = submitAction(state, {
    captainId: 'npc-peer',
    nowMs: 2,
    action: { actionId: 'b1', roundNo: 1, type: 'IGNORE' },
  }).state;

  assert.equal(state.lifecycle, 'SETTLING');
  const effects = deriveSettlementEffects({ state, nowMs: 3 });
  assert.equal(effects.combatProfileAfter['human-flee'], -1);
  assert.equal(effects.tradeProfileAfter['human-flee'], -1);
});

test('NPC combat and trade profiles never appear in settlement profile maps', () => {
  let state = createEncounter({
    encounterId: 'enc-npc-fixed',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: 4,
    nowMs: 1,
    a: {
      captainId: 'npc-agg',
      controller: 'npc',
      kind: 'npc',
      handle: 'Agg',
      snapshot: baseCombatant('npc-agg', { combatProfile: 65, tradeProfile: -40 }),
    },
    b: {
      captainId: 'npc-vic',
      controller: 'npc',
      kind: 'npc',
      handle: 'Vic',
      snapshot: baseCombatant('npc-vic', { combatProfile: -65, tradeProfile: 0 }),
    },
  });
  state = submitAction(state, {
    captainId: 'npc-agg',
    nowMs: 1,
    action: { actionId: 'a1', roundNo: 1, type: 'ATTACK' },
  }).state;
  state = submitAction(state, {
    captainId: 'npc-vic',
    nowMs: 2,
    action: { actionId: 'b1', roundNo: 1, type: 'ATTACK' },
  }).state;

  const effects = deriveSettlementEffects({ state, nowMs: 3 });
  assert.deepEqual(effects.combatProfileAfter, {});
  assert.deepEqual(effects.tradeProfileAfter, {});
});

test('proxy-controlled human rounds do not train behaviour profiles', () => {
  let state = createEncounter({
    encounterId: 'enc-proxy',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: 5,
    nowMs: 1,
    a: {
      captainId: 'human-proxy',
      controller: 'human',
      kind: 'human',
      handle: 'Ghost',
      snapshot: baseCombatant('human-proxy'),
    },
    b: {
      captainId: 'npc-x',
      controller: 'npc',
      kind: 'npc',
      handle: 'X',
      snapshot: baseCombatant('npc-x'),
    },
  });
  state = submitAction(state, {
    captainId: 'human-proxy',
    nowMs: 1,
    action: { actionId: 'a1', roundNo: 1, type: 'ATTACK' },
  }).state;
  state = submitAction(state, {
    captainId: 'npc-x',
    nowMs: 2,
    action: { actionId: 'b1', roundNo: 1, type: 'FLEE' },
  }).state;

  // Mark the human action as proxy-supplied (disconnect proxy audit flag)
  assert.ok(state.rounds.length >= 1);
  state.rounds[0].proxyFlags = { a: true, b: false };

  const profiles = deriveBehaviourProfileUpdates(state);
  assert.equal(profiles.combatProfileAfter['human-proxy'], 0);
  assert.equal(profiles.tradeProfileAfter['human-proxy'], 0);

  // Same action without proxy would move the score
  state.rounds[0].proxyFlags = { a: false, b: false };
  const trained = deriveBehaviourProfileUpdates(state);
  assert.ok(trained.combatProfileAfter['human-proxy'] > 0);
});

test('publicDisposition flips to aggressive after enough consistent aggression', () => {
  let state = createEncounter({
    encounterId: 'enc-disp',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: 9,
    nowMs: 1,
    a: {
      captainId: 'human-disp',
      controller: 'human',
      kind: 'human',
      handle: 'Rising',
      snapshot: baseCombatant('human-disp', { combatProfile: 30, tradeProfile: 30 }),
    },
    b: {
      captainId: 'npc-disp',
      controller: 'npc',
      kind: 'npc',
      handle: 'Target',
      snapshot: baseCombatant('npc-disp'),
    },
  });
  assert.equal(publicDisposition(30, 30), 'neutral');

  state = submitAction(state, {
    captainId: 'human-disp',
    nowMs: 1,
    action: { actionId: 'a1', roundNo: 1, type: 'ATTACK' },
  }).state;
  state = submitAction(state, {
    captainId: 'npc-disp',
    nowMs: 2,
    action: { actionId: 'b1', roundNo: 1, type: 'IGNORE' },
  }).state;

  const effects = deriveSettlementEffects({ state, nowMs: 3 });
  const combat = effects.combatProfileAfter['human-disp'];
  const trade = effects.tradeProfileAfter['human-disp'];
  assert.equal(combat, 31);
  assert.equal(trade, 31);
  assert.equal(publicDisposition(combat, trade), 'aggressive');

  const captain = createCaptainState({
    captainId: 'human-disp',
    kind: 'human',
    handle: 'Rising',
    systemId: 'sol',
    nowMs: 1,
    combatProfile: 30,
    tradeProfile: 30,
  });
  captain.lifecycle = 'IN_ENCOUNTER';
  captain.activeEncounterId = 'enc-disp';
  assert.equal(publicCaptainView(captain).publicDisposition, 'neutral');

  const settled = applyEncounterSettlement(captain, {
    encounterId: 'enc-disp',
    deltaHash: 'd1',
    credits: captain.credits,
    cargo: [],
    hull: captain.hull,
    shields: [captain.shields],
    lifecycleAfter: 'TRAVELLING',
    nowMs: 3,
    combatProfileAfter: combat,
    tradeProfileAfter: trade,
  });
  assert.equal(settled.ok, true);
  assert.equal(captain.combatProfile, 31);
  assert.equal(captain.tradeProfile, 31);
  assert.equal(publicCaptainView(captain).publicDisposition, 'aggressive');
});

test('deliverSettlement threads profile fields into settleCaptain body', async () => {
  let state = createEncounter({
    encounterId: 'enc-deliver-prof',
    systemId: 'sol',
    routeArea: 'sol:approach',
    seed: 11,
    nowMs: 1,
    a: {
      captainId: 'human-d',
      controller: 'human',
      kind: 'human',
      handle: 'H',
      snapshot: baseCombatant('human-d'),
    },
    b: {
      captainId: 'npc-d',
      controller: 'npc',
      kind: 'npc',
      handle: 'N',
      snapshot: baseCombatant('npc-d', {
        cargo: [{ good: CommodityId.Water, qty: 1 }],
      }),
    },
  });
  state = submitAction(state, {
    captainId: 'human-d',
    nowMs: 1,
    action: {
      actionId: 'd1',
      roundNo: 1,
      type: 'DEMAND',
      demand: { credits: 10, cargo: [] },
    },
  }).state;
  state = submitAction(state, {
    captainId: 'npc-d',
    nowMs: 2,
    action: { actionId: 'c1', roundNo: 1, type: 'COMPLY' },
  }).state;

  assert.equal(state.lifecycle, 'SETTLING');
  assert.ok(state.settlementEffects?.combatProfileAfter['human-d'] > 0);

  const settleBodies = [];
  await deliverSettlement(state, 10, {
    async settleCaptain({ captainId, body }) {
      settleBodies.push({ captainId, body });
      return true;
    },
    async applyPolice() { return true; },
    async upsertRelationship() { return true; },
    async addWreck() { return true; },
  });

  const humanSettle = settleBodies.find((s) => s.captainId === 'human-d');
  assert.ok(humanSettle);
  assert.equal(humanSettle.body.combatProfileAfter, state.settlementEffects.combatProfileAfter['human-d']);
  assert.equal(humanSettle.body.tradeProfileAfter, state.settlementEffects.tradeProfileAfter['human-d']);

  const npcSettle = settleBodies.find((s) => s.captainId === 'npc-d');
  assert.ok(npcSettle);
  assert.equal('combatProfileAfter' in npcSettle.body, false);
  assert.equal('tradeProfileAfter' in npcSettle.body, false);
});
