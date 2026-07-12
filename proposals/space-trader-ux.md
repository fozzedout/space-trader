# Design Document: User Flow and Client UX

**Companion to:** `proposals/space-trader-design.md` (Phase 0 build-ready design v0.6)
**Status:** UX design v0.3
**Scope:** The player-facing flow for every Phase 0 mechanic. This document adds no new mechanics; every screen and transition below is the presentation of a state machine already defined in the main design. Coverage is tracked in §12.

---

## 1. Principles

1. **The client renders authoritative state; it never predicts it.** Every screen is a projection of the captain view returned by the server. Optimistic UI is forbidden for anything the server settles (credits, cargo, encounter results). The client may only pre-render *choices*, never *outcomes*.
2. **Lifecycle state selects the screen.** The captain lifecycle (design §17.1) is the top-level router. The player can never navigate to a screen their lifecycle state forbids; forbidden actions are absent, not disabled-with-an-error.
3. **Locks are shown as in-fiction waiting, not as errors.** Transaction and settlement locks (design §14.3, §15.2) appear as short diegetic waits ("transmitting manifest…"), and the UI blocks exactly the actions the lock blocks — nothing more.
4. **No controller-type leakage.** Nothing in layout, timing, copy, or presentation may differ between an NPC opponent and a human opponent (design §7.7). This includes loading indicators and response latency masking.
5. **Low-graphics ethos, mobile first.** Single-column layout, large touch targets, no gesture-only controls, playable one-handed. Everything readable in text; graphics are flavour.
6. **Every dead end has an exit.** Death, retirement, stranding, and recovery states must always present the player's next action on the same screen.

---

## 2. Top-level client state machine

The client owns one router keyed on the captain view:

| Server state | Screen |
|---|---|
| No session | **Sign-in** |
| Session, no active captain | **Captain creation** |
| `ACTIVE`, docked | **Docked hub** |
| `TRAVELLING` | **Approach** |
| `ENCOUNTER_CLAIMED` | **Approach** (contact resolving; input suspended) |
| `IN_ENCOUNTER` | **Encounter** |
| `SETTLING` | **Settlement wait** (overlay on last screen) |
| `AWAITING_RECOVERY` | **Adrift** |
| `RECOVERING` | **Recovery wait** |
| `RETIRED` / `DEAD` | **Epilogue → Captain creation** |

The client polls or subscribes for captain-view changes; on reconnect or app resume it re-fetches the view and routes from scratch. There is no client-side memory of "where the player was" that can disagree with the server.

---

## 3. Onboarding

### 3.1 Sign-in

1. Email entry → "send magic link".
2. The same screen shows "check your email"; the link opens the client and completes the session (design §13.6). No password, no username at this stage.
3. Returning sessions skip straight to routing (§2).

### 3.2 Captain creation

Shown when the account has no active captain (first sign-in, or after death/retirement).

- Choose a **handle** (public, permanent for that identity).
- Confirm the fixed starting package: basic ship, starting credits, starting system.
- One confirmation step, then the captain is created and the player lands on the Docked hub.

There is no build customisation in Phase 0; creation is deliberately under a minute.

### 3.3 First-dock orientation

The first dock for a fresh captain overlays three short dismissible callouts (market, travel, ship). No modal tutorial, no forced sequence. The callouts never reappear for that captain.

---

## 4. Docked hub

The hub is a tab bar over a persistent status strip.

**Status strip (always visible while docked or travelling):** handle, current system, carried credits, fuel, hull, and a police-standing badge (band only: trusted / ordinary / wanted / attack-on-sight).

**Tabs:**

- **Dock** — summary, cargo manifest, refuel, repair.
- **Market** — the commodity exchange (§5).
- **Shipyard** — ship purchase/trade-in, equipment including the escape-pod package.
- **Bank** — deposit/withdraw carried credits, debt status.
- **Captain** — public profile as others see it (disposition band, police band, ship class), private profile trends (band + trend only, per design §7.5), proxy-mode selection (§8.3), retirement.
- **Departures** — destination selection and launch (§6.1).

News and leaderboards are D1-backed read views and may ship late in Phase 0 as a seventh tab; nothing else depends on them.

---

## 5. Market flow

The market flow must surface progressive pricing (design §12.3–12.4) honestly:

1. Player picks a commodity and a direction (buy/sell).
2. Player sets a quantity via stepper or "max affordable / max held".
3. The client requests a **progressive quote**; the terminal shows the full total and the effective average unit price before confirmation. The displayed first-unit price is never multiplied client-side.
4. **Confirm** creates the reservation; the quoted total is final (design §14.2).
5. While the transaction runs, the market tab shows the diegetic wait state; other tabs remain browsable but all economic buttons and Departures are suppressed (design §14.3).
6. On `COMPLETE`, cargo, credits, and the market list refresh together from the response.

Quote staleness: a quote is displayed with a short validity window matching the reservation lifetime. If it lapses before confirmation, the confirm button re-quotes instead of submitting.

Fuel, repair, upgrades, ship purchase, and bank transfers reuse this exact quote → confirm → wait → complete pattern.

---

## 6. Travel flow

### 6.1 Departure

- Departures tab lists in-range systems with distance, fuel cost, and remaining fuel after the jump. Out-of-range systems are listed but marked, with the shortfall shown.
- If a strongly favourable NPC has offered to travel together (design §8.6), the offer appears here, attached to the matching destination, in diegetic wording ("Kestrel is heading to Regulas and suggests convoying"). Accepting sets the travel group for that journey only.
- Confirm consumes fuel and performs the hyperspace jump immediately (design §4.1); the client transitions to the Approach screen.

### 6.2 Approach

The Approach screen is a progress track of the ~15–20 ticks with the ship marker advancing.

- Empty ticks **auto-advance** by default: the client submits the next tick as soon as the server confirms the previous one, respecting the server's minimum tick interval (design §4.2). A pause/resume control lets the player stop at the current tick.
- The player never sees or manages route areas, global windows, occupancy, or matching. Those are server concerns; the client only submits "advance" and renders what comes back.
- A tick response may carry an event: **encounter claimed** (input suspends, contact resolves into the Encounter screen), **wreck or pod sighted** (inline card with scoop/rescue/ignore choices, requiring scoop and capacity as applicable, design §10), or **docked** (arrival transition to the hub).
- When travelling with a companion (design §8.6), the Approach screen shows a persistent convoy indicator with the companion's handle. The indicator clears when the agreement ends (arrival, destruction, or break), and the arrival summary notes the completed journey together.
- Closing the app mid-approach pauses the trip (design §4.5). On return, the Approach screen resumes at the same tick.

### 6.3 Arrival

Docking shows a one-screen arrival summary — system name, local police-presence flavour, and one-line market teaser — then the Docked hub. Skippable with one tap.

---

## 7. Encounter flow

This is the highest-stakes UI in the game and the one place the NPC illusion lives or dies.

### 7.1 Contact

The encounter opens with the opponent card, which shows exactly the information-parity set (design §7.7): handle, ship class and visible equipment cues, public disposition band, public police band and bounty flag, and any direct history with this captain ("you have met before"). Nothing else. The card is identical in structure and timing for human and NPC opponents.

### 7.2 Round loop

Each normal round presents:

1. **Action row** — only the actions legal in the current phase (design §5.3). Illegal actions are absent.
2. **Parameter builders** — `DEMAND` opens a small form (credits and/or cargo lines); `TRADE_OFFER` opens a two-column give/get builder over the player's own carried credits and cargo (the opponent side is free-form, since their holdings are private); `ACCEPT_TRADE` shows the exact pending offer it accepts and its hash-bound contents; `HAIL` selects from the canned message bank in Phase 0.
3. **Pending items** — a pending opponent `DEMAND` (design §5.2) stays visible above the action row with its exact contents until it commits, is replaced, or the encounter escalates or ends; `COMPLY` is offered against it, with no indication of whether the player can afford it (the shortfall check is private, design §5.2). A pending `TRADE_OFFER` from either side is shown the same way.
4. **Deadline** — a visible countdown to action lock. The deadline copy is neutral ("response window") and identical regardless of the opponent's controller.
5. **Lock state** — after submission the action row is replaced by "action locked" with the countdown continuing. The player's locked action is shown to them; the opponent's is not.
6. **Resolution reveal** — when the round resolves, both actions and the outcome are revealed together in a short log entry: damage dealt/received, hull/shield deltas, transfers committed, phase change. The log persists for the whole encounter and scrolls.

Round pacing is server-driven. The client never advances a round; it renders resolution when the server reports it.

### 7.3 Surrender claim

On entering `SURRENDER_RESOLUTION` as victor, the claim screen shows the revealed carried credits and cargo (design §5.4) with per-line take/leave selectors and a running total, plus two shortcuts: **take nothing** and **take everything**. The deadline and its take-nothing fallback are shown. The surrendered captain sees a waiting screen with no information about what is being inspected.

### 7.4 Encounter end

Every terminal outcome gets a one-screen summary before returning to the Approach screen (or to Adrift/Epilogue on destruction): what happened, net transfers, damage, and — where the settlement produced them — police consequences ("this incident has been logged with system authorities"). The summary appears only after `COMPLETE`; while settlement runs, the screen shows the diegetic wait (design §15.2). Behaviour-profile and relationship changes are never displayed as numbers.

### 7.5 Police encounters

Police encounters reuse the same screen with a distinct police header and the police action sets (design §5.6). Inspection results (confiscations, fines) render in the same resolution-log format. The deadline defaults (comply / surrender / flee) are shown as the "no response" outcome on the countdown.

### 7.6 Wreck and pod encounters

Wreck and escape-pod encounters are single-decision screens: contents (if scoopable), the scoop/rescue action gated on equipment and capacity, and ignore. Rescue shows the rescued captain's handle after completion, never their controller type.

---

## 8. Disconnects, proxies, and resume

### 8.1 In-encounter disconnect

The client reports disconnect/background transitions; the server runs the hidden grace and proxy takeover (design §6.1). The opponent's UI shows nothing.

### 8.2 Reconnect catch-up

On reconnect during or after a proxied stretch, the player gets the **catch-up summary** (design §6.2) as an interstitial before control resumes: proxy rounds, actions taken, damage, transfers, messages sent, current state. It must be readable in seconds — a compact log, not a wall of prose. Control resumes at the next round boundary; the interstitial says so explicitly, and notes that proxy rounds did not affect the player's learned profiles (design §6.5).

### 8.3 Proxy mode selection

The Captain tab offers the two modes (learned profile / generic coward, design §6.3) with one-line descriptions of behaviour tendencies. The learned profile is described by its current bands only; there is no way to inspect or edit the underlying scores.

---

## 9. Destruction, recovery, death, retirement

### 9.1 Adrift (`AWAITING_RECOVERY`)

A dedicated screen: "your ship is destroyed; your pod is adrift near <system>". It shows the automated-recovery countdown (`recovery_due_at`, design §9.1), updates if the pod is rescued or destroyed, and permits nothing but watching and reading status. On recovery it transitions through the Recovery wait to the Docked hub with the replacement ship, and offers the immediate trade-toward-another-model shortcut into the Shipyard.

### 9.2 Death

Permanent death gets an **Epilogue** screen: captain name, lifespan, closing summary drawn from history (kills, trades, net worth peak). One action: "register a new captain" → Captain creation (§3.2). The epilogue is explicit that nothing transfers.

### 9.3 Retirement

Retirement lives in the Captain tab behind a two-step confirmation that states the permanence rules (design §9.4). It is unavailable (absent, with a one-line reason) while any lock or non-`ACTIVE` lifecycle state blocks it. Confirmed retirement goes to the same Epilogue screen.

---

## 10. Information display rules

A single normative list of what the client may show about **another** captain, anywhere in the UI:

- handle;
- ship class and visible equipment cues;
- public disposition band (never component scores);
- public police band, wanted/bounty flag;
- public history and reputation records;
- the player's own direct memory of them.

Forbidden everywhere: controller type, private profile scores, hidden cargo, server strength assessment, disconnect/proxy status. These must also not be inferable from UI timing or layout differences.

About the player **themselves**: bands and trends of their own profiles, but not numeric scores (design §7.5); their exact police record number may be shown as it is their own public record.

---

## 11. Phase 0 client gaps

The current `server/public` client is a development harness. Delta to this design:

- systems list and goods are hardcoded; must come from a galaxy/config endpoint;
- market trades are fixed buy-1/sell-1 with a locally computed price; needs quantity selection and the server progressive quote (§5);
- travel requires manual "advance" taps and a manual "scan for traffic" that calls the matching endpoint with a client-computed `routeArea`/`globalTick`; matching must be server-driven, and the client reduced to auto-advancing ticks (§6.2);
- the client supplies the trip seed from `Math.random`; seeds are server concerns (design §16.3);
- `DEMAND`, `TRADE_OFFER`, and `SURRENDER_CLAIM` submit hardcoded parameters; each needs its builder (§7.2, §7.3);
- no round deadlines, no countdowns, no resolution log — actions apply silently;
- no catch-up summary interstitial (reconnect shows a toast);
- no captain-creation, epilogue, adrift, or settlement-wait screens;
- dev-only bootstrap and ambient-tick controls must be removed from the player client;
- no bank, shipyard beyond two fixed buttons, proxy-mode selection, or Captain profile view.

None of these require server mechanics that are not already designed; several require new read/quote endpoints (galaxy config, progressive quote, encounter deadline in the view payload).

---

## 12. Coverage matrix

Two-way traceability between the mechanics design and this document. Every section of the design doc appears exactly once; "server-only" means the mechanic deliberately has no player-facing surface, which is itself an auditable claim.

| Design § | Mechanic | UX surface | Status |
|---|---|---|---|
| 3 | Core loop | §§4–7 (hub → market → travel → encounter → dock) | Covered |
| 4.1 | Hyperspace jump | §6.1 departure | Covered |
| 4.2 | Approach ticks, player pacing | §6.2 auto-advance, pause/resume | Covered |
| 4.3 | Windows, occupancy, matching | §6.2 — deliberately invisible; client never computes ticks or route areas | Covered (by absence) |
| 4.4 | Claim protocol | §2 `ENCOUNTER_CLAIMED` input suspension; design §4.4.1 poll contract | Covered |
| 4.5 | Interrupted travel | §6.2 pause on close, resume at tick | Covered |
| 5.1 | Encounter types | §7.1 captain, §7.5 police, §7.6 wreck/pod | Covered |
| 5.2 | Actions, parameters, pending demand privacy | §7.2 builders and pending items | Covered |
| 5.3 | Phases and legal actions | §7.2 action row derives from phase | Covered |
| 5.4 | Round resolution, surrender claim | §7.2 reveal log, §7.3 claim screen | Covered |
| 5.5 | One encounter system | Principle 4, §10 | Covered |
| 5.6 | Police flow | §7.5, including deadline defaults | Covered |
| 6.1 | Hidden grace | §8.1 — invisible to opponent by design | Covered |
| 6.2 | Catch-up summary | §8.2 interstitial | Covered |
| 6.3–6.4 | Proxy modes and canned comms | §8.3 selection; proxy hails render as ordinary hails | Covered |
| 6.5 | Proxy actions don't train profiles | Noted in §8.2 interstitial copy | Covered |
| 7.1–7.4 | Learned profiles, hidden strength | §10 — own bands/trends only; strength never surfaced | Covered (by absence) |
| 7.5 | Public disposition | §7.1 opponent card, §4 Captain tab | Covered |
| 7.6 | NPC fixed profiles | Server-only | N/A |
| 7.7 | Information parity | §10 normative list, Principle 4 | Covered |
| 8.1–8.5 | Hostility, memory facts, decay, extremes | Surfaced only through NPC behaviour and canned dialogue; "met before" marker in §7.1; design §8.2.1 | Covered |
| 8.6 | Companion travel | §6.1 offer, §6.2 convoy indicator; design §8.6.1 | Covered |
| 8.7 | Ambient NPC simulation | Server-only; visible indirectly through markets and news | N/A |
| 9.1 | Escape pod, recovery | §9.1 Adrift screen with countdown | Covered |
| 9.2 | Permanent death | §9.2 Epilogue; design §9.2.1 | Covered |
| 9.3 | Equipment loss | Stated in Adrift/Epilogue copy | Covered |
| 9.4 | Retirement | §9.3 | Covered |
| 10.1–10.3 | Cargo survival, scoops, debris | §6.2 sighting card, §7.6; scoop/capacity gating | Covered |
| 10.4 | Pod rescue | §7.6; rescued handle shown, controller hidden | Covered |
| 11.1 | Inferred activity, no roles | History/news read views (§4 tab, partially deferred §13) | Partial — acceptable for Phase 0 |
| 11.2 | Automatic reporting | §7.4 consequences line in end summary | Covered |
| 11.3 | Wanted status, bounty | §4 status-strip badge (self), §7.1 bounty flag (others) | Covered |
| 11.4–11.5 | Lawful kills, bounty payment, rehabilitation | §7.4 end summary shows payout/standing change | Covered |
| 11.6 | Police surrender, fines, debt | §7.5 results, §4 Bank debt display | Covered |
| 12.1–12.5 | Pricing, stock, pressure, recovery | §5 progressive quote flow | Covered |
| 13.6–13.7 | Auth and captain creation | §3.1–3.2; design §13.7 | Covered |
| 14.1–14.5 | Transactions, locks | §5 wait states, Principle 3; non-economic tabs stay browsable | Covered |
| 15.1–15.4 | Settlement | §2 settling overlay, §7.4 summary gated on `COMPLETE` | Covered |
| 16.1–16.5 | Ruleset, RNG, versioning | No player surface; client must not supply seeds (§11) | Covered (by absence) |
| 17.1 | Captain lifecycle | §2 router table — every state has a screen | Covered |
| 17.2 | Pod lifecycle | §9.1 state changes on the Adrift screen | Covered |
| 17.3 | Rescue relationship/history | §7.6; no numeric relationship display | Covered |

### 12.1 Gaps closed in design v0.6 (UX → server)

The following presentation needs were undefined in design v0.5 and are now owned by the mechanics document:

| Gap | Was | Now |
|---|---|---|
| G1 companion-offer delivery | Diegetic mention with no carrier | Design §8.6.1 — System DO docked-roster offers |
| G2 memory-fact dialogue | Facts "support canned dialogue" only | Design §8.2.1 — typed facts → `messageKey` mapping |
| G3 handle selection | Auth only; no creation rules | Design §13.7 — uniqueness, format, deny-list |
| G4 epilogue data | Raw D1 history only | Design §9.2.1 — `captain_epilogue` projection |
| G5 claim notification | Tick response only | Design §4.4.1 — fixed-interval captain-view poll |

### 12.2 Gaps this UX revision fixed in the presentation (server → UX)

For the record, mechanics that v0.1 missed: pending-demand display and the `COMPLY` builder (§7.2 item 3), and the in-journey convoy indicator (§6.2). Both are now specified above.

---

## 13. Explicitly deferred UX

- Free-text hails (mechanics deferred, design §2.2); Phase 0 ships canned messages only.
- News, leaderboards, and history browsers beyond a minimal read view.
- Push notifications for out-of-app events (pod rescued, bounty posted).
- Sound, animation beyond simple transitions, and any ship-graphics work past class silhouettes.
- Onboarding beyond the three first-dock callouts.
