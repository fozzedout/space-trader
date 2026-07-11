import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMODITIES,
  CommodityId,
  ORIGINAL_GALAXY,
  SpecialResource,
  SystemStatus,
  attackHits,
  baseEquipmentSellPrice,
  commanderFleeSucceeds,
  debtInterest,
  determinePrice,
  effectiveSkills,
  enemyShipPrice,
  equipmentPurchasePrice,
  initialQuantity,
  insurancePremium,
  originalEncounterKind,
  originalPoliceBand,
  originalPoliceEncounterStrength,
  originalReputationBand,
  originalShipBounty,
  reduceHullDamage,
  shipPurchasePrice,
  shipTradeInValue,
  shuffleSystemStatus,
  standardPrice,
  traderAdjustedBuyPrice,
  weaponDamage,
  wormholeTax,
  XorShift32,
} from '../dist/index.js';

class SequenceRng {
  constructor(values) { this.values = [...values]; }
  nextInt(maxExclusive) {
    assert.ok(maxExclusive > 0);
    const value = this.values.shift() ?? 0;
    assert.ok(value >= 0 && value < maxExclusive, `${value} is outside 0..${maxExclusive - 1}`);
    return value;
  }
}

const baseContext = {
  techLevel: 2,
  politicsId: 0,
  size: 2,
  status: SystemStatus.Uneventful,
  resource: SpecialResource.None,
  difficulty: 2,
};

test('authoritative table sizes are preserved', () => {
  assert.equal(COMMODITIES.length, 10);
});

test('standard price uses integer baseline modifiers', () => {
  const water = COMMODITIES[CommodityId.Water];
  assert.equal(standardPrice(water, baseContext), 34);
  assert.equal(traderAdjustedBuyPrice(34, 10), 35);
  assert.equal(baseEquipmentSellPrice(34), 25);
});

test('arrival prices reproduce market, criminal intermediary and trader markup', () => {
  const context = { ...baseContext, status: SystemStatus.Drought };
  const lawful = determinePrice(COMMODITIES[CommodityId.Water], context, 8, 0, new SequenceRng([3, 1]));
  assert.deepEqual(lawful, { standard: 34, market: 53, buy: 55, sell: 53 });

  const criminal = determinePrice(COMMODITIES[CommodityId.Water], context, 8, -6, new SequenceRng([3, 1]));
  assert.deepEqual(criminal, { standard: 34, market: 53, buy: 54, sell: 47 });
});

test('a system may buy a commodity it cannot produce', () => {
  const games = COMMODITIES[CommodityId.Games];
  const price = determinePrice(games, baseContext, 5, 0, new SequenceRng([0, 0]));
  assert.ok(price.sell > 0);
  assert.equal(price.buy, 0);
});

test('quantity generation preserves source RNG draw order', () => {
  assert.equal(initialQuantity(COMMODITIES[CommodityId.Water], baseContext, new SequenceRng([0, 0, 0])), 27);
  assert.equal(initialQuantity(COMMODITIES[CommodityId.Water], baseContext, new SequenceRng([0, 9, 0])), 18);
  const drought = { ...baseContext, status: SystemStatus.Drought };
  assert.equal(initialQuantity(COMMODITIES[CommodityId.Water], drought, new SequenceRng([0, 0, 0])), 5);
});

test('system status shuffle follows the original 15 percent transitions', () => {
  assert.equal(shuffleSystemStatus(SystemStatus.War, new SequenceRng([14])), SystemStatus.Uneventful);
  assert.equal(shuffleSystemStatus(SystemStatus.War, new SequenceRng([15])), SystemStatus.War);
  assert.equal(shuffleSystemStatus(SystemStatus.Uneventful, new SequenceRng([14, 2])), SystemStatus.Drought);
});

test('effective skills use best crew member plus gadget bonuses', () => {
  const skills = effectiveSkills([
    { pilot: 4, fighter: 8, trader: 3, engineer: 2 },
    { pilot: 7, fighter: 5, trader: 9, engineer: 6 },
  ], { navigatingSystem: true, cloakingDevice: true, targetingSystem: true, autoRepairSystem: true });
  assert.deepEqual(skills, { pilot: 12, fighter: 11, trader: 9, engineer: 9 });
});

test('combat formulas are deterministic through injected RNG', () => {
  assert.equal(attackHits(10, 2, 6, false, new SequenceRng([5, 3])), true);
  assert.equal(attackHits(10, 2, 6, true, new SequenceRng([5, 3])), false);
  assert.equal(weaponDamage(50, 5, new SequenceRng([54])), 54);
  assert.equal(reduceHullDamage(100, 10, 100, 2, new SequenceRng([5])), 50);
  assert.equal(reduceHullDamage(100, 10, 200, 2, new SequenceRng([5])), 95);
  assert.equal(commanderFleeSucceeds(9, 6, 2, new SequenceRng([5, 2])), true);
});

test('equipment and ship purchase prices use original trader discounts', () => {
  assert.equal(equipmentPurchasePrice(5, 2000, 4, 6), 0);
  assert.equal(equipmentPurchasePrice(5, 2000, 5, 6), 1880);
  assert.equal(shipPurchasePrice(10000, 6), 9400);
});

test('ship valuation preserves trade-in and enemy price formulas', () => {
  const tradeIn = shipTradeInValue(1, 90, 10, { weapons: [0], shields: [], gadgets: [0] });
  assert.equal(tradeIn, 10482);

  const enemyValue = enemyShipPrice(1, [0], [0], { pilot: 5, fighter: 5, engineer: 5 });
  assert.equal(enemyValue, 8500);
  assert.equal(originalShipBounty(enemyValue), 25);
});

test('ordinary travel encounter classification preserves original thresholds', () => {
  const weights = { difficulty: 2, isFlea: false, pirateStrength: 2, policeStrength: 3, traderStrength: 4 };
  assert.equal(originalEncounterKind(weights, new SequenceRng([1])), 'pirate');
  assert.equal(originalEncounterKind(weights, new SequenceRng([3])), 'police');
  assert.equal(originalEncounterKind(weights, new SequenceRng([7])), 'trader');
  assert.equal(originalEncounterKind(weights, new SequenceRng([10])), 'none');
  assert.equal(originalEncounterKind({ ...weights, alreadyRaided: true }, new SequenceRng([1])), 'police');
  assert.equal(originalEncounterKind({ ...weights, isFlea: true }, new SequenceRng([4])), 'trader');
  assert.equal(originalPoliceEncounterStrength(3, -71), 9);
  assert.equal(originalPoliceEncounterStrength(3, -31), 6);
  assert.equal(originalPoliceEncounterStrength(3, -30), 3);
});

test('travel, police and reputation helpers preserve original baselines', () => {
  assert.equal(wormholeTax(2), 50);
  assert.equal(debtInterest(1000), 100);
  assert.equal(insurancePremium(10000, 0), 25);
  assert.equal(insurancePremium(10000, 90), 2);
  assert.equal(originalShipBounty(1000), 25);
  assert.equal(originalShipBounty(10000), 50);
  assert.equal(originalShipBounty(600000), 2500);
  assert.equal(originalPoliceBand(-31).name, 'Villain');
  assert.equal(originalPoliceBand(12).name, 'Trusted');
  assert.equal(originalReputationBand(600).name, 'Deadly');
});

test('original galaxy constants are available as baseline inputs', () => {
  assert.deepEqual(ORIGINAL_GALAXY, {
    solarSystems: 120,
    wormholes: 6,
    width: 150,
    height: 110,
    minimumSystemDistance: 6,
    closeDistance: 13,
    wormholeDistance: 3,
    maximumFuelRange: 20,
  });
});

test('STO PRNG is stable for a fixed seed', () => {
  const rng = new XorShift32(123456789);
  assert.deepEqual([rng.nextInt(1000), rng.nextInt(1000), rng.nextInt(1000)], [632, 521, 291]);
});
