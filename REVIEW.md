# Project Review & Rebuild Notes

## What this project was trying to do

An autonomous, self-sustaining galactic trading economy: AI traders move
production to where it's needed; shortages create price gaps; traders chase
the profit and close the gap. The system should absorb disasters, pirates,
and human players and re-balance on its own.

## Why the first attempt failed

The git history tells the story: feature commits → "reset to simple economy
sim" → more features → "bookmarked before complete rewrite" → "project wipe".
Four root causes, in order of importance:

### 1. The core loop was never proven before complexity was added

The self-balancing feedback loop (shortage → price ↑ → traders deliver →
price ↓) is the entire premise. It was never isolated, tested, and proven at
small scale. Instead, instability was treated as a missing-feature problem,
so features kept being added: contracts, treasuries, info decay, NPC
learning, world evolution, tech progression, factions, black markets.
ECONOMY_BIBLE.md grew to 1,668 lines; PROGRESS.md held ~120 tasks, every
one of them "not started" at the time of the wipe.

### 2. Hidden stabilizers masked the broken loop

`applySpaceElevator()` (in the pre-wipe `src/star-system.ts`) silently
injected and removed inventory every tick to keep markets alive. With magic
correction running, you cannot tell whether the economy balances itself —
which was the one question the project needed answered. The spec itself
eventually flagged it for removal (§1 of ECONOMY_BIBLE.md), but by then the
design had been tuned *around* it.

### 3. Circular production dependencies could deadlock permanently

In the old chain, food required fertilizer + machinery; machinery required
alloys + electronics; electronics required alloys + machinery; fertilizer
required food. There were no primary goods. Once any link starved, the whole
chain locked up with no way to restart — hence the "bootstrap production"
hacks in the spec (§3.1), which are another form of magic.

### 4. Galaxy generation wasn't needs-consistent

Random populations meant a role (e.g. industrial) could be generated too
small to supply the galaxy, creating a permanent structural deficit no
trader behavior could ever fix. The spec recognized this (§10's sizing pass)
but it was never built.

## The rebuild (this version)

A deliberately minimal core (~700 lines + tests) that proves the loop first.
Everything else is future work.

| Decision | Why |
|---|---|
| 6 goods, DAG production chain with input-free roots (food, ore) | Primary production always restarts after any collapse — deadlock is structurally impossible (enforced by `balance.test.ts`) |
| Price is a pure function of inventory vs target | Immediate feedback, no smoothing lag, trivially testable; every trade moves the price |
| Midpoint (price-impact) execution pricing | Large trades pay the price impact they cause; dumping a full hold into a tiny market is unprofitable, so traders self-limit |
| Traders size loads to the destination's deficit | Found during rebuild: full-capacity loads made small-but-critical markets (fuel, machinery) permanently unservable |
| Role populations normalized at generation | Galaxy is needs-consistent by construction; aggregate surplus per good is a unit test, not a prayer |
| No treasuries, contracts, info decay, learning, factions | None of them are needed to prove the loop; each is a separately testable extension later |
| Zero hidden stabilizers | Only production, consumption, and ship trades change inventory. Disasters are absorbed by stock buffers, price signals, and traders — verifiably (see `self-balance.test.ts`) |

### What the tests now prove

- **Traders ARE the balancing mechanism**: with 0 traders the galaxy starves
  (6+ food stockouts); with traders, zero.
- **Cold start → equilibrium**: all goods settle near base price, no stockouts.
- **Disaster recovery**: crop blight + granary raid → price spikes →
  imports flow in during the shock → price and stocks recover after.
- **Pirate raid**: 90% of a market's inventory destroyed → absorbed, recovers.
- **Demand spike (war)**: 6× fuel demand → imports rise → unwinds cleanly.
- **Determinism**: same seed + same events = bit-identical run, including
  through shocks and raids.

### What was removed

- Broken container scaffolding (`Containerfile`, compose files,
  `container-run.sh`, `pod-space-trader.service`) — they targeted the
  deleted HTTP server. Recoverable from git history when a server returns.
- `ECONOMY_BIBLE.md` is kept as a design reference (many of its ideas are
  good extensions) but is no longer "the canonical spec to implement in
  full". The roadmap in PROGRESS.md is intentionally smaller.

## Recommended path from here

Grow only in directions that keep the proven loop testable, one feature at
a time, each with a scenario test before merging:

1. **Players**: a player is just a ship with a UI — the market API
   (`quoteBuy`/`executeBuy`/...) already treats all ships identically.
2. **Imperfect information**: traders currently have galaxy-wide price
   visibility. Per-ship observed prices with staleness is the single most
   interesting realism upgrade, and the metrics will show its cost.
3. **Persistent pirates** as agents (not just events), so security becomes
   an emergent price factor on routes.
4. **Treasuries/credit conservation** if trader wealth inflation (currently
   unbounded, ~2.2×/300 ticks) needs sinks.
5. **Server + UI** once the headless sim is worth watching.
