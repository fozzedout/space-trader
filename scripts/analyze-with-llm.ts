/**
 * Analyze collected economy data using LM Studio LLM
 */

import * as fs from "fs/promises";
import * as path from "path";

const RAW_LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234/v1/chat/completions";
const LM_STUDIO_URL = RAW_LM_STUDIO_URL.includes("/v1/")
  ? RAW_LM_STUDIO_URL
  : `${RAW_LM_STUDIO_URL.replace(/\/$/, "")}/v1/chat/completions`;
// Use local-model (LM Studio will use whatever model is currently loaded)
// Or specify a model via LM_STUDIO_MODEL env var
const MODEL = process.env.LM_STUDIO_MODEL || "local-model";

interface AnalysisRequest {
  data: any;
  prompt: string;
}

async function callLMStudio(prompt: string): Promise<string> {
  const response = await fetch(LM_STUDIO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: `You are an expert game economy designer analyzing a space trading simulation. Your task is to identify specific balance issues and provide concrete, actionable recommendations.

CRITICAL ANALYSIS AREAS:
1. **Production/Consumption Balance**: Compare production vs consumption rates. If production < consumption, inventory will deplete. If production > consumption, inventory will grow. Ideal ratio is ~1.0-1.1 for stability.

2. **Price Stability**: Look for goods with extreme price volatility (>20% change). Prices should respond to inventory but not swing wildly.

3. **NPC Profitability**: Calculate if NPCs are making money. Check if credits are increasing over time. If credits are stagnant or decreasing, NPCs aren't trading profitably.

4. **Inventory Health**: Identify goods with critically low inventory (<100 units) or excessive inventory (>5000 units). Both indicate balance issues.

5. **Market Activity**: Check if NPCs are actively trading (phase distribution, cargo movement). Low activity suggests trading isn't profitable.

6. **System Specialization**: Verify if world types (agricultural, industrial, etc.) are producing appropriate goods and if specialization bonuses are working.

ACTUAL CODE STRUCTURE:
- Production/consumption rates are in src/star-system.ts (calculateProductionRate, calculateConsumptionRate)
- Price calculation is in src/star-system.ts (calculatePrice method)
- NPC trading decisions are in src/ship.ts (makeNPCTradingDecision, tryBuyGoods, trySellGoods)
- Balance config is in src/balance-config.ts (getMinProfitMargin, getMaxPriceMultiplier, etc.)
- Goods definitions are in src/goods.ts (getGoodDefinition, getAllGoodIds)

PROVIDE:
- Specific numerical issues with actual data values (e.g., "food production 1.0 < consumption 0.9, causing -10% inventory decline")
- Code-level recommendations referencing actual files (e.g., "In src/balance-config.ts, increase minProfitMargin from 0.001 to 0.05")
- Function-level suggestions (e.g., "In src/star-system.ts calculatePrice(), add inventory buffer check for values < 500")
- NPC behavior fixes with actual function names (e.g., "In src/ship.ts makeNPCTradingDecision(), increase profit threshold")
- Economic model improvements with file locations (e.g., "In src/star-system.ts, modify production rate calculation to add 10% buffer")`,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LM Studio API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  if (!data?.choices?.length) {
    throw new Error(`Unexpected LM Studio response: ${JSON.stringify(data).slice(0, 2000)}`);
  }
  return data.choices[0]?.message?.content || "No response from LLM";
}

function formatDataForAnalysis(data: any[]): string {
  if (!data || data.length === 0) {
    return "No data collected";
  }

  const first = data[0];
  const last = data[data.length - 1];
  const mid = data[Math.floor(data.length / 2)];

  // Calculate statistics
  const priceChanges: Record<string, { start: number; end: number; change: number; changePercent: number }> = {};
  const inventoryChanges: Record<string, { start: number; end: number; change: number }> = {};
  const creditChanges: { start: number; end: number; change: number } = {
    start: 0,
    end: 0,
    change: 0,
  };

  // Analyze price and inventory trends, and production/consumption rates
  const productionRates: Record<string, { total: number; count: number; avg: number }> = {};
  const consumptionRates: Record<string, { total: number; count: number; avg: number }> = {};
  
  for (const system of first.systems || []) {
    for (const market of system.markets || []) {
      if (!priceChanges[market.goodId]) {
        priceChanges[market.goodId] = { start: 0, end: 0, change: 0, changePercent: 0 };
        inventoryChanges[market.goodId] = { start: 0, end: 0, change: 0 };
        productionRates[market.goodId] = { total: 0, count: 0, avg: 0 };
        consumptionRates[market.goodId] = { total: 0, count: 0, avg: 0 };
      }
      priceChanges[market.goodId].start += market.price;
      inventoryChanges[market.goodId].start += market.inventory;
      productionRates[market.goodId].total += market.production || 0;
      productionRates[market.goodId].count++;
      consumptionRates[market.goodId].total += market.consumption || 0;
      consumptionRates[market.goodId].count++;
    }
  }

  for (const system of last.systems || []) {
    for (const market of system.markets || []) {
      if (priceChanges[market.goodId]) {
        priceChanges[market.goodId].end += market.price;
        inventoryChanges[market.goodId].end += market.inventory;
      }
    }
  }
  
  // Calculate averages
  for (const goodId of Object.keys(productionRates)) {
    productionRates[goodId].avg = productionRates[goodId].total / productionRates[goodId].count;
    consumptionRates[goodId].avg = consumptionRates[goodId].total / consumptionRates[goodId].count;
  }

  for (const goodId of Object.keys(priceChanges)) {
    const priceChange = priceChanges[goodId];
    priceChange.change = priceChange.end - priceChange.start;
    priceChange.changePercent = priceChange.start > 0 
      ? (priceChange.change / priceChange.start) * 100 
      : 0;

    const invChange = inventoryChanges[goodId];
    invChange.change = invChange.end - invChange.start;
  }

  // Calculate credit changes
  for (const ship of first.ships || []) {
    creditChanges.start += ship.credits;
  }
  for (const ship of last.ships || []) {
    creditChanges.end += ship.credits;
  }
  creditChanges.change = creditChanges.end - creditChanges.start;

  // Ship statistics
  const npcCount = (first.ships || []).filter((s: any) => s.isNPC).length;
  const playerCount = (first.ships || []).filter((s: any) => !s.isNPC).length;
  const avgCreditsStart = creditChanges.start / (first.ships?.length || 1);
  const avgCreditsEnd = creditChanges.end / (last.ships?.length || 1);

  // Phase distribution
  const phaseDistribution: Record<string, number> = {};
  for (const ship of last.ships || []) {
    phaseDistribution[ship.phase] = (phaseDistribution[ship.phase] || 0) + 1;
  }

  // System health metrics
  const systemHealth: Array<{
    id: number;
    name: string;
    avgPrice: number;
    totalInventory: number;
    lowInventoryGoods: number;
  }> = [];

  for (const system of last.systems || []) {
    let totalPrice = 0;
    let priceCount = 0;
    let totalInv = 0;
    let lowInv = 0;

    for (const market of system.markets || []) {
      totalPrice += market.price;
      priceCount++;
      totalInv += market.inventory;
      if (market.inventory < 100) {
        lowInv++;
      }
    }

    systemHealth.push({
      id: system.id,
      name: system.name,
      avgPrice: priceCount > 0 ? totalPrice / priceCount : 0,
      totalInventory: totalInv,
      lowInventoryGoods: lowInv,
    });
  }

  return `# Economy Simulation Analysis Data

## Simulation Overview
- Duration: ${((last.timestamp - first.timestamp) / 1000 / 60).toFixed(1)} minutes
- Data points collected: ${data.length}
- Systems: ${first.systems?.length || 0}
- NPCs: ${npcCount}
- Players: ${playerCount}

## Economic Trends

### Price Changes (Average across all systems)
${Object.entries(priceChanges)
  .map(([good, change]) => `- ${good}: ${change.start.toFixed(2)} → ${change.end.toFixed(2)} (${change.changePercent > 0 ? "+" : ""}${change.changePercent.toFixed(1)}%)`)
  .join("\n")}

### Inventory Changes (Total across all systems)
${Object.entries(inventoryChanges)
  .map(([good, change]) => `- ${good}: ${change.start.toFixed(0)} → ${change.end.toFixed(0)} (${change.change > 0 ? "+" : ""}${change.change.toFixed(0)})`)
  .join("\n")}

### Production vs Consumption Rates (Average per system)
${Object.entries(productionRates)
  .map(([good, prod]) => {
    const cons = consumptionRates[good];
    const ratio = prod.avg > 0 ? (cons.avg / prod.avg).toFixed(2) : "N/A";
    const status = prod.avg > cons.avg ? "✅ SURPLUS" : prod.avg < cons.avg ? "⚠️ DEFICIT" : "⚖️ BALANCED";
    return `- ${good}: Production ${prod.avg.toFixed(3)} vs Consumption ${cons.avg.toFixed(3)} (ratio: ${ratio}) ${status}`;
  })
  .join("\n")}

### Credit Economy
- Total credits (start): ${creditChanges.start.toFixed(0)}
- Total credits (end): ${creditChanges.end.toFixed(0)}
- Change: ${creditChanges.change > 0 ? "+" : ""}${creditChanges.change.toFixed(0)}
- Average credits per ship (start): ${avgCreditsStart.toFixed(0)}
- Average credits per ship (end): ${avgCreditsEnd.toFixed(0)}

## Current State (Final Snapshot)

### Ship Phase Distribution
${Object.entries(phaseDistribution)
  .map(([phase, count]) => `- ${phase}: ${count}`)
  .join("\n")}

### System Health
${systemHealth
  .map((s) => `- ${s.name} (${s.id}): avg price ${s.avgPrice.toFixed(2)}, total inventory ${s.totalInventory.toFixed(0)}, ${s.lowInventoryGoods} goods with low inventory (<100)`)
  .join("\n")}

### Market Metrics (Final)
- Active traders: ${last.metrics?.activeTraders || 0}
- Traveling ships: ${last.metrics?.travelingShips || 0}
- At station ships: ${last.metrics?.atStationShips || 0}
- Total cargo: ${last.metrics?.totalCargo || 0}

### Average Prices (Final, across all systems)
${Object.entries(last.metrics?.averagePrice || {})
  .map(([good, price]) => `- ${good}: ${(price as number).toFixed(2)}`)
  .join("\n")}

### Total Inventory (Final, across all systems)
${Object.entries(last.metrics?.totalInventory || {})
  .map(([good, inv]) => `- ${good}: ${(inv as number).toFixed(0)}`)
  .join("\n")}

## Sample Data Points

### First Snapshot (t=0)
${JSON.stringify({
  timestamp: new Date(first.timestamp).toISOString(),
  systems: first.systems?.length || 0,
  ships: first.ships?.length || 0,
  metrics: first.metrics,
}, null, 2)}

### Middle Snapshot (t=${Math.floor(data.length / 2)})
${JSON.stringify({
  timestamp: new Date(mid.timestamp).toISOString(),
  systems: mid.systems?.length || 0,
  ships: mid.ships?.length || 0,
  metrics: mid.metrics,
}, null, 2)}

### Final Snapshot (t=${data.length - 1})
${JSON.stringify({
  timestamp: new Date(last.timestamp).toISOString(),
  systems: last.systems?.length || 0,
  ships: last.ships?.length || 0,
  metrics: last.metrics,
}, null, 2)}

## Detailed Analysis Required

Analyze this economy simulation and provide:

### 1. Production/Consumption Analysis
For each good, calculate:
- Production rate vs consumption rate (are they balanced?)
- Inventory trend (increasing/decreasing/stable?)
- If inventory is declining: production < consumption (needs fix)
- If inventory is growing: production > consumption (may need adjustment)

### 2. Price Stability Analysis
- Which goods show >20% price volatility? (problematic)
- Are prices responding appropriately to inventory changes?
- Are there goods with prices that don't match their inventory levels?

### 3. NPC Profitability Analysis
- Calculate: (end credits - start credits) / number of NPCs
- Are NPCs making money? (credits should increase over time)
- If credits are stagnant: NPCs aren't trading profitably
- Check cargo movement: Are NPCs buying and selling goods?

### 4. Inventory Health Check
- List goods with inventory < 100 (critical shortage risk)
- List goods with inventory > 5000 (overproduction)
- Identify goods with rapid inventory decline (>10% over simulation)

### 5. Market Activity Assessment
- How many NPCs are actively trading? (at_station phase)
- How many are traveling? (traveling phase)
- Is cargo being moved between systems?
- Low activity = trading not profitable enough

### 6. System-Specific Issues
For each system:
- Are production rates appropriate for world type?
- Are specialized goods (agricultural→food, industrial→metals) being produced?
- Are there systems with consistently low inventory across multiple goods?

### 7. Concrete Recommendations
Provide SPECIFIC, ACTIONABLE fixes:
- **Code changes**: "In balance-config.ts, change food production multiplier from 1.0 to 1.15"
- **Formula adjustments**: "Modify price calculation to add floor at basePrice * 0.8 and ceiling at basePrice * 1.5"
- **NPC behavior**: "Increase minimum profit margin threshold from 10% to 15% in ship.ts makeNPCTradingDecision"
- **Balance tweaks**: "Reduce consumption rate for electronics by 10% to match production"
- **Economic model**: "Add inventory buffer system: maintain 500-2000 unit range per good per system"

### 8. Economic Model Improvements
Suggest new mechanics or improvements:
- Price stabilization mechanisms
- NPC decision-making improvements
- Market event systems
- Trade route optimization
- Economic feedback loops

Be specific with numbers, file names, and code locations when possible.
`;
}

async function main(): Promise<void> {
  const dataFile = process.argv[2];

  if (!dataFile) {
    console.error("Usage: tsx scripts/analyze-with-llm.ts <data-file.json>");
    console.error("Example: tsx scripts/analyze-with-llm.ts economy-data/economy-data-1234567890.json");
    process.exit(1);
  }

  const filepath = path.resolve(dataFile);
  console.log(`Loading data from: ${filepath}`);

  const fileContent = await fs.readFile(filepath, "utf-8");
  const data = JSON.parse(fileContent);

  console.log(`Loaded ${data.length} data points`);
  console.log(`Connecting to LM Studio at: ${LM_STUDIO_URL}\n`);

  // Format data for analysis
  const analysisPrompt = formatDataForAnalysis(data);

  console.log("Sending analysis request to LM Studio...\n");

  try {
    const analysis = await callLMStudio(analysisPrompt);

    // Save analysis report
    const outputDir = path.join(process.cwd(), "economy-reports");
    await fs.mkdir(outputDir, { recursive: true });

    const reportFilename = `economy-report-${Date.now()}.md`;
    const reportPath = path.join(outputDir, reportFilename);

    const report = `# Economy Analysis Report

Generated: ${new Date().toISOString()}
Data Source: ${dataFile}
Data Points: ${data.length}

---

${analysis}}

---

## Raw Analysis Data

\`\`\`
${analysisPrompt}
\`\`\`
`;

    await fs.writeFile(reportPath, report);
    console.log(`\nAnalysis complete!`);
    console.log(`Report saved to: ${reportPath}\n`);
    console.log("=" .repeat(80));
    console.log(analysis);
    console.log("=" .repeat(80));
  } catch (error: any) {
    console.error("Error calling LM Studio:", error.message);
    console.error("\nMake sure LM Studio is running and the API is enabled.");
    console.error("Default URL: http://localhost:1234/v1/chat/completions");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
