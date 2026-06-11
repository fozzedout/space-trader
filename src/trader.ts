import { EQUIPMENT, buyEquipment, equipmentQuote, type EquipmentId } from "./equipment.js";
import type { ActionResult, PlayerAction } from "./player.js";
import { GOOD_IDS, type GoodId } from "./goods.js";
import { HubNetwork, InfoBoard, takeSnapshot } from "./info.js";
import type { Rng } from "./rng.js";
import type { StarSystem } from "./system.js";

export interface TraderConfig {
  /** Distance travelled per tick. */
  speed: number;
  /** Credit cost per unit of distance (hull wear; pure credit sink). */
  costPerDist: number;
  /** Fuel units burned per unit of distance, bought at the origin market. */
  fuelPerDist: number;
  /** Fuel units a scoop can skim from the star per idle tick. */
  harvestRate: number;
  /** Ore units a shredder can grind from asteroids per idle tick. */
  oreHarvestRate: number;
  /** Minimum profit as a fraction of purchase cost to accept a route. */
  minMarginFrac: number;
  /** After this many idle ticks, relocate to a random system. */
  idleRelocateAfter: number;
  /** Traders only buy inventory above this fraction of target stock. */
  originReserveFrac: number;
  /** When relocating idle, probability of heading to a hub for fresh news. */
  hubRelocateBias: number;
  /** Interest per tick on outstanding loan balance (the debt clock). */
  loanRatePerTick: number;
  /** Ticks until an unpaid loan defaults and the bank seizes the ship. */
  loanTermTicks: number;
  /** Maximum loan as a fraction of ship value (the collateral). */
  loanToValue: number;
  /** Hull collateral value per unit of cargo capacity. */
  shipValuePerCapacity: number;
  /** Cash kept on hand; everything above it goes to loan repayment. */
  repayBuffer: number;
  /** Extra borrowed on top of exact need, to cover early interest. */
  borrowCushion: number;
  /** Buy a shredder (cash) when credits exceed this multiple of its cost. */
  shredderWealthMult: number;
  /**
   * Margin multiplier required on trades made with borrowed money.
   * Betting the bank's credits at the ordinary margin is a treadmill:
   * thin leveraged bets churn (~30% of trips lose) and equity never
   * builds. Borrowed trades must be clearly good deals.
   */
  leveragedMarginMult: number;
  /**
   * With this many ticks left on the loan term, a geared debtor stops
   * trading and grinds the local system until the loan is cleared —
   * harvest income is slow but certain, trading is not, and default
   * costs the ship.
   */
  emergencyGrindTicks: number;
  /**
   * Two-leg repositioning only scans the nearest N systems (plus all
   * hubs) as candidate buy-origins. Flying empty across the galaxy
   * almost never scores well anyway (score divides by total trip time),
   * and an unbounded scan is O(systems²) per idle ship.
   */
  repositionScanLimit: number;
  /** Past the due date, foreclosure happens only after this many ticks
   * without a payment: default means stopping, not paying slowly. */
  delinquencyGraceTicks: number;
}

export const DEFAULT_TRADER_CONFIG: TraderConfig = {
  speed: 12,
  costPerDist: 0.3,
  fuelPerDist: 0.015,
  harvestRate: 0.5,
  oreHarvestRate: 0.4,
  minMarginFrac: 0.05,
  idleRelocateAfter: 8,
  originReserveFrac: 0.4,
  hubRelocateBias: 0.5,
  loanRatePerTick: 0.002,
  loanTermTicks: 250,
  loanToValue: 0.6,
  shipValuePerCapacity: 40,
  repayBuffer: 600,
  borrowCushion: 50,
  shredderWealthMult: 3,
  leveragedMarginMult: 2,
  emergencyGrindTicks: 150,
  repositionScanLimit: 8,
  delinquencyGraceTicks: 30,
};

interface Cargo {
  good: GoodId;
  qty: number;
  costBasis: number;
}

interface Travel {
  destId: number;
  arrivalTick: number;
}

/** A station bank loan. The ship itself is the collateral. */
export interface Loan {
  principal: number;
  lenderSystemId: number;
  dueTick: number;
  /** Banks foreclose on debtors who STOP paying, not on slow payers —
   * past the due date, any recent payment keeps the ship. Slow payers
   * still bleed interest the whole time. */
  lastPaymentTick: number;
}

interface Route {
  good: GoodId;
  qty: number;
  dest: StarSystem;
  score: number;
  cost: number;
  tripCost: number;
  travelTicks: number;
  profit: number;
}

/**
 * An NPC trader. Pure profit-seeker: buys where goods are cheap (surplus),
 * sells where it BELIEVES they're dear (shortage). Belief comes from its
 * InfoBoard — personal observations plus hub network news — never from
 * live remote state. Player ships get exactly the same information,
 * equipment, and banking mechanics. The aggregate effect of many of these
 * is the self-balancing distribution network — there is no central
 * coordinator.
 */
export class Trader {
  readonly id: number;
  credits: number;
  readonly capacity: number;
  locationId: number;
  cargo: Cargo | null = null;
  travel: Travel | null = null;
  idleTicks = 0;
  /** What this ship knows about the galaxy's markets. */
  readonly board = new InfoBoard();
  /** Fitted gear. Ships start bare and outfit themselves at stations. */
  equipment: Record<EquipmentId, boolean> = { scoop: false, shredder: false };
  /** Outstanding station-bank loan, if any (one at a time; ship is collateral). */
  loan: Loan | null = null;
  /** False once the bank has seized the ship (loan default). */
  active = true;
  /** "ai" ships run the NPC planner; "player" ships execute queued
   * actions (from a UI, a script, or an LLM — see player.ts). All
   * mechanics — markets, news, bank, foreclosure — are identical. */
  controller: "ai" | "player" = "ai";
  /** Next action for a player-controlled ship; consumed on its tick. */
  pendingAction: PlayerAction | null = null;
  lastActionResult: ActionResult | null = null;

  /** Lifetime diagnostics. */
  tripsCompleted = 0;
  totalProfit = 0;
  totalHarvested = 0;
  loansTaken = 0;
  totalBorrowed = 0;
  totalRepaid = 0;
  interestAccrued = 0;

  constructor(opts: { id: number; credits: number; capacity: number; locationId: number }) {
    this.id = opts.id;
    this.credits = opts.credits;
    this.capacity = opts.capacity;
    this.locationId = opts.locationId;
  }

  /** Collateral: hull plus fitted gear at nominal value. */
  shipValue(cfg: TraderConfig): number {
    let value = this.capacity * cfg.shipValuePerCapacity;
    for (const [id, owned] of Object.entries(this.equipment) as [EquipmentId, boolean][]) {
      if (owned) value += EQUIPMENT[id].collateralValue;
    }
    return value;
  }

  /** How much the bank will still lend (one loan at a time). */
  borrowCapacity(cfg: TraderConfig): number {
    return this.loan ? 0 : this.shipValue(cfg) * cfg.loanToValue;
  }

  tick(
    tick: number,
    systems: StarSystem[],
    cfg: TraderConfig,
    rng: Rng,
    hubNet: HubNetwork,
  ): void {
    if (!this.active) return;

    // The debt clock runs everywhere, including in transit. Debt is the
    // one deliberately time-based cost in the economy: it pressures
    // borrowers to work, without taxing the debt-free.
    if (this.loan) {
      const interest = this.loan.principal * cfg.loanRatePerTick;
      this.loan.principal += interest;
      this.interestAccrued += interest;
    }

    if (this.travel) {
      if (tick < this.travel.arrivalTick) return;
      this.arrive(systems);
    }

    const here = this.systemById(systems, this.locationId);

    // Docked, overdue, AND delinquent: the bank forecloses. Cargo is
    // liquidated into the local market, and the ship — the collateral —
    // is seized. The trader is out of the game. A debtor past the due
    // date who keeps making payments keeps the ship (and keeps paying
    // interest).
    if (
      this.loan &&
      tick >= this.loan.dueTick &&
      this.loan.principal > 0 &&
      tick - this.loan.lastPaymentTick > cfg.delinquencyGraceTicks
    ) {
      if (this.cargo) {
        here.markets[this.cargo.good].executeSell(this.cargo.qty);
        this.cargo = null;
      }
      this.credits = 0;
      this.equipment = { scoop: false, shredder: false };
      this.loan = null;
      this.active = false;
      return;
    }

    // Being docked here means seeing this market live; docking at a hub
    // additionally swaps news with the whole relay network. Identical
    // for NPC and player ships.
    this.board.record(here.id, takeSnapshot(here, tick));
    if (here.isHub) this.board.syncWith(hubNet.board);

    if (this.controller === "player") {
      const action = this.pendingAction ?? { type: "wait" as const };
      this.pendingAction = null;
      this.lastActionResult = this.executePlayerAction(tick, here, systems, cfg, hubNet, action);
      return;
    }

    this.plan(tick, here, systems, cfg, rng, hubNet);
  }

  /**
   * Execute one queued player action. Validation failures are reported
   * in the result (and surfaced in the next observation), never thrown —
   * an agent's bad move costs a tick, not a crash.
   */
  private executePlayerAction(
    tick: number,
    here: StarSystem,
    systems: StarSystem[],
    cfg: TraderConfig,
    hubNet: HubNetwork,
    action: PlayerAction,
  ): ActionResult {
    const fail = (detail: string): ActionResult => ({ tick, action, ok: false, detail });
    const ok = (detail: string): ActionResult => ({ tick, action, ok: true, detail });

    switch (action.type) {
      case "wait":
        return ok("waited");

      case "buy": {
        if (!Number.isFinite(action.qty) || action.qty < 1) return fail("qty must be >= 1");
        const qty = Math.floor(action.qty);
        if (this.cargo && this.cargo.good !== action.good) {
          return fail(`hold already carries ${this.cargo.good} (one commodity at a time)`);
        }
        const held = this.cargo?.qty ?? 0;
        if (held + qty > this.capacity) {
          return fail(`capacity ${this.capacity}, already holding ${held}`);
        }
        const market = here.markets[action.good];
        if (qty > market.inventory) {
          return fail(`market has only ${Math.floor(market.inventory)} ${action.good}`);
        }
        const cost = market.quoteBuy(qty);
        if (cost > this.credits) {
          return fail(`costs ${cost.toFixed(0)}, you have ${this.credits.toFixed(0)}`);
        }
        this.credits -= market.executeBuy(qty);
        this.cargo = this.cargo
          ? { good: action.good, qty: held + qty, costBasis: this.cargo.costBasis + cost }
          : { good: action.good, qty, costBasis: cost };
        return ok(`bought ${qty} ${action.good} for ${cost.toFixed(0)}`);
      }

      case "sell": {
        if (!this.cargo || this.cargo.good !== action.good) {
          return fail(`not holding ${action.good}`);
        }
        if (!Number.isFinite(action.qty) || action.qty < 1) return fail("qty must be >= 1");
        const qty = Math.min(Math.floor(action.qty), this.cargo.qty);
        const revenue = here.markets[action.good].executeSell(qty);
        const basisShare = this.cargo.costBasis * (qty / this.cargo.qty);
        this.credits += revenue;
        this.totalProfit += revenue - basisShare;
        this.cargo =
          qty === this.cargo.qty
            ? null
            : {
                good: this.cargo.good,
                qty: this.cargo.qty - qty,
                costBasis: this.cargo.costBasis - basisShare,
              };
        if (this.cargo === null) this.tripsCompleted += 1;
        return ok(`sold ${qty} ${action.good} for ${revenue.toFixed(0)}`);
      }

      case "travel": {
        const dest = systems.find((s) => s.id === action.destId);
        if (!dest) return fail(`no system ${action.destId}`);
        if (dest.id === here.id) return fail("already here");
        const dist = here.distanceTo(dest);
        const fuelUnits = dist * cfg.fuelPerDist;
        if (here.markets.fuel.inventory < fuelUnits) {
          return fail(
            `port has ${here.markets.fuel.inventory.toFixed(1)} fuel, trip needs ${fuelUnits.toFixed(1)} (harvest to refill it, if you have a scoop)`,
          );
        }
        this.depart(tick, here, dest, cfg);
        // Departing a hub with cargo files a public flight plan — players
        // are on the manifests like everyone else.
        if (here.isHub && this.cargo && this.travel) {
          hubNet.file({
            destId: dest.id,
            good: this.cargo.good,
            qty: this.cargo.qty,
            arrivalTick: this.travel.arrivalTick,
          });
        }
        return ok(`departed for ${dest.name}, arriving tick ${this.travel!.arrivalTick}`);
      }

      case "harvest": {
        if (!this.equipment.scoop && !this.equipment.shredder) {
          return fail("no scoop or shredder fitted");
        }
        const before = this.credits;
        this.harvest(here, cfg);
        return ok(`harvested for ${(this.credits - before).toFixed(1)}`);
      }

      case "buy_equipment": {
        if (this.equipment[action.equipment]) return fail(`${action.equipment} already fitted`);
        const quote = equipmentQuote(here, action.equipment);
        if (quote === null) return fail(`parts for ${action.equipment} not in stock here`);
        if (quote > this.credits) {
          return fail(`costs ~${quote.toFixed(0)}, you have ${this.credits.toFixed(0)} (borrow first?)`);
        }
        this.credits -= buyEquipment(here, action.equipment);
        this.equipment[action.equipment] = true;
        return ok(`fitted ${action.equipment}`);
      }

      case "borrow": {
        if (!Number.isFinite(action.amount) || action.amount <= 0) {
          return fail("amount must be > 0");
        }
        const maxDebt = this.shipValue(cfg) * cfg.loanToValue;
        const newPrincipal = (this.loan?.principal ?? 0) + action.amount;
        if (newPrincipal > maxDebt) {
          return fail(
            `total debt would be ${newPrincipal.toFixed(0)}, collateral supports ${maxDebt.toFixed(0)}`,
          );
        }
        this.topUp(action.amount, tick, here, cfg);
        return ok(
          `borrowed ${action.amount.toFixed(0)} against the ship (term resets; due tick ${this.loan!.dueTick})`,
        );
      }

      case "repay": {
        if (!this.loan) return fail("no outstanding loan");
        if (!Number.isFinite(action.amount) || action.amount <= 0) {
          return fail("amount must be > 0");
        }
        const payment = Math.min(action.amount, this.loan.principal, this.credits);
        if (payment <= 0) return fail("no credits to pay with");
        this.credits -= payment;
        this.loan.principal -= payment;
        this.loan.lastPaymentTick = tick;
        this.totalRepaid += payment;
        const cleared = this.loan.principal <= 0.01;
        if (cleared) this.loan = null;
        return ok(cleared ? `paid ${payment.toFixed(0)}; loan cleared` : `paid ${payment.toFixed(0)}`);
      }
    }
  }

  private arrive(systems: StarSystem[]): void {
    if (!this.travel) return;
    this.locationId = this.travel.destId;
    this.travel = null;
    // Player ships decide for themselves when (and how much) to sell.
    if (this.controller === "player") return;
    if (this.cargo) {
      const market = this.systemById(systems, this.locationId).markets[this.cargo.good];
      const revenue = market.executeSell(this.cargo.qty);
      this.credits += revenue;
      this.totalProfit += revenue - this.cargo.costBasis;
      this.tripsCompleted += 1;
      this.cargo = null;
    }
  }

  private plan(
    tick: number,
    here: StarSystem,
    systems: StarSystem[],
    cfg: TraderConfig,
    rng: Rng,
    hubNet: HubNetwork,
  ): void {
    // Paying the loan down comes before everything else: interest ticks,
    // and a cleared loan frees the collateral for the next opportunity.
    this.repay(tick, cfg);

    // Deadline pressure: with the term running out, a geared debtor
    // parks and works the local system until the loan is cleared. Slow
    // and certain beats fast and risky when default costs the ship.
    if (
      this.loan &&
      this.loan.dueTick - tick <= cfg.emergencyGrindTicks &&
      (this.equipment.scoop || this.equipment.shredder)
    ) {
      this.harvest(here, cfg);
      // A grinding ship isn't going anywhere: it doesn't need trip
      // capital, so nearly every credit goes straight to the bank.
      this.repay(tick, cfg, cfg.borrowCushion);
      return;
    }

    // Opportunity cost of leaving: what the ship's own gear earns per
    // tick by staying put and harvesting. Any trade must beat this —
    // otherwise small-stake "dust" trades whose trip costs eat the cargo
    // profit slowly bleed a poor trader to death (the pre-loan-era
    // bleed-out, rediscovered at the bottom of the wealth ladder).
    const harvestBaseline = this.harvestValuePerTick(here, cfg);

    // Best trade on cash...
    let best = this.bestRouteFrom(here, here, 0, this.credits, systems, cfg, hubNet);
    if (best && best.score <= harvestBaseline) best = null;

    // ...and, if the bank would lend, the best leveraged trade. Borrowing
    // is only worth it if the bigger trade still clears the margin after
    // the estimated interest on the borrowed amount.
    const headroom = this.borrowCapacity(cfg);
    let borrowAmount = 0;
    if (headroom > 0) {
      const lev = this.bestRouteFrom(
        here,
        here,
        0,
        this.credits + headroom,
        systems,
        cfg,
        hubNet,
      );
      if (lev && lev.score > harvestBaseline && (!best || lev.score > best.score)) {
        const needed = lev.cost + lev.tripCost + cfg.borrowCushion - this.credits;
        if (needed <= 0) {
          best = lev;
        } else {
          const interestEst = needed * cfg.loanRatePerTick * (lev.travelTicks + 15);
          const requiredMargin = lev.cost * cfg.minMarginFrac * cfg.leveragedMarginMult;
          if (lev.profit - interestEst >= requiredMargin) {
            best = lev;
            borrowAmount = Math.min(needed, headroom);
          }
        }
      }
    }

    if (best) {
      if (borrowAmount > 0) this.borrow(borrowAmount, tick, here, cfg);
      const market = here.markets[best.good];
      const cost = market.executeBuy(best.qty);
      this.credits -= cost;
      this.cargo = { good: best.good, qty: best.qty, costBasis: cost };
      this.depart(tick, here, best.dest, cfg);
      // Departing a hub with cargo files a public flight plan.
      if (here.isHub && this.travel) {
        hubNet.file({
          destId: best.dest.id,
          good: best.good,
          qty: best.qty,
          arrivalTick: this.travel.arrivalTick,
        });
      }
      this.idleTicks = 0;
      return;
    }

    // No trade worth making. Outfit for local work instead: a scoop pays
    // for itself wherever fuel sells, and the station bank will lend
    // against the ship to a trader too broke to buy one outright — the
    // intended way back up from rock bottom.
    if (this.maybeBuyEquipment(tick, here, cfg)) return;

    // Look for a two-leg plan: fly empty to a system the board says has
    // cheap surplus, buy there, deliver onward. This is how remote gluts
    // get tapped instead of rotting behind storage caps.
    const fuelMarket = here.markets.fuel;
    const canFuel = (s: StarSystem) =>
      fuelMarket.inventory >= here.distanceTo(s) * cfg.fuelPerDist;
    const repositionCandidates = systems
      .filter((s) => s.id !== here.id && !s.isHub)
      .sort((a, b) => here.distanceTo(a) - here.distanceTo(b))
      .slice(0, cfg.repositionScanLimit)
      .concat(systems.filter((s) => s.isHub && s.id !== here.id));
    let reposition: { origin: StarSystem; score: number } | null = null;
    for (const origin of repositionCandidates) {
      if (!canFuel(origin)) continue;
      const firstLeg = Math.max(1, Math.ceil(here.distanceTo(origin) / cfg.speed));
      const plan = this.bestRouteFrom(here, origin, firstLeg, this.credits, systems, cfg, hubNet);
      if (
        plan &&
        plan.score > harvestBaseline &&
        (!reposition || plan.score > reposition.score)
      ) {
        reposition = { origin, score: plan.score };
      }
    }
    if (reposition) {
      this.depart(tick, here, reposition.origin, cfg);
      this.idleTicks = 0;
      return;
    }

    // Not even a repositioning plan (as far as this ship knows): after a
    // while, drift — preferring a hub, where the latest news is — so stuck
    // traders refresh stale boards instead of idling forever.
    // EXCEPT while indebted with working gear: relocation costs roughly
    // what harvesting earns, so a debtor that keeps drifting can never
    // clear its loan (and loses the ship). In debt, stay put and grind.
    const canWorkLocally = this.equipment.scoop || this.equipment.shredder;
    this.idleTicks += 1;
    if (
      this.idleTicks >= cfg.idleRelocateAfter &&
      systems.length > 1 &&
      !(this.loan && canWorkLocally)
    ) {
      const hubs = systems.filter((s) => s.isHub && s.id !== here.id && canFuel(s));
      const reachable = systems.filter((s) => s.id !== here.id && canFuel(s));
      let dest: StarSystem | null = null;
      if (hubs.length > 0 && rng.next() < cfg.hubRelocateBias) {
        dest = rng.pick(hubs);
      } else if (reachable.length > 0) {
        dest = rng.pick(reachable);
      }
      if (dest) {
        this.depart(tick, here, dest, cfg);
        this.idleTicks = 0;
        return;
      }
      // No fuel in port for any journey: stranded — fall through to the
      // scoop, which refills this very market until escape is possible.
    }

    this.harvest(here, cfg);
  }

  /** Take a station-bank loan against the ship. */
  private borrow(amount: number, tick: number, here: StarSystem, cfg: TraderConfig): void {
    this.credits += amount;
    this.loan = {
      principal: amount,
      lenderSystemId: here.id,
      dueTick: tick + cfg.loanTermTicks,
      lastPaymentTick: tick,
    };
    this.loansTaken += 1;
    this.totalBorrowed += amount;
  }

  /**
   * Refinance: extend an existing loan to buy income-producing gear. The
   * bank only does this because the gear adds collateral AND creates the
   * income that services the debt — it's the escape hatch from the one
   * otherwise-doomed state (in debt, no cash, no gear, no income).
   */
  private topUp(amount: number, tick: number, here: StarSystem, cfg: TraderConfig): void {
    if (!this.loan) {
      this.borrow(amount, tick, here, cfg);
      return;
    }
    this.credits += amount;
    this.loan.principal += amount;
    this.loan.dueTick = tick + cfg.loanTermTicks; // refinanced: term restarts
    this.loan.lenderSystemId = here.id;
    this.totalBorrowed += amount;
  }

  /** Pay the loan down with everything above the operating buffer. */
  private repay(tick: number, cfg: TraderConfig, buffer = cfg.repayBuffer): void {
    if (!this.loan) return;
    const payment = Math.min(this.loan.principal, this.credits - buffer);
    if (payment <= 0) return;
    this.credits -= payment;
    this.loan.principal -= payment;
    this.loan.lastPaymentTick = tick;
    this.totalRepaid += payment;
    if (this.loan.principal <= 0.01) this.loan = null;
  }

  /**
   * Outfit at the station when idle: a scoop first (borrowing against the
   * ship if needed — gear bought on credit and worked off locally is the
   * recovery path for a broke trader), then a shredder once wealthy.
   */
  private maybeBuyEquipment(tick: number, here: StarSystem, cfg: TraderConfig): boolean {
    if (!this.equipment.scoop) {
      const quote = equipmentQuote(here, "scoop");
      if (quote !== null) {
        const shortfall = quote + cfg.borrowCushion - this.credits;
        if (shortfall <= 0) {
          this.credits -= buyEquipment(here, "scoop");
          this.equipment.scoop = true;
          return true;
        }
        // Borrow for it — including topping up an existing loan, as long
        // as total debt stays within the collateral value of the ship
        // WITH the scoop fitted (the gear is part of what's pledged).
        const maxDebt =
          (this.shipValue(cfg) + EQUIPMENT.scoop.collateralValue) * cfg.loanToValue;
        if ((this.loan?.principal ?? 0) + shortfall <= maxDebt) {
          this.topUp(shortfall, tick, here, cfg);
          this.credits -= buyEquipment(here, "scoop");
          this.equipment.scoop = true;
          return true;
        }
      }
      return false;
    }
    if (!this.equipment.shredder) {
      const quote = equipmentQuote(here, "shredder");
      if (quote !== null && this.credits > quote * cfg.shredderWealthMult) {
        this.credits -= buyEquipment(here, "shredder");
        this.equipment.shredder = true;
        return true;
      }
    }
    return false;
  }

  /**
   * Best (good, destination) trade starting at `origin` within `budget`,
   * scored as profit per tick including `leadTicks` spent getting to the
   * origin first. When `origin` is not the ship's current system, origin
   * state comes from the InfoBoard — the plan is a bet on remembered
   * prices.
   */
  private bestRouteFrom(
    here: StarSystem,
    origin: StarSystem,
    leadTicks: number,
    budget: number,
    systems: StarSystem[],
    cfg: TraderConfig,
    hubNet: HubNetwork,
  ): Route | null {
    const isLive = origin.id === here.id;
    const originSnap = this.board.get(origin.id);
    if (!isLive && !originSnap) return null;
    const originInv = (good: GoodId): number =>
      isLive ? origin.markets[good].inventory : originSnap!.inventories[good];

    let best: Route | null = null;

    for (const good of GOOD_IDS) {
      const market = origin.markets[good];
      const inv = originInv(good);
      const available = Math.floor(inv - market.targetStock * cfg.originReserveFrac);
      if (available < 1) continue;
      const priceNow = market.priceAt(inv);
      const maxLoad = Math.min(this.capacity, available, Math.floor(budget / priceNow));
      if (maxLoad < 1) continue;

      for (const dest of systems) {
        if (dest.id === origin.id) continue;
        const dist = origin.distanceTo(dest);

        // Travel burns fuel, bought at the origin at departure. No fuel
        // in port, no trip (harvesting can refill a port — see plan()).
        const fuelUnits = dist * cfg.fuelPerDist;
        const fuelInv = originInv("fuel");
        const fuelAvailable = good === "fuel" ? fuelInv - fuelUnits : fuelInv;
        if (fuelAvailable < fuelUnits) continue;
        const fuelCost = origin.markets.fuel.priceAt(fuelInv - fuelUnits / 2) * fuelUnits;

        // Destination state is known only as of the last report — the
        // trade is a bet that the shortage still exists on arrival.
        const snap = this.board.get(dest.id);
        if (!snap) continue;
        const destMarket = dest.markets[good]; // static structure only (targetStock, price curve)
        // At a hub, the manifests show cargo already in flight to this
        // destination — count it as if it had landed, so hub-synced
        // traders don't all chase the same shortage.
        const pending = here.isHub ? hubNet.pendingFor(dest.id, good) : 0;
        const knownInv = snap.inventories[good] + pending;

        // Ship only what the destination can absorb above its target —
        // dumping a full hold into a tiny market would crash its price
        // (and the midpoint estimate prices that in, making it unprofitable).
        const absorbable = Math.floor(destMarket.targetStock * 1.2 - knownInv);
        const qty = Math.min(good === "fuel" ? maxLoad - Math.ceil(fuelUnits) : maxLoad, absorbable);
        if (qty < 1) continue;

        const cost = market.priceAt(inv - qty / 2) * qty;
        if (cost > budget) continue;
        const travelTicks = Math.max(1, Math.ceil(dist / cfg.speed));
        const revenue = destMarket.priceAt(knownInv + qty / 2) * qty;
        const tripCost = dist * cfg.costPerDist + fuelCost;
        const profit = revenue - cost - tripCost;
        if (profit < cost * cfg.minMarginFrac) continue;
        const score = profit / (leadTicks + travelTicks);
        if (!best || score > best.score) {
          best = { good, qty, dest, score, cost, tripCost, travelTicks, profit };
        }
      }
    }
    return best;
  }

  /** Credits per tick the ship's gear would earn harvesting here now. */
  private harvestValuePerTick(here: StarSystem, cfg: TraderConfig): number {
    let value = 0;
    if (this.equipment.scoop) {
      value = Math.max(value, here.markets.fuel.price * cfg.harvestRate);
    }
    if (this.equipment.shredder) {
      value = Math.max(value, here.markets.ore.price * cfg.oreHarvestRate);
    }
    return value;
  }

  /**
   * Work the local system with fitted gear: skim the star for fuel
   * (scoop) or grind asteroids into ore (shredder), selling into the
   * local market. Slow, capital-free income — the floor for a trader
   * down on its luck, and the bootstrap that restocks a starved port.
   */
  private harvest(here: StarSystem, cfg: TraderConfig): void {
    const options: { good: GoodId; rate: number }[] = [];
    if (this.equipment.scoop) options.push({ good: "fuel", rate: cfg.harvestRate });
    if (this.equipment.shredder) options.push({ good: "ore", rate: cfg.oreHarvestRate });
    let pick: { good: GoodId; rate: number } | null = null;
    let pickValue = 0;
    for (const opt of options) {
      const value = here.markets[opt.good].price * opt.rate;
      if (value > pickValue) {
        pick = opt;
        pickValue = value;
      }
    }
    if (!pick) return; // no gear fitted: truly idle
    this.credits += here.markets[pick.good].executeSell(pick.rate);
    this.totalHarvested += pick.rate;
  }

  private depart(tick: number, from: StarSystem, to: StarSystem, cfg: TraderConfig): void {
    const dist = from.distanceTo(to);
    // Wear is deducted unchecked: a broke trader may run a small overdraft
    // to reposition rather than be stranded forever in a dead market.
    // viability.test.ts bounds how deep this can ever go.
    this.credits -= dist * cfg.costPerDist;
    // Fuel is physical: bought from the origin market (callers have
    // checked availability). Burning it is the fleet's demand on the
    // fuel economy.
    const fuelUnits = dist * cfg.fuelPerDist;
    this.credits -= from.markets.fuel.executeBuy(fuelUnits);
    this.travel = {
      destId: to.id,
      arrivalTick: tick + Math.max(1, Math.ceil(dist / cfg.speed)),
    };
  }

  private systemById(systems: StarSystem[], id: number): StarSystem {
    const sys = systems.find((s) => s.id === id);
    if (!sys) throw new Error(`unknown system ${id}`);
    return sys;
  }
}
