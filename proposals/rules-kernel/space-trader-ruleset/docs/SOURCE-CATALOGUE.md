# Source catalogue

This package reconstructs the original **Space Trader 1.2.2** gameplay baseline for the Phase 0 rules kernel. It intentionally excludes PalmOS UI code and STO multiplayer mechanics.

## Primary authority

Original source mirror:

- Repository: `https://github.com/abotkin/spacetraderPalmOS`
- Upstream author and copyright holder: Pieter Spronck
- Repository description: source for Space Trader 1.2.2
- Licence: GNU GPL version 2 or later in individual source headers; repository metadata identifies GPL-2.0
- Snapshot reviewed: `master`, retrieved 2026-07-11

| Package area | Primary source | Original symbols/data |
|---|---|---|
| Commodity definitions | `Src/Global.c` | `Tradeitem` |
| Ship definitions | `Src/Global.c` | `Shiptype` |
| Weapons, shields, gadgets | `Src/Global.c` | `Weapontype`, `Shieldtype`, `Gadgettype` |
| Political systems | `Src/Global.c` | `Politics` |
| Police and reputation bands | `Src/Global.c`, `Src/spacetrader.h` | `PoliceRecord`, `Reputation`, score constants |
| Data-field meaning | `Src/DataTypes.h` | `TRADEITEM`, `SHIPTYPE`, `POLITICS`, equipment structs |
| Constants and IDs | `Src/spacetrader.h` | commodity, status, equipment, galaxy, skill and encounter constants |
| Market bootstrap | `Src/Traveler.c` | `StandardPrice`, `InitializeTradeitems`, `DeterminePrices`, `ShuffleStatus` |
| Player buy prices | `Src/Traveler.c` / referenced `RecalculateBuyPrices` implementation | production availability, criminal intermediary and trader markup |
| Cargo/equipment trading | `Src/Cargo.c` | cargo operations, `BasePrice`, `BaseSellPrice` |
| Skills | `Src/Skill.c` | effective skill calculation and difficulty modifiers |
| Combat | `Src/Encounter.c` | hit, damage, shielding, hull damage, flee, surrender and bounty behaviour |
| Travel encounters | `Src/Traveler.c` | ordinary encounter roll and police strength multiplier |
| Travel finance | `Src/Traveler.c`, `Src/Fuel.c` | repair, fuel, interest, insurance and police-record movement |
| Ship valuation | `Src/ShipPrice.c` | `EnemyShipPrice`, `CurrentShipPriceWithoutCargo` |

## Secondary extraction aid

The following mechanics reference was used only as an index and cross-check, not as authority when it conflicts with the Palm source:

- `https://github.com/satelliteoflove/spacetrader-tui/blob/main/docs/space_trader_original_mechanics.md`

## Extraction policy

1. Numeric tables were transcribed from `Global.c` and interpreted using the corresponding structs in `DataTypes.h`.
2. Arithmetic uses JavaScript `Math.trunc` to model C integer truncation toward zero.
3. Randomised formulas accept an injected `RandomSource`; draw order is preserved, while the PRNG implementation is STO-owned and separately versioned.
4. UI behaviour, quests and single-player-only state are not included unless required by the Phase 0 core loop.
5. Every multiplayer deviation is documented in `STO-DEVIATIONS.md` rather than silently altering an original helper.
