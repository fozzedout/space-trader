import { GOOD_IDS, type GoodId } from "./goods.js";
import type { StarSystem } from "./system.js";

/**
 * Information model: nobody is omniscient — not NPC traders, not players.
 *
 * A ship knows a system's market only as a SNAPSHOT taken when it (or
 * someone who reported to the hub network) last saw it. Trade hubs are
 * connected to each other by an instant relay: a ship docking at any hub
 * uploads everything it has observed and downloads everything the network
 * has heard. News of a shortage therefore physically travels: someone has
 * to see it, then carry it to a hub, and from there it reaches everyone
 * who checks in at any hub.
 *
 * Any ship — NPC or player — gets exactly the same InfoBoard mechanics.
 */
export interface MarketSnapshot {
  /** Tick at which this observation was made. */
  readonly tick: number;
  readonly prices: Readonly<Record<GoodId, number>>;
  readonly inventories: Readonly<Record<GoodId, number>>;
}

export function takeSnapshot(system: StarSystem, tick: number): MarketSnapshot {
  const prices = {} as Record<GoodId, number>;
  const inventories = {} as Record<GoodId, number>;
  for (const good of GOOD_IDS) {
    prices[good] = system.markets[good].price;
    inventories[good] = system.markets[good].inventory;
  }
  return { tick, prices, inventories };
}

/** A flight plan filed with the hub network: cargo already on its way. */
export interface Manifest {
  destId: number;
  good: GoodId;
  qty: number;
  arrivalTick: number;
}

/**
 * The hub relay network: shared market news plus shipping manifests.
 * Ships departing a hub with cargo file a flight plan; anyone planning at
 * a hub sees what's already in flight and discounts the opportunity. This
 * is what stops every hub-synced trader chasing the same shortage — the
 * network coordinates through information, never by moving goods itself.
 */
export class HubNetwork {
  readonly board = new InfoBoard();
  private manifests: Manifest[] = [];
  /** Sum of in-flight qty keyed by "destId:good" — pendingFor is on the
   * innermost route-evaluation path, so it must be O(1). */
  private pendingIndex = new Map<string, number>();

  file(manifest: Manifest): void {
    this.manifests.push(manifest);
    const key = `${manifest.destId}:${manifest.good}`;
    this.pendingIndex.set(key, (this.pendingIndex.get(key) ?? 0) + manifest.qty);
  }

  /** Units already in flight to `destId` for `good` (unexpired manifests). */
  pendingFor(destId: number, good: GoodId): number {
    return this.pendingIndex.get(`${destId}:${good}`) ?? 0;
  }

  /** Drop manifests for journeys that have already arrived. */
  prune(tick: number): void {
    if (this.manifests.length === 0) return;
    this.manifests = this.manifests.filter((m) => m.arrivalTick > tick);
    this.pendingIndex.clear();
    for (const m of this.manifests) {
      const key = `${m.destId}:${m.good}`;
      this.pendingIndex.set(key, (this.pendingIndex.get(key) ?? 0) + m.qty);
    }
  }
}

export class InfoBoard {
  private entries = new Map<number, MarketSnapshot>();

  /** Store an observation; an older snapshot never overwrites a newer one. */
  record(systemId: number, snap: MarketSnapshot): void {
    const current = this.entries.get(systemId);
    if (!current || snap.tick >= current.tick) {
      this.entries.set(systemId, snap);
    }
  }

  get(systemId: number): MarketSnapshot | undefined {
    return this.entries.get(systemId);
  }

  /** Two-way sync (e.g. ship docking at a hub): freshest snapshot wins on both sides. */
  syncWith(other: InfoBoard): void {
    for (const [id, snap] of other.entries) this.record(id, snap);
    for (const [id, snap] of this.entries) other.record(id, snap);
  }

  /** Average age (ticks) of this board's knowledge across `systemIds`. */
  avgAge(tick: number, systemIds: readonly number[]): number {
    if (systemIds.length === 0) return 0;
    let sum = 0;
    for (const id of systemIds) {
      const snap = this.entries.get(id);
      sum += snap ? tick - snap.tick : tick;
    }
    return sum / systemIds.length;
  }
}
