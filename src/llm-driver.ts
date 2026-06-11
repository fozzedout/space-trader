/**
 * Drive a player ship with an LLM (or an offline heuristic).
 *
 *   ANTHROPIC_API_KEY=... npm run play          # Claude decides each move
 *   npm run play                                # offline heuristic decider
 *
 * Options via env: SEED (default 42), DECISIONS (default 30),
 * MODEL (default claude-opus-4-8), EFFORT (default low).
 *
 * The loop: advance the sim until the player ship is docked, build an
 * observation (only what the ship is entitled to know), ask the decider
 * for one action, queue it, repeat. The decider sees exactly what a
 * human player UI would show — nothing more.
 */
import Anthropic from "@anthropic-ai/sdk";
import { GOOD_IDS } from "./goods.js";
import type { PlayerAction, PlayerObservation } from "./player.js";
import { Simulation } from "./sim.js";

type Decider = (obs: PlayerObservation) => Promise<{ action: PlayerAction; why: string }>;

// ---------------------------------------------------------------- rules

const RULES = `You are the captain of a small trading ship in a living galactic economy.

GOAL: grow your net worth (credits + cargo value - loan) by trading.

HOW THE WORLD WORKS
- Each system produces and consumes goods by role; prices are set by local
  inventory vs target stock: scarce = expensive, glutted = cheap.
- Buy where a good is cheap (inventory far above targetStock), sell where
  it's dear. Your own trades move prices.
- Remote market data comes from the hub news network and is newsAgeTicks
  old — a shortage may be gone when you arrive. Fresh news beats stale.
- At a trade hub you also see inboundCargo: goods already in flight to a
  destination. Don't race cargo that's already on its way.
- Travel burns fuel bought from the ORIGIN port (fuelNeeded) plus wear
  (wearPerDist * distance). Both come out of your pocket at departure.
- A scoop (equipment) lets you harvest fuel from the local star for
  harvestValuePerTick credits/tick — slow but capital-free income, and it
  refills the port's fuel. A shredder does the same with asteroid ore.
- The station bank lends against your ship (borrowCapacity). Interest
  accrues per tick. If your loan is past dueTick AND you haven't made a
  payment within delinquencyGraceTicks, THE BANK SEIZES YOUR SHIP and the
  game is over. Repay aggressively; borrowing resets the term.

ACTIONS (one per tick)
- {"action":"buy","good":G,"qty":N}      buy at the local market
- {"action":"sell","good":G,"qty":N}     sell from your hold
- {"action":"travel","destId":N}         fly to a known system
- {"action":"harvest"}                   work the local system (needs gear)
- {"action":"buy_equipment","equipment":"scoop"|"shredder"}
- {"action":"borrow","amount":N}         loan against the ship
- {"action":"repay","amount":N}          pay the loan down
- {"action":"wait"}                      do nothing this tick

Your hold carries ONE commodity at a time. Travel takes several ticks
(travelTicks); you cannot act in transit. Check lastActionResult — if your
previous action failed it tells you why.`;

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    why: { type: "string", description: "One short sentence of reasoning." },
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
  required: ["why", "action"],
  additionalProperties: false,
} as const;

// ------------------------------------------------------------ deciders

function makeClaudeDecider(): Decider {
  const client = new Anthropic();
  const model = process.env["MODEL"] ?? "claude-opus-4-8";
  const effort = (process.env["EFFORT"] ?? "low") as "low" | "medium" | "high";
  return async (obs) => {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: [{ type: "text", text: RULES, cache_control: { type: "ephemeral" } }],
      // One game turn per request: low effort keeps the loop fast/cheap;
      // raise EFFORT=high to watch it play more carefully.
      output_config: {
        effort,
        format: { type: "json_schema", schema: ACTION_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: `Current observation (JSON):\n${JSON.stringify(obs)}\n\nChoose one action.`,
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      return { action: { type: "wait" }, why: "model refused; waiting" };
    }
    const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
    const raw = JSON.parse(text) as Record<string, unknown>;
    return { action: toAction(raw), why: String(raw["why"] ?? "") };
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

/**
 * Offline fallback: a simple greedy strategy using only the observation —
 * proof that the API carries enough signal to play, and a baseline for
 * comparing LLM play against.
 */
export const heuristicDecider: Decider = async (obs) => {
  const here = obs.dockedAt;
  if (!here) return { action: { type: "wait" }, why: "in transit" };

  // Debt first.
  if (obs.you.loan && obs.you.credits > 200) {
    return {
      action: { type: "repay", amount: obs.you.credits - 100 },
      why: "paying the loan down",
    };
  }

  // Holding cargo: sell here if profitable, else go where it's dear.
  if (obs.you.cargo) {
    const { good, qty, costBasis } = obs.you.cargo;
    const local = here.market.find((m) => m.good === good)!;
    if (local.price * qty > costBasis * 1.05) {
      return { action: { type: "sell", good, qty }, why: "selling at a profit" };
    }
    let best: { destId: number; value: number } | null = null;
    for (const sys of obs.knownSystems) {
      const price = sys.market.find((m) => m.good === good)!.price;
      const value = price * qty - sys.distance * obs.rules.wearPerDist;
      if (!best || value > best.value) best = { destId: sys.id, value };
    }
    if (best && best.value > costBasis * 1.05) {
      return { action: { type: "travel", destId: best.destId }, why: "hauling to a better market" };
    }
    return { action: { type: "sell", good, qty }, why: "cutting losses" };
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
      why: "buying into a known spread",
    };
  }

  // Nothing to trade: outfit, harvest, or drift to a hub for news.
  const scoopQuote = here.equipmentForSale.scoop;
  if (!obs.you.equipment.scoop && scoopQuote !== null && obs.you.credits > scoopQuote + 100) {
    return { action: { type: "buy_equipment", equipment: "scoop" }, why: "fitting a scoop" };
  }
  if (obs.you.equipment.scoop && here.harvestValuePerTick > 5) {
    return { action: { type: "harvest" }, why: "skimming the star" };
  }
  const hub = obs.knownSystems.find((s) => s.isHub);
  if (hub && !here.isHub) {
    return { action: { type: "travel", destId: hub.id }, why: "heading to a hub for news" };
  }
  return { action: { type: "wait" }, why: "nothing worth doing" };
};

// ----------------------------------------------------------------- run

async function main(): Promise<void> {
  const seed = Number(process.env["SEED"] ?? 42);
  const decisions = Number(process.env["DECISIONS"] ?? 30);
  const useClaude = Boolean(process.env["ANTHROPIC_API_KEY"]);
  const decide = useClaude ? makeClaudeDecider() : heuristicDecider;

  const sim = new Simulation(seed);
  const shipId = sim.addPlayer({ credits: 5000, capacity: 100 });
  sim.run(300); // warm the economy up around the player

  const startWorth = netWorth(sim, shipId);
  console.log(
    `Driving ship #${shipId} with ${useClaude ? `Claude (${process.env["MODEL"] ?? "claude-opus-4-8"})` : "the offline heuristic"} | seed ${seed} | start net worth ${startWorth.toFixed(0)}\n`,
  );

  for (let i = 0; i < decisions; i++) {
    // Advance until the ship is docked and able to act.
    let guard = 0;
    while (sim.observe(shipId).you.inTransit && guard++ < 100) sim.step();
    const obs = sim.observe(shipId);
    if (!obs.you.active) {
      console.log("The bank seized your ship. Game over.");
      break;
    }
    const { action, why } = await decide(obs);
    sim.act(shipId, action);
    sim.step();
    const result = sim.observe(shipId).lastActionResult;
    console.log(
      `[t${obs.tick}] ${why}\n        -> ${JSON.stringify(action)} | ${result?.ok ? "ok" : "FAILED"}: ${result?.detail}`,
    );
  }

  const endWorth = netWorth(sim, shipId);
  const npcs = sim.galaxy.traders.filter((t) => t.active && t.controller === "ai");
  const npcAvg = npcs.reduce((a, t) => a + t.credits, 0) / npcs.length;
  console.log(
    `\nNet worth: ${startWorth.toFixed(0)} -> ${endWorth.toFixed(0)} (${endWorth >= startWorth ? "+" : ""}${(endWorth - startWorth).toFixed(0)}) | NPC average credits: ${npcAvg.toFixed(0)}`,
  );
}

function netWorth(sim: Simulation, shipId: number): number {
  const obs = sim.observe(shipId);
  return obs.you.credits + (obs.you.cargo?.costBasis ?? 0) - (obs.you.loan?.principal ?? 0);
}

// Only run the loop when executed directly (the deciders are importable).
const isMain = process.argv[1]?.endsWith("llm-driver.ts");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
