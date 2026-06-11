# Space Trader - Progress

The core simulation was rebuilt from scratch after the project wipe — see
`REVIEW.md` for why, and `README.md` for the architecture and invariants.

**Status tracking:** set `Status` to `not started`, `in progress`, or `done`.
One task = one clear outcome with a scenario test. If a task grows, split it
here before starting.

---

## Core (rebuilt)

| Task | Status | Files |
|------|--------|-------|
| Goods catalog as DAG with input-free roots | done | `src/goods.ts` |
| Pure inventory-based price formation with midpoint execution | done | `src/market.ts` |
| Input-limited production, consumption, storage caps | done | `src/system.ts` |
| Production/consumption shocks with expiry | done | `src/system.ts`, `src/sim.ts` |
| Pirate raids (inventory destruction) | done | `src/sim.ts` |
| Profit-seeking traders with deficit-sized loads | done | `src/trader.ts` |
| Needs-consistent galaxy generation (normalized role populations) | done | `src/galaxy.ts` |
| Deterministic simulation + state hash | done | `src/sim.ts`, `src/rng.ts` |
| Metrics (price ratios, stockouts, trader wealth) | done | `src/sim.ts` |
| Scenario tests: equilibrium, blight, raid, war demand, no-traders control | done | `src/self-balance.test.ts` |
| Balance invariant tests (DAG, value chain, aggregate surplus) | done | `src/balance.test.ts` |
| Headless demo CLI | done | `src/cli.ts` |
| Imperfect information: per-ship InfoBoards, hub relay network, shipping manifests | done | `src/info.ts`, `src/trader.ts` |

## Next (one at a time, each with a scenario test)

| Task | Status | Notes |
|------|--------|-------|
| Player ships: join the sim as a ship using the same market and InfoBoard APIs | not started | Players move prices and learn news exactly like NPCs |
| Staleness-discounted route scoring (confidence decay on old observations) | not started | Traders currently trust old snapshots at face value |
| Persistent pirate agents preying on routes | not started | Security as an emergent price factor; test recovery still holds |
| Credit conservation: system treasuries as counterparties | not started | Only if trader wealth inflation becomes a problem |
| Larger-scale run (48+ systems, 500+ traders) perf check | not started | Keep tick cost roughly linear |
| HTTP server + live market viewer | not started | Only once the headless sim is worth watching |

## Rules of growth

- Never add hidden stabilizers (no inventory/credit injection).
- Keep determinism: all randomness through seeded `Rng`.
- A feature lands only with a test showing the economy still self-balances.
