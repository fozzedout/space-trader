# STO original baseline rules

A Cloudflare-independent TypeScript package containing the traceable PalmOS **Space Trader 1.2.2** baseline needed by the STO Phase 0 design.

## Included

- 10 commodities and their original table fields
- 17 political systems
- 10 purchasable and 5 special ships
- weapons, shields, gadgets and escape-pod cost
- market equilibrium, arrival-price, buy/sell and starting-quantity formulas
- original status-shuffle behaviour
- effective crew skills and difficulty adjustment
- combat hit, damage, shield, hull-cap and flee helpers
- ship trade-in, enemy-ship valuation, repair, fuel, insurance, interest and wormhole helpers
- ordinary pirate/police/trader encounter classification
- original police and reputation bands plus bounty reference helpers
- original galaxy geometry constants and fixed special-system indices
- deterministic STO PRNG v1
- golden tests and source traceability

## Not included

- PalmOS UI code or original artwork
- quests and special-event scripting
- the exact random galaxy placement algorithm or the complete 120-name system catalogue
- generated opponent loadouts and special encounter branches
- the STO encounter state machine
- shared-stock pressure and progressive multiplayer pricing
- STO police, wanted-status and surrender settlement rules
- Durable Objects, D1 or API code

Those belong to later parts of the Phase 0 implementation and must follow design v0.5. See `docs/STO-DEVIATIONS.md` and `docs/EXTRACTION-STATUS.md`.

## Commands

```bash
npm run build
npm test
```

No runtime dependencies are required.

## Integration rule

Treat this package as a **versioned baseline library**, not as the whole game ruleset. Import original helpers into a separate `ruleset-phase0-v1` package that adds the explicit multiplayer rules from design v0.5.

## Important distinction

The original PalmOS random function is not reproduced. Every randomised helper accepts a `RandomSource`. `XorShift32` is the new STO deterministic PRNG and must be versioned independently from the extracted formulas.
