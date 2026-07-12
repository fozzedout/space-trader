import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  CommodityId,
  RulesetRng,
  canonicalizeExchange,
  proposalHash,
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

let actionSeq = 0;
function act(type, extra = {}) {
  actionSeq += 1;
  return { actionId: `${type}-${actionSeq}`, roundNo: 1, type, ...extra };
}

const DEMAND = { credits: 50, cargo: [{ good: CommodityId.Water, qty: 1 }] };
const OFFER_A = canonicalizeExchange({
  aToB: { credits: 10, cargo: [] },
  bToA: { credits: 0, cargo: [{ good: CommodityId.Water, qty: 1 }] },
});
const OFFER_B_DIFF = canonicalizeExchange({
  aToB: { credits: 20, cargo: [] },
  bToA: { credits: 0, cargo: [{ good: CommodityId.Water, qty: 1 }] },
});

const FLEE_OK = 1; // flee succeeds with default pilots
const FLEE_FAIL = 13; // flee fails with default pilots

function round(opts) {
  return resolveCaptainRound({
    phase: opts.phase,
    a: opts.a ?? combatant('a'),
    b: opts.b ?? combatant('b'),
    actionA: opts.actionA,
    actionB: opts.actionB,
    pendingOffers: opts.pendingOffers ?? [],
    pendingDemand: opts.pendingDemand ?? null,
    rng: opts.rng ?? new RulesetRng(opts.seed ?? 1),
    aUsesCommanderFlee: opts.aUsesCommanderFlee,
  });
}

function assertDisengage(r) {
  assert.equal(r.ended, true);
  assert.equal(r.phaseAfter, 'TERMINAL');
  assert.equal(r.endReason, 'disengage');
  assert.equal(r.transfers.length, 0);
}

function assertCombat(r) {
  assert.equal(r.phaseAfter, r.ended ? 'TERMINAL' : 'COMBAT');
  if (r.ended) assert.equal(r.endReason, 'destroyed');
  assert.ok(r.attacks.length >= 1);
  assert.equal(r.transfers.length, 0);
}

function assertNegotiation(r, extra = {}) {
  assert.equal(r.ended, false);
  assert.equal(r.phaseAfter, 'NEGOTIATION');
  if (extra.pendingDemand !== undefined) {
    assert.deepEqual(r.pendingDemand, extra.pendingDemand);
  }
  if (extra.offerCount !== undefined) {
    assert.equal(r.pendingOffers.length, extra.offerCount);
  }
  if (extra.transfers === 0) assert.equal(r.transfers.length, 0);
}

// ---------------------------------------------------------------------------
// CONTACT — 21 unordered pairs
// ---------------------------------------------------------------------------
describe('CONTACT action-pair table (§5.4)', () => {
  const phase = 'CONTACT';

  test('ATTACK+ATTACK — both resolve from pre-round state; stay COMBAT unless destroyed', () => {
    const r = round({
      phase,
      actionA: act('ATTACK'),
      actionB: act('ATTACK'),
      seed: 42,
    });
    assert.equal(r.attacks.length, 2);
    assert.equal(r.transfers.length, 0);
    if (r.ended) {
      assert.equal(r.phaseAfter, 'TERMINAL');
      assert.equal(r.endReason, 'destroyed');
    } else {
      assert.equal(r.phaseAfter, 'COMBAT');
    }
  });

  test('ATTACK+FLEE — flee first; success cancels attack / fail lets attack land', () => {
    // B flees via opponentFleeSucceeds (seed 1 succeeds with default pilots)
    const ok = round({
      phase,
      actionA: act('ATTACK'),
      actionB: act('FLEE'),
      seed: FLEE_OK,
    });
    assert.equal(ok.fleeResults[0]?.success, true);
    assert.equal(ok.ended, true);
    assert.equal(ok.endReason, 'flee_success');
    assert.equal(ok.attacks.length, 0);

    // A flees via commanderFleeSucceeds (seed 13 fails with default pilots)
    const fail = round({
      phase,
      actionA: act('FLEE'),
      actionB: act('ATTACK'),
      seed: FLEE_FAIL,
    });
    assert.equal(fail.fleeResults[0]?.success, false);
    assertCombat(fail);
  });

  test('ATTACK+HAIL — attack resolves; hail has no mechanical effect (§5.4 ATTACK vs any other)', () => {
    const r = round({ phase, actionA: act('ATTACK'), actionB: act('HAIL'), seed: 7 });
    assertCombat(r);
  });

  test('ATTACK+IGNORE — attack resolves; IGNORE does not cancel (§5.4 ATTACK vs any other)', () => {
    const r = round({ phase, actionA: act('ATTACK'), actionB: act('IGNORE'), seed: 7 });
    assertCombat(r);
  });

  test('ATTACK+DEMAND — attack resolves; no demand transfer commits', () => {
    const r = round({
      phase,
      actionA: act('ATTACK'),
      actionB: act('DEMAND', { demand: DEMAND }),
      seed: 7,
    });
    assertCombat(r);
    assert.equal(r.pendingDemand, null);
  });

  test('ATTACK+TRADE_OFFER — attack resolves; no trade commits', () => {
    const r = round({
      phase,
      actionA: act('ATTACK'),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      seed: 7,
    });
    assertCombat(r);
    assert.equal(r.pendingOffers.length, 0);
  });

  test('FLEE+FLEE — mutual flee auto-succeeds; encounter ends', () => {
    const r = round({ phase, actionA: act('FLEE'), actionB: act('FLEE'), seed: 1 });
    assert.equal(r.ended, true);
    assert.equal(r.endReason, 'mutual_flee');
    assert.equal(r.attacks.length, 0);
  });

  test('FLEE+HAIL — flee resolves; success ends / fail stays NEGOTIATION (§5.4 HAIL vs FLEE)', () => {
    const ok = round({ phase, actionA: act('FLEE'), actionB: act('HAIL'), seed: FLEE_OK });
    assert.equal(ok.ended, true);
    assert.equal(ok.endReason, 'flee_success');

    const fail = round({ phase, actionA: act('FLEE'), actionB: act('HAIL'), seed: FLEE_FAIL });
    assert.equal(fail.fleeResults[0]?.success, false);
    assertNegotiation(fail);
  });

  test('FLEE+IGNORE — success ends; failed flee vs IGNORE still disengages (§5.4 IGNORE vs non-attack)', () => {
    const ok = round({ phase, actionA: act('FLEE'), actionB: act('IGNORE'), seed: FLEE_OK });
    assert.equal(ok.ended, true);
    assert.equal(ok.endReason, 'flee_success');

    const fail = round({ phase, actionA: act('FLEE'), actionB: act('IGNORE'), seed: FLEE_FAIL });
    assert.equal(fail.fleeResults[0]?.success, false);
    assertDisengage(fail);
  });

  test('FLEE+DEMAND — success ends; fail leaves demand pending in NEGOTIATION', () => {
    const ok = round({
      phase,
      actionA: act('FLEE'),
      actionB: act('DEMAND', { demand: DEMAND }),
      seed: FLEE_OK,
    });
    assert.equal(ok.ended, true);
    assert.equal(ok.endReason, 'flee_success');

    const fail = round({
      phase,
      actionA: act('FLEE'),
      actionB: act('DEMAND', { demand: DEMAND }),
      seed: FLEE_FAIL,
    });
    assert.equal(fail.fleeResults[0]?.success, false);
    assertNegotiation(fail, {
      pendingDemand: { demanderId: 'b', demand: DEMAND },
      transfers: 0,
    });
  });

  test('FLEE+TRADE_OFFER — success ends; fail leaves offer pending in NEGOTIATION', () => {
    const ok = round({
      phase,
      actionA: act('FLEE'),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      seed: FLEE_OK,
    });
    assert.equal(ok.ended, true);
    assert.equal(ok.endReason, 'flee_success');

    const fail = round({
      phase,
      actionA: act('FLEE'),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      seed: FLEE_FAIL,
    });
    assert.equal(fail.fleeResults[0]?.success, false);
    assertNegotiation(fail, { offerCount: 1, transfers: 0 });
  });

  test('HAIL+HAIL — enter/remain NEGOTIATION', () => {
    assertNegotiation(round({ phase, actionA: act('HAIL'), actionB: act('HAIL') }));
  });

  test('HAIL+IGNORE — IGNORE disengages (§5.4 IGNORE vs any non-attack)', () => {
    assertDisengage(round({ phase, actionA: act('HAIL'), actionB: act('IGNORE') }));
  });

  test('HAIL+DEMAND — demand pending; NEGOTIATION (§5.4 DEMAND vs HAIL)', () => {
    const r = round({
      phase,
      actionA: act('HAIL'),
      actionB: act('DEMAND', { demand: DEMAND }),
    });
    assertNegotiation(r, {
      pendingDemand: { demanderId: 'b', demand: DEMAND },
      transfers: 0,
    });
  });

  test('HAIL+TRADE_OFFER — offer pending; NEGOTIATION (general catch-all: unresolved proposals)', () => {
    const r = round({
      phase,
      actionA: act('HAIL'),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
    });
    assertNegotiation(r, { offerCount: 1, transfers: 0 });
  });

  test('IGNORE+IGNORE — encounter ends', () => {
    assertDisengage(round({ phase, actionA: act('IGNORE'), actionB: act('IGNORE') }));
  });

  test('IGNORE+DEMAND — disengage; no transfer (§5.4 DEMAND vs IGNORE)', () => {
    const r = round({
      phase,
      actionA: act('IGNORE'),
      actionB: act('DEMAND', { demand: DEMAND }),
    });
    assertDisengage(r);
  });

  test('IGNORE+TRADE_OFFER — no trade; encounter ends', () => {
    assertDisengage(round({
      phase,
      actionA: act('IGNORE'),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
    }));
  });

  test('DEMAND+DEMAND — neither commits; NEGOTIATION', () => {
    const r = round({
      phase,
      actionA: act('DEMAND', { demand: DEMAND }),
      actionB: act('DEMAND', { demand: { credits: 10, cargo: [] } }),
    });
    assertNegotiation(r, { transfers: 0 });
    assert.equal(r.demandOutcomes.length, 2);
  });

  test('DEMAND+TRADE_OFFER — both revealed; demand+offer pending; NEGOTIATION', () => {
    const r = round({
      phase,
      actionA: act('DEMAND', { demand: DEMAND }),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
    });
    assertNegotiation(r, {
      pendingDemand: { demanderId: 'a', demand: DEMAND },
      offerCount: 1,
      transfers: 0,
    });
  });

  test('TRADE_OFFER+TRADE_OFFER — identical exchange commits; differing stay pending', () => {
    const same = round({
      phase,
      actionA: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      // B describes the same deal from B's side
      actionB: act('TRADE_OFFER', {
        tradeOffer: { aToB: OFFER_A.bToA, bToA: OFFER_A.aToB },
      }),
    });
    assert.equal(same.ended, true);
    assert.equal(same.endReason, 'trade');
    assert.equal(same.transfers.length, 2);

    const diff = round({
      phase,
      actionA: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_B_DIFF }),
    });
    assertNegotiation(diff, { offerCount: 2, transfers: 0 });
  });
});

// ---------------------------------------------------------------------------
// NEGOTIATION — 45 unordered pairs (+ pending variants for ACCEPT_TRADE/COMPLY)
// ---------------------------------------------------------------------------
describe('NEGOTIATION action-pair table (§5.4)', () => {
  const phase = 'NEGOTIATION';
  const pendingOfferFromB = () => {
    const exchange = OFFER_A;
    return [{
      proposerId: 'b',
      exchange,
      proposalHash: proposalHash(exchange),
    }];
  };
  const pendingDemandFromB = () => ({ demanderId: 'b', demand: DEMAND });

  test('ATTACK+ATTACK', () => {
    const r = round({ phase, actionA: act('ATTACK'), actionB: act('ATTACK'), seed: 42 });
    assert.equal(r.attacks.length, 2);
    assert.ok(r.phaseAfter === 'COMBAT' || r.endReason === 'destroyed');
  });

  test('ATTACK+FLEE', () => {
    const ok = round({ phase, actionA: act('ATTACK'), actionB: act('FLEE'), seed: FLEE_OK });
    assert.equal(ok.ended, true);
    assert.equal(ok.endReason, 'flee_success');
    const fail = round({ phase, actionA: act('FLEE'), actionB: act('ATTACK'), seed: FLEE_FAIL });
    assertCombat(fail);
  });

  test('ATTACK+HAIL / IGNORE / DEMAND / TRADE_OFFER / ACCEPT_TRADE / COMPLY — attack wins (§5.4 ATTACK vs any other)', () => {
    for (const actionB of [
      act('HAIL'),
      act('IGNORE'),
      act('DEMAND', { demand: DEMAND }),
      act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      act('ACCEPT_TRADE', { acceptProposalHash: 'stale' }),
      act('COMPLY'),
    ]) {
      const r = round({ phase, actionA: act('ATTACK'), actionB, seed: 7 });
      assertCombat(r);
      assert.equal(r.transfers.length, 0);
    }
  });

  test('ATTACK+SURRENDER — surrender before attack; SURRENDER_RESOLUTION', () => {
    const r = round({ phase, actionA: act('ATTACK'), actionB: act('SURRENDER') });
    assert.equal(r.ended, false);
    assert.equal(r.phaseAfter, 'SURRENDER_RESOLUTION');
    assert.equal(r.surrenderVictorId, 'a');
    assert.equal(r.attacks.length, 0);
  });

  test('FLEE+FLEE', () => {
    const r = round({ phase, actionA: act('FLEE'), actionB: act('FLEE') });
    assert.equal(r.endReason, 'mutual_flee');
    assert.equal(r.ended, true);
  });

  test('FLEE+HAIL / DEMAND / TRADE_OFFER / ACCEPT_TRADE / COMPLY — flee vs non-attack', () => {
    const partners = [
      { name: 'HAIL', b: act('HAIL') },
      { name: 'DEMAND', b: act('DEMAND', { demand: DEMAND }) },
      { name: 'TRADE_OFFER', b: act('TRADE_OFFER', { tradeOffer: OFFER_A }) },
      { name: 'ACCEPT_TRADE', b: act('ACCEPT_TRADE', { acceptProposalHash: 'x' }) },
      { name: 'COMPLY', b: act('COMPLY') },
    ];
    for (const p of partners) {
      const ok = round({ phase, actionA: act('FLEE'), actionB: p.b, seed: FLEE_OK });
      assert.equal(ok.ended, true, p.name);
      assert.equal(ok.endReason, 'flee_success', p.name);
    }
    const failHail = round({ phase, actionA: act('FLEE'), actionB: act('HAIL'), seed: FLEE_FAIL });
    assertNegotiation(failHail);
    const failDemand = round({
      phase,
      actionA: act('FLEE'),
      actionB: act('DEMAND', { demand: DEMAND }),
      seed: FLEE_FAIL,
    });
    assertNegotiation(failDemand, { pendingDemand: { demanderId: 'b', demand: DEMAND } });
  });

  test('FLEE+IGNORE — failed flee still disengages', () => {
    assert.equal(
      round({ phase, actionA: act('FLEE'), actionB: act('IGNORE'), seed: FLEE_OK }).endReason,
      'flee_success',
    );
    assertDisengage(round({ phase, actionA: act('FLEE'), actionB: act('IGNORE'), seed: FLEE_FAIL }));
  });

  test('FLEE+SURRENDER — surrender takes priority over flee', () => {
    const r = round({ phase, actionA: act('FLEE'), actionB: act('SURRENDER') });
    assert.equal(r.phaseAfter, 'SURRENDER_RESOLUTION');
    assert.equal(r.surrenderVictorId, 'a');
    assert.equal(r.ended, false);
  });

  test('HAIL+HAIL', () => {
    assertNegotiation(round({ phase, actionA: act('HAIL'), actionB: act('HAIL') }));
  });

  test('HAIL+IGNORE', () => {
    assertDisengage(round({ phase, actionA: act('HAIL'), actionB: act('IGNORE') }));
  });

  test('HAIL+DEMAND / TRADE_OFFER', () => {
    assertNegotiation(round({
      phase,
      actionA: act('HAIL'),
      actionB: act('DEMAND', { demand: DEMAND }),
    }), { pendingDemand: { demanderId: 'b', demand: DEMAND } });
    assertNegotiation(round({
      phase,
      actionA: act('HAIL'),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
    }), { offerCount: 1 });
  });

  test('HAIL+ACCEPT_TRADE — with pending: HAIL does not revoke; accept commits (§5.4)', () => {
    const offers = pendingOfferFromB();
    const r = round({
      phase,
      actionA: act('ACCEPT_TRADE', { acceptProposalHash: offers[0].proposalHash }),
      actionB: act('HAIL'),
      pendingOffers: offers,
    });
    assert.equal(r.ended, true);
    assert.equal(r.endReason, 'trade');
    assert.equal(r.transfers.length, 2);
  });

  test('HAIL+ACCEPT_TRADE — without pending: stale accept; HAIL keeps NEGOTIATION', () => {
    assertNegotiation(round({
      phase,
      actionA: act('ACCEPT_TRADE', { acceptProposalHash: 'nope' }),
      actionB: act('HAIL'),
    }));
  });

  test('HAIL+COMPLY — without pending: invalid COMPLY → IGNORE fallback → disengage', () => {
    assertDisengage(round({ phase, actionA: act('COMPLY'), actionB: act('HAIL') }));
  });

  test('HAIL+COMPLY — with pending demand: COMPLY transfers', () => {
    const r = round({
      phase,
      actionA: act('COMPLY'),
      actionB: act('HAIL'),
      pendingDemand: pendingDemandFromB(),
      a: combatant('a', { credits: 500, cargo: [{ good: CommodityId.Water, qty: 2 }] }),
    });
    assert.equal(r.ended, true);
    assert.equal(r.endReason, 'demand_transfer');
  });

  test('HAIL+SURRENDER', () => {
    const r = round({ phase, actionA: act('HAIL'), actionB: act('SURRENDER') });
    assert.equal(r.phaseAfter, 'SURRENDER_RESOLUTION');
    assert.equal(r.surrenderVictorId, 'a');
  });

  test('IGNORE+IGNORE / DEMAND / TRADE_OFFER', () => {
    assertDisengage(round({ phase, actionA: act('IGNORE'), actionB: act('IGNORE') }));
    assertDisengage(round({
      phase,
      actionA: act('IGNORE'),
      actionB: act('DEMAND', { demand: DEMAND }),
    }));
    assertDisengage(round({
      phase,
      actionA: act('IGNORE'),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
    }));
  });

  test('IGNORE+ACCEPT_TRADE — IGNORE ends; no trade (§5.4 TRADE/ACCEPT vs IGNORE)', () => {
    const offers = pendingOfferFromB();
    const r = round({
      phase,
      actionA: act('ACCEPT_TRADE', { acceptProposalHash: offers[0].proposalHash }),
      actionB: act('IGNORE'),
      pendingOffers: offers,
    });
    assertDisengage(r);
  });

  test('IGNORE+COMPLY — without pending: disengage', () => {
    assertDisengage(round({ phase, actionA: act('IGNORE'), actionB: act('COMPLY') }));
  });

  test('IGNORE+COMPLY — with pending demand: valid COMPLY transfers (priority 4 before IGNORE)', () => {
    const r = round({
      phase,
      actionA: act('COMPLY'),
      actionB: act('IGNORE'),
      pendingDemand: pendingDemandFromB(),
      a: combatant('a', { credits: 500, cargo: [{ good: CommodityId.Water, qty: 2 }] }),
    });
    assert.equal(r.ended, true);
    assert.equal(r.endReason, 'demand_transfer');
    assert.equal(r.transfers.length, 1);
  });

  test('IGNORE+SURRENDER — surrender takes priority', () => {
    const r = round({ phase, actionA: act('IGNORE'), actionB: act('SURRENDER') });
    assert.equal(r.phaseAfter, 'SURRENDER_RESOLUTION');
    assert.equal(r.surrenderVictorId, 'a');
  });

  test('DEMAND+DEMAND', () => {
    assertNegotiation(round({
      phase,
      actionA: act('DEMAND', { demand: DEMAND }),
      actionB: act('DEMAND', { demand: { credits: 1, cargo: [] } }),
    }), { transfers: 0 });
  });

  test('DEMAND+TRADE_OFFER', () => {
    assertNegotiation(round({
      phase,
      actionA: act('DEMAND', { demand: DEMAND }),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
    }), { pendingDemand: { demanderId: 'a', demand: DEMAND }, offerCount: 1 });
  });

  test('HAIL+DEMAND — DEMAND by pending-offer proposer revokes their offer', () => {
    const offers = pendingOfferFromB();
    const r = round({
      phase,
      actionA: act('HAIL'),
      actionB: act('DEMAND', { demand: DEMAND }),
      pendingOffers: offers,
    });
    assertNegotiation(r, {
      pendingDemand: { demanderId: 'b', demand: DEMAND },
      offerCount: 0,
      transfers: 0,
    });
  });

  test('DEMAND+ACCEPT_TRADE — DEMAND revokes pending offer; demand stays pending', () => {
    const offers = pendingOfferFromB();
    const r = round({
      phase,
      actionA: act('ACCEPT_TRADE', { acceptProposalHash: offers[0].proposalHash }),
      actionB: act('DEMAND', { demand: DEMAND }),
      pendingOffers: offers,
    });
    assertNegotiation(r, {
      pendingDemand: { demanderId: 'b', demand: DEMAND },
      offerCount: 0,
      transfers: 0,
    });
  });

  test('DEMAND+COMPLY — simultaneous fulfilable transfer', () => {
    const r = round({
      phase,
      actionA: act('DEMAND', { demand: DEMAND }),
      actionB: act('COMPLY'),
      b: combatant('b', { credits: 500, cargo: [{ good: CommodityId.Water, qty: 2 }] }),
    });
    assert.equal(r.ended, true);
    assert.equal(r.endReason, 'demand_transfer');
  });

  test('DEMAND+COMPLY — simultaneous unfulfillable → NOT_COMPLIED, NEGOTIATION', () => {
    const r = round({
      phase,
      actionA: act('DEMAND', { demand: { credits: 99999, cargo: [] } }),
      actionB: act('COMPLY'),
      b: combatant('b', { credits: 10, cargo: [] }),
    });
    assertNegotiation(r, { transfers: 0 });
    assert.equal(r.demandOutcomes[0]?.result, 'NOT_COMPLIED');
  });

  test('DEMAND+SURRENDER', () => {
    const r = round({ phase, actionA: act('DEMAND', { demand: DEMAND }), actionB: act('SURRENDER') });
    assert.equal(r.phaseAfter, 'SURRENDER_RESOLUTION');
    assert.equal(r.surrenderVictorId, 'a');
  });

  test('TRADE_OFFER+TRADE_OFFER — same / differing', () => {
    const same = round({
      phase,
      actionA: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      actionB: act('TRADE_OFFER', { tradeOffer: { aToB: OFFER_A.bToA, bToA: OFFER_A.aToB } }),
    });
    assert.equal(same.endReason, 'trade');
    assertNegotiation(round({
      phase,
      actionA: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_B_DIFF }),
    }), { offerCount: 2 });
  });

  test('TRADE_OFFER+ACCEPT_TRADE — replacement offer revokes prior; accept does not commit', () => {
    const offers = pendingOfferFromB();
    const r = round({
      phase,
      actionA: act('ACCEPT_TRADE', { acceptProposalHash: offers[0].proposalHash }),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_B_DIFF }),
      pendingOffers: offers,
    });
    assertNegotiation(r, { offerCount: 1, transfers: 0 });
    // B's submission is role-normalized via reverseExchange in offerFrom
    assert.equal(
      r.pendingOffers[0]?.proposalHash,
      proposalHash({ aToB: OFFER_B_DIFF.bToA, bToA: OFFER_B_DIFF.aToB }),
    );
  });

  test('TRADE_OFFER+ACCEPT_TRADE — without matching pending: offer registers; accept noop', () => {
    assertNegotiation(round({
      phase,
      actionA: act('ACCEPT_TRADE', { acceptProposalHash: 'missing' }),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
    }), { offerCount: 1, transfers: 0 });
  });

  test('TRADE_OFFER+COMPLY — without pending demand: invalid COMPLY → disengage (Part 1 fix)', () => {
    assertDisengage(round({
      phase,
      actionA: act('COMPLY'),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
    }));
  });

  test('TRADE_OFFER+COMPLY — with pending demand: COMPLY transfers (priority 4 before offer)', () => {
    const r = round({
      phase,
      actionA: act('COMPLY'),
      actionB: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      pendingDemand: pendingDemandFromB(),
      a: combatant('a', { credits: 500, cargo: [{ good: CommodityId.Water, qty: 2 }] }),
    });
    assert.equal(r.endReason, 'demand_transfer');
    assert.equal(r.transfers.length, 1);
  });

  test('TRADE_OFFER+SURRENDER', () => {
    const r = round({
      phase,
      actionA: act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      actionB: act('SURRENDER'),
    });
    assert.equal(r.phaseAfter, 'SURRENDER_RESOLUTION');
    assert.equal(r.surrenderVictorId, 'a');
  });

  test('ACCEPT_TRADE+ACCEPT_TRADE — dual stale accept → NEGOTIATION', () => {
    const r = round({
      phase,
      actionA: act('ACCEPT_TRADE', { acceptProposalHash: 'x' }),
      actionB: act('ACCEPT_TRADE', { acceptProposalHash: 'y' }),
    });
    assertNegotiation(r, { transfers: 0 });
  });

  test('ACCEPT_TRADE+ACCEPT_TRADE — both accept same pending offer from B: first tryAccept commits', () => {
    const offers = pendingOfferFromB();
    const r = round({
      phase,
      actionA: act('ACCEPT_TRADE', { acceptProposalHash: offers[0].proposalHash }),
      actionB: act('ACCEPT_TRADE', { acceptProposalHash: offers[0].proposalHash }),
      pendingOffers: offers,
    });
    // tryAccept(A accepting B's offer): B's ACCEPT_TRADE does not revoke → commits
    assert.equal(r.ended, true);
    assert.equal(r.endReason, 'trade');
  });

  test('ACCEPT_TRADE+COMPLY — without pending: COMPLY disengages (IGNORE fallback)', () => {
    assertDisengage(round({
      phase,
      actionA: act('COMPLY'),
      actionB: act('ACCEPT_TRADE', { acceptProposalHash: 'x' }),
    }));
  });

  test('ACCEPT_TRADE+COMPLY — accept valid pending vs invalid COMPLY: COMPLY ends first', () => {
    const offers = pendingOfferFromB();
    const r = round({
      phase,
      actionA: act('ACCEPT_TRADE', { acceptProposalHash: offers[0].proposalHash }),
      actionB: act('COMPLY'),
      pendingOffers: offers,
    });
    assertDisengage(r);
  });

  test('ACCEPT_TRADE+SURRENDER', () => {
    const r = round({
      phase,
      actionA: act('ACCEPT_TRADE', { acceptProposalHash: 'x' }),
      actionB: act('SURRENDER'),
    });
    assert.equal(r.phaseAfter, 'SURRENDER_RESOLUTION');
  });

  test('COMPLY+COMPLY — neither has a demand targeting them → disengage', () => {
    assertDisengage(round({ phase, actionA: act('COMPLY'), actionB: act('COMPLY') }));
  });

  test('COMPLY+SURRENDER — surrender priority', () => {
    const r = round({ phase, actionA: act('COMPLY'), actionB: act('SURRENDER') });
    assert.equal(r.phaseAfter, 'SURRENDER_RESOLUTION');
    assert.equal(r.surrenderVictorId, 'a');
  });

  test('SURRENDER+SURRENDER — mutual surrender ends with no victor', () => {
    const r = round({ phase, actionA: act('SURRENDER'), actionB: act('SURRENDER') });
    assert.equal(r.ended, true);
    assert.equal(r.endReason, 'mutual_surrender');
    assert.equal(r.surrenderVictorId, null);
  });
});

// ---------------------------------------------------------------------------
// COMBAT — 6 unordered pairs
// ---------------------------------------------------------------------------
describe('COMBAT action-pair table (§5.4)', () => {
  const phase = 'COMBAT';

  test('ATTACK+ATTACK', () => {
    const r = round({ phase, actionA: act('ATTACK'), actionB: act('ATTACK'), seed: 42 });
    assert.equal(r.attacks.length, 2);
    assert.ok(r.phaseAfter === 'COMBAT' || r.endReason === 'destroyed');
  });

  test('ATTACK+FLEE', () => {
    const ok = round({ phase, actionA: act('ATTACK'), actionB: act('FLEE'), seed: FLEE_OK });
    assert.equal(ok.endReason, 'flee_success');
    const fail = round({ phase, actionA: act('FLEE'), actionB: act('ATTACK'), seed: FLEE_FAIL });
    assertCombat(fail);
  });

  test('ATTACK+SURRENDER — surrender before attack', () => {
    const r = round({ phase, actionA: act('ATTACK'), actionB: act('SURRENDER') });
    assert.equal(r.phaseAfter, 'SURRENDER_RESOLUTION');
    assert.equal(r.surrenderVictorId, 'a');
    assert.equal(r.attacks.length, 0);
  });

  test('FLEE+FLEE', () => {
    const r = round({ phase, actionA: act('FLEE'), actionB: act('FLEE') });
    assert.equal(r.endReason, 'mutual_flee');
  });

  test('FLEE+SURRENDER — surrender priority over flee', () => {
    const r = round({ phase, actionA: act('FLEE'), actionB: act('SURRENDER') });
    assert.equal(r.phaseAfter, 'SURRENDER_RESOLUTION');
    assert.equal(r.surrenderVictorId, 'a');
  });

  test('SURRENDER+SURRENDER', () => {
    const r = round({ phase, actionA: act('SURRENDER'), actionB: act('SURRENDER') });
    assert.equal(r.endReason, 'mutual_surrender');
    assert.equal(r.ended, true);
  });
});

// ---------------------------------------------------------------------------
// Role-reversal symmetry + determinism
// ---------------------------------------------------------------------------
describe('role-reversal symmetry (§5.4 unlisted symmetric orderings)', () => {
  const cases = [
    {
      name: 'DEMAND vs IGNORE',
      a: () => act('DEMAND', { demand: DEMAND }),
      b: () => act('IGNORE'),
      phase: 'CONTACT',
    },
    {
      name: 'ATTACK vs HAIL',
      a: () => act('ATTACK'),
      b: () => act('HAIL'),
      phase: 'CONTACT',
      seed: 7,
    },
    {
      name: 'HAIL vs TRADE_OFFER',
      a: () => act('HAIL'),
      b: () => act('TRADE_OFFER', { tradeOffer: OFFER_A }),
      phase: 'CONTACT',
    },
    {
      name: 'DEMAND vs COMPLY',
      a: () => act('DEMAND', { demand: DEMAND }),
      b: () => act('COMPLY'),
      phase: 'NEGOTIATION',
      richTarget: true,
    },
    {
      name: 'SURRENDER vs HAIL',
      a: () => act('SURRENDER'),
      b: () => act('HAIL'),
      phase: 'NEGOTIATION',
    },
    {
      name: 'DEMAND vs HAIL',
      a: () => act('DEMAND', { demand: DEMAND }),
      b: () => act('HAIL'),
      phase: 'NEGOTIATION',
    },
  ];

  for (const c of cases) {
    test(`${c.name} — swapping A/B mirrors outcome`, () => {
      const rich = combatant('x', { credits: 500, cargo: [{ good: CommodityId.Water, qty: 2 }] });
      const fwd = round({
        phase: c.phase,
        actionA: c.a(),
        actionB: c.b(),
        seed: c.seed ?? 1,
        b: c.richTarget ? { ...rich, captainId: 'b' } : undefined,
      });
      const rev = round({
        phase: c.phase,
        actionA: c.b(),
        actionB: c.a(),
        seed: c.seed ?? 1,
        a: c.richTarget ? { ...rich, captainId: 'a' } : undefined,
      });
      assert.equal(fwd.phaseAfter, rev.phaseAfter);
      assert.equal(fwd.ended, rev.ended);
      assert.equal(fwd.endReason, rev.endReason);
      assert.equal(fwd.transfers.length, rev.transfers.length);
      assert.equal(fwd.attacks.length, rev.attacks.length);
      if (fwd.surrenderVictorId) {
        assert.equal(fwd.surrenderVictorId === 'a' ? 'b' : 'a', rev.surrenderVictorId);
      }
      if (fwd.pendingDemand) {
        assert.equal(
          fwd.pendingDemand.demanderId === 'a' ? 'b' : 'a',
          rev.pendingDemand?.demanderId,
        );
      }
      if (fwd.pendingOffers.length || rev.pendingOffers.length) {
        assert.equal(fwd.pendingOffers.length, rev.pendingOffers.length);
        const fwdSides = fwd.pendingOffers.map((o) => (o.proposerId === 'a' ? 'b' : 'a')).sort();
        const revSides = rev.pendingOffers.map((o) => o.proposerId).sort();
        assert.deepEqual(fwdSides, revSides);
      }
    });
  }
});

describe('determinism — identical inputs → deepEqual', () => {
  const samples = [
    {
      name: 'mutual attack CONTACT',
      build: () => ({
        phase: 'CONTACT',
        actionA: act('ATTACK'),
        actionB: act('ATTACK'),
        seed: 99,
      }),
    },
    {
      name: 'demand vs comply NEGOTIATION',
      build: () => ({
        phase: 'NEGOTIATION',
        actionA: act('DEMAND', { demand: DEMAND }),
        actionB: act('COMPLY'),
        b: combatant('b', { credits: 500, cargo: [{ good: CommodityId.Water, qty: 2 }] }),
        seed: 7,
      }),
    },
    {
      name: 'flee vs hail CONTACT',
      build: () => ({
        phase: 'CONTACT',
        actionA: act('FLEE'),
        actionB: act('HAIL'),
        seed: FLEE_FAIL,
      }),
    },
    {
      name: 'surrender vs attack COMBAT',
      build: () => ({
        phase: 'COMBAT',
        actionA: act('SURRENDER'),
        actionB: act('ATTACK'),
        seed: 3,
      }),
    },
  ];

  for (const s of samples) {
    test(s.name, () => {
      actionSeq = 1000;
      const i1 = s.build();
      actionSeq = 1000;
      const i2 = s.build();
      assert.deepEqual(round(i1), round(i2));
    });
  }
});
