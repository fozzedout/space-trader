# Space Trader

A deterministic, self-balancing galactic trade economy simulation.

Star systems produce and consume goods according to their role (agricultural,
mining, industrial, high-tech). Prices are a pure function of local inventory
versus target stock. Profit-seeking NPC traders buy where goods are cheap
(surplus) and sell where they're dear (shortage). The aggregate effect is a
distribution network that **balances itself** — through disasters, pirate
raids, and demand shocks — with no central coordinator and no hidden
stabilizers.

> This is a rebuilt core. The previous attempt failed and was wiped; see
> [REVIEW.md](REVIEW.md) for the post-mortem and the design decisions that
> came out of it.

## Quickstart

```bash
npm install
npm test        # type-check + 33 tests, incl. disaster-recovery & trader viability
npm run sim     # headless demo: warmup → blight + pirate raid → recovery
```

The demo output shows average price (as a multiple of base price) and
stockout counts per good. Watch the food price spike when the blight hits,
imports flow in, and the system recover.

## How the self-balancing works

1. Each system's market prices each good from its inventory:
   `price = basePrice * (1 + elasticity * (1 - inventory/target))`, clamped.
   Shortage → expensive. Surplus → cheap. No smoothing, no lag.
2. Trades execute at the **midpoint** inventory price, so large trades pay
   the price impact they cause. Traders can't profitably drain or flood a
   market.
3. Traders scan goods × destinations, size the load to what the destination
   can absorb, and take the best profit-per-tick route above a minimum
   margin. Buying raises the origin price; delivering lowers the
   destination price — each trade closes part of the gap it exploited.
4. Production chains are a DAG whose roots (food, ore) need no inputs, so
   production always restarts after any collapse — the economy cannot
   deadlock.

Disasters are just state changes (production shocks, inventory destruction).
The same mechanics that distribute everyday surplus absorb them: the shock
creates a price gap, the gap attracts traders, the deliveries close it.

## Fuel and the scoop

Travel burns fuel, bought from the origin market at every departure — the
fleet is real demand on the fuel economy, and busy ports run lean. Fuel is
a **primary good skimmed from stars** (every system harvests some,
industrial worlds at scale), so like food and ore it can never deadlock the
chain. Ships carry a scoop: when no trade is worth making — or a port has
no fuel to sell — a ship skims the local star and sells into the local
market. Harvesting is slow, capital-free income: the floor for a trader
down on its luck, and the bootstrap that refuels a blockaded port from
inside (`fuel.test.ts` proves both). Traders also make two-leg plans
("fly empty to where the board says goods are cheap, buy, deliver"), which
is how remote gluts get tapped instead of rotting behind storage caps.

## Information model (nobody is omniscient)

Ships don't see live remote markets. Each ship has an **InfoBoard**: a
snapshot of every market as of the last time it (or the network) saw it.
News physically travels:

- Docking at a system shows that market live.
- A subset of systems are **trade hubs**, connected by an instant relay.
  Docking at any hub uploads everything the ship has observed and downloads
  everything the network has heard — so news of a shortage spreads ship →
  hub → whole network → every ship that next checks in at a hub.
- Ships departing a hub with cargo file a **shipping manifest**; planners
  at hubs see what's already in flight and discount the opportunity. This
  is what stops hub-synced traders all chasing the same shortage (shared
  stale news otherwise causes herding — see `info.ts`).
- Idle traders drift toward hubs to hear the news.

A far-away trader learns of a demand hotspot only when the news reaches it,
and trades are bets that the shortage still exists on arrival — selling is
committed, so stale information costs real money. The metric
`avgInfoAgeTicks` tracks how stale the fleet's knowledge is.

**Information symmetry:** any ship — NPC or future player — uses exactly
the same InfoBoard and hub mechanics. Players will never be more (or less)
informed than the market access they physically have.

## Why traders survive bad luck (no bleed-out)

Trading here is genuinely risky — measured over long runs, **~30% of trips
lose money** (stale news means the shortage is sometimes gone on arrival),
losing streaks of 5 trips happen, and most traders at some point lose
30–60% of their net worth from its peak. Yet no trader ever goes bankrupt
(`viability.test.ts` enforces this), because losses are structurally
prevented from compounding:

1. **Losses are capped at the stake, and the stake is capped by current
   wealth.** No debt, no leverage: a trade can only lose what was paid for
   the cargo, and a poorer trader automatically places smaller bets. With
   positive expected value per trip, battered traders shrink, then recover.
2. **No fixed burn rate.** An idle ship costs nothing, so a trader that
   just took a beating can wait for a fat margin instead of being forced
   into marginal trades by ticking upkeep.
3. **No forced-liquidation haircut.** The only "forced" sale is selling
   your cargo at the destination you chose, at normal market prices.
4. **No speculative buying.** A trader only buys cargo against a route it
   believes profitable at departure; there is no inventory held in hope of
   a future buyer.

The first attempt's constant trader bleed-out (which then demanded
replenishment spawns, which broke credit conservation, which demanded
treasuries...) came from violating 2 and 3: always-on operating costs plus
a forced-liquidation discount turned ordinary bad luck into death spirals.
If trader turnover is ever *wanted* for game texture, reintroduce upkeep
deliberately — it is the bankruptcy dial — together with endogenous entry,
and let `viability.test.ts` bound the churn rate.

## Project layout

| File | Purpose |
|---|---|
| `src/goods.ts` | Goods catalog, production chain (DAG), role production/consumption rates |
| `src/market.ts` | Per-system per-good market: pure price function, midpoint trade execution |
| `src/system.ts` | Star system tick: input-limited production, consumption, storage caps, shocks |
| `src/info.ts` | Information model: per-ship InfoBoards, hub relay network, shipping manifests |
| `src/trader.ts` | NPC trader: route evaluation on observed (not live) prices, load sizing, travel |
| `src/galaxy.ts` | Deterministic, needs-consistent galaxy generation |
| `src/sim.ts` | Orchestrator: tick order, external events (shocks, raids), metrics, state hash |
| `src/cli.ts` | Headless demo scenario |
| `src/*.test.ts` | `self-balance.test.ts` proves the premise; `viability.test.ts` proves traders stay in business |

## Invariants (do not break these)

- **No magic**: only production, consumption, and ship trades change
  inventory. Never add code that injects/corrects stock or credits.
- **Determinism**: same seed + same external events = bit-identical run
  (`stateHash()`); all randomness goes through the seeded `Rng`.
- **Restartability**: the production chain stays a DAG with input-free
  roots (`balance.test.ts` enforces this).
- **Needs-consistency**: generated galaxies must run an aggregate surplus
  on every good (`balance.test.ts` enforces this too).
- **Information symmetry**: no ship reads live remote market state; all
  knowledge flows through InfoBoards and the hub network, identically for
  NPCs and players.

Every new feature should come with a scenario test showing the economy still
balances with it enabled.

## Roadmap

See [PROGRESS.md](PROGRESS.md). [ECONOMY_BIBLE.md](ECONOMY_BIBLE.md) is the
old full-scope design document — kept as an idea reference, not as a spec to
implement wholesale.
