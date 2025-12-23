import { ShipPhase, ShipState, ShipId, SystemId } from "./types";

const DEFAULT_STALE_MS = 120000;
const LOCAL_PHASES = new Set<ShipPhase>([
  "at_station",
  "resting",
  "sleeping",
  "departing",
  "arriving",
]);

export type ShipPresence = {
  shipId: ShipId;
  systemId: SystemId;
  phase: ShipPhase;
  lastSeen: number;
};

const systemIndex = new Map<SystemId, Map<ShipId, ShipPresence>>();
const shipIndex = new Map<ShipId, ShipPresence>();

function removeFromSystem(shipId: ShipId, systemId: SystemId): void {
  const systemMap = systemIndex.get(systemId);
  if (!systemMap) return;
  systemMap.delete(shipId);
  if (systemMap.size === 0) {
    systemIndex.delete(systemId);
  }
}

export function updateShipPresence(shipState: ShipState): void {
  const now = Date.now();
  const shouldTrack =
    shipState.currentSystem !== null &&
    shipState.currentSystem !== undefined &&
    LOCAL_PHASES.has(shipState.phase);

  const existing = shipIndex.get(shipState.id);

  if (!shouldTrack) {
    if (existing) {
      removeFromSystem(existing.shipId, existing.systemId);
      shipIndex.delete(shipState.id);
    }
    return;
  }

  const systemId = shipState.currentSystem as SystemId;
  if (existing && existing.systemId !== systemId) {
    removeFromSystem(existing.shipId, existing.systemId);
  }

  const presence: ShipPresence = {
    shipId: shipState.id,
    systemId,
    phase: shipState.phase,
    lastSeen: now,
  };

  shipIndex.set(shipState.id, presence);

  let systemMap = systemIndex.get(systemId);
  if (!systemMap) {
    systemMap = new Map();
    systemIndex.set(systemId, systemMap);
  }
  systemMap.set(shipState.id, presence);
}

export function removeShipPresence(shipId: ShipId): void {
  const existing = shipIndex.get(shipId);
  if (!existing) return;
  removeFromSystem(existing.shipId, existing.systemId);
  shipIndex.delete(shipId);
}

export function clearShipPresence(): void {
  systemIndex.clear();
  shipIndex.clear();
}

function pruneStaleEntries(staleMs: number): void {
  const now = Date.now();
  for (const [shipId, presence] of Array.from(shipIndex.entries())) {
    if (now - presence.lastSeen > staleMs) {
      removeFromSystem(shipId, presence.systemId);
      shipIndex.delete(shipId);
    }
  }
}

export function listShipsInSystem(systemId: SystemId, staleMs = DEFAULT_STALE_MS): ShipId[] {
  pruneStaleEntries(staleMs);
  const systemMap = systemIndex.get(systemId);
  if (!systemMap) return [];
  return Array.from(systemMap.keys());
}

export function getPresenceBySystem(staleMs = DEFAULT_STALE_MS): Record<number, ShipPresence[]> {
  pruneStaleEntries(staleMs);
  const result: Record<number, ShipPresence[]> = {};
  for (const [systemId, systemMap] of Array.from(systemIndex.entries())) {
    result[systemId] = Array.from(systemMap.values()).map(presence => ({
      shipId: presence.shipId,
      systemId: presence.systemId,
      phase: presence.phase,
      lastSeen: presence.lastSeen,
    }));
  }
  return result;
}
