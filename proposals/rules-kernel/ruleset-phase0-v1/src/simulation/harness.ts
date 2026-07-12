import {
  COMMODITIES,
  CommodityId,
  determinePrice,
  initialQuantity,
  SystemStatus,
  SpecialResource,
} from '@sto/original-baseline-rules';
import { RULESET_VERSION } from '../config.js';
import { bootstrapMarketGood, progressiveQuote, commitQuote, applyMarketRecovery, unitPrice } from '../market.js';
import type { MarketGoodState } from '../types.js';
import { RulesetRng } from '../prng.js';
import { resolveCaptainRound } from '../encounter-resolver.js';
import type { CombatantSnapshot, CaptainAction } from '../types.js';
import { decideOrdinaryNpc } from '../npc-policy.js';
import { scoreForBand, randomFixedProfileBand } from '../profiles.js';

export interface SimCaptain {
  id: string;
  credits: number;
  systemIndex: number;
  cargo: Map<CommodityId, number>;
  combatProfile: number;
  tradeProfile: number;
}

export interface EconomyCreditSnapshot {
  readonly day: number;
  readonly totalCredits: number;
  /** `totalCredits / totalCreditsStart` at this checkpoint. */
  readonly ratio: number;
}

export interface EconomySimResult {
  readonly rulesetVersion: typeof RULESET_VERSION;
  readonly captainDays: number;
  readonly trades: number;
  readonly totalCreditsEnd: number;
  readonly totalCreditsStart: number;
  readonly profitableRouteHits: number;
  readonly markets: readonly { good: CommodityId; stock: number; pressureBps: number; price: number }[];
  /** Intermediate money-supply samples when `checkpointDays` was provided. */
  readonly creditCheckpoints: readonly EconomyCreditSnapshot[];
}

function makeCombatant(id: string, credits: number, combat: number, trade: number): CombatantSnapshot {
  return {
    captainId: id,
    shipSize: 1,
    hull: 100,
    maxHull: 100,
    shields: [50],
    totalWeaponPower: 25,
    pilot: 5,
    fighter: 5,
    engineer: 5,
    hasEscapePod: false,
    policeRecord: 0,
    combatProfile: combat,
    tradeProfile: trade,
    credits,
    cargo: [{ good: CommodityId.Water, qty: 5 }],
    difficulty: 2,
  };
}

function measureTotalCredits(captains: readonly SimCaptain[], markets: readonly MarketGoodState[][]): number {
  return captains.reduce((sum, c) => {
    let cargoValue = 0;
    for (const [good, qty] of c.cargo) {
      const state = markets[c.systemIndex]!.find((m) => m.good === good);
      cargoValue += qty * (state?.equilibriumPrice ?? 0);
    }
    return sum + c.credits + cargoValue;
  }, 0);
}

/**
 * Ambient NPC captain-day economy run against the shared market model.
 * Success signal: profitable routes persist and money supply stays bounded.
 */
export function runAmbientEconomy(args: {
  readonly seed: number;
  readonly captainDays: number;
  readonly captains?: number;
  readonly systems?: number;
  /**
   * Optional 1-based day numbers at which to sample running total credits.
   * Ignored days outside `[1, captainDays]` are skipped. Existing callers
   * that omit this keep the previous return shape aside from an empty
   * `creditCheckpoints` array.
   */
  readonly checkpointDays?: readonly number[];
}): EconomySimResult {
  const rng = new RulesetRng(args.seed);
  const systemCount = args.systems ?? 4;
  const captainCount = args.captains ?? 8;
  const now0 = 1_000_000;
  const checkpointSet = new Set(
    (args.checkpointDays ?? []).filter((d) => d >= 1 && d <= args.captainDays),
  );

  const markets: MarketGoodState[][] = [];
  for (let s = 0; s < systemCount; s += 1) {
    const ctx = {
      techLevel: (3 + (s % 5)) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
      politicsId: s % 17,
      size: (s % 5) as 0 | 1 | 2 | 3 | 4,
      status: SystemStatus.Uneventful,
      resource: SpecialResource.None,
      difficulty: 2 as const,
    };
    const goods: MarketGoodState[] = [];
    const priceRng = rng.fork(s + 1);
    for (const commodity of COMMODITIES) {
      const priced = determinePrice(commodity, ctx, 5, 0, priceRng);
      const qty = initialQuantity(commodity, ctx, priceRng);
      if (priced.buy <= 0 && priced.sell <= 0) continue;
      goods.push(bootstrapMarketGood(
        commodity.id,
        Math.max(1, priced.market || priced.standard || 1),
        Math.max(1, qty),
        now0,
      ));
    }
    markets.push(goods);
  }

  const captains: SimCaptain[] = [];
  let totalCreditsStart = 0;
  for (let i = 0; i < captainCount; i += 1) {
    const combat = scoreForBand(randomFixedProfileBand(rng));
    const trade = scoreForBand(randomFixedProfileBand(rng));
    const credits = 5_000 + rng.nextInt(5_000);
    totalCreditsStart += credits;
    captains.push({
      id: `npc-${i}`,
      credits,
      systemIndex: i % systemCount,
      cargo: new Map(),
      combatProfile: combat,
      tradeProfile: trade,
    });
  }

  let trades = 0;
  let profitableRouteHits = 0;
  let now = now0;
  const creditCheckpoints: EconomyCreditSnapshot[] = [];

  for (let day = 0; day < args.captainDays; day += 1) {
    now += 86_400_000;
    for (const market of markets) {
      for (let g = 0; g < market.length; g += 1) {
        market[g] = applyMarketRecovery(market[g]!, now);
      }
    }

    for (const captain of captains) {
      // travel to a neighbouring system
      captain.systemIndex = (captain.systemIndex + 1 + rng.nextInt(systemCount - 1)) % systemCount;
      const market = markets[captain.systemIndex]!;
      if (market.length === 0) continue;

      // sell inventory
      for (const [good, qty] of [...captain.cargo.entries()]) {
        if (qty <= 0) continue;
        const state = market.find((m) => m.good === good);
        if (!state) continue;
        const sellQty = Math.min(qty, 1 + rng.nextInt(Math.min(5, qty)));
        try {
          const quote = progressiveQuote(state, 'sell', sellQty);
          const idx = market.findIndex((m) => m.good === good);
          market[idx] = commitQuote(state, quote);
          captain.credits += quote.total;
          captain.cargo.set(good, qty - sellQty);
          trades += 1;
          if (quote.total >= sellQty * state.equilibriumPrice) profitableRouteHits += 1;
        } catch {
          /* skip */
        }
      }

      // buy something affordable
      const candidate = market[rng.nextInt(market.length)]!;
      if (candidate.stock > 0) {
        const price = unitPrice(
          candidate.equilibriumPrice,
          candidate.stock,
          candidate.targetStock,
          candidate.pressureBps,
        );
        const qty = Math.min(3, candidate.stock, Math.max(0, Math.floor(captain.credits / Math.max(1, price))));
        if (qty > 0) {
          try {
            const quote = progressiveQuote(candidate, 'buy', qty);
            if (captain.credits >= quote.total) {
              const idx = market.findIndex((m) => m.good === candidate.good);
              market[idx] = commitQuote(candidate, quote);
              captain.credits -= quote.total;
              captain.cargo.set(candidate.good, (captain.cargo.get(candidate.good) ?? 0) + qty);
              trades += 1;
              if (price <= candidate.equilibriumPrice) profitableRouteHits += 1;
            }
          } catch {
            /* skip */
          }
        }
      }
    }

    const dayNumber = day + 1;
    if (checkpointSet.has(dayNumber)) {
      const totalCredits = measureTotalCredits(captains, markets);
      creditCheckpoints.push({
        day: dayNumber,
        totalCredits,
        ratio: totalCredits / Math.max(1, totalCreditsStart),
      });
    }
  }

  const totalCreditsEnd = measureTotalCredits(captains, markets);

  const flatMarkets = markets.flat().map((m) => ({
    good: m.good,
    stock: m.stock,
    pressureBps: m.pressureBps,
    price: unitPrice(m.equilibriumPrice, m.stock, m.targetStock, m.pressureBps),
  }));

  return {
    rulesetVersion: RULESET_VERSION,
    captainDays: args.captainDays,
    trades,
    totalCreditsEnd,
    totalCreditsStart,
    profitableRouteHits,
    markets: flatMarkets,
    creditCheckpoints,
  };
}

export interface EncounterSimResult {
  readonly rulesetVersion: typeof RULESET_VERSION;
  readonly rounds: number;
  readonly ended: boolean;
  readonly endReason?: string;
  readonly events: readonly string[];
}

/** Scripted / policy-driven encounter matchup through the resolver. */
export function runScriptedEncounter(args: {
  readonly seed: number;
  readonly maxRounds?: number;
  readonly aCombat?: 'passive' | 'neutral' | 'aggressive';
  readonly bCombat?: 'passive' | 'neutral' | 'aggressive';
}): EncounterSimResult {
  const rng = new RulesetRng(args.seed);
  const a = makeCombatant('a', 2_000, scoreForBand(args.aCombat ?? 'neutral'), 0);
  const b = makeCombatant('b', 2_000, scoreForBand(args.bCombat ?? 'aggressive'), 0);
  let phase: 'CONTACT' | 'NEGOTIATION' | 'COMBAT' = 'CONTACT';
  let pendingOffers: never[] = [];
  let pendingDemand = null;
  const allEvents: string[] = [];
  let rounds = 0;
  let ended = false;
  let endReason: string | undefined;
  const maxRounds = args.maxRounds ?? 12;

  let hullA = a.hull;
  let hullB = b.hull;
  let shieldsA = [...a.shields];
  let shieldsB = [...b.shields];

  while (!ended && rounds < maxRounds) {
    rounds += 1;
    const snapA = { ...a, hull: hullA, shields: shieldsA };
    const snapB = { ...b, hull: hullB, shields: shieldsB };
    const decisionA = decideOrdinaryNpc({
      phase,
      self: snapA,
      other: snapB,
      relationship: null,
      pendingOffers,
      pendingDemandDemanderId: pendingDemand?.demanderId ?? null,
      surrenderVictorId: null,
      roundNo: rounds,
      rng,
      otherPublicDisposition: 'aggressive',
    });
    const decisionB = decideOrdinaryNpc({
      phase,
      self: snapB,
      other: snapA,
      relationship: null,
      pendingOffers,
      pendingDemandDemanderId: pendingDemand?.demanderId ?? null,
      surrenderVictorId: null,
      roundNo: rounds,
      rng,
      otherPublicDisposition: 'neutral',
    });

    const result = resolveCaptainRound({
      phase,
      a: snapA,
      b: snapB,
      actionA: decisionA.action,
      actionB: decisionB.action,
      pendingOffers,
      pendingDemand,
      rng,
    });
    allEvents.push(...result.events);
    for (const atk of result.attacks) {
      if (atk.defenderId === 'a') {
        hullA = atk.hullAfter;
        shieldsA = [...atk.shieldsAfter];
      } else {
        hullB = atk.hullAfter;
        shieldsB = [...atk.shieldsAfter];
      }
    }
    pendingOffers = result.pendingOffers as typeof pendingOffers;
    pendingDemand = result.pendingDemand;
    if (result.ended || result.phaseAfter === 'TERMINAL') {
      ended = true;
      endReason = result.endReason;
      break;
    }
    if (result.phaseAfter === 'COMBAT' || result.phaseAfter === 'NEGOTIATION' || result.phaseAfter === 'CONTACT') {
      phase = result.phaseAfter;
    } else {
      ended = true;
      endReason = result.endReason ?? result.phaseAfter;
    }
  }

  return {
    rulesetVersion: RULESET_VERSION,
    rounds,
    ended,
    ...(endReason !== undefined ? { endReason } : {}),
    events: allEvents,
  };
}
