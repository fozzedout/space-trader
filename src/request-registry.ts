import { GoodId, SystemId } from "./types";

export type RequestEntry = {
  goodId: GoodId;
  bonusPerUnit: number;
  remainingUnits: number;
  price: number;
};

export type SystemRequestEntry = {
  systemId: SystemId;
  x: number;
  y: number;
  requests: RequestEntry[];
  updatedAt: number;
};

const requestRegistry = new Map<SystemId, SystemRequestEntry>();

export function updateRequestRegistry(
  systemId: SystemId,
  coords: { x: number; y: number },
  requests: RequestEntry[]
): void {
  if (!requests || requests.length === 0) {
    requestRegistry.delete(systemId);
    return;
  }

  requestRegistry.set(systemId, {
    systemId,
    x: coords.x,
    y: coords.y,
    requests,
    updatedAt: Date.now(),
  });
}

export function getRequestRegistry(): SystemRequestEntry[] {
  return Array.from(requestRegistry.values());
}

export function getSystemRequests(systemId: SystemId): SystemRequestEntry | null {
  return requestRegistry.get(systemId) || null;
}

export function clearRequestRegistry(): void {
  requestRegistry.clear();
}
