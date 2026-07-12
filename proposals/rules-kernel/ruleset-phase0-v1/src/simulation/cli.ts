import { runAmbientEconomy, runScriptedEncounter } from './harness.js';

function argValue(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  return fallback;
}

const captainDays = Number(argValue('--captain-days', '1000'));
const seed = Number(argValue('--seed', '42'));

const economy = runAmbientEconomy({ seed, captainDays });
const encounter = runScriptedEncounter({ seed: seed + 7, aCombat: 'neutral', bCombat: 'aggressive' });

const moneyRatio = economy.totalCreditsEnd / Math.max(1, economy.totalCreditsStart);

console.log(JSON.stringify({
  rulesetVersion: economy.rulesetVersion,
  economy: {
    captainDays: economy.captainDays,
    trades: economy.trades,
    profitableRouteHits: economy.profitableRouteHits,
    totalCreditsStart: economy.totalCreditsStart,
    totalCreditsEnd: economy.totalCreditsEnd,
    moneyRatio: Number(moneyRatio.toFixed(3)),
  },
  encounter: {
    rounds: encounter.rounds,
    ended: encounter.ended,
    endReason: encounter.endReason,
    eventCount: encounter.events.length,
  },
}, null, 2));
