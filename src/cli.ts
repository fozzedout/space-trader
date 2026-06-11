/**
 * Headless demo run: warm up the economy, hit it with a food blight and a
 * pirate raid, and watch it self-balance. Usage:
 *
 *   npm run sim            # default seed 42
 *   npm run sim -- 1234    # custom seed
 */
import { GOOD_IDS } from "./goods.js";
import { Simulation } from "./sim.js";

const seed = Number(process.argv[2] ?? 42);
const sim = new Simulation(seed);

console.log(`Space Trader economy demo (seed ${seed})`);
console.log(`${sim.galaxy.systems.length} systems, ${sim.galaxy.traders.length} traders\n`);
for (const s of sim.galaxy.systems) {
  console.log(
    `  #${s.id} ${s.name.padEnd(12)} ${s.role.padEnd(13)} pop ${s.pop.toFixed(1)}  (${s.x.toFixed(0)}, ${s.y.toFixed(0)})${s.isHub ? "  [TRADE HUB]" : ""}`,
  );
}

function printMetrics(label: string): void {
  const m = sim.metrics();
  console.log(`\n[tick ${m.tick}] ${label}`);
  console.log("  good          avg price   max price   stockouts");
  for (const good of GOOD_IDS) {
    const g = m.goods[good];
    console.log(
      `  ${good.padEnd(12)} ${g.avgPriceRatio.toFixed(2).padStart(9)}x ${g.maxPriceRatio
        .toFixed(2)
        .padStart(10)}x ${String(g.stockouts).padStart(10)}`,
    );
  }
  console.log(
    `  trader credits: ${Math.round(m.totalTraderCredits).toLocaleString()} | in transit: ${m.tradersInTransit} | avg market news age: ${m.avgInfoAgeTicks.toFixed(0)} ticks`,
  );
  console.log(
    `  bank: ${Math.round(m.totalDebt).toLocaleString()} outstanding across ${m.tradersIndebted} loans | ships seized: ${m.tradersSeized}`,
  );
}

sim.run(300);
printMetrics("after warmup — equilibrium");

const victim = sim.systemsByRole("agricultural")[0]!;
console.log(
  `\n>>> DISASTER at ${victim.name}: crop blight (no food production for 120 ticks) + pirates burn 85% of stored food`,
);
sim.applyShock(victim.id, { good: "food", prodMult: 0, consMult: 1, duration: 120 });
sim.pirateRaid(victim.id, "food", 0.85);

sim.run(40);
printMetrics("mid-blight — shortage, prices spiking, traders responding");
const foodMarket = victim.markets.food;
console.log(
  `  ${victim.name} food: inventory ${foodMarket.inventory.toFixed(0)} / target ${foodMarket.targetStock.toFixed(0)}, price ${foodMarket.price.toFixed(1)} (base 10), imported so far ${foodMarket.imported.toFixed(0)}`,
);

sim.run(280);
printMetrics("blight over + recovery");
console.log(
  `  ${victim.name} food: inventory ${foodMarket.inventory.toFixed(0)} / target ${foodMarket.targetStock.toFixed(0)}, price ${foodMarket.price.toFixed(1)}, total imported ${foodMarket.imported.toFixed(0)}`,
);

const raidTarget = sim.systemsByRole("industrial")[0]!;
const destroyed = sim.pirateRaid(raidTarget.id, "machinery", 0.9);
console.log(
  `\n>>> PIRATES: raid at ${raidTarget.name}, ${destroyed.toFixed(0)} machinery destroyed`,
);

sim.run(150);
printMetrics("post-raid recovery");

console.log("\nDone. Same seed always reproduces this run exactly.");
