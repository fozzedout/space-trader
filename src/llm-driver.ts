/**
 * Drive player ships with LLMs over long periods, journaling everything
 * they think and do — the journals are the story.
 *
 * Deciders (auto-selected, or force with DRIVER=lmstudio|claude|heuristic):
 *   - LM Studio (local GPU, OpenAI-compatible API) when LMSTUDIO_BASE_URL
 *     is set (e.g. http://localhost:1234/v1). Built for weeks-long runs:
 *     free tokens, and reasoning models' <think> text is captured into
 *     the journal.
 *   - Claude when ANTHROPIC_API_KEY is set (MODEL, EFFORT env).
 *   - Offline heuristic otherwise (baseline; also used in tests).
 *
 * Usage:
 *   LMSTUDIO_BASE_URL=http://localhost:1234/v1 npm run play
 *
 * Env:
 *   SEED=42            galaxy seed
 *   TICKS=120          sim ticks to run (0 = run until Ctrl+C)
 *   CAPTAINS="Mara Voss:qwen2.5-14b,Jax Teller:llama-3.1-8b"
 *                      name:model pairs, one ship each (default 1 captain)
 *   EVENTS=1           scheduled deterministic disasters (story weather)
 *   LOG_DIR=logs       journals written here as JSONL (gitignored)
 *
 * Pacing: the sim advances one tick per round of decisions, so on a local
 * GPU the inference latency itself paces the game — captains think, the
 * world waits. Each docked captain decides once per tick.
 */
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { GOOD_IDS } from "./goods.js";
import type { PlayerAction, PlayerObservation } from "./player.js";
import { Rng } from "./rng.js";
import { Simulation } from "./sim.js";

export interface JournalEntry {
  tick: number;
  /** Raw chain-of-thought from local reasoning models (<think> text). */
  thinking?: string;
  /** The captain's log line — in character, written by the model. */
  log: string;
  action: PlayerAction;
  result: string;
  ok: boolean;
  netWorth: number;
}

export type Decider = (
  obs: PlayerObservation,
  recentLog: JournalEntry[],
) => Promise<{ action: PlayerAction; log: string; thinking?: string }>;

// ---------------------------------------------------------------- rules

const RULES = `You are the captain of a small trading ship in a living galactic economy.

GOAL: grow your net worth (credits + cargo value - loan) by trading. Stay
alive: if your loan goes delinquent the bank seizes your ship.

HOW THE WORLD WORKS
- Each system produces and consumes goods by role; prices are set by local
  inventory vs targetStock: scarce = expensive, glutted = cheap.
- Buy where a good is cheap (inventory far above targetStock), sell where
  it's dear. Your own trades move prices, so don't overbuy thin markets —
  execution costs more than the listed price when your order is large.
- Remote market data comes from the hub news network and is newsAgeTicks
  old — a shortage may be gone when you arrive. Fresh news beats stale.
- At a trade hub you also see inboundCargo: goods already in flight to a
  destination. Don't race cargo that's already on its way.
- Travel burns fuel bought from the ORIGIN port (fuelNeeded) plus wear
  (wearPerDist * distance), both paid at departure.
- A scoop lets you harvest fuel from the local star for
  harvestValuePerTick credits/tick — slow, capital-free income that also
  refills the port. A shredder does the same with asteroid ore.
- The station bank lends against your ship (borrowCapacity). Interest
  accrues every tick. Past dueTick with no payment for
  delinquencyGraceTicks, THE BANK SEIZES YOUR SHIP. Repay aggressively.

ACTIONS (exactly one per turn)
- {"action":"buy","good":G,"qty":N}      buy at the local market
- {"action":"sell","good":G,"qty":N}     sell from your hold
- {"action":"travel","destId":N}         fly to a known system
- {"action":"harvest"}                   work the local system (needs gear)
- {"action":"buy_equipment","equipment":"scoop"|"shredder"}
- {"action":"borrow","amount":N}         loan against the ship
- {"action":"repay","amount":N}          pay the loan down
- {"action":"wait"}                      do nothing this tick

Your hold carries ONE commodity at a time. Travel takes travelTicks; you
cannot act in transit. If your previous action failed, lastActionResult
says why — adapt instead of repeating it.

Respond with JSON only:
{"log": "<your captain's log entry — in character, 1-3 sentences, present
tense; this is the ongoing record of your voyage>", "action": "...", ...}`;

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    log: { type: "string", description: "Captain's log entry, in character, 1-3 sentences." },
    action: {
      type: "string",
      enum: ["wait", "buy", "sell", "travel", "harvest", "buy_equipment", "borrow", "repay"],
    },
    good: { type: "string", enum: [...GOOD_IDS] },
    qty: { type: "integer" },
    destId: { type: "integer" },
    equipment: { type: "string", enum: ["scoop", "shredder"] },
    amount: { type: "number" },
  },
  required: ["log", "action"],
  additionalProperties: false,
} as const;

function buildUserMessage(obs: PlayerObservation, recentLog: JournalEntry[]): string {
  const memory =
    recentLog.length > 0
      ? `Your recent log entries (oldest first):\n${recentLog
          .map((e) => `[t${e.tick}] ${e.log} (${JSON.stringify(e.action)} -> ${e.result})`)
          .join("\n")}\n\n`
      : "";
  return `${memory}Current observation (JSON):\n${JSON.stringify(obs)}\n\nChoose one action and write your log entry.`;
}

// ------------------------------------------------- LM Studio (local GPU)

/**
 * OpenAI-compatible chat completions against a local LM Studio server.
 * Built to survive what local models actually do: <think> preambles,
 * markdown-fenced JSON, occasional garbage. A bad reply costs one waited
 * tick, never a crash — the run must survive weeks unattended.
 */
function makeLmStudioDecider(baseUrl: string, model: string, persona: string): Decider {
  return async (obs, recentLog) => {
    const body: Record<string, unknown> = {
      model,
      temperature: 0.7,
      max_tokens: 1500,
      messages: [
        { role: "system", content: `${RULES}\n\nYou are Captain ${persona}.` },
        { role: "user", content: buildUserMessage(obs, recentLog) },
      ],
      // LM Studio enforces this via grammar for models that support it;
      // servers/models that don't will just return free text, which the
      // extractor below handles.
      response_format: {
        type: "json_schema",
        json_schema: { name: "player_action", strict: true, schema: ACTION_SCHEMA },
      },
    };
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000), // local inference can be slow
      });
      if (!res.ok) {
        return { action: { type: "wait" }, log: `(comms static: server ${res.status})` };
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string; reasoning_content?: string } }[];
      };
      const message = data.choices?.[0]?.message;
      const { thinking, jsonText } = extractThinkingAndJson(
        message?.content ?? "",
        message?.reasoning_content,
      );
      const raw = JSON.parse(jsonText) as Record<string, unknown>;
      return {
        action: toAction(raw),
        log: String(raw["log"] ?? raw["why"] ?? "..."),
        ...(thinking ? { thinking } : {}),
      };
    } catch (err) {
      return {
        action: { type: "wait" },
        log: `(lost in thought: ${err instanceof Error ? err.message.slice(0, 80) : "?"})`,
      };
    }
  };
}

/** Strip <think> blocks (capturing them) and dig the JSON object out. */
export function extractThinkingAndJson(
  content: string,
  reasoningContent?: string,
): { thinking?: string; jsonText: string } {
  let thinking = reasoningContent?.trim();
  let text = content;
  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    thinking = (thinking ? `${thinking}\n` : "") + thinkMatch[1]!.trim();
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  }
  // Markdown fences, then first {...} span.
  text = text.replace(/```(?:json)?/g, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const jsonText = start >= 0 && end > start ? text.slice(start, end + 1) : "{}";
  return thinking ? { thinking, jsonText } : { jsonText };
}

// ------------------------------------------------------------- Claude

function makeClaudeDecider(persona: string): Decider {
  const client = new Anthropic();
  const model = process.env["MODEL"] ?? "claude-opus-4-8";
  const effort = (process.env["EFFORT"] ?? "low") as "low" | "medium" | "high";
  return async (obs, recentLog) => {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: [
        {
          type: "text",
          text: `${RULES}\n\nYou are Captain ${persona}.`,
          cache_control: { type: "ephemeral" },
        },
      ],
      // One game turn per request: low effort keeps the loop fast/cheap.
      output_config: { effort, format: { type: "json_schema", schema: ACTION_SCHEMA } },
      messages: [{ role: "user", content: buildUserMessage(obs, recentLog) }],
    });
    if (response.stop_reason === "refusal") {
      return { action: { type: "wait" }, log: "(the captain stays silent)" };
    }
    const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
    const raw = JSON.parse(text) as Record<string, unknown>;
    return { action: toAction(raw), log: String(raw["log"] ?? "") };
  };
}

function toAction(raw: Record<string, unknown>): PlayerAction {
  switch (raw["action"]) {
    case "buy":
      return { type: "buy", good: raw["good"] as never, qty: Number(raw["qty"]) };
    case "sell":
      return { type: "sell", good: raw["good"] as never, qty: Number(raw["qty"]) };
    case "travel":
      return { type: "travel", destId: Number(raw["destId"]) };
    case "harvest":
      return { type: "harvest" };
    case "buy_equipment":
      return { type: "buy_equipment", equipment: raw["equipment"] as never };
    case "borrow":
      return { type: "borrow", amount: Number(raw["amount"]) };
    case "repay":
      return { type: "repay", amount: Number(raw["amount"]) };
    default:
      return { type: "wait" };
  }
}

// ----------------------------------------------------------- heuristic

/**
 * Offline fallback: a simple greedy strategy using only the observation —
 * proof that the API carries enough signal to play, and a baseline for
 * comparing LLM play against.
 */
export const heuristicDecider: Decider = async (obs) => {
  const here = obs.dockedAt;
  if (!here) return { action: { type: "wait" }, log: "in transit" };

  // Debt first.
  if (obs.you.loan && obs.you.credits > 200) {
    return {
      action: { type: "repay", amount: obs.you.credits - 100 },
      log: "paying the loan down",
    };
  }

  // Holding cargo: sell here if profitable, else go where it's dear.
  if (obs.you.cargo) {
    const { good, qty, costBasis } = obs.you.cargo;
    const local = here.market.find((m) => m.good === good)!;
    if (local.price * qty > costBasis * 1.05) {
      return { action: { type: "sell", good, qty }, log: "selling at a profit" };
    }
    let best: { destId: number; value: number } | null = null;
    for (const sys of obs.knownSystems) {
      const price = sys.market.find((m) => m.good === good)!.price;
      const value = price * qty - sys.distance * obs.rules.wearPerDist;
      if (!best || value > best.value) best = { destId: sys.id, value };
    }
    if (best && best.value > costBasis * 1.05) {
      return { action: { type: "travel", destId: best.destId }, log: "hauling to a better market" };
    }
    return { action: { type: "sell", good, qty }, log: "cutting losses" };
  }

  // Empty hold: best known buy-here-sell-there spread. Budget with
  // headroom for price impact (execution costs more than spot when your
  // own buy moves the market), and never ship more than the destination
  // can absorb above its target — dumping crashes the sale price.
  let bestTrade: { good: (typeof GOOD_IDS)[number]; qty: number; profit: number } | null = null;
  for (const m of here.market) {
    const surplus = m.inventory - m.targetStock * 0.5;
    if (surplus < 1) continue;
    for (const sys of obs.knownSystems) {
      const there = sys.market.find((x) => x.good === m.good)!;
      const absorbable = there.targetStock * 1.2 - there.inventory;
      const qty = Math.min(
        obs.you.capacity,
        Math.floor(surplus),
        Math.floor(obs.you.credits / (m.price * 1.4)),
        Math.floor(absorbable),
        Math.floor(m.inventory * 0.3), // cap own price impact
      );
      if (qty < 1) continue;
      const profit = (there.price - m.price) * qty - sys.distance * obs.rules.wearPerDist;
      if (profit > m.price * qty * 0.15 && (!bestTrade || profit > bestTrade.profit)) {
        bestTrade = { good: m.good, qty, profit };
      }
    }
  }
  if (bestTrade) {
    return {
      action: { type: "buy", good: bestTrade.good, qty: bestTrade.qty },
      log: "buying into a known spread",
    };
  }

  // Nothing to trade: outfit, harvest, or drift to a hub for news.
  const scoopQuote = here.equipmentForSale.scoop;
  if (!obs.you.equipment.scoop && scoopQuote !== null && obs.you.credits > scoopQuote + 100) {
    return { action: { type: "buy_equipment", equipment: "scoop" }, log: "fitting a scoop" };
  }
  if (obs.you.equipment.scoop && here.harvestValuePerTick > 5) {
    return { action: { type: "harvest" }, log: "skimming the star" };
  }
  const hub = obs.knownSystems.find((s) => s.isHub);
  if (hub && !here.isHub) {
    return { action: { type: "travel", destId: hub.id }, log: "heading to a hub for news" };
  }
  return { action: { type: "wait" }, log: "nothing worth doing" };
};

// ------------------------------------------------------- story weather

const STORY_EVENTS = [
  { name: "crop blight", role: "agricultural", good: "food", prodMult: 0, duration: 100 },
  { name: "mine collapse", role: "mining", good: "ore", prodMult: 0.1, duration: 150 },
  { name: "fuel blockade", role: "industrial", good: "fuel", prodMult: 0, duration: 120 },
  { name: "war demand", role: "mining", good: "fuel", prodMult: 1, consMult: 6, duration: 80 },
] as const;

function maybeWorldEvent(sim: Simulation, rng: Rng, worldLog: string): void {
  const event = STORY_EVENTS[rng.int(0, STORY_EVENTS.length - 1)]!;
  const candidates = sim.systemsByRole(event.role as never);
  const system = candidates[rng.int(0, candidates.length - 1)]!;
  sim.applyShock(system.id, {
    good: event.good as never,
    prodMult: event.prodMult,
    consMult: "consMult" in event ? event.consMult : 1,
    duration: event.duration,
  });
  if (rng.next() < 0.5) sim.pirateRaid(system.id, event.good as never, 0.6);
  appendJsonl(worldLog, {
    tick: sim.tick,
    event: event.name,
    system: system.name,
    systemId: system.id,
    duration: event.duration,
  });
  console.log(`\n*** GALACTIC NEWS [t${sim.tick}]: ${event.name} at ${system.name} ***\n`);
}

// ----------------------------------------------------------------- run

interface Captain {
  shipId: number;
  name: string;
  decide: Decider;
  journal: JournalEntry[];
  file: string;
}

function appendJsonl(file: string, entry: unknown): void {
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function netWorth(sim: Simulation, shipId: number): number {
  const obs = sim.observe(shipId);
  return obs.you.credits + (obs.you.cargo?.costBasis ?? 0) - (obs.you.loan?.principal ?? 0);
}

async function main(): Promise<void> {
  const seed = Number(process.env["SEED"] ?? 42);
  const ticks = Number(process.env["TICKS"] ?? 120);
  const logDir = process.env["LOG_DIR"] ?? "logs";
  const lmBase = process.env["LMSTUDIO_BASE_URL"];
  const driver =
    process.env["DRIVER"] ??
    (lmBase ? "lmstudio" : process.env["ANTHROPIC_API_KEY"] ? "claude" : "heuristic");

  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const worldLog = path.join(logDir, `world-${seed}-${stamp}.jsonl`);

  const sim = new Simulation(seed);
  const captainSpecs = (process.env["CAPTAINS"] ?? "Captain:default")
    .split(",")
    .map((spec) => {
      const [name, model] = spec.split(":");
      return { name: name!.trim(), model: (model ?? "default").trim() };
    });

  const captains: Captain[] = captainSpecs.map(({ name, model }) => {
    const shipId = sim.addPlayer({ credits: 5000, capacity: 100 });
    const decide =
      driver === "lmstudio"
        ? makeLmStudioDecider(lmBase ?? "http://localhost:1234/v1", model, name)
        : driver === "claude"
          ? makeClaudeDecider(name)
          : heuristicDecider;
    const file = path.join(logDir, `${name.replace(/\W+/g, "_")}-${seed}-${stamp}.jsonl`);
    return { shipId, name, decide, journal: [], file };
  });

  sim.run(300); // warm the economy up around the captains
  const eventRng = new Rng(seed).fork("story-events");
  let nextEventTick = sim.tick + eventRng.int(150, 350);

  console.log(
    `Voyage begins | driver=${driver} | seed=${seed} | ${captains.map((c) => `${c.name}(#${c.shipId})`).join(", ")} | journals in ${logDir}/`,
  );

  for (let i = 0; ticks === 0 || i < ticks; i++) {
    if (process.env["EVENTS"] === "1" && sim.tick >= nextEventTick) {
      maybeWorldEvent(sim, eventRng, worldLog);
      nextEventTick = sim.tick + eventRng.int(150, 350);
    }

    for (const captain of captains) {
      const obs = sim.observe(captain.shipId);
      if (!obs.you.active) continue; // ship seized: this story is over
      if (obs.you.inTransit) continue;
      const { action, log, thinking } = await captain.decide(obs, captain.journal.slice(-8));
      sim.act(captain.shipId, action);
      // Result is known after the tick; entry is completed below.
      captain.journal.push({
        tick: obs.tick,
        ...(thinking ? { thinking } : {}),
        log,
        action,
        result: "",
        ok: false,
        netWorth: 0,
      });
    }

    sim.step();

    for (const captain of captains) {
      const pending = captain.journal[captain.journal.length - 1];
      if (!pending || pending.result !== "") continue;
      const result = sim.observe(captain.shipId).lastActionResult;
      pending.result = result?.detail ?? "";
      pending.ok = result?.ok ?? false;
      pending.netWorth = Math.round(netWorth(sim, captain.shipId));
      appendJsonl(captain.file, pending);
      console.log(
        `[t${pending.tick}] ${captain.name}: ${pending.log}\n        -> ${JSON.stringify(pending.action)} | ${pending.ok ? "ok" : "FAILED"}: ${pending.result} | worth ${pending.netWorth}`,
      );
    }

    const anyAlive = captains.some((c) => sim.observe(c.shipId).you.active);
    if (!anyAlive) {
      console.log("All ships seized. The chronicle ends here.");
      break;
    }
  }

  console.log("\n--- voyage summary ---");
  for (const captain of captains) {
    const obs = sim.observe(captain.shipId);
    console.log(
      `${captain.name}: ${obs.you.active ? `net worth ${netWorth(sim, captain.shipId).toFixed(0)}` : "ship seized by the bank"} | ${captain.journal.length} log entries -> ${captain.file}`,
    );
  }
}

// Only run the loop when executed directly (the deciders are importable).
const isMain = process.argv[1]?.endsWith("llm-driver.ts");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
