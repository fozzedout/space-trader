import type { EquipmentId } from "./equipment.js";
import { equipmentQuote } from "./equipment.js";
import { GOOD_IDS, type GoodId } from "./goods.js";
import type { HubNetwork } from "./info.js";
import type { StarSystem } from "./system.js";
import type { Trader, TraderConfig } from "./trader.js";

/**
 * The player/agent API. A player ship is an ordinary Trader whose
 * decisions come from queued actions instead of the NPC planner — same
 * markets, same InfoBoard, same bank, same foreclosure. Observations are
 * JSON-serializable and contain ONLY what the ship is entitled to know
 * (information symmetry): the local market live, everything else as
 * board snapshots, manifests only when docked at a hub.
 *
 * Designed to be driven by anything that maps Observation -> PlayerAction:
 * a UI, a script, or an LLM (see llm-driver.ts).
 */

export type PlayerAction =
  | { type: "wait" }
  | { type: "buy"; good: GoodId; qty: number }
  | { type: "sell"; good: GoodId; qty: number }
  | { type: "travel"; destId: number }
  | { type: "harvest" }
  | { type: "buy_equipment"; equipment: EquipmentId }
  | { type: "borrow"; amount: number }
  | { type: "repay"; amount: number };

export interface ActionResult {
  tick: number;
  action: PlayerAction;
  ok: boolean;
  detail: string;
}

export interface MarketView {
  good: GoodId;
  price: number;
  inventory: number;
  targetStock: number;
}

export interface KnownSystemView {
  id: number;
  name: string;
  role: string;
  isHub: boolean;
  distance: number;
  travelTicks: number;
  fuelNeeded: number;
  /** How many ticks old this market snapshot is. Old news is a bet. */
  newsAgeTicks: number;
  /** Prices/inventories are snapshots; targetStock is static structure
   * (the level the market prices around), known to everyone. */
  market: { good: GoodId; price: number; inventory: number; targetStock: number }[];
  /** Cargo already in flight toward this system — visible only from a hub. */
  inboundCargo?: { good: GoodId; qty: number }[];
}

export interface PlayerObservation {
  tick: number;
  you: {
    shipId: number;
    active: boolean;
    credits: number;
    capacity: number;
    cargo: { good: GoodId; qty: number; costBasis: number } | null;
    equipment: Record<EquipmentId, boolean>;
    loan: { principal: number; dueTick: number; lastPaymentTick: number } | null;
    shipValue: number;
    borrowCapacity: number;
    inTransit: { destId: number; arrivalTick: number } | null;
  };
  /** Live local state — null while in transit. */
  dockedAt: {
    id: number;
    name: string;
    role: string;
    isHub: boolean;
    market: MarketView[];
    equipmentForSale: Record<EquipmentId, number | null>;
    /** Credits/tick your gear would earn harvesting here right now. */
    harvestValuePerTick: number;
  } | null;
  knownSystems: KnownSystemView[];
  rules: {
    speed: number;
    fuelPerDist: number;
    wearPerDist: number;
    harvestRateFuel: number;
    harvestRateOre: number;
    loanInterestPerTick: number;
    loanTermTicks: number;
    loanToValue: number;
    delinquencyGraceTicks: number;
  };
  lastActionResult: ActionResult | null;
}

export function observePlayer(
  trader: Trader,
  systems: StarSystem[],
  hubNet: HubNetwork,
  tick: number,
  cfg: TraderConfig,
): PlayerObservation {
  const here = trader.travel
    ? null
    : systems.find((s) => s.id === trader.locationId) ?? null;

  const knownSystems: KnownSystemView[] = [];
  const origin = systems.find((s) => s.id === trader.locationId)!;
  for (const system of systems) {
    if (here && system.id === here.id) continue;
    const snap = trader.board.get(system.id);
    if (!snap) continue;
    const dist = origin.distanceTo(system);
    const view: KnownSystemView = {
      id: system.id,
      name: system.name,
      role: system.role,
      isHub: system.isHub,
      distance: Math.round(dist),
      travelTicks: Math.max(1, Math.ceil(dist / cfg.speed)),
      fuelNeeded: round2(dist * cfg.fuelPerDist),
      newsAgeTicks: tick - snap.tick,
      market: GOOD_IDS.map((good) => ({
        good,
        price: round2(snap.prices[good]),
        inventory: Math.round(snap.inventories[good]),
        targetStock: Math.round(system.markets[good].targetStock),
      })),
    };
    // Shipping manifests are hub information: only visible while docked
    // at a hub, exactly as for NPC traders.
    if (here?.isHub) {
      const inbound = GOOD_IDS.map((good) => ({
        good,
        qty: Math.round(hubNet.pendingFor(system.id, good)),
      })).filter((entry) => entry.qty > 0);
      if (inbound.length > 0) view.inboundCargo = inbound;
    }
    knownSystems.push(view);
  }

  return {
    tick,
    you: {
      shipId: trader.id,
      active: trader.active,
      credits: round2(trader.credits),
      capacity: trader.capacity,
      cargo: trader.cargo
        ? {
            good: trader.cargo.good,
            qty: trader.cargo.qty,
            costBasis: round2(trader.cargo.costBasis),
          }
        : null,
      equipment: { ...trader.equipment },
      loan: trader.loan
        ? {
            principal: round2(trader.loan.principal),
            dueTick: trader.loan.dueTick,
            lastPaymentTick: trader.loan.lastPaymentTick,
          }
        : null,
      shipValue: round2(trader.shipValue(cfg)),
      borrowCapacity: round2(trader.borrowCapacity(cfg)),
      inTransit: trader.travel ? { ...trader.travel } : null,
    },
    dockedAt: here
      ? {
          id: here.id,
          name: here.name,
          role: here.role,
          isHub: here.isHub,
          market: GOOD_IDS.map((good) => {
            const m = here.markets[good];
            return {
              good,
              price: round2(m.price),
              inventory: Math.round(m.inventory),
              targetStock: Math.round(m.targetStock),
            };
          }),
          equipmentForSale: {
            scoop: trader.equipment.scoop ? null : roundOrNull(equipmentQuote(here, "scoop")),
            shredder: trader.equipment.shredder
              ? null
              : roundOrNull(equipmentQuote(here, "shredder")),
          },
          harvestValuePerTick: round2(
            Math.max(
              trader.equipment.scoop ? here.markets.fuel.price * cfg.harvestRate : 0,
              trader.equipment.shredder ? here.markets.ore.price * cfg.oreHarvestRate : 0,
            ),
          ),
        }
      : null,
    knownSystems,
    rules: {
      speed: cfg.speed,
      fuelPerDist: cfg.fuelPerDist,
      wearPerDist: cfg.costPerDist,
      harvestRateFuel: cfg.harvestRate,
      harvestRateOre: cfg.oreHarvestRate,
      loanInterestPerTick: cfg.loanRatePerTick,
      loanTermTicks: cfg.loanTermTicks,
      loanToValue: cfg.loanToValue,
      delinquencyGraceTicks: cfg.delinquencyGraceTicks,
    },
    lastActionResult: trader.lastActionResult,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function roundOrNull(x: number | null): number | null {
  return x === null ? null : round2(x);
}
