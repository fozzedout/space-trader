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
npm test        # type-check + 47 tests, incl. disaster-recovery & trader viability
npm run sim     # headless demo: warmup → blight + pirate raid → recovery
npm run play    # LLM captains: LM Studio (local GPU) if LMSTUDIO_BASE_URL
                # is set, Claude if ANTHROPIC_API_KEY, else a heuristic
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

## Equipment and the station bank

Ships start bare and outfit themselves at stations. Gear is assembled from
**real parts bought out of the local market** (machinery + electronics), so
outfitting is demand on the goods economy and gear is cheap where machinery
is glutted. The scoop enables fuel skimming; the asteroid shredder grinds
local rock into ore — both are capital-free local work.

Station banks lend **against the ship as collateral** (loan-to-value cap).
Two intended uses, both exercised by NPCs and available to players:

- **Outfitting from rock bottom**: a broke trader borrows to buy a scoop
  and works the loan off locally. Banks will even refinance an existing
  loan to fund gear, because the gear adds collateral and creates the very
  income that services the debt.
- **Leverage on good trades**: when a trade is bigger than cash on hand,
  borrow the difference — but borrowed trades must clear **double** the
  usual margin (thin leveraged bets are a treadmill that never builds
  equity), and interest accrues per tick, in transit or not.

Debt is the economy's one deliberately *time-based* cost: it pressures
borrowers to work without taxing the debt-free. Debtor discipline is built
in: repayment comes before new plans, trades must beat the ship's own
harvesting income (no dust trades), debtors with working gear don't drift,
and when the term runs short they park and grind until clear. Default is
real — the bank liquidates cargo, strips gear, and seizes the ship
(`loans.test.ts`); the viability suite requires zero seizures in ordinary
play, including the disaster marathon.

## Driving a ship: players and LLM agents

A player ship is an ordinary ship (`sim.addPlayer()`): same markets, same
hub-relayed news, same bank, same foreclosure — but its decisions come
from queued actions instead of the NPC planner. The loop is:

```ts
const sim = new Simulation(42);
const id = sim.addPlayer({ credits: 5000, capacity: 100 });
sim.run(300);                         // let the economy warm up
const obs = sim.observe(id);          // JSON: only what the ship may know
sim.act(id, { type: "buy", good: "food", qty: 30 });
sim.step();                           // action executes on the ship's tick
sim.observe(id).lastActionResult;     // ok/failed + reason
```

Actions: `buy`, `sell`, `travel`, `harvest`, `buy_equipment`, `borrow`,
`repay`, `wait` — one per tick, single-commodity hold, no actions in
transit. Invalid actions fail with a reason (never throw); a bad move
costs the tick, which is exactly the cost a human player would pay.

The observation enforces **information symmetry**: the local market live,
remote systems as dated hub-news snapshots (`newsAgeTicks`), shipping
manifests only while docked at a hub. `player.test.ts` proves the
observation carries enough signal to trade profitably, and that a
delinquent player loses their ship like anyone else.

### LLM captains and the voyage chronicle

`src/llm-driver.ts` (`npm run play`) runs LLM-driven captains for long
periods and journals everything they think and do — the journals are the
story. Built for **local models via LM Studio** (free tokens, weeks-long
runs):

```bash
LMSTUDIO_BASE_URL=http://localhost:1234/v1 \
CAPTAINS="Mara Voss:qwen2.5-14b-instruct,Jax Teller:llama-3.1-8b" \
TICKS=0 EVENTS=1 npm run play
```

- One ship per captain, each with its own model and persona; the model
  writes an in-character captain's log line with every action, and
  reasoning models' `<think>` text is captured into the journal too.
- Journals land in `logs/<captain>-<seed>-<stamp>.jsonl` (tick, thinking,
  log, action, result, net worth) — raw material for the chronicle.
- Each decision includes the captain's last 8 log entries, so the story
  (and strategy) carries memory between turns.
- `EVENTS=1` rolls deterministic disasters (blights, mine collapses, fuel
  blockades, war demand) every few hundred ticks into a world log —
  weather for the narrative; captains only learn of it through markets
  and hub news, like everyone else.
- `TICKS=0` runs until Ctrl+C. Inference latency paces the game: captains
  think, the world waits. Bad model output never crashes the run — it
  becomes a waited tick with a "(lost in thought)" log line.
- Claude is still available as a decider (`ANTHROPIC_API_KEY`, `MODEL`,
  `EFFORT`) for shorter runs or guest-star captains, and the offline
  heuristic remains the baseline.

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
   wealth.** A trade can only lose what was paid for the cargo, and a
   poorer trader automatically places smaller bets. With positive expected
   value per trip, battered traders shrink, then recover. (Bank leverage
   is the deliberate, bounded exception — collateral-capped, and borrowed
   trades must clear double margin; see the station bank section.)
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
| `src/equipment.ts` | Ship gear (scoop, shredder) assembled from real parts at stations |
| `src/trader.ts` | NPC trader: route evaluation on observed (not live) prices, loans, harvesting, travel |
| `src/galaxy.ts` | Deterministic, needs-consistent galaxy generation |
| `src/player.ts` | Player/agent API: observations (information-symmetric) and actions |
| `src/llm-driver.ts` | Claude (or heuristic) playing a ship through the player API |
| `src/sim.ts` | Orchestrator: tick order, external events (shocks, raids), metrics, state hash, player glue |
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
