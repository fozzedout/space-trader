/**
 * LocalStorage: ShipState round-trip via flushAllShips and get("state").
 */

import { describe, it, expect, afterEach } from "vitest";
import { LocalStorage } from "./local-storage";
import type { ShipState } from "./types";

describe("LocalStorage ShipState round-trip", () => {
  const oid = `test-roundtrip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const sample: ShipState = {
    id: oid,
    name: "Roundtrip Ship",
    currentSystem: 1,
    destinationSystem: null,
    phase: "at_station",
    cargo: new Map([["food", 10]]),
    purchasePrices: new Map([["food", 20.5]]),
    credits: 600,
    isNPC: false,
    seed: "test-seed",
    travelStartTime: null,
    lastTradeTick: 0,
  };

  afterEach(async () => {
    try {
      const ls = new LocalStorage(oid);
      await ls.delete("state");
    } catch {
      // ignore
    }
  });

  it("persists and loads ShipState via flushAllShips and get", async () => {
    await LocalStorage.flushAllShips([{ objectId: oid, data: sample }]);
    const ls = new LocalStorage(oid);
    const loaded = await ls.get<ShipState>("state");
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(sample.id);
    expect(loaded!.name).toBe(sample.name);
    expect(loaded!.currentSystem).toBe(sample.currentSystem);
    expect(loaded!.destinationSystem).toBe(sample.destinationSystem);
    expect(loaded!.phase).toBe(sample.phase);
    expect(loaded!.credits).toBe(sample.credits);
    expect(loaded!.isNPC).toBe(sample.isNPC);
    expect(loaded!.seed).toBe(sample.seed);
    expect(loaded!.travelStartTime).toBe(sample.travelStartTime);
    expect(loaded!.lastTradeTick).toBe(0); // loadShipState always returns 0
    expect(loaded!.cargo).toEqual(sample.cargo);
    expect(loaded!.purchasePrices).toEqual(sample.purchasePrices);
  });
});
