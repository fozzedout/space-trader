# Space Trader Online (STO)

Persistent multiplayer *Space Trader* on Cloudflare Workers / Durable Objects / D1.

## Current status

**Phase 0 vertical slice** with magic-link session auth, durable DO alarms, idempotent D1 projections, ambient NPCs, and dock fuel/repair/upgrade. Open the Worker URL, sign in, initialize the galaxy (dev), then dock → trade → jump → scan for traffic → fight/talk.

## Layout

| Path | What |
|---|---|
| `proposals/space-trader-design.md` | Spec (v0.5) |
| `proposals/rules-kernel/` | Baseline + `ruleset-phase0-v1` |
| `server/` | Game server + playtest web client (`public/`) |

## Playtest

```bash
cd server
npm test
npm run typecheck
npm run db:migrate:local
npm run dev
```

1. Enter email → request magic link (dev returns token) → verify  
2. **Initialize galaxy** (development only)  
3. Dock / Market / Travel / Ship (refuel, repair, upgrade, escape pod)  
4. While approaching, **Scan for traffic** matches ambient NPC presence
