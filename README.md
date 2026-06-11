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
npm test        # type-check + 22 tests, incl. disaster-recovery scenarios
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

## Project layout

| File | Purpose |
|---|---|
| `src/goods.ts` | Goods catalog, production chain (DAG), role production/consumption rates |
| `src/market.ts` | Per-system per-good market: pure price function, midpoint trade execution |
| `src/system.ts` | Star system tick: input-limited production, consumption, storage caps, shocks |
| `src/trader.ts` | NPC trader: route evaluation, load sizing, travel |
| `src/galaxy.ts` | Deterministic, needs-consistent galaxy generation |
| `src/sim.ts` | Orchestrator: tick order, external events (shocks, raids), metrics, state hash |
| `src/cli.ts` | Headless demo scenario |
| `src/*.test.ts` | Including `self-balance.test.ts` — the scenario tests that prove the premise |

## Invariants (do not break these)

- **No magic**: only production, consumption, and ship trades change
  inventory. Never add code that injects/corrects stock or credits.
- **Determinism**: same seed + same external events = bit-identical run
  (`stateHash()`); all randomness goes through the seeded `Rng`.
- **Restartability**: the production chain stays a DAG with input-free
  roots (`balance.test.ts` enforces this).
- **Needs-consistency**: generated galaxies must run an aggregate surplus
  on every good (`balance.test.ts` enforces this too).

Every new feature should come with a scenario test showing the economy still
balances with it enabled.

## Roadmap

See [PROGRESS.md](PROGRESS.md). [ECONOMY_BIBLE.md](ECONOMY_BIBLE.md) is the
old full-scope design document — kept as an idea reference, not as a spec to
implement wholesale.
