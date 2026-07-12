import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CommodityId,
  RulesetRng,
  resolveCaptainRound,
} from '../dist/index.js';

function combatant(id, overrides = {}) {
  return {
    captainId: id,
    shipSize: 1,
    hull: 100,
    maxHull: 100,
    shields: [40],
    totalWeaponPower: 20,
    pilot: 5,
    fighter: 5,
    engineer: 5,
    hasEscapePod: false,
    policeRecord: 0,
    combatProfile: 0,
    tradeProfile: 0,
    credits: 1000,
    cargo: [{ good: CommodityId.Water, qty: 4 }],
    difficulty: 2,
    ...overrides,
  };
}

function act(type, extra = {}) {
  return { actionId: `${type}-1`, roundNo: 1, type, ...extra };
}

/**
 * Invalid COMPLY (no pending demand targeting the complier) must follow the
 * deterministic phase fallback (IGNORE in NEGOTIATION). Against priority-5/6
 * partners that an effective IGNORE would disengage from, the round must end
 * with no transfer and no pending offer/demand left behind.
 *
 * DEMAND is omitted here: simultaneous DEMAND+COMPLY is a *valid* demand
 * (design §5.4) and is handled at priority 4 before the without-demand branch.
 * ATTACK/FLEE/SURRENDER are skipped — earlier priorities resolve them first.
 */
const DISENGAGE_PARTNERS = [
  {
    name: 'TRADE_OFFER',
    actionB: act('TRADE_OFFER', {
      tradeOffer: {
        aToB: { credits: 10, cargo: [] },
        bToA: { credits: 0, cargo: [{ good: CommodityId.Water, qty: 1 }] },
      },
    }),
  },
  { name: 'HAIL', actionB: act('HAIL') },
  { name: 'IGNORE', actionB: act('IGNORE') },
];

for (const partner of DISENGAGE_PARTNERS) {
  test(`invalid COMPLY vs ${partner.name} ends via disengagement (IGNORE fallback)`, () => {
    const result = resolveCaptainRound({
      phase: 'NEGOTIATION',
      a: combatant('a'),
      b: combatant('b'),
      actionA: act('COMPLY'),
      actionB: partner.actionB,
      pendingOffers: [],
      pendingDemand: null,
      rng: new RulesetRng(1),
    });
    assert.equal(result.ended, true);
    assert.equal(result.phaseAfter, 'TERMINAL');
    assert.equal(result.endReason, 'disengage');
    assert.equal(result.transfers.length, 0);
    assert.equal(result.pendingOffers.length, 0);
    assert.equal(result.pendingDemand, null);
  });
}

test('simultaneous DEMAND+COMPLY remains valid (not the without-demand path)', () => {
  const result = resolveCaptainRound({
    phase: 'NEGOTIATION',
    a: combatant('a'),
    b: combatant('b', { credits: 500, cargo: [{ good: CommodityId.Water, qty: 2 }] }),
    actionA: act('DEMAND', { demand: { credits: 100, cargo: [] } }),
    actionB: act('COMPLY'),
    pendingOffers: [],
    pendingDemand: null,
    rng: new RulesetRng(1),
  });
  assert.equal(result.ended, true);
  assert.equal(result.endReason, 'demand_transfer');
  assert.equal(result.transfers.length, 1);
});
