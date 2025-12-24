/**
 * Per-tick system snapshot cache
 * 
 * This module provides a cache for system snapshots that are pre-fetched
 * at the start of each galaxy tick. Ships can use this cache instead of
 * fetching snapshots individually, eliminating duplicate I/O operations.
 */

import { SystemId, GoodId, TechLevel } from "./types";

export interface CachedSnapshot {
  state: { x?: number; y?: number; techLevel?: TechLevel } | null;
  markets: Record<GoodId, { price: number; inventory: number; production?: number; consumption?: number }>;
}

let systemSnapshotCache: Map<SystemId, CachedSnapshot> | null = null;
let snapshotCacheTickId: string | null = null;

/**
 * Set the snapshot cache for the current tick
 */
export function setSnapshotCache(
  cache: Map<SystemId, CachedSnapshot>,
  tickId: string
): void {
  systemSnapshotCache = cache;
  snapshotCacheTickId = tickId;
}

/**
 * Clear the snapshot cache (e.g., when tick completes)
 */
export function clearSnapshotCache(): void {
  systemSnapshotCache = null;
  snapshotCacheTickId = null;
}

/**
 * Get a cached snapshot for a system, if available
 * Note: Cache is cleared between ticks, so if it exists, it's valid for the current processing cycle
 */
export function getCachedSnapshot(
  systemId: SystemId
): CachedSnapshot | null {
  if (systemSnapshotCache) {
    return systemSnapshotCache.get(systemId) || null;
  }
  return null;
}

/**
 * Check if cache is available
 */
export function isCacheAvailable(): boolean {
  return systemSnapshotCache !== null;
}

