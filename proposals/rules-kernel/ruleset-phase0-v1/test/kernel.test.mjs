import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RULESET_VERSION,
  PHASE0_TUNING,
  RulesetRng,
  unitPrice,
  progressiveQuote,
  applyMarketRecovery,
  bootstrapMarketGood,
  canonicalizeExchange,
  proposalHash,
  exchangesEqual,
  reverseExchange,
  resolveCaptainRound,
  resolveSurrenderClaim,
  selectPoliceContactType,
  resolvePoliceRound,
  shouldTriggerPoliceContact,
  policeCombatantSnapshot,
  decide,
  settleDestruction,
  activeBounty,
  wantedSeverity,
  matchEncounterPairs,
  deriveEncounterId,
  generateTravelSequence,
  survivingCargo,
  createWreck,
  surrenderHostilityDelta,
  moveBehaviourScore,
  profileBand,
  classifyAction,
  runAmbientEconomy,
  runScriptedEncounter,
  CommodityId,
} from '../dist/index.js';

test('ruleset version is pinned', () => {
  assert.equal(RULESET_VERSION, 'ruleset-phase0-v1');
  assert.equal(PHASE0_TUNING.stockEffectMaxBps, 2500);
});

test('PRNG is deterministic for identical seed and draw position', () => {
  const a = new RulesetRng(12345);
  const b = new RulesetRng(12345);
  const seqA = Array.from({ length: 20 }, () => a.nextInt(1000));
  const seqB = Array.from({ length: 20 }, () => b.nextInt(1000));
  assert.deepEqual(seqA, seqB);

  const c = new RulesetRng(12345, 5);
  const d = new RulesetRng(12345);
  for (let i = 0; i < 5; i += 1) d.nextInt(1000);
  assert.equal(c.nextInt(1000), d.nextInt(1000));
});

test('market price function and progressive quotes are deterministic', () => {
  const state = bootstrapMarketGood(CommodityId.Water, 100, 100, 0);
  assert.equal(unitPrice(100, 100, 100, 0), 100);
  assert.ok(unitPrice(100, 0, 100, 0) > 100);
  assert.ok(unitPrice(100, 200, 100, 0) < 100);

  const quote = progressiveQuote(state, 'buy', 5);
  assert.equal(quote.unitPrices.length, 5);
  assert.equal(quote.total, quote.unitPrices.reduce((s, p) => s + p, 0));
  assert.equal(quote.finalStock, 95);

  const again = progressiveQuote(state, 'buy', 5);
  assert.deepEqual(quote, again);
});

test('market recovery moves toward target', () => {
  let state = bootstrapMarketGood(CommodityId.Food, 100, 100, 0);
  state = { ...state, stock: 50, pressureBps: 1000 };
  const recovered = applyMarketRecovery(state, PHASE0_TUNING.recoveryPeriodMs * 3);
  assert.ok(recovered.stock > 50);
  assert.ok(Math.abs(recovered.pressureBps) < 1000);
});

test('trade offers canonicalize and hash stably', () => {
  const raw = {
    aToB: { credits: 100, cargo: [{ good: CommodityId.Water, qty: 2 }, { good: CommodityId.Water, qty: 1 }] },
    bToA: { credits: 40, cargo: [{ good: CommodityId.Water, qty: 1 }] },
  };
  const canonical = canonicalizeExchange(raw);
  assert.equal(canonical.aToB.credits, 60);
  assert.equal(canonical.aToB.cargo[0]?.qty, 2);
  assert.equal(proposalHash(raw), proposalHash(canonical));
  assert.ok(exchangesEqual(canonical, reverseExchange(reverseExchange(canonical))));
  assert.throws(() => canonicalizeExchange({
    aToB: { credits: 10, cargo: [] },
    bToA: { credits: 10, cargo: [] },
  }));
});

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

test('mutual flee ends encounter without damage', () => {
  const rng = new RulesetRng(99);
  const result = resolveCaptainRound({
    phase: 'CONTACT',
    a: combatant('a'),
    b: combatant('b'),
    actionA: { actionId: '1', roundNo: 1, type: 'FLEE' },
    actionB: { actionId: '2', roundNo: 1, type: 'FLEE' },
    pendingOffers: [],
    pendingDemand: null,
    rng,
  });
  assert.equal(result.ended, true);
  assert.equal(result.endReason, 'mutual_flee');
  assert.equal(result.attacks.length, 0);
});

test('demand vs comply transfers atomically when fulfilable', () => {
  const rng = new RulesetRng(7);
  const result = resolveCaptainRound({
    phase: 'NEGOTIATION',
    a: combatant('a'),
    b: combatant('b', { credits: 500, cargo: [{ good: CommodityId.Water, qty: 2 }] }),
    actionA: {
      actionId: '1',
      roundNo: 1,
      type: 'DEMAND',
      demand: { credits: 100, cargo: [{ good: CommodityId.Water, qty: 1 }] },
    },
    actionB: { actionId: '2', roundNo: 1, type: 'COMPLY' },
    pendingOffers: [],
    pendingDemand: null,
    rng,
  });
  assert.equal(result.ended, true);
  assert.equal(result.transfers[0]?.kind, 'demand');
  assert.equal(result.demandOutcomes[0]?.result, 'COMPLIED');
});

test('unfulfillable demand returns opaque NOT_COMPLIED', () => {
  const rng = new RulesetRng(8);
  const result = resolveCaptainRound({
    phase: 'NEGOTIATION',
    a: combatant('a'),
    b: combatant('b', { credits: 10, cargo: [] }),
    actionA: {
      actionId: '1',
      roundNo: 1,
      type: 'DEMAND',
      demand: { credits: 9999, cargo: [] },
    },
    actionB: { actionId: '2', roundNo: 1, type: 'COMPLY' },
    pendingOffers: [],
    pendingDemand: null,
    rng,
  });
  assert.equal(result.demandOutcomes[0]?.result, 'NOT_COMPLIED');
  assert.equal(result.transfers.length, 0);
  assert.equal(result.ended, false);
});

test('identical encounter inputs produce identical results', () => {
  const run = () => {
    const rng = new RulesetRng(4242);
    return resolveCaptainRound({
      phase: 'CONTACT',
      a: combatant('a', { totalWeaponPower: 30 }),
      b: combatant('b'),
      actionA: { actionId: '1', roundNo: 1, type: 'ATTACK' },
      actionB: { actionId: '2', roundNo: 1, type: 'FLEE' },
      pendingOffers: [],
      pendingDemand: null,
      rng,
    });
  };
  assert.deepEqual(run(), run());
});

test('surrender claim clamps to holdings', () => {
  const transfer = resolveSurrenderClaim('victor', combatant('victim', { credits: 50, cargo: [{ good: CommodityId.Food, qty: 2 }] }), {
    credits: 999,
    cargo: [{ good: CommodityId.Food, qty: 9 }],
  });
  assert.equal(transfer?.credits, 50);
  assert.equal(transfer?.cargo[0]?.qty, 2);
});

test('police contact and inspection are deterministic', () => {
  const rng = new RulesetRng(55);
  const contact = selectPoliceContactType(-100, 5, rng);
  assert.equal(contact, 'ATTACK_ON_SIGHT');

  const rng2 = new RulesetRng(56);
  const result = resolvePoliceRound({
    contact: 'INSPECTION',
    phase: 'CONTACT',
    captain: combatant('c', {
      cargo: [{ good: CommodityId.Narcotics, qty: 2 }],
    }),
    police: combatant('police'),
    response: 'COMPLY',
    politicsId: 5, // Cybernetic State — narcotics not allowed
    rng: rng2,
  });
  assert.equal(result.ended, true);
  assert.ok(result.confiscated.length >= 1);
});

test('NPC decide is deterministic', () => {
  const input = {
    phase: 'CONTACT',
    self: combatant('npc', { combatProfile: 65, tradeProfile: 0 }),
    other: combatant('other', { policeRecord: 0 }),
    relationship: null,
    pendingOffers: [],
    pendingDemandDemanderId: null,
    surrenderVictorId: null,
    roundNo: 1,
    rng: new RulesetRng(77),
    otherPublicDisposition: 'neutral',
  };
  const a = decide('ordinary_npc', { ...input, rng: new RulesetRng(77) });
  const b = decide('ordinary_npc', { ...input, rng: new RulesetRng(77) });
  assert.deepEqual(a, b);
});

test('bounty and rehabilitation rules', () => {
  assert.equal(wantedSeverity(-50), 20);
  assert.ok(activeBounty(-50) > PHASE0_TUNING.baseWantedBounty);
  const lawful = settleDestruction({
    killerId: 'k',
    victimId: 'v',
    killerPoliceRecordBefore: 0,
    victimPoliceRecordBefore: -50,
    killerInitiatedUnprovoked: false,
  });
  assert.equal(lawful.lawful, true);
  assert.ok(lawful.bountyPaid > 0);
  assert.equal(lawful.victimPoliceAfterIfSurvives, -30);

  const wantedKiller = settleDestruction({
    killerId: 'k',
    victimId: 'v',
    killerPoliceRecordBefore: -40,
    victimPoliceRecordBefore: -50,
    killerInitiatedUnprovoked: false,
  });
  assert.equal(wantedKiller.bountyPaid, 0);
  assert.ok(wantedKiller.killerPoliceDelta > 0);
});

test('travel matching is deterministic and non-overlapping', () => {
  const eligible = [
    { captainId: 'c1', routeArea: 'approach-1', startedAt: 0, endsAt: 10_000 },
    { captainId: 'c2', routeArea: 'approach-1', startedAt: 0, endsAt: 10_000 },
    { captainId: 'c3', routeArea: 'approach-1', startedAt: 0, endsAt: 10_000 },
    { captainId: 'c4', routeArea: 'approach-1', startedAt: 0, endsAt: 10_000 },
  ];
  const a = matchEncounterPairs({ systemId: 's1', routeArea: 'approach-1', globalTick: 10, eligible });
  const b = matchEncounterPairs({ systemId: 's1', routeArea: 'approach-1', globalTick: 10, eligible });
  assert.deepEqual(a, b);
  assert.equal(a.length, 2);
  const ids = new Set(a.flatMap((p) => [p.captainAId, p.captainBId]));
  assert.equal(ids.size, 4);
  assert.equal(
    a[0].encounterId,
    deriveEncounterId('s1', 'approach-1', 10, a[0].captainAId, a[0].captainBId),
  );
});

test('companions are not paired against each other', () => {
  const pairs = matchEncounterPairs({
    systemId: 's1',
    routeArea: 'r',
    globalTick: 1,
    eligible: [
      { captainId: 'human', routeArea: 'r', startedAt: 0, endsAt: 5_000, travelGroupId: 'g1', matchable: true },
      { captainId: 'friend', routeArea: 'r', startedAt: 0, endsAt: 5_000, travelGroupId: 'g1', matchable: false },
    ],
  });
  assert.equal(pairs.length, 0);
});

test('travel sequence stores ruleset version', () => {
  const trip = generateTravelSequence({
    tripId: 't1',
    seed: 9,
    destinationSystemId: 'sol',
    routeArea: 'sol-approach',
  });
  assert.equal(trip.rulesetVersion, RULESET_VERSION);
  assert.ok(trip.approachTicks >= PHASE0_TUNING.approachTicksMin);
  assert.ok(trip.approachTicks <= PHASE0_TUNING.approachTicksMax);
});

test('wreck cargo survival is seeded', () => {
  const cargo = [{ good: CommodityId.Ore, qty: 20 }];
  const a = survivingCargo(cargo, new RulesetRng(3));
  const b = survivingCargo(cargo, new RulesetRng(3));
  assert.deepEqual(a, b);
});

test('createWreck stores routeArea unchanged', () => {
  const wreck = createWreck({
    wreckId: 'wreck-loc-1',
    routeArea: 'regulas:approach',
    cargo: [{ good: CommodityId.Water, qty: 1 }],
    nowMs: 1000,
  });
  assert.equal(wreck.routeArea, 'regulas:approach');
  assert.equal(wreck.wreckId, 'wreck-loc-1');
});

test('surrender hostility curve', () => {
  assert.equal(surrenderHostilityDelta(0), -10);
  assert.equal(surrenderHostilityDelta(1), 50);
  assert.equal(surrenderHostilityDelta(0.5), 28);
});

test('behaviour score movement', () => {
  assert.equal(moveBehaviourScore(0, 'aggressive'), 1);
  assert.equal(moveBehaviourScore(5, 'passive'), 3);
  assert.equal(profileBand(65), 'aggressive');
  const cls = classifyAction({
    actionType: 'DEMAND',
    initiatedConflict: true,
    escalated: false,
    returningFire: false,
    self: combatant('a'),
    other: combatant('b'),
    inCombat: false,
  });
  assert.equal(cls.behaviour, 'aggressive');
});

test('simulation harness runs under ruleset-phase0-v1', () => {
  const economy = runAmbientEconomy({ seed: 11, captainDays: 50, captains: 6, systems: 3 });
  assert.equal(economy.rulesetVersion, RULESET_VERSION);
  assert.ok(economy.trades > 0);
  assert.ok(economy.profitableRouteHits > 0);
  const ratio = economy.totalCreditsEnd / economy.totalCreditsStart;
  assert.ok(ratio > 0.2 && ratio < 20);

  const encounter = runScriptedEncounter({ seed: 12, maxRounds: 8 });
  assert.equal(encounter.rulesetVersion, RULESET_VERSION);
  assert.ok(encounter.rounds >= 1);
});

test('simulation harness demonstrates persistent trade routes, stable money supply, and non-degenerate combat at Phase 0 scale', () => {
  const captainDays = 1000;
  const captains = 8;
  const systems = 4;
  const economySeeds = [11, 42, 99, 123, 777];
  const checkpointDays = [333, 666, 1000];
  /** Tighter than the smoke-test [0.2, 20] band; allows moderate credit growth from NPC trading. */
  const moneyRatioMin = 0.5;
  const moneyRatioMax = 5;
  /** Consecutive checkpoint ratio-of-ratios must stay bounded (no runaway monotonic drift). */
  const checkpointDriftMin = 0.35;
  const checkpointDriftMax = 2.5;

  for (const seed of economySeeds) {
    const economy = runAmbientEconomy({
      seed,
      captainDays,
      captains,
      systems,
      checkpointDays,
    });
    assert.equal(economy.rulesetVersion, RULESET_VERSION);
    assert.ok(economy.trades > 0, `seed ${seed}: expected trades`);
    assert.ok(economy.profitableRouteHits > 0, `seed ${seed}: expected profitable route hits`);

    const ratio = economy.totalCreditsEnd / economy.totalCreditsStart;
    assert.ok(
      ratio > moneyRatioMin && ratio < moneyRatioMax,
      `seed ${seed}: money ratio ${ratio.toFixed(3)} outside (${moneyRatioMin}, ${moneyRatioMax})`,
    );

    assert.equal(economy.creditCheckpoints.length, checkpointDays.length);
    for (let i = 0; i < economy.creditCheckpoints.length; i += 1) {
      const snap = economy.creditCheckpoints[i];
      assert.equal(snap.day, checkpointDays[i]);
      assert.ok(
        snap.ratio > moneyRatioMin && snap.ratio < moneyRatioMax,
        `seed ${seed} day ${snap.day}: checkpoint ratio ${snap.ratio.toFixed(3)} outside (${moneyRatioMin}, ${moneyRatioMax})`,
      );
      if (i > 0) {
        const prev = economy.creditCheckpoints[i - 1];
        const drift = snap.ratio / prev.ratio;
        assert.ok(
          drift >= checkpointDriftMin && drift <= checkpointDriftMax,
          `seed ${seed}: checkpoint drift ${prev.day}->${snap.day} = ${drift.toFixed(3)} outside [${checkpointDriftMin}, ${checkpointDriftMax}]`,
        );
      }
    }
  }

  const matchups = [
    ['aggressive', 'aggressive'],
    ['aggressive', 'passive'],
    ['neutral', 'neutral'],
    ['passive', 'passive'],
  ];
  const combatSeeds = [12, 34, 56, 78, 90, 111, 222, 333];
  const maxRounds = 12;
  /** @type {{ a: string, b: string, rounds: number, ended: boolean, endReason?: string }[]} */
  const combatResults = [];
  for (const [aCombat, bCombat] of matchups) {
    for (const seed of combatSeeds) {
      const encounter = runScriptedEncounter({
        seed,
        maxRounds,
        aCombat,
        bCombat,
      });
      assert.equal(encounter.rulesetVersion, RULESET_VERSION);
      assert.ok(encounter.rounds >= 1);
      combatResults.push({
        a: aCombat,
        b: bCombat,
        rounds: encounter.rounds,
        ended: encounter.ended,
        endReason: encounter.endReason,
      });
    }
  }

  const total = combatResults.length;
  const roundOneCount = combatResults.filter((r) => r.rounds === 1).length;
  const longerThanOne = combatResults.filter((r) => r.rounds > 1).length;
  const endedCount = combatResults.filter((r) => r.ended).length;
  const hitCapUnresolved = combatResults.filter((r) => !r.ended && r.rounds >= maxRounds).length;
  const endReasons = new Set(
    combatResults.filter((r) => r.ended && r.endReason).map((r) => r.endReason),
  );

  assert.ok(longerThanOne > 0, 'combat must not always resolve in round 1');
  assert.ok(roundOneCount < total, 'combat must not always resolve in round 1');
  assert.ok(
    endedCount / total >= 0.7,
    `expected large majority of matchups to end before cap; ended=${endedCount}/${total}, unresolvedAtCap=${hitCapUnresolved}`,
  );
  assert.ok(
    endReasons.size >= 2,
    `expected varied endReason values, got: ${[...endReasons].join(', ') || '(none)'}`,
  );

  const endedRate = (a, b) => {
    const subset = combatResults.filter((r) => r.a === a && r.b === b);
    return subset.filter((r) => r.ended).length / subset.length;
  };
  const agAgRate = endedRate('aggressive', 'aggressive');
  const agPaRate = endedRate('aggressive', 'passive');
  assert.ok(
    agPaRate >= agAgRate,
    `aggressive-vs-passive should resolve at least as reliably as aggressive-vs-aggressive (${agPaRate} vs ${agAgRate})`,
  );
});

test('shouldTriggerPoliceContact is deterministic and scales with presence', () => {
  const a = shouldTriggerPoliceContact(0, 3, new RulesetRng(101));
  const b = shouldTriggerPoliceContact(0, 3, new RulesetRng(101));
  assert.equal(a, b);

  let lowHits = 0;
  let highHits = 0;
  const samples = 2_000;
  for (let i = 0; i < samples; i += 1) {
    const seed = (0x9e3779b9 * (i + 1)) >>> 0 || 1;
    if (shouldTriggerPoliceContact(0, 0, new RulesetRng(seed))) lowHits += 1;
    if (shouldTriggerPoliceContact(0, 7, new RulesetRng(seed))) highHits += 1;
  }
  assert.ok(highHits > lowHits, `expected presence=7 (${highHits}) > presence=0 (${lowHits})`);
  assert.ok(lowHits > 0 && lowHits < samples);
  assert.ok(highHits < samples);
  assert.ok(PHASE0_TUNING.policeContactCheckProbabilityBps >= 200);
  assert.ok(PHASE0_TUNING.policeContactCheckProbabilityBps <= 1500);
});

test('policeCombatantSnapshot scales with presence and record', () => {
  const weak = policeCombatantSnapshot(1, 0, new RulesetRng(3));
  const strong = policeCombatantSnapshot(7, -100, new RulesetRng(3));
  assert.equal(weak.captainId, 'police');
  assert.equal(strong.captainId, 'police');
  assert.ok(strong.hull >= weak.hull || strong.totalWeaponPower >= weak.totalWeaponPower);
  assert.ok(strong.totalWeaponPower >= weak.totalWeaponPower);
  assert.deepEqual(
    policeCombatantSnapshot(4, -40, new RulesetRng(9)),
    policeCombatantSnapshot(4, -40, new RulesetRng(9)),
  );
});
