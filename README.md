# Space Trader Online (STO)

A persistent multiplayer recreation of the PalmOS classic *Space Trader*, built on Cloudflare Workers, Durable Objects, and D1. The defining feature: named NPC captains share the same records, markets, encounter rules, and visible profiles as human players, and nothing in play reveals which is which.

## Current status

**Design complete, implementation not started.** The Phase 0 specification is finished and build-ready; the original-game baseline rules are ported and golden-tested. The next artifact is the `ruleset-phase0-v1` kernel package (design §20.1).

## Repository layout

| Path | What it is |
|---|---|
| `proposals/space-trader-design.md` | **The design document (v0.5).** Phase 0 implementation specification: game rules, encounter resolution, economy, architecture, transaction model, lifecycle rules, and the build sequence (§20). |
| `proposals/rules-kernel/space-trader-ruleset/` | `@sto/original-baseline-rules` — Cloudflare-independent TypeScript port of the PalmOS Space Trader 1.2.2 tables and formulas (GPL-2.0-or-later, golden-tested). `npm install && npm test` inside the package. |

## Key facts for anyone (or any agent) building this

- **The design doc is the specification of record.** Section 20 defines the implementation sequence: rules kernel → Captain/System DO slice → encounter/proxy slice → relationships/police/destruction → playtest gate.
- **The baseline package is a guideline, not settled balance.** Its single-player tuning may not survive MMO conditions (trade margins under shared arbitrage, symmetric PvP combat pacing, long-run money supply). Expect rework — always shipped as a new named ruleset version (`ruleset-phase0-v1`, `-v2`, …) layered over the unchanged baseline library. Never edit the baseline package for balance. See design §16.1.
- **Balance changes are validated by simulation first.** The offline simulation harness (design §20.1) must show persistent profitable routes, non-degenerate combat, and stable money supply before a ruleset version is accepted.
- **Licensing:** the baseline package is GPL-2.0-or-later (derived from the original source). Code importing it is a derivative work; choose licences accordingly.
- **Determinism is non-negotiable.** Identical state, seed, and ruleset version must always produce identical results. Every trip and encounter stores its seed, PRNG version, and ruleset version (design §16.3).

## Architectural rule of record

> Each mutable game invariant has exactly one authoritative Durable Object. D1 stores completed history and queryable projections, but never independently mutates state owned by a Durable Object. Cross-object operations use idempotent reservation, commit, projection, and retry protocols. Once authoritative state commits, its D1 projection must retry until successful, and affected gameplay remains locked until synchronisation is complete.
