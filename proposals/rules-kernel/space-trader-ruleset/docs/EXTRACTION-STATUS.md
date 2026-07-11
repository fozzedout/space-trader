# Extraction status

## Ready for Phase 0 kernel use

| Area | Status | Notes |
|---|---|---|
| Commodities | Complete | All ten table rows and relevant fields |
| Politics | Complete | All seventeen table rows |
| Ships | Complete | Ten purchasable plus five special ships |
| Equipment | Complete | Weapons, shields, gadgets and escape-pod cost |
| Market baseline | Complete | Standard price, arrival variance, criminal adjustment, trader markup and initial quantity |
| Skills | Complete | Effective crew skills, gadget bonuses and difficulty adjustment |
| Combat primitives | Complete | Hit, weapon damage, shield absorption, hull cap and flee formulas |
| Ship valuation | Complete | Player trade-in, equipment resale and enemy ship valuation |
| Travel finance | Complete | Fuel/repair helpers, wormhole tax, interest and insurance |
| Ordinary encounters | Complete for baseline weighting | Pirate/police/trader/none classification only |
| Police reference | Complete | Original bands, record decay, encounter multiplier and bounty formula |
| Galaxy constants | Complete | Geometry, system count, wormholes, range and fixed special-system indices |

## Deliberately deferred

These are not required to begin the Phase 0 core kernel, or are replaced by STO v0.5:

- PalmOS UI and event-loop behaviour
- exact original random galaxy placement and complete canonical name list
- quest-specific systems, story encounters and newspaper content
- original sequential encounter controller
- generated enemy ship/crew/loadout algorithms
- original escape-pod replacement flow
- original orbit-trader user interface
- save-game layout and PalmOS persistence

## Validation approach

- Tables are transcribed from `Global.c` and interpreted using `DataTypes.h` and `spacetrader.h`.
- Formula helpers preserve C-style truncating integer arithmetic.
- Random draw order is tested where it affects deterministic replay.
- Golden tests exercise threshold boundaries, criminal pricing, fleeing hit logic, quantity draw order and valuation.
- STO-specific behaviour is excluded from baseline helpers and documented separately.
