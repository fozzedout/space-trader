# ruleset-phase0-v1

Cloudflare-independent TypeScript rules kernel for STO Phase 0 (design §20.1).

Layers multiplayer rules from `proposals/space-trader-design.md` v0.5 over `@sto/original-baseline-rules`. Balance tuning lives only in this package; the baseline library is never edited for balance.

## Included

- Pinned `ruleset-phase0-v1` configuration
- Deterministic PRNG wrapper (XorShift32 / STO PRNG v1)
- Travel sequence generation and global-window encounter matching
- Progressive market quotes, stock/pressure, and recovery
- Simultaneous captain encounter resolver and police encounter state machine
- Ordinary NPC decision policy and disconnect-proxy policies
- Canonical bilateral trade offers and atomic exchange hashing
- Surrender-claim valuation and hostility curve
- Combat strength assessor
- Behaviour-profile and relationship classifiers
- Crime reporting, bounty, rehabilitation, wreck, and destruction helpers
- Offline simulation harness (ambient economy + scripted encounters)

## Commands

```bash
npm install
npm test
npm run simulate -- --captain-days 500
```

## Version pin

Automated tests and live play must name `RULESET_VERSION` (`ruleset-phase0-v1`). Existing trips and encounters keep the version they started with.
