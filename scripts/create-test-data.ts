/**
 * Create minimal test data for prompt evaluation
 */

import * as fs from "fs/promises";
import * as path from "path";

// Create minimal realistic test data
const testData = [
  {
    timestamp: Date.now() - 300000, // 5 minutes ago
    systems: [
      {
        id: 0,
        name: "Alpha Centauri",
        population: 50,
        techLevel: 5,
        worldType: "industrial",
        currentTick: 0,
        markets: [
          { goodId: "food", price: 20.0, inventory: 2000, production: 1.0, consumption: 0.9, basePrice: 20 },
          { goodId: "metals", price: 80.0, inventory: 1500, production: 1.2, consumption: 1.0, basePrice: 75 },
          { goodId: "electronics", price: 250.0, inventory: 800, production: 0.8, consumption: 0.7, basePrice: 250 },
        ],
      },
      {
        id: 1,
        name: "Vega",
        population: 30,
        techLevel: 3,
        worldType: "agricultural",
        currentTick: 0,
        markets: [
          { goodId: "food", price: 15.0, inventory: 3000, production: 1.5, consumption: 0.8, basePrice: 15 },
          { goodId: "textiles", price: 40.0, inventory: 1200, production: 1.0, consumption: 0.6, basePrice: 40 },
        ],
      },
    ],
    ships: [
      { id: "npc-0", name: "Trader Alpha", isNPC: true, currentSystem: 0, phase: "at_station", credits: 10000, cargo: { food: 50 } },
      { id: "npc-1", name: "Trader Beta", isNPC: true, currentSystem: 1, phase: "at_station", credits: 9500, cargo: { metals: 20 } },
    ],
    trades: [],
    metrics: {
      totalCredits: 19500,
      totalCargo: 70,
      activeTraders: 2,
      travelingShips: 0,
      atStationShips: 2,
      averagePrice: { food: 17.5, metals: 80.0, electronics: 250.0, textiles: 40.0 },
      totalInventory: { food: 5000, metals: 1500, electronics: 800, textiles: 1200 },
    },
  },
  {
    timestamp: Date.now() - 150000, // 2.5 minutes ago
    systems: [
      {
        id: 0,
        name: "Alpha Centauri",
        population: 50,
        techLevel: 5,
        worldType: "industrial",
        currentTick: 5,
        markets: [
          { goodId: "food", price: 22.5, inventory: 1950, production: 1.0, consumption: 0.9, basePrice: 20 },
          { goodId: "metals", price: 85.0, inventory: 1480, production: 1.2, consumption: 1.0, basePrice: 75 },
          { goodId: "electronics", price: 255.0, inventory: 810, production: 0.8, consumption: 0.7, basePrice: 250 },
        ],
      },
      {
        id: 1,
        name: "Vega",
        population: 30,
        techLevel: 3,
        worldType: "agricultural",
        currentTick: 5,
        markets: [
          { goodId: "food", price: 16.0, inventory: 2980, production: 1.5, consumption: 0.8, basePrice: 15 },
          { goodId: "textiles", price: 42.0, inventory: 1180, production: 1.0, consumption: 0.6, basePrice: 40 },
        ],
      },
    ],
    ships: [
      { id: "npc-0", name: "Trader Alpha", isNPC: true, currentSystem: 1, phase: "traveling", credits: 10125, cargo: { food: 0 } },
      { id: "npc-1", name: "Trader Beta", isNPC: true, currentSystem: 0, phase: "at_station", credits: 9800, cargo: { metals: 15 } },
    ],
    trades: [],
    metrics: {
      totalCredits: 19925,
      totalCargo: 15,
      activeTraders: 1,
      travelingShips: 1,
      atStationShips: 1,
      averagePrice: { food: 19.25, metals: 85.0, electronics: 255.0, textiles: 42.0 },
      totalInventory: { food: 4930, metals: 1480, electronics: 810, textiles: 1180 },
    },
  },
  {
    timestamp: Date.now(), // Now
    systems: [
      {
        id: 0,
        name: "Alpha Centauri",
        population: 50,
        techLevel: 5,
        worldType: "industrial",
        currentTick: 10,
        markets: [
          { goodId: "food", price: 25.0, inventory: 1900, production: 1.0, consumption: 0.9, basePrice: 20 },
          { goodId: "metals", price: 90.0, inventory: 1450, production: 1.2, consumption: 1.0, basePrice: 75 },
          { goodId: "electronics", price: 260.0, inventory: 820, production: 0.8, consumption: 0.7, basePrice: 250 },
        ],
      },
      {
        id: 1,
        name: "Vega",
        population: 30,
        techLevel: 3,
        worldType: "agricultural",
        currentTick: 10,
        markets: [
          { goodId: "food", price: 17.0, inventory: 2960, production: 1.5, consumption: 0.8, basePrice: 15 },
          { goodId: "textiles", price: 44.0, inventory: 1160, production: 1.0, consumption: 0.6, basePrice: 40 },
        ],
      },
    ],
    ships: [
      { id: "npc-0", name: "Trader Alpha", isNPC: true, currentSystem: 1, phase: "at_station", credits: 10250, cargo: {} },
      { id: "npc-1", name: "Trader Beta", isNPC: true, currentSystem: 0, phase: "at_station", credits: 9900, cargo: { metals: 10 } },
    ],
    trades: [],
    metrics: {
      totalCredits: 20150,
      totalCargo: 10,
      activeTraders: 2,
      travelingShips: 0,
      atStationShips: 2,
      averagePrice: { food: 21.0, metals: 90.0, electronics: 260.0, textiles: 44.0 },
      totalInventory: { food: 4860, metals: 1450, electronics: 820, textiles: 1160 },
    },
  },
];

async function main() {
  const outputDir = path.join(process.cwd(), "economy-data");
  await fs.mkdir(outputDir, { recursive: true });

  const filename = `economy-data-test-${Date.now()}.json`;
  const filepath = path.join(outputDir, filename);

  await fs.writeFile(filepath, JSON.stringify(testData, null, 2));
  console.log(`Test data created: ${filepath}`);
  console.log(`Data points: ${testData.length}`);
}

main().catch(console.error);
