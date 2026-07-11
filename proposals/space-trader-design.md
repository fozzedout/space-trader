# Design Document: Multiplayer Space Trader

**Working title:** Space Trader Online (STO)  
**Status:** Phase 0 build-ready design v0.5  
**Platform:** Cloudflare Workers, Durable Objects, D1, Cron Triggers / Durable Object alarms  
**Client:** Mobile-friendly web client, preserving the original game's low-graphics ethos

### Revision v0.5

This revision closes the final implementation-specification gaps identified in review:

- an executable police encounter flow: contact types, responses, outcomes, police combat, and deadline defaults;
- the explicit market price function, progressive quoting algorithm, and recovery formulas;
- an ordinary NPC decision policy with a fixed priority order over relationships, wanted status, and profile bands;
- a uniform demand-resolution rule that closes direct and timing-based inventory probing;
- companion travel-group matching rules;
- the `ruleset-phase0-v1` initial ruleset pin and economically stranded NPC handling.

### Revision v0.4

This revision converts the remaining implementation assumptions and Phase 0 gameplay decisions into explicit rules:

- fixed global travel-window timing, occupancy, deterministic pairing, and claim expiry;
- complete encounter precedence and fallback rules, including atomic bilateral cargo-and-credit trades;
- player-selected surrender claims, with relationship and police consequences proportional to what is taken;
- activity-based pirate, bounty-hunter, and trader behaviour with no stored role labels;
- automatic post-encounter crime reporting, wanted-state bounties, eligibility, rehabilitation, and reset rules;
- durable transaction commit points, request hashes, reconciliation, and D1 uniqueness rules;
- durable retry queues multiplexed through one Durable Object alarm;
- explicit captain, encounter, reservation, and escape-pod lifecycle states;
- consistent human/NPC relationship and rescue-history behaviour;
- defined administrative recovery and observability requirements without allowing gameplay rollback.

---

## 1. Vision

Recreate the core loop of the classic PalmOS *Space Trader*—travel, trade, encounter, upgrade—as a persistent multiplayer galaxy.

The defining feature is that named NPC captains occupy the same game space as human captains. NPCs and humans use the same captain records, ships, markets, encounter actions, relationship rules, and visible profiles. A player should not be able to identify an NPC merely from how the game presents or resolves an encounter.

Later phases may add LLM-driven communication and richer strategic behaviour. Phase 0 must prove that the game is fun and that the NPC illusion works without relying on an LLM.

### 1.1 Design pillars

1. **The economy is the game.** Prices and stock are shared state. Human and NPC activity must visibly affect other captains.
2. **NPCs are captains.** Humans and NPCs use the same game rules and data shape. Only the controller differs.
3. **Turn-based everywhere.** Travel and encounters resolve in discrete server-authoritative steps.
4. **Deterministic mechanics, expressive presentation.** Fixed rules decide outcomes. Dialogue and personality never override mechanics.
5. **One authority for each mutable invariant.** Every piece of live game state has one authoritative Durable Object. D1 stores projections, history, and queryable records.
6. **Phase 0 proves fun, not completeness.** Tuning values are provisional. Features that do not test the core loop or NPC illusion are deferred.

---

## 2. Phase 0 objective and scope

Phase 0 is not a disposable mock-up. It is the first production-shaped vertical slice, using the intended Durable Object ownership model from the beginning.

It must prove:

- the original trade–travel–encounter loop remains enjoyable;
- shared markets feel meaningfully affected by other captains;
- named NPC captains feel plausibly like human players;
- real PvP works through the same encounter machinery;
- mobile disconnects are handled fairly without creating a combat exploit;
- no trade or encounter flow can duplicate credits, cargo, stock, or rewards.

### 2.1 Included in Phase 0

- Persistent human and NPC captains.
- Shared galaxy and shared markets.
- Original-style hyperspace and planetary approach travel.
- Human-vs-NPC and human-vs-human encounters.
- Simultaneous hidden-action encounter rounds.
- Open PvP for the limited test group.
- Disconnect grace period and NPC proxy takeover.
- Separate learned combat and trade profiles for human captains.
- Fixed combat and trade profiles for NPC captains.
- Direct NPC relationship memory.
- Police record, bounties, destruction, escape pods, permanent death, and retirement.
- Finite stock, progressive order pricing, pressure, and recovery.
- Deterministic seeded outcomes and versioned rules.

### 2.2 Explicitly deferred

- LLM-generated dialogue or strategy.
- NPCs learning from their own behaviour.
- Multi-party combat or companion combat assistance.
- Guilds, factions, stations, or territory.
- Broad NPC gossip or knowledge of events they did not witness.
- Natural NPC retirement.
- Retired captains becoming civilian system characters.
- Complex police missions, fines-as-gameplay, amnesties, or bribery systems.
- Native mobile clients.

---

## 3. Core game loop

A captain docks at a planet, reviews the market, buys or sells cargo, repairs or upgrades the ship, chooses a destination within fuel range, travels, resolves any encounters, and docks at the destination.

Long-term progression comes from:

- wealth and ship progression;
- combat and trade reputation;
- police standing and bounties;
- persistent relationships with named captains;
- survival, escape-pod ownership, and identity continuity.

---

## 4. Travel model

Travel preserves the original game's two-part structure.

### 4.1 Hyperspace

The hyperspace jump is immediate once departure is accepted and fuel is consumed.

### 4.2 Planetary approach

After hyperspace, the captain enters an approach sequence, provisionally around 15–20 travel ticks.

- Empty ticks resolve rapidly.
- Travel is player-paced rather than wall-clock travel.
- The server enforces a small minimum tick interval to prevent automated rapid-fire journeys.
- An encounter pauses approach progression until resolved or ignored.
- The player does not click through every empty tick; the client may advance them automatically while the server remains authoritative.

### 4.3 Shared travel space and global tick windows

The destination System DO owns all route areas in that system's approach space. Active travel is divided into fixed global windows derived from server time:

```text
global_tick = floor(unix_time_ms / travel_window_ms)
presence_key = route_area + global_tick
```

`travel_window_ms` is versioned configuration. The Phase 0 default is five seconds.

When a captain enters an approach step, the Captain DO records a persisted occupancy interval and registers it with the destination System DO. Occupancy lasts from the accepted step time until the earliest of:

- the next travel step being accepted;
- the captain being claimed for an encounter;
- the trip being paused, cancelled by an authoritative lifecycle transition, or completed;
- a maximum occupancy lifetime defined by the ruleset.

The System DO derives eligibility for every global window overlapped by that occupancy interval. This prevents NPC or human encounter availability from depending on a scheduler firing at one exact instant.

Captains are eligible to encounter each other when they occupy the same route area during the same global window.

- Human and NPC captains use the same occupancy and eligibility representation.
- The route area is the relevant shared approach-space segment, not merely the destination system.
- Registration for a window closes at the end of that window. Matching for that window occurs once, immediately after closure or lazily on the next System DO wake.
- The System DO creates as many non-overlapping one-on-one pairs as possible from eligible captains in that window.
- Pairing order is determined by a stable sort of captain IDs followed by deterministic seeded shuffling using `system_id + route_area + global_tick + ruleset_version`.
- A captain may be selected at most once in a global window and cannot be selected while already claimed or locked.
- Registrations received after a window closes apply only to later overlapping windows and never rewrite a completed selection.
- A paused or disconnected captain does not create new occupancy. Existing occupancy is closed when the pause is recorded.
- Stale presence rows are removed idempotently after the configured maximum occupancy lifetime.

### 4.4 Encounter claim protocol

The System DO uses an idempotent two-captain claim protocol:

1. The System DO selects an eligible pair and creates one `encounter_id`.
2. It asks both Captain DOs to claim that `encounter_id`.
3. A Captain DO accepts only if the captain is still travelling, is present in the selected route area and tick, and has no existing encounter claim.
4. If both claims succeed, the Encounter DO is created or started using the same `encounter_id`.
5. If either claim rejects or times out, any successful claim is released idempotently.
6. Every retry reuses the same `encounter_id`; it never creates a second encounter for the same selection attempt.
7. A successful claim records `claim_expires_at`. If the Encounter DO has not durably entered `CONTACT` before expiry, either the System DO or Captain DO may release the claim idempotently.
8. Once the Encounter DO durably acknowledges both participants, the claim becomes bound to that encounter and cannot expire automatically.

The `encounter_id` is derived deterministically from the system, route area, global tick, and selected captain IDs. This prevents duplicate encounter creation after retries or restarts.

This prevents double matching and ensures that partial failures cannot leave a captain permanently claimed.

### 4.5 Interrupted travel

Outside a shared human encounter, disconnecting pauses that captain's interactive progression.

The captain's current trip, tick, and pending encounter are preserved. Time continues elsewhere in the simulation, but no new personal travel actions resolve until control resumes or an agreed proxy rule applies.

A trip stores the generated deterministic travel sequence or sufficient RNG metadata to reproduce it. Later rule changes must not rewrite an existing trip's history.

---

## 5. Encounters

### 5.1 Encounter types

Phase 0 includes:

- police encounters (section 5.6);
- captain encounters between any two human or NPC captains;
- wreck/debris encounters;
- escape-pod encounters.

Pirate, bounty-hunter, and trader are not encounter types or stored captain roles. They are descriptions inferred from what a captain does. A captain encounter may therefore become a consensual trade, an attempted robbery, a bounty hunt, a fight, or a peaceful disengagement without exposing or assigning a role label.

### 5.2 Captain actions

Captain encounters use a shared mechanical action set:

- `ATTACK`
- `FLEE`
- `HAIL`
- `IGNORE`
- `DEMAND`
- `TRADE_OFFER`
- `ACCEPT_TRADE`
- `SURRENDER`
- `COMPLY`
- `SURRENDER_CLAIM`

Every action includes an `action_id`, round number, and rules-defined parameters. The rules engine validates every action and parameter before lock-in.

- A syntactically invalid client submission is rejected and may be resubmitted before the deadline.
- If no valid action is locked by the deadline, the controller policy supplies one.
- If a supplied action is no longer legal when the round resolves, it is replaced by the deterministic phase fallback: `IGNORE` in `CONTACT` or `NEGOTIATION`, and `FLEE` in `COMBAT`; if `FLEE` is impossible, `SURRENDER`; if surrender is impossible, `IGNORE`.
- The same round, captain, and `action_id` may be submitted repeatedly but may not resolve to different action content.

A `TRADE_OFFER` describes one complete bilateral exchange. Either side may give any combination of:

- carried credits;
- one or more cargo types and quantities.

The exchange may therefore be cargo for credits, cargo for cargo, or any valid combination of cargo and carried credits in both directions. Before hashing, the resolver nets the same asset flowing in both directions and rejects a zero-effect exchange. Negative amounts are invalid. Banked credits, debt, ships, installed equipment, and assets not explicitly supported by the ruleset cannot be included.

A `DEMAND` describes cargo and/or carried credits to be transferred one way under coercion. A captain may request any non-negative amount; the demand is publicly valid regardless of whether the target can fulfil it. Fulfilment is checked privately on the target's side, and the demander receives only `COMPLIED` or `NOT_COMPLIED`. Refusal, insufficient holdings, invalid target-side compliance, and timeout all produce the same public `NOT_COMPLIED` result, with identical round timing and payload, and no remaining balance or reason is ever disclosed. This closes both direct and timing-based inventory probing. An unfulfillable demand remains attempted piracy and receives the same attempted-piracy penalty.

`SURRENDER_CLAIM` is legal only after surrender has established a victor. It is not a normal simultaneous-round action.

### 5.3 Encounter phases

Every captain encounter uses the same four public mechanical phases:

```text
CONTACT
NEGOTIATION
COMBAT
TERMINAL
```

- **CONTACT** — legal actions: `ATTACK`, `FLEE`, `HAIL`, `IGNORE`, `DEMAND`, `TRADE_OFFER`.
- **NEGOTIATION** — legal actions: `ATTACK`, `FLEE`, `HAIL`, `IGNORE`, `DEMAND`, `TRADE_OFFER`, `ACCEPT_TRADE`, `COMPLY`, and `SURRENDER` where context permits.
- **COMBAT** — legal actions: `ATTACK`, `FLEE`, `SURRENDER`; `HAIL` is permitted only as a message attached to one of those mechanical actions.
- **TERMINAL** — no new normal-round actions are accepted. Settlement and projection occur in internal post-terminal states described in section 15.

A surrender creates an internal `SURRENDER_RESOLUTION` substate within `NEGOTIATION`. Only the victor may submit `SURRENDER_CLAIM`. The surrendered captain receives no further action. If the victor does not submit a claim by the deadline, the deterministic fallback is to take nothing and end the encounter.

The versioned rules package contains the complete deterministic ordered action-pair transition table. The table, rather than controller-specific logic, is the rule of record.

### 5.4 Simultaneous hidden-action rounds

Both captains choose privately. A normal round resolves when both actions are locked or when a deadline or proxy rule supplies the missing action.

The original *Space Trader* combat formulas are used as the Phase 0 baseline except where this document explicitly replaces them for simultaneous multiplayer resolution. The same state, locked actions, seed, RNG position, and ruleset version must always produce the same result.

Phase 0 resolves interacting actions in this priority order:

1. surrender;
2. escape attempts;
3. attacks;
4. valid demand compliance or valid trade acceptance;
5. unresolved demands and trade proposals;
6. hail and disengagement.

A higher-priority action prevents a lower-priority action only where the rules below explicitly say so. Unlisted symmetric orderings use the same outcome with participant roles reversed.

#### `ATTACK` versus `ATTACK`

- Both attacks resolve from the same pre-round state.
- Both captains may deal damage, even if one is destroyed by the other in that round.
- Destruction, mutual destruction, bounty, police, and wreck effects are derived after both attacks resolve.
- The encounter remains in `COMBAT` unless one or both captains are destroyed.

#### `ATTACK` versus `FLEE`

The flee attempt resolves first.

- If flight succeeds, the encounter ends and the attack does not land.
- If flight fails, the attack resolves normally and the encounter enters or remains in `COMBAT`.
- The fleeing captain does not return fire during that round.

#### `ATTACK` versus `SURRENDER`

Surrender resolves before the attack.

- The attack is cancelled.
- The surrendering captain becomes compliant.
- The other captain becomes the victor and the encounter enters `SURRENDER_RESOLUTION`.
- The victor may not attack after surrender has been accepted.

#### `ATTACK` versus any other action

- The non-attack action does not cancel or delay the attack.
- The attack resolves normally and the encounter enters `COMBAT`.
- No trade, demand, compliance, or other transfer commits in that round.
- The non-attacking captain does not return fire.
- A hail may still be displayed, but has no mechanical effect on the attack.

#### `FLEE` versus `FLEE`

- Both flee attempts automatically succeed.
- The encounter ends immediately with no attacks or damage.
- Both actions are classified as passive behaviour.
- No new relationship change is created solely by mutual flight, although classifications from earlier actions remain valid.

#### `FLEE` versus a non-attack, non-surrender action

- The flee attempt resolves normally.
- If flight succeeds, the encounter ends and no demand or trade transfer occurs.
- If flight fails, the encounter remains in its current non-terminal phase and the opposing hail, demand, or offer may remain visible or pending where valid.

#### `DEMAND` versus `COMPLY`

- The demand succeeds without combat if the demanded captain can fulfil the exact demand.
- The demanded cargo and/or carried credits transfer atomically through encounter settlement.
- If the target cannot fulfil the exact demand, no transfer occurs, the demander sees only the standard `NOT_COMPLIED` result, and the encounter remains in `NEGOTIATION`.
- Making the demand is aggressive behaviour and a criminal piracy action.
- Complying is passive behaviour.
- The encounter ends after a successful transfer settles.

#### `DEMAND` versus `DEMAND`

- Both demands are revealed.
- Neither commits and the encounter remains in `NEGOTIATION`.
- Both actions are aggressive and both attempted piracy events are reported at settlement.

#### `DEMAND` versus `HAIL` or `TRADE_OFFER`

- The demand and the other communication are revealed.
- No transfer occurs.
- The demand remains pending for a later valid `COMPLY` unless replaced, withdrawn by disengagement, or invalidated by escalation.
- The encounter remains in `NEGOTIATION`.

#### `DEMAND` versus `IGNORE`

- No transfer occurs.
- The encounter ends through disengagement.
- The demand is still recorded as attempted piracy and reported automatically at settlement.

#### `COMPLY` without a valid pending or simultaneous demand

- The action is invalid and follows the deterministic phase fallback.
- No transfer can be inferred or invented by the resolver.

#### Encounter trade offers

Each `TRADE_OFFER` is a signed willingness by its proposer to complete that exact canonical exchange. The offer receives a stable proposal hash.

- A pending offer remains valid until its proposer replaces it, explicitly disengages, attacks, flees, demands, surrenders, or can no longer fulfil it.
- `ACCEPT_TRADE` must reference the exact current proposal hash.
- Acceptance never reveals inventory or credit information beyond the offer itself.
- Before commit, both Captain DOs revalidate the exact cargo and carried-credit deltas.
- A successful exchange commits atomically: either every cargo and credit delta for both captains commits, or none does.
- Encounter trades never alter a system market's stock or pressure.

#### `TRADE_OFFER` versus `TRADE_OFFER`

- Both proposals are revealed simultaneously.
- If both describe the same canonical bilateral exchange, both captains have explicitly accepted that exchange and it commits atomically if still fulfilable.
- If they differ, neither commits. Each remains visible as a proposal and the encounter remains in `NEGOTIATION`.

#### `ACCEPT_TRADE` involving a pending offer

- If the acceptance references an offer that was current at the start of the round, and the proposer does not revoke or replace it during that round, the exchange commits atomically if both captains can still fulfil it.
- `HAIL` by the proposer does not revoke the offer.
- `ATTACK`, `FLEE`, `IGNORE`, `DEMAND`, `SURRENDER`, or a replacement `TRADE_OFFER` by the proposer revokes the previously pending offer before acceptance can commit.
- Two `ACCEPT_TRADE` actions commit only when they resolve to the same canonical exchange.
- A stale, mismatched, or unfulfillable acceptance commits nothing and leaves the encounter in `NEGOTIATION` unless another action ends or escalates it.

#### `TRADE_OFFER` or `ACCEPT_TRADE` versus `IGNORE` or successful `FLEE`

- No trade occurs.
- The encounter ends.

#### `SURRENDER` versus a non-attack action

- A valid surrender takes priority and makes the other captain the victor.
- The encounter enters `SURRENDER_RESOLUTION`.
- If both captains surrender simultaneously, neither gains victor rights and the encounter ends through mutual disengagement.

#### Surrender claim

The victor chooses what to take. The claim may contain any combination from nothing up to all of the surrendered captain's:

- carried credits;
- carried cargo.

The victor may not take banked credits, debt capacity, the ship, installed equipment, or any asset not physically carried and supported by the claim rules.

On entering `SURRENDER_RESOLUTION`, the surrendered captain's eligible carried cargo and carried-credit balance are revealed privately to the victor for the claim interface. No banked credits, equipment, or other private state is revealed.

The claim is validated against the surrendered captain's holdings at the surrender snapshot and commits atomically through encounter settlement. Once it commits, the encounter ends and the victor may not resume the attack.

For an NPC victim, the relationship effect is proportional to the share of accessible surrender value removed:

```text
accessible_value = carried_credits + reference_value(all carried cargo)
removed_fraction = claimed_reference_value / max(1, accessible_value)
```

Cargo uses the destination system's equilibrium reference price captured when the encounter began, excluding live pressure, so the calculation is deterministic and cannot be manipulated during settlement.

Phase 0 defaults:

- taking nothing applies a major favourable hostility shift of `-10` toward the victor;
- taking anything applies `ceil(5 + 45 * removed_fraction)` hostility points toward the victor;
- taking everything therefore applies `+50`, equivalent to a major betrayal-scale grievance.

For a human victim, no hidden numeric human-to-human relationship score is created; the exact surrender and claim are recorded in history.

Any non-zero surrender claim is coerced theft. It is automatically reported after the encounter and applies a police penalty proportional to the value and fraction removed, even when the victim was wanted.

#### `HAIL` versus `HAIL`

- Both messages are revealed and the encounter enters or remains in `NEGOTIATION`.
- Neither action changes behaviour profiles or relationships by itself.

#### `HAIL` versus `FLEE`

- The hail is shown.
- The flee attempt resolves normally.
- If flight succeeds, the encounter ends; otherwise it remains in `NEGOTIATION`.

#### `IGNORE` versus any non-attack, non-surrender action

- The ignoring captain disengages.
- No trade or other transfer occurs.
- The encounter ends.

#### `IGNORE` versus `IGNORE`

- The encounter ends immediately.
- Both captains resume approach travel.
- Neither receives another action opportunity in that encounter.
- Both actions are neutral and no relationship change is created by the mutual disengagement.

### 5.5 One encounter system

Human and NPC encounters use the same state machine, action-pair table, and resolver. The only difference is the source of an action:

- human client;
- fixed NPC policy;
- disconnected-player proxy.

No outcome rule depends on whether a captain is human or NPC.

### 5.6 Police encounters

Police encounters use their own deterministic state machine because the captain action-pair table does not cover inspections, confiscation, or police-issued surrender orders. Contraband is defined by the original baseline commodity and government tables in the versioned rules package.

**Contact type.** The ruleset selects one of the following using police standing, local police presence, and the seeded encounter RNG:

- `PASS` — police acknowledge the captain and end the encounter.
- `INSPECTION` — police order the captain to submit to a cargo inspection.
- `SURRENDER_ORDER` — police order a wanted captain to surrender.
- `ATTACK_ON_SIGHT` — used at police record `-100`.

**Responses.**

- `INSPECTION`: `COMPLY`, `FLEE`, or `ATTACK`.
- `SURRENDER_ORDER`: `SURRENDER`, `FLEE`, or `ATTACK`.
- `ATTACK_ON_SIGHT`: `FLEE` or `ATTACK`.

**Outcomes.**

- **Comply with inspection** — police inspect the actual carried cargo. Illegal cargo is confiscated and a fine is applied according to quantity and type. If nothing illegal is found, the captain is released without penalty. The encounter ends.
- **Surrender to police** — resolved by section 11.6: illegal cargo is confiscated, a fine is charged, no bounty is paid or cleared, and police standing is not automatically reset. The encounter ends.
- **Flee** — the baseline flee calculation resolves first. Success ends the encounter; failure enters police combat. Fleeing an ordinary inspection applies a police penalty; fleeing while already wanted worsens standing further.
- **Attack** — combat begins immediately. Initiating an attack on police is criminal, and destroying a police ship applies a major police penalty. Police do not surrender in Phase 0.

**Police combat.** The captain may `ATTACK`, `FLEE`, or `SURRENDER`, except at police record `-100`, where surrender is unavailable. Successful surrender uses the police-surrender outcome. Combat ends on escape, surrender, or destruction.

**Deadline defaults.** A missed player deadline defaults to `COMPLY` during an inspection, `SURRENDER` during a surrender order, and `FLEE` during attack-on-sight combat.

Police encounters settle through the same Encounter DO settlement, automatic reporting, and projection rules as captain encounters.

---

## 6. Disconnect handling and player proxies

A normal single-player-style pause is exploitable in PvP. Disconnecting must not remove a captain from a shared encounter.

### 6.1 Hidden grace period

When a human disconnects during a shared encounter:

1. The encounter enters a short hidden reconnection grace period.
2. The opponent receives no indication that a disconnect occurred.
3. If the player reconnects before expiry, they retain control.
4. If not, an NPC proxy submits an action immediately when the grace period expires.
5. The encounter continues normally.

Repeated disconnects during the same encounter use a fixed escalation: the first receives the full configured grace period, the second receives half, and the third and later receive immediate proxy takeover. The base grace duration remains a provisional tuning value.

### 6.2 Reclaiming control

A reconnecting player regains control at the next round boundary.

Any proxy action already locked for the current round remains valid and cannot be replaced.

The returning player receives a private catch-up summary showing:

- proxy-controlled rounds;
- actions taken;
- damage dealt and received;
- cargo, ammunition, or equipment changes;
- canned messages sent;
- current encounter state.

The opponent is never told that control changed.

### 6.3 Proxy modes

Each human captain chooses one of two proxy modes:

- **Learned profile** — default.
- **Generic coward profile** — fixed escape-first behaviour.

The learned profile cannot be edited directly. This prevents players from min-maxing an autopilot configuration.

The learned proxy uses the captain's current combat or trade profile band as a weighted fixed policy:

- **Aggressive** strongly favours `ATTACK`, `DEMAND`, escalation, and refusal to surrender.
- **Neutral** favours returning fire, reasonable trade, `IGNORE`, and rational withdrawal.
- **Passive** strongly favours `FLEE`, `SURRENDER`, `COMPLY`, and de-escalation.

The policy may consider only information legitimately available to the human player, including visible ship and equipment cues, current damage, direct relationship memory, and previous actions in the encounter. It may not inspect hidden cargo, private profile scores, controller type, or the server's private strength assessment.

The policy is deterministic: the same encounter state, captain profile, ruleset version, seed, and RNG position always produce the same proxy decision.

The generic coward profile:

- attempts to flee whenever legal;
- avoids initiating or escalating combat;
- uses passive canned communication;
- uses deterministic fallback rules if flight is impossible.

### 6.4 Proxy communication

A proxy may communicate only through approved canned message banks:

- aggressive;
- neutral;
- passive.

The active combat or trade profile selects the appropriate style.

The proxy never generates free-form text or attempts to imitate the player's personal writing style.

### 6.5 Learning restriction

Proxy-controlled actions do not train the player's learned profiles. Only deliberate human-controlled choices update them.

---

## 7. Behaviour profiles

### 7.1 Human profiles

Each human captain has two private learned scores:

- **Combat profile**
- **Trade profile**

Each score ranges from `-100` to `+100`:

- `-100` to `-31`: passive
- `-30` to `+30`: neutral
- `+31` to `+100`: aggressive

Every score begins at `0`.

### 7.2 Score movement

Actions are classified as aggressive, neutral, or passive.

The score moves according to the current side of zero:

| Current score | Aggressive choice | Neutral choice | Passive choice |
|---|---:|---:|---:|
| Above 0 | +1 | -1 | -2 |
| Exactly 0 | +1 | 0 | -1 |
| Below 0 | +2 | +1 | -1 |

An opposite choice may cross zero. Scores are clamped to `-100..+100`.

This makes changing character faster than reinforcing an established extreme.

### 7.3 Contextual classification

The classification is based on intent and context, not only the selected button.

**Aggressive behaviour** includes:

- initiating conflict;
- escalating a non-hostile encounter;
- continuing to attack after the other captain tries to disengage;
- coercive demands or threats.

**Passive behaviour** includes:

- fleeing;
- surrendering;
- conceding or de-escalating when combat was still reasonably avoidable.

**Neutral behaviour** includes:

- returning fire;
- refusing a demand;
- ordinary trade;
- ignoring another captain;
- rational withdrawal when clearly outmatched.

Each meaningful choice is scored independently. An aggressive initiation is not erased merely because the player later flees.

### 7.4 Hidden strength assessment

The server calculates an encounter-specific strength assessment using:

- weapons and expected damage;
- shields;
- EMP missile defence;
- armour and hull;
- dodge and ship capability;
- mobility and escape capability;
- relevant equipment and loadout interactions.

The calculation is used only to judge whether fleeing or surrendering was rational.

Players are not shown a strength number or comparison. They judge risk from visible ship graphics, class, reputation, prior knowledge, and behaviour.

### 7.5 Public disposition

Other captains see one public disposition only.

```text
public_score = average(combat_score, trade_score)
```

The same bands apply:

- passive;
- neutral;
- aggressive.

The owner may privately see the current bands and trends of the component profiles, but not edit them. Exact numeric scores need not be exposed.

This allows a passive combatant and aggressive trader to appear publicly neutral.

### 7.6 NPC profiles in Phase 0

NPC captains do not learn in Phase 0.

At creation, each NPC receives:

- one random passive/neutral/aggressive combat profile;
- one independent random passive/neutral/aggressive trade profile.

The Phase 0 default is an equal three-way roll for each axis. There are no archetypes or per-archetype weights yet.

### 7.7 Information parity

NPCs may not use hidden information merely because the server stores it. They can react only to information that a human captain could legitimately know:

- the single public disposition;
- visible ship class and equipment cues;
- public police record, bounty, reputation, and history;
- direct relationship memory;
- current encounter actions and dialogue.

NPCs cannot inspect another captain's private combat or trade scores, hidden cargo, controller type, or server-side strength rating. Controller type is private server data and is never exposed through public captain projections, public APIs, encounter payloads, timing messages, or ordinary client diagnostics.

---

## 8. NPC direct memory and relationships

Phase 0 NPCs remember only direct interactions with a captain.

### 8.1 Hostility score

Each NPC–captain pair has a hostility score:

- `-100`: permanent friendship
- `-99` to `-31`: favourable
- `-30` to `+30`: neutral
- `+31` to `+99`: hostile
- `+100`: permanent grudge

Aggressive player actions anger the NPC. Passive, conciliatory, or generous actions placate it. Neutral actions tend gradually toward neutrality.

Because repeated encounters with the same NPC are comparatively rare, relationship changes are larger than behaviour-profile changes.

Provisional starting values:

- minor hostility shift: 5 points;
- major hostility shift: 10 points;
- betrayal: 50 points.

These values are tuning defaults, not final balance.

### 8.2 Memory facts

Each pair may retain up to five notable direct facts, such as:

- attacked me near Regulas;
- surrendered without a fight;
- gave me a favourable deal;
- travelled with me;
- destroyed my ship;
- rescued my escape pod.

Facts support canned dialogue and later LLM context. The numeric hostility score drives current behaviour.

### 8.3 Decay

Non-extreme relationships fade toward neutral over real time.

Provisional default:

- short no-decay period after the last encounter;
- then one point per day toward zero.

Reaching `-100` or `+100` through accumulated interactions locks the relationship and stops natural decay.

### 8.4 Permanent grudge

At `+100`:

- the NPC refuses trade and placation;
- it attacks whenever it is not clearly outmatched;
- if clearly outmatched, it disengages and remains hostile;
- the grudge does not decay.

### 8.5 Permanent friendship

At `-100`:

- the NPC never initiates combat against the friend;
- it always stops when encountered;
- it strongly prefers cooperation and favourable bounded deals;
- it may offer warnings or useful information;
- it remembers the relationship permanently.

A serious betrayal flips a permanent friendship directly from `-100` to `+100`.

Betrayal includes deliberately attacking a friendly travelling companion or similarly clear acts. Routine disagreement or refusing a deal is not betrayal.

### 8.6 Travelling together

Strongly favourable NPCs may offer to travel together. Permanent friends always offer when the route conditions match.

- The NPC mentions its intended destination diegetically.
- The option exists only when both captains intend to travel to the same system.
- The agreement lasts for one journey only.
- Accepting is relationship-neutral because both captains benefit.
- Hostile random-encounter probability is reduced.
- Police and other non-hostile captain encounters are not necessarily reduced.
- Combat remains one-on-one in Phase 0.
- Attacking the companion is a major betrayal.

Companion matching rules:

- The two captains share one `travel_group_id` for that journey.
- Group members are never eligible to be paired against each other by section 4.3 matching.
- The companion NPC is removed from independent encounter matching for the journey; the human captain remains the externally matchable captain.
- The travel group may receive at most one encounter in a global window, and an active encounter pauses both journeys.
- The companion provides no combat assistance.
- Hostile captain-encounter weighting is reduced before selection; police, wreck, escape-pod, and other non-hostile weighting is not reduced.
- The agreement ends when the destination is reached, either captain is destroyed, or the agreement is explicitly broken. An explicit attack on the companion ends the group and triggers the betrayal rule.

### 8.7 Ambient NPC simulation

Named NPC captains must have real positions, ships, money, cargo, and histories. They are not generated only when a player needs an encounter.

A scheduled world process advances a rotating cohort of NPCs through ordinary captain commands:

- choose a plausible destination within range;
- buy, sell, refuel, repair, or upgrade under the same constraints as humans;
- enter travel space and become eligible for encounters;
- affect shared stock and pressure through committed transactions.

Phase 0 policies remain simple and fixed. NPCs do not receive privileged market forecasts or impossible movement.

If permanent deaths reduce the active NPC population below the configured test target, the world may introduce a new, unrelated NPC captain. The dead identity remains dead and no relationships or history transfer.

An NPC that cannot perform any legal profitable or recovery action is economically stranded. A stranded NPC becomes inactive: it is excluded from encounter selection and ambient scheduling, and the world process may introduce a new, unrelated NPC to maintain the configured active population. The stranded identity remains in history and is never reset or reused.

---

## 9. Destruction, escape pods, death, and retirement

### 9.1 Escape-pod package

No captain starts with an escape-pod package. Human and NPC captains acquire it through the same equipment progression.

The package includes identity continuity, a physical escape pod, and a stored clone backup.

If a captain with the package is destroyed:

- the captain's identity survives;
- the Captain DO enters lifecycle state `AWAITING_RECOVERY`;
- relationships, memory facts, behaviour profiles, reputation, credits, bank, and debt survive;
- ship, cargo, and installed equipment are lost;
- a persistent escape-pod encounter object is created in the relevant approach space;
- the captain cannot trade, travel, retire, or enter another encounter while awaiting recovery.

Recovery occurs in one of two ways:

1. **Rescue** — another eligible captain encounters and rescues the pod, immediately returning the destroyed captain to a safe system.
2. **Automated recovery** — if the pod is not rescued before `recovery_due_at`, the stored clone backup returns the captain to a safe system. Destroying the physical pod prevents rescue but does not change the already scheduled recovery time.

The Phase 0 default sets `recovery_due_at` to five minutes after ship destruction. The physical pod remains rescueable until that time unless it is destroyed. This value is versioned tuning configuration, not a wall-clock rule embedded in settlement code.

After either recovery path:

- the captain receives the most basic ship;
- the captain may immediately trade it toward another model if they can afford the difference;
- the lifecycle returns to active play only after the Captain DO and D1 projections complete successfully.

The physical pod therefore creates a rescue opportunity, but loss of that pod does not destroy an identity protected by the stored clone backup.

### 9.2 Permanent death

If a captain without an escape-pod package is destroyed:

- an NPC captain dies permanently and is removed from active play;
- a human captain identity dies permanently;
- the account may create a fresh captain identity;
- no relationships, behaviour profiles, reputation, or assets transfer to the new identity.

Historical records may retain the old identity internally, but it disappears from active public play in Phase 0.

### 9.3 Installed equipment

All installed equipment is lost with the destroyed ship. Phase 0 has no equipment salvage or wreck-recovery system.

### 9.4 Retirement

A human player may retire a captain at any time while the captain is active and not locked by travel claiming, encounter settlement, economic settlement, or recovery.

Retirement is permanent:

- the captain becomes inactive;
- the captain cannot be reactivated;
- no assets, reputation, or relationships transfer;
- the account creates a fresh captain to continue;
- the retired captain disappears from active public play in Phase 0.

A later phase may place retired captains into civilian roles in their retirement system.

NPCs do not retire naturally in Phase 0.

---

## 10. Wrecks, cargo recovery, and escape-pod rescue

### 10.1 Cargo survival

Only a percentage of cargo survives a ship explosion. Exact survival percentage is provisional and must be playtested.

- All standard cargo types use the same survival chance because they use standard containers.
- Precious gemstones are always lost because they are not carried as standard tonnage cargo.
- A commodity definition can explicitly mark wreck recoverability.

### 10.2 Scoops

A ship must have a scoop to collect wreck cargo.

Recovery is limited by free cargo capacity.

The scoop also supports later or parallel mechanics such as:

- mining;
- sun skimming for fuel.

### 10.3 Persistent debris

Surviving uncollected cargo enters the general random-encounter pool for the relevant approach space.

- Any eligible captain may later encounter it.
- A scoop and free capacity are still required.
- The wreck expires after a configured lifetime or when emptied.

Scooping abandoned cargo is behaviourally neutral.

### 10.4 Escape-pod rescue

A physical escape pod remains in the relevant approach space as a persistent encounter object until rescued, destroyed, or expired.

Rescuing an escape pod is always a positive act:

- the rescue immediately begins recovery of the `AWAITING_RECOVERY` captain to a safe system;
- it strongly improves the rescued captain's relationship with the rescuer;
- it creates a notable direct memory fact;
- it is treated as a major favourable event.

Ignoring an escape pod is neutral because the captain may be unable or unwilling to perform a rescue.

Attacking and destroying an escape pod is criminal activity. Destroying the physical pod prevents player rescue but does not cause permanent death when the destroyed captain has a valid stored clone backup; automated recovery still occurs after the configured delay.

---

## 11. Police, legality, inferred activity, and bounties

### 11.1 Inferred activity, not role labels

Phase 0 does not assign or store pirate, bounty-hunter, or trader roles.

These words describe patterns of action:

- **Pirate activity** — attempting coercive demands, stealing cargo or credits, looting a surrendered captain, or attacking for loot.
- **Bounty-hunting activity** — seeking and destroying wanted captains for police reward or rehabilitation.
- **Trading activity** — completing consensual exchanges or system-market trades for profit.

A captain may perform any combination of these activities over time. The game may record and summarise the actions in history, reputation, news, or dialogue, but no authoritative role field controls what the captain is allowed to do.

### 11.2 Automatic post-encounter reporting

When an encounter reaches a terminal result, the Encounter DO automatically reports all relevant legal events as part of settlement. No surviving witness, nearby captain, or police presence is required.

The report derives from the authoritative encounter log and includes where applicable:

- attempted piracy;
- completed coercive transfer or theft;
- unprovoked attack;
- lawful return fire;
- ship destruction;
- escape-pod attack or destruction;
- wanted-target destruction;
- bounty eligibility and payment;
- police-record changes.

The report, police deltas, bounty changes, and encounter result are idempotent under the same `encounter_id`. They are never applied from client claims or dialogue.

Attempted piracy receives a smaller police penalty than completed theft. Completed criminal penalties scale with the seriousness of the act and the value or proportion taken. Exact numeric weights are versioned tuning values.

### 11.3 Police record and wanted status

Police standing uses a `-100..+100` range:

- `-100`: attack on sight;
- `-99` to `-31`: wanted;
- `-30` to `+30`: ordinary standing;
- `+31` to `+100`: trusted.

A captain becomes wanted immediately when their police record reaches `-31` or lower. Wanted status is a police classification, not a pirate role.

A wanted captain:

- has an active police bounty;
- receives increased police-interception weighting when police are in plausible range;
- may be lawfully destroyed by another captain;
- remains free to trade, travel, fight, or commit further crimes unless stopped by an encounter or other normal lock.

The bounty is derived from the current wanted severity:

```text
wanted_severity = clamp(-30 - police_record, 1, 70)
bounty = base_wanted_bounty + wanted_severity * bounty_per_point
```

`base_wanted_bounty` and `bounty_per_point` are versioned tuning values. Further crimes worsen the police record and therefore increase the bounty. At `-100`, the captain has the maximum Phase 0 police bounty.

Phase 0 has no player-funded or private bounties.

### 11.4 Lawful and unlawful actions

- Destroying a captain who was wanted immediately before destruction is lawful.
- Destroying a captain who was not wanted immediately before destruction is criminal, even if that captain behaved aggressively during the encounter.
- Returning fire or defending oneself without destroying a non-wanted aggressor is not itself criminal.
- Initiating an unprovoked attack against a non-wanted captain is criminal even if no ship is destroyed.
- Coercive demands, surrender looting, and other non-consensual transfers are theft and are criminal.
- Theft remains theft when the victim is wanted.
- Attacking or damaging a wanted captain is not itself criminal, but grants no reward or police improvement by itself. If the target escapes or survives, the attacker receives no bounty and no standing improvement.
- Destroying or attacking an escape pod is criminal as defined in section 10.4.

The target's wanted status is captured immediately before the terminal destruction result and used for the lawful-kill decision. This keeps the rule deterministic and prevents the same settlement from first making a victim wanted and then retroactively legalising their destruction.

### 11.5 Bounty payment and police rehabilitation

Police bounties are paid only for confirmed destruction. Phase 0 has no prisoner, arrest-delivery, surrender-for-bounty, or cargo-seizure reward.

When a non-wanted captain destroys a wanted captain:

- the kill is lawful;
- the killer receives the target's active police bounty;
- the killer receives a standard police-standing improvement proportional to the target's wanted severity;
- the event is recorded as bounty-hunting activity.

When a wanted captain destroys another wanted captain:

- the kill is lawful;
- the killer receives no bounty payment;
- the killer receives an enhanced police-standing improvement, using a Phase 0 default multiplier of `2.0` over the standard rehabilitation award;
- the event is recorded as bounty-hunting activity;
- the killer may rehabilitate out of the wanted band through repeated lawful destructions.

Bounty eligibility is determined from the killer's police standing immediately before the target's destruction. A wanted killer who becomes non-wanted because of that kill still receives no bounty for that kill, but becomes eligible for later bounties.

Combat is one-on-one in Phase 0, so there is no contribution splitting. The bounty and police award are applied once under the unique `encounter_id` and destruction event.

If the destroyed wanted captain survives through an escape-pod package and automated or player rescue:

- the old bounty is considered satisfied and cleared;
- their police record is reset to `-30`, the neutral boundary immediately above wanted;
- any later criminal penalty of at least one point returns them immediately to `-31` or lower and creates a new bounty from the new wanted severity.

If the destroyed wanted captain dies permanently, the bounty is cleared and the legal record ends with that identity.

### 11.6 Surrender to police

For Phase 0, surrendering to police:

- confiscates illegal cargo;
- charges a fine;
- avoids combat;
- does not automatically reset police standing;
- does not imprison the captain or seize the ship;
- does not satisfy or pay a police bounty.

A modest unpaid fine may become debt. If the captain becomes economically unviable, the player may retire the identity and start again. Retirement is available at any time while the captain is otherwise eligible to retire, not only in police custody.

Exact fine and debt thresholds are tuning values.

---

## 12. Shared economy

### 12.1 Equilibrium

The original *Space Trader* rules are the baseline for:

- commodity availability;
- equilibrium price;
- tech-level effects;
- government and resource modifiers;
- fuel, repairs, ships, and equipment.

The multiplayer economy adds stock and pressure around that baseline.

### 12.2 Stock and pressure

Each system market holds finite stock for each commodity.

- Buying reduces stock and raises price pressure.
- Selling increases stock and lowers price pressure.
- Humans and NPCs affect the same market.
- Market pressure is bounded.
- Stock and pressure recover gradually toward equilibrium.

### 12.3 Progressive order pricing

A multi-unit order is priced progressively rather than applying the first displayed price to every unit.

- Each unit or small batch is priced against the progressively changing stock/pressure state.
- The terminal shows the full total before confirmation.
- The reservation locks that total.
- Stock and pressure change only when the transaction commits.

### 12.4 Price function

Phase 0 uses an explicit basis-point price function, versioned in the rules package:

```text
stock_ratio =
    clamp((target_stock - current_stock) / max(1, target_stock), -1, +1)

stock_adjustment_bps =
    round(stock_ratio * stock_effect_max_bps)

combined_adjustment_bps =
    clamp(
        stock_adjustment_bps + pressure_bps,
        -total_effect_max_bps,
        +total_effect_max_bps
    )

unit_price =
    max(
        1,
        round(
            equilibrium_price *
            (10000 + combined_adjustment_bps) /
            10000
        )
    )
```

`pressure_bps` is itself clamped to `±pressure_max_bps`. Buying decreases stock and increases pressure; selling increases stock and decreases pressure.

Phase 0 defaults, pinned in `ruleset-phase0-v1`:

```text
stock_effect_max_bps = 2500     -- ±25%
pressure_max_bps     = 1500     -- ±15%
total_effect_max_bps = 4000     -- ±40%
```

Progressive orders (section 12.3) quote against this function unit by unit:

1. calculate the next unit price;
2. apply the hypothetical one-unit stock and pressure movement;
3. calculate the following unit price;
4. continue until the full quantity is quoted;
5. commit none of those movements until the reservation commits.

### 12.5 Recovery

Each market has a target stock derived from the original economy rules.

Recovery moves a percentage of the remaining gap toward target rather than adding a flat amount:

```text
stock_recovery =
    round((target_stock - current_stock) * stock_recovery_rate)

pressure_recovery =
    round((0 - pressure_bps) * pressure_decay_rate)
```

Elapsed recovery periods are applied deterministically before any quote.

The System DO stores a last-recovery timestamp and applies accumulated replenishment and pressure decay when it wakes or receives a request. A scheduled world process may still handle galaxy-wide events and NPC movement.

Exact percentages and decay rates are provisional simulation values.

---

## 13. Architecture

### 13.1 Authority map

| State | Authoritative owner | D1 role |
|---|---|---|
| Credits, bank, debt | Captain DO | Projection/history |
| Cargo | Captain DO | Projection |
| Ship, fuel, hull, equipment | Captain DO | Projection |
| Captain status, location, active trip | Captain DO | Projection/search |
| Human behaviour profiles and proxy mode | Captain DO | Projection/private view |
| NPC fixed profiles | NPC Captain DO | Projection |
| NPC direct relationship memory | NPC Captain DO | Projection/history |
| Police record and derived active bounty | Captain DO | Projection/history |
| Market stock, pressure, reservations | System DO | Projection/analytics |
| Local roster and travel-tick presence | System DO | Optional projection |
| Active encounter rounds | Encounter DO | None until settlement |
| Encounter result and log | Encounter DO until complete | Durable history |
| Galaxy configuration, seasons, accounts | D1 | Authoritative |
| News and public history | D1 | Authoritative |

Each human and NPC captain has a Captain DO. Humans and NPCs therefore share the same authoritative state shape.

### 13.2 Captain DO responsibilities

The Captain DO owns and serialises:

- all captain economic state;
- ship and cargo state;
- travel and location state;
- active encounter participation;
- behaviour profiles;
- police record and derived active bounty;
- proxy mode;
- pending transactions and settlement locks;
- retirement, destruction, and escape-pod recovery state.

It rejects incompatible concurrent operations automatically through its single-threaded authority boundary.

### 13.3 System DO responsibilities

One System DO per solar system owns:

- live market state;
- stock and price pressure;
- short-lived economic reservations;
- local docked roster;
- current approach/travel-tick presence;
- eligible captain encounter selection;
- local police presence/weighting;
- wreck/debris encounter pool;
- elapsed-time market recovery.

### 13.4 Encounter DO responsibilities

One Encounter DO per active encounter owns:

- participants and controller type;
- round state machine;
- hidden submitted actions;
- deadlines and disconnect grace handling;
- proxy action requests;
- deterministic resolution;
- minimal round audit context;
- irreversible final result;
- bilateral encounter-trade and surrender-claim settlement;
- legal-event classification, automatic crime reporting, and bounty eligibility;
- settlement coordination across Captain DOs and any System DO effects;
- final D1 history/projection write.

### 13.5 D1 responsibilities

D1 stores:

- accounts and authentication records;
- private account-to-captain/controller mappings where required;
- public captain projections that exclude controller type;
- searchable rosters and profiles;
- galaxy configuration;
- market projections;
- completed trades and economic history;
- completed encounter history;
- activity, crime, kill, bounty, police, relationship, and retirement history;
- news, events, seasons, and leaderboards.

D1 is not independently allowed to mutate state owned by a DO. Human/NPC/controller classification is private server-side information. If projected for administration or diagnostics, it must be stored separately from public captain data and must never be returned by ordinary player-facing APIs.

### 13.6 Phase 0 authentication

Phase 0 uses the simplest practical account model for the controlled test group:

- email magic-link sign-in;
- secure HTTP-only session cookie;
- server-side session record in D1;
- one active captain identity per account.

The authentication provider is replaceable, but gameplay code depends only on the resolved account and captain identity.

---

## 14. Cross-object transaction model

Every economic or settlement command has a unique `operation_id` and is idempotent.

### 14.1 Cargo trade flow

The Captain DO coordinates the trade:

1. Worker authenticates the request and forwards one command to the Captain DO.
2. Captain DO validates location, status, funds, capacity, and locks incompatible actions.
3. Captain DO asks the System DO for a short-lived reservation and final progressive quote.
4. System DO records reservation quantity and locked price under `operation_id`.
5. Captain DO applies its pending credit/cargo change.
6. Captain DO confirms the reservation.
7. System DO commits stock and pressure changes.
8. Captain DO writes the completed trade and projections to D1.
9. The transaction becomes `COMPLETE` and locks clear.

### 14.2 Reservation rules

- Active reservation lifetime is short, provisionally around five seconds.
- The reservation price is final.
- Market pressure changes only on commit.
- An expired active lock remains recoverable by `operation_id` for a longer reconciliation period.
- The same operation may be retried without duplicating state.
- The player cannot manually cancel once the Captain DO has applied its side.

### 14.3 Pending and projection locks

Captain-side transaction states:

```text
RESERVED
CAPTAIN_COMMITTED
SYSTEM_COMMITTED
PROJECTING_TO_D1
COMPLETE
```

System-side reservation states:

```text
HELD
COMMIT_REQUIRED
COMMITTED
CANCELLED
```

Once the Captain DO reaches `CAPTAIN_COMMITTED`, the System DO reservation must be promoted to or recoverable as `COMMIT_REQUIRED`. From that point it may not expire, cancel, reprice, or release its stock to another operation. It remains recoverable by `operation_id` until committed.

Until `COMPLETE`:

- further economic actions are blocked;
- departure is blocked;
- combat and incoming encounters are blocked;
- non-economic interaction remains available, such as talking to a merchant or reading news.

If the System DO is temporarily unavailable, affected assets remain pending and locked until reconciliation establishes whether the market committed.

Timeout alone never triggers rollback. The coordinator queries status using the same `operation_id`; an unknown or ambiguous response is retried rather than interpreted as failure.

Every operation stores a canonical request hash and expected delta hash. Reuse of the same `operation_id` with different content is rejected and raised as an integrity error. The same ID with the same content always returns the previously stored state or result.

If both DOs committed but D1 projection fails, gameplay state remains fixed and the Captain DO retries the idempotent D1 projection until it succeeds. The transaction remains incomplete and economically locked until D1 confirms the projection. Only then may it enter `COMPLETE` and release its locks.

D1 projection rules:

- completed-operation tables have a unique constraint on `operation_id`;
- all rows belonging to one completed projection are written in one D1 transaction or batch;
- a duplicate insert with the same projection hash is treated as success;
- a duplicate identifier with different content is an integrity fault requiring administrative attention, not automatic overwrite;
- administrative tools may inspect and retry an operation but may not fabricate rollback after authoritative commit.

### 14.4 Durable retry scheduling

Each Captain, System, and Encounter DO maintains a persisted queue of due work. Because a Durable Object has one alarm slot, one queue and one alarm multiplex all local deadlines and retries, including:

- D1 projection retries;
- cross-object reconciliation;
- encounter action deadlines and disconnect grace expiry;
- claim expiry;
- market recovery wake-ups where needed;
- escape-pod and automated-recovery events;
- relationship-decay maintenance where materialised.

The queue stores task type, idempotency key, due time, attempt count, and last error classification. The alarm handler processes all due tasks within a bounded work budget, persists their outcomes, and schedules the next alarm for the earliest remaining task.

Retries use bounded exponential backoff with deterministic jitter. Automatic retries are never abandoned for authoritative committed work. Repeated failures create an administrative alert while retaining the task and gameplay lock.

### 14.5 Other economic actions

Fuel, repairs, upgrades, ship purchases, and bank transfers use the same transaction framework.

Some involve only the Captain DO and D1; others may require another authoritative DO. They still use:

- operation IDs;
- idempotency;
- explicit transaction states;
- D1 projection before completion.

---

## 15. Encounter settlement

### 15.1 Irreversible result and lifecycle

Once the rules engine reaches a terminal encounter outcome, that result is final.

The internal encounter lifecycle is:

```text
CONTACT
NEGOTIATION
COMBAT
TERMINAL
SETTLING
PROJECTING_TO_D1
COMPLETE
```

`TERMINAL` freezes the mechanical result. `SETTLING` applies authoritative deltas. `PROJECTING_TO_D1` writes history and projections. There is no timeout rollback.

### 15.2 Settlement flow

1. Encounter DO freezes the terminal result.
2. It derives captain deltas, bilateral trade or surrender transfers, relationship changes, behaviour-profile changes, inferred activity events, automatic crime reports, police changes, bounty rewards, destruction, and wreck effects from the full log.
3. Each affected Captain DO applies its delta idempotently and remains locked. The same `encounter_id` and delta hash is accepted repeatedly; the same ID with different delta content is rejected as an integrity fault.
4. Any System DO effect, such as creating wreck debris, commits idempotently.
5. Encounter DO waits for all acknowledgements.
6. Encounter DO writes the final encounter record and projections to D1 in one atomic D1 transaction or batch, protected by unique `encounter_id` constraints and a projection hash.
7. Both captains are released only after the D1 write succeeds or an identical prior projection is confirmed.

If a Captain DO, System DO, or D1 projection is unavailable, the encounter remains in `SETTLING` and retries idempotently until every authoritative delta and D1 projection succeeds. The terminal result is never rolled back or replaced. Neither captain may trade, travel, retire, or begin another encounter until the encounter reaches `COMPLETE`.

### 15.3 Profile and relationship calculation

Behaviour-profile and relationship changes are calculated once at settlement from the full encounter log.

They are not written mid-round.

The classifier considers:

- who initiated conflict;
- who escalated or attempted to disengage;
- rational-withdrawal strength assessment;
- consensual trade, demand, surrender, and surrender-claim context;
- the value and proportion removed through coercion;
- wanted status captured at the required legal decision point;
- whether actions were human- or proxy-controlled.

Proxy-controlled actions do not train human learned profiles.

### 15.4 Minimal audit data

Each round stores only what is required to reproduce and classify it:

- submitted actions;
- resolved result;
- relevant hull/shield state;
- hidden matchup classification;
- initiation/escalation/disengagement context;
- legal, wanted, bounty-eligibility, and crime-classification context where relevant;
- ruleset version;
- RNG position.

A final summary records the complete terminal state and settlement deltas.

---

## 16. Deterministic ruleset

### 16.1 Baseline

Phase 0 ports the original *Space Trader* rules as the baseline for:

- commodity and tech-level tables;
- equilibrium pricing;
- ship and equipment statistics;
- combat hit, damage, defence, and flee formulas;
- fuel, repair, and upgrade rules;
- core police and bounty concepts;
- escape-pod fundamentals.

The new project must still express these rules explicitly in its own versioned rules package rather than relying on developers to consult the original source ad hoc.

The ported baseline lives in `proposals/rules-kernel/space-trader-ruleset` (`@sto/original-baseline-rules`, GPL-2.0-or-later, golden-tested against PalmOS Space Trader 1.2.2). It is a known-working single-player baseline, not settled multiplayer balance. Three areas are expected to need MMO-specific rework:

- trade margins under multi-captain arbitrage — the original spreads were tuned for one trader, and shared pressure may compress every profitable route;
- combat pacing under symmetric PvP — the original hit, damage, and flee formulas were tuned in the player's favour against generated opponents;
- long-run money supply — trading faucets versus fuel, repair, insurance, fine, and interest sinks were never balanced for a persistent world.

Rebalancing is always delivered as a new named ruleset version layered over the unchanged baseline package. The baseline library itself is never edited for balance.

Before Phase 0 tuning is accepted, the offline simulation harness (section 20.1) must exercise the kernel — thousands of simulated captain-days of ambient NPC trading against the market model, and scripted encounter matchups through the resolver — to confirm that profitable routes persist, combat is not degenerate, and the money supply is stable.

### 16.2 New multiplayer rules

The STO rules package must explicitly define:

- simultaneous action-pair resolution;
- atomic bilateral encounter trades;
- player-selected surrender claims and proportional hostility effects;
- automatic crime reporting, wanted status, bounty calculation, and rehabilitation;
- shared stock and pressure;
- the explicit price function, progressive order pricing, and recovery formulas;
- travel-tick captain matching and companion travel groups;
- proxy takeover;
- behaviour-profile movement;
- relationship movement and decay;
- the police encounter flow and police encounter weighting;
- ordinary NPC policy weights, demand sizing, offer pricing, and surrender-claim fractions;
- cross-object settlement rules;
- wreck persistence and cargo survival.

### 16.3 Versioning and RNG

Each trip and encounter stores:

- seed;
- PRNG algorithm/version;
- ruleset version;
- current draw position or generated schedule;
- final generated outcomes where needed for historical stability.

A later code or balance change must not reinterpret an existing journey or encounter.

### 16.4 Numeric representation

Use integer or fixed-point arithmetic where practical for:

- credits;
- stock;
- hull, shields, fuel;
- behaviour and hostility scores;
- pressure and probability weights.

Every formula must define rounding, clamping, minimums, and maximums.

### 16.5 Initial ruleset pin

The ported original baseline package and every provisional tuning value in section 21 are bundled into one named, versioned executable configuration:

```text
ruleset-phase0-v1
```

- `ruleset-phase0-v1` is the first executable rules package and the default for all Phase 0 play.
- Automated tests must name the exact ruleset version they run against; no test may rely on unpinned defaults.
- Tuning changes create a new ruleset version. Existing trips and encounters keep the version they started with, per section 16.3.

---

## 17. Lifecycle rules

### 17.1 Captain lifecycle

```text
ACTIVE
TRAVELLING
ENCOUNTER_CLAIMED
IN_ENCOUNTER
SETTLING
AWAITING_RECOVERY
RECOVERING
RETIRED
DEAD
```

- `ACTIVE` may trade, upgrade, retire, or begin travel if no operation lock exists.
- `TRAVELLING` may advance approach steps and be claimed for an encounter.
- `ENCOUNTER_CLAIMED` permits only claim completion, claim release, or administrative inspection.
- `IN_ENCOUNTER` permits encounter actions only.
- `SETTLING` permits no new gameplay action.
- `AWAITING_RECOVERY` permits reconnecting, viewing status, and receiving rescue, but no economic or travel action.
- `RECOVERING` applies the replacement ship and safe-system transition and remains locked until D1 projection succeeds.
- `RETIRED` and `DEAD` are terminal.

Every transition is initiated by an idempotent command and records its operation or encounter ID. Lifecycle state and incompatible-operation locks are checked together by the Captain DO.

### 17.2 Escape-pod lifecycle

```text
AVAILABLE
RESCUE_CLAIMED
RESCUED
DESTROYED
EXPIRED
AUTOMATED_RECOVERY
COMPLETE
```

- Only `AVAILABLE` may be claimed for rescue or attacked.
- Rescue claims expire unless bound to a completed rescue encounter.
- `RESCUED` immediately schedules captain recovery.
- `DESTROYED` and `EXPIRED` schedule automated recovery when a valid clone backup exists.
- Rescue, destruction, expiry, and automated recovery are idempotent and mutually exclusive terminal paths for the physical pod.

### 17.3 Rescue relationship and history

- If the rescued captain is an NPC, its own Captain DO applies a major favourable hostility shift toward the rescuer and stores the direct memory fact.
- If the rescued captain is human, no private numeric relationship score is invented. The rescue is stored in encounter history and may affect public reputation or later human-facing history features.
- The rescuer never receives privileged knowledge of whether the rescued captain is human or NPC.

## 18. Data model outline

The live authoritative schema is split across DO-local SQLite storage. D1 stores projections and completed history.

### 18.1 Captain DO local storage

```sql
captain_state(
  captain_id TEXT PRIMARY KEY,
  kind TEXT CHECK(kind IN ('human','npc')),
  handle TEXT,
  credits INTEGER,
  bank INTEGER,
  debt INTEGER,
  system_id TEXT,
  status TEXT,
  ship_type TEXT,
  hull INTEGER,
  shields INTEGER,
  fuel INTEGER,
  weapons_json TEXT,
  equipment_json TEXT,
  police_record INTEGER,
  combat_profile INTEGER,
  trade_profile INTEGER,
  proxy_mode TEXT,
  active_trip_id TEXT NULL,
  active_encounter_id TEXT NULL,
  lifecycle_state TEXT,
  updated_at INTEGER
);

cargo(
  good TEXT PRIMARY KEY,
  qty INTEGER,
  avg_cost INTEGER
);

captain_operations(
  operation_id TEXT PRIMARY KEY,
  operation_type TEXT,
  state TEXT,
  request_hash TEXT,
  delta_hash TEXT,
  request_json TEXT,
  result_json TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

npc_relationships(
  other_captain_id TEXT PRIMARY KEY,
  hostility_score INTEGER,
  facts_json TEXT,
  last_met_at INTEGER,
  locked_extreme INTEGER
);
```

### 18.2 System DO local storage

```sql
market_state(
  good TEXT PRIMARY KEY,
  equilibrium_price INTEGER,
  pressure_fixed INTEGER,
  stock INTEGER,
  target_stock INTEGER,
  updated_at INTEGER
);

market_reservations(
  operation_id TEXT PRIMARY KEY,
  captain_id TEXT,
  good TEXT,
  quantity INTEGER,
  locked_total INTEGER,
  state TEXT,
  request_hash TEXT,
  active_expires_at INTEGER,
  reconcile_expires_at INTEGER
);

travel_presence(
  captain_id TEXT PRIMARY KEY,
  route_area TEXT,
  approach_tick INTEGER,
  occupancy_started_at INTEGER,
  occupancy_ends_at INTEGER,
  encounter_id TEXT NULL,
  status TEXT,
  updated_at INTEGER
);

wreck_pool(
  wreck_id TEXT PRIMARY KEY,
  cargo_json TEXT,
  escape_pod_captain_id TEXT NULL,
  pod_state TEXT NULL,
  recovery_due_at INTEGER NULL,
  expires_at INTEGER
);
```

### 18.3 Encounter DO local storage

```sql
encounter_state(
  encounter_id TEXT PRIMARY KEY,
  phase TEXT,
  round_no INTEGER,
  ruleset_version TEXT,
  rng_state TEXT,
  pending_trade_offers_json TEXT NULL,
  pending_demand_json TEXT NULL,
  surrender_victor_id TEXT NULL,
  surrender_snapshot_json TEXT NULL,
  result_json TEXT NULL,
  result_hash TEXT NULL,
  updated_at INTEGER
);

participants(
  captain_id TEXT PRIMARY KEY,
  controller TEXT,
  connected INTEGER,
  grace_expires_at INTEGER NULL,
  settlement_state TEXT
);

rounds(
  round_no INTEGER PRIMARY KEY,
  actions_json TEXT,
  context_json TEXT,
  result_json TEXT
);
```

### 18.4 Common Durable Object scheduling storage

Each Captain, System, and Encounter DO has its own local copy of:

```sql
scheduled_tasks(
  task_id TEXT PRIMARY KEY,
  task_type TEXT,
  idempotency_key TEXT,
  due_at INTEGER,
  attempt_count INTEGER,
  payload_json TEXT,
  last_error TEXT NULL
);
```

### 18.5 D1 projections and history

```sql
accounts(...);

captains_projection(
  id TEXT PRIMARY KEY,
  handle TEXT,
  system_id TEXT,
  status TEXT,
  ship_type TEXT,
  police_record INTEGER,
  active_bounty INTEGER, -- derived from projected police_record and ruleset
  public_disposition TEXT,
  lifecycle_state TEXT,
  updated_at INTEGER
);

captain_controller_private(...); -- never exposed through public player APIs
-- No pirate, trader, or bounty-hunter role column exists.
systems(...);
market_projection(...);
completed_trades(...);
completed_encounters(...);
captain_activity_events(...); -- descriptive history only; no role label
crime_events(...);
kill_events(...);
bounty_events(...);
relationship_projection(...);
news(...);
seasons(...);
```

The final schema may vary, but authority boundaries must not.

---

## 19. NPC behaviour interface

Phase 0 uses a fixed, pure behaviour function:

```ts
decide(
  encounterState,
  captainProfile,
  relationshipMemory
) => {
  action: 'ATTACK' | 'FLEE' | 'HAIL' | 'IGNORE' |
          'DEMAND' | 'TRADE_OFFER' | 'ACCEPT_TRADE' |
          'SURRENDER' | 'COMPLY' | 'SURRENDER_CLAIM',
  params: Record<string, unknown>,
  messageKey?: string
}
```

The resolver validates the action and parameters regardless of source.

The same interface supports:

- ordinary NPC captains;
- disconnected-player proxies;
- later LLM-backed NPC decisions.

In Phase 0:

- NPC profiles are fixed;
- learned human proxies use the deterministic weighted policy defined in section 6.3;
- generic coward proxies use their fixed escape-first policy;
- all controllers receive only information permitted by the information-parity rules;
- dialogue is selected from canned banks;
- no model or controller can mint credits, bypass damage, inspect private controller type, invent a role label, or invent illegal actions.

### 19.1 Ordinary NPC policy

Ordinary NPC captains use a deterministic priority policy over their fixed profiles and direct relationship memory. The disconnected-player proxy policy (section 6.3) cannot stand in for it, because an ordinary NPC also has hostility memory and its own economic goals. Earlier rules take precedence:

1. **Permanent friendship (`-100`)** — never initiate attack or demand; prefer `HAIL`, a fair `TRADE_OFFER`, or `IGNORE`; accept reasonable affordable exchanges; take nothing after a surrender unless attacked earlier in that encounter.
2. **Permanent grudge (`+100`)** — attack unless clearly outmatched; flee if clearly outmatched; never trade or comply voluntarily.
3. **Wanted target** — a non-wanted NPC may attack a wanted target when its deterministic strength assessment is favourable; a wanted NPC may do the same for police rehabilitation, receiving no bounty.
4. **Hostile relationship** — an aggressive combat profile favours `DEMAND` and `ATTACK`; neutral favours `HAIL`, `IGNORE`, or retaliation; passive favours `FLEE` or disengagement.
5. **Favourable relationship** — prefer `HAIL`, trade, and disengagement; never initiate combat unless the other captain is wanted and rule 3 applies.
6. **Neutral relationship** — the trade-profile band sets the probability of offering or accepting trade; the combat-profile band sets the probability of demand, attack, ignore, or flee; the choice is deterministic from the encounter seed and RNG position.
7. **During combat** — return fire unless the strength assessment indicates rational withdrawal; passive profiles flee or surrender earlier; aggressive profiles continue longer; NPCs never inspect hidden opponent state (section 7.7).
8. **Surrender claims** — passive profiles normally take nothing; neutral takes a modest deterministic fraction; aggressive or hostile takes a larger deterministic fraction; a claim never exceeds the revealed surrender inventory.

The rules package must define the actual action weights, demand sizes, trade-offer pricing bounds, and surrender-claim fractions for each profile band — "favours" is prose, not an implementable rule. All values are pinned in `ruleset-phase0-v1`.

### 19.2 Later LLM integration

A later LLM controller must use the same `decide()` contract. Player text is passed as untrusted quoted input, and model output is validated against the legal action enum and parameter rules. Invalid, slow, or unavailable model responses fall back to the fixed policy.

The LLM may choose legal actions and generate dialogue, but it can never alter credits, damage, cargo, movement, probabilities, or settlement. Ambient NPC simulation remains deterministic and does not require LLM calls.

---

## 20. Phase 0 implementation sequence

### 20.1 Rules kernel

Build a Cloudflare-independent TypeScript package containing:

- original baseline data and formulas;
- deterministic PRNG wrapper;
- travel sequence generator;
- progressive market quote logic;
- simultaneous encounter resolver;
- police encounter state machine;
- ordinary NPC decision policy;
- canonical bilateral trade-offer and atomic exchange logic;
- surrender-claim valuation and hostility curve;
- combat strength assessor;
- behaviour and relationship classifiers;
- inferred activity, crime reporting, destruction, bounty, police rehabilitation, and wreck rules;
- an offline simulation harness: ambient NPC captain-day economy runs and scripted encounter matchups used to validate balance before and after every ruleset version change.

Success criteria: identical state, seed, and ruleset version always produce the same result; and under `ruleset-phase0-v1` the simulation harness shows persistent profitable trade routes, non-degenerate combat, and a stable money supply.

### 20.2 Captain and System DO vertical slice

Build:

- Captain DO authority;
- one or two System DOs;
- shared market;
- progressive trade transaction;
- travel ticks;
- named NPC captains;
- D1 projections.

Success criterion: the core loop is playable, travel claims cannot double-match a captain, failed claims release cleanly, and no retry duplicates economic state.

### 20.3 Encounter and proxy slice

Build:

- Encounter DO;
- simultaneous hidden actions;
- human-vs-NPC and human-vs-human encounters;
- hidden disconnect grace;
- learned/coward proxy modes;
- settlement across Captain DOs;
- private reconnect summary.

Success criterion: the complete ordered action-pair table resolves deterministically, disconnecting never removes consequences or provides a superior strategy, and no controller-type information leaks through payloads, timing, error handling, or presentation.

### 20.4 Relationships, police, and destruction

Build:

- direct NPC relationship memory;
- proportional surrender grievances and mercy;
- friendship/grudge extremes;
- escape pods and permanent death;
- wreck and rescue encounters;
- automatic crime reporting, police records, wanted-state bounties, and rehabilitation;
- retirement.

Success criterion: persistent named captains create recognisable stories without an LLM, and an escape-pod-equipped captain can always progress from `AWAITING_RECOVERY` through rescue or automated recovery.

### 20.5 Playtest gate

Phase 0 succeeds if:

- testers repeatedly choose to make another journey;
- trading and ship progression are enjoyable;
- testers cannot reliably identify NPCs solely from encounter presentation;
- relationships produce memorable repeat encounters;
- PvP and mobile disconnect handling feel fair;
- no duplication or partial-settlement exploit is found under forced retries and DO restarts.

---

## 21. Provisional tuning values

The following are intentionally not final and should be adjusted through simulation and playtesting:

- approach ticks per journey: approximately 15–20;
- global travel-tick window duration;
- failed encounter-claim timeout and release delay;
- base disconnect grace period: short mobile-friendly window; the first/half/immediate escalation rule is fixed;
- active trade reservation: approximately five seconds;
- reservation reconciliation retention;
- general hostility changes: minor 5, major 10, betrayal 50;
- surrender hostility curve: mercy `-10`, non-zero claim `ceil(5 + 45 * removed_fraction)`;
- hostility-score decay: one point per day toward zero after a grace period;
- friendly-travel hostile-encounter reduction;
- cargo survival percentage after destruction;
- wreck lifetime;
- escape-pod automated recovery: Phase 0 default five minutes after destruction;
- attempted-piracy, completed-theft, unprovoked-attack, unlawful-destruction, and escape-pod crime penalties;
- wanted bounty base and per-severity-point values;
- standard wanted-destruction rehabilitation award; wanted-killer multiplier defaults to `2.0`;
- stock target and replenishment percentages;
- pressure effect and decay;
- price-function caps: stock effect ±2500 bps, pressure ±1500 bps, total ±4000 bps;
- police contact-type selection weights, inspection fines, and confiscation penalties;
- ordinary NPC action weights, demand sizing, offer pricing bounds, and surrender-claim fractions per profile band;
- rational-outmatch strength threshold;
- encounter probabilities and random weights.

These values do not block implementation because their interfaces and ownership are now defined. Their initial executable values are pinned in `ruleset-phase0-v1` (section 16.5).

---

## 22. Later-phase opportunities

Once Phase 0 proves the core game:

- LLM-generated NPC dialogue and free-text hails;
- NPC-initiated messages, deals, warnings, and requests;
- richer memory and rumours;
- NPC learning and evolving profiles;
- retired captains becoming system workers or contacts;
- companions joining multi-party combat;
- pursuit, ambushes, and indirect grudge behaviour;
- prisoner capture, arrest delivery, private bounties, police missions, amnesty, and bribery;
- factions, guilds, stations, and territory;
- seasons and persistent museums/history.

---

## 23. Architectural rule of record

> Each mutable game invariant has exactly one authoritative Durable Object. D1 stores completed history and queryable projections, but never independently mutates state owned by a Durable Object. Cross-object operations use idempotent reservation, commit, projection, and retry protocols. Once authoritative state commits, its D1 projection must retry until successful, and affected gameplay remains locked until synchronisation is complete.

This rule, together with the versioned deterministic ruleset, is the foundation for Phase 0.
