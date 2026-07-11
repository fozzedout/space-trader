# STO Phase 0 deviations from the PalmOS baseline

The functions named `original*` preserve a PalmOS baseline. The Phase 0 game must layer the v0.5 design rules over them.

## Economy

- Original prices are generated on arrival and quantities drift slowly per system.
- STO adds finite shared stock, progressive order pricing, bounded pressure and elapsed-time recovery.
- `standardPrice`, `determinePrice` and `initialQuantity` are equilibrium/bootstrap inputs, not the complete multiplayer market.

## Encounters and combat

- The original is single-player and resolves actions sequentially.
- STO uses hidden simultaneous action rounds, a four-phase state machine, deterministic action-pair precedence and atomic settlement.
- Original hit, damage, shields, hull-damage caps and flee formulas remain useful baseline formulas.
- STO allows human-vs-human and human-vs-NPC combat through the same resolver.

## Police and bounties

- Original police bands and score changes are retained only as traceable reference helpers.
- STO v0.5 uses its own `-100..+100` bands, automatically reports crimes after encounter settlement, and treats wanted status independently from inferred activity roles.
- STO bounties are proportional to wanted status, paid only on destruction, and unavailable to a killer who is currently wanted.
- Destroying a wanted captain resets a surviving identity to `-30`; immediate further criminal behaviour returns them to wanted status.

## Surrender and piracy

- STO surrender lets the victor choose any amount up to all carried cargo and carried credits.
- Banked credits, debt, ships and installed equipment cannot be taken.
- NPC hostility scales with the proportion/value removed; taking nothing is mercy.
- Theft remains theft even when committed against a wanted captain.

## Escape pods and death

- The original escape pod immediately provides a replacement Flea after destruction.
- STO creates a persistent physical pod, `AWAITING_RECOVERY`, rescue opportunities and eventual automated clone recovery.
- Destruction without the package permanently kills the captain identity.

## Skills and NPC behaviour

- Original commander skills are a separate RPG system. STO learned combat/trade behaviour profiles are not the same values.
- Baseline skill functions may be used for ship handling and combat only if Phase 0 retains those original crew statistics.
- NPC and disconnected-player policies must obey v0.5 information-parity and deterministic proxy rules.

## Travel

- Original travel uses 21 clicks and one elapsed day.
- STO provisionally uses approximately 15-20 player-paced approach ticks plus five-second global occupancy windows.
- Original travel repair and encounter concepts are baseline inputs; v0.5 travel ownership and matching rules take precedence.
