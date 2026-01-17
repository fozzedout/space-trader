# Economy Test Recovery Tasks

## Findings (root causes)
1) `/api/ship/:id` GET returns a tick response instead of ship state, so ship data is always missing or defaulted.
2) `/api/system/:id?action=snapshot` serializes `markets` as `{}` because `Map` is not converted before JSON output.
3) The economy data collector samples immediately after `/api/galaxy/tick`, but ticks are queued async and `StarSystem.tick()` no-ops unless the tick interval has elapsed, so most samples show no change.
4) Tick interval mismatch (server 29s vs system 30s) further reduces observable market changes in short test runs.

## Tasks (ordered, with acceptance criteria)

- [x] Task 1: Fix ship GET to return ship state (no implicit tick).
  - Files: `src/local-server.ts`
  - Steps:
    1) In the `/api/ship/:id` handler, make `GET` return `ship.getState()` by default.
    2) Only allow ticking via explicit `POST` with `action=tick` (or `/tick` endpoint), not via `GET`.
  - Acceptance:
    - `curl http://localhost:3000/api/ship/npc-0` returns JSON with keys `id`, `credits`, `phase`, `currentSystem` (not `{ success: true }`).

- [x] Task 2: Serialize system snapshots with `markets` converted to plain objects.
  - Files: `src/local-server.ts`
  - Steps:
    1) Add a helper that converts snapshot output (`markets: Map`) to `{ [goodId]: MarketState }`.
    2) Use that helper in `/api/system/:id?action=snapshot`.
  - Acceptance:
    - `curl http://localhost:3000/api/system/0?action=snapshot` returns JSON with a `markets` object containing known keys like `food` and `metals`.

- [x] Task 3: Ensure economy data collection waits for an actual tick.
  - Files: `scripts/collect-economy-data.ts` (and optionally `src/local-server.ts`)
  - Steps (pick one, document in code):
    - Option A (script-only): Read `currentTick` from a system snapshot, call `/api/galaxy/tick`, then poll that system until `currentTick` increases (with a timeout >= 35s).
    - Option B (server change): Add a `force=true` or `sync=true` mode to `/api/galaxy/tick` that processes at least one tick synchronously, and use it from the script.
  - Acceptance:
    - In test mode, consecutive data points show `currentTick` increasing and at least one market price or inventory value changing over time.

- [x] Task 4: Align tick intervals to avoid off-by-one timing issues.
  - Files: `src/local-server.ts`, `src/star-system.ts`
  - Steps:
    1) Use a single source of truth for the tick interval (env var or shared constant).
    2) Ensure both server and system use the same interval value.
  - Acceptance:
    - A `galaxy/tick` call followed by a wait of one interval always produces a non-zero `processed` count.

## Verification (run after tasks are complete)

1) Start server:
   - `npm run dev`

2) Health check:
   - `curl http://localhost:3000/api/health`
   - Expect: `{"status":"ok"}`

3) System snapshot includes markets:
   - `curl http://localhost:3000/api/system/0?action=snapshot`
   - Expect: `markets` is a non-empty object with keys like `food`.

4) Ship state is returned on GET:
   - `curl http://localhost:3000/api/ship/npc-0`
   - Expect: JSON with `id`, `credits`, `phase`, `currentSystem`.

5) Tick progression is observable:
   - Capture `currentTick` from `/api/system/0?action=snapshot`.
   - Call `/api/galaxy/tick` (or `/api/galaxy/tick?sync=true` if added).
   - Wait or poll until `currentTick` increases by at least 1.

6) Economy test produces non-empty data:
   - `npm run test:economy`
   - Expect: `economy-data/economy-data-*.json` exists and includes non-empty `systems` and `metrics.averagePrice`.
