import type { CommodityId } from '@sto/original-baseline-rules';
import { COMMODITIES } from '@sto/original-baseline-rules';
import { PHASE0_TUNING } from './config.js';
import type { RulesetRng } from './prng.js';
import type { CargoLot } from './types.js';

/** Gemstones are always lost; Phase 0 has no gem commodity in the baseline table,
 * but a commodity may mark wreck recoverability explicitly later. */
export function isWreckRecoverable(good: CommodityId): boolean {
  const def = COMMODITIES[good];
  if (!def) return false;
  // Baseline has no gemstone row; all standard cargo uses the same survival chance.
  return true;
}

export function survivingCargo(
  cargo: readonly CargoLot[],
  rng: RulesetRng,
  survivalPercent = PHASE0_TUNING.cargoSurvivalPercent,
): CargoLot[] {
  const out: CargoLot[] = [];
  for (const lot of cargo) {
    if (!isWreckRecoverable(lot.good)) continue;
    let qty = 0;
    for (let i = 0; i < lot.qty; i += 1) {
      if (rng.nextInt(100) < survivalPercent) qty += 1;
    }
    if (qty > 0) out.push({ good: lot.good, qty });
  }
  return out;
}

export type EscapePodState =
  | 'AVAILABLE'
  | 'RESCUE_CLAIMED'
  | 'RESCUED'
  | 'DESTROYED'
  | 'EXPIRED'
  | 'AUTOMATED_RECOVERY'
  | 'COMPLETE';

export interface WreckDebris {
  readonly wreckId: string;
  /** Approach-space segment where this wreck persists (e.g. `regulas:approach`). */
  readonly routeArea: string;
  readonly cargo: readonly CargoLot[];
  readonly escapePodCaptainId: string | null;
  readonly podState: EscapePodState | null;
  readonly recoveryDueAt: number | null;
  readonly expiresAt: number;
}

export function createWreck(args: {
  readonly wreckId: string;
  readonly routeArea: string;
  readonly cargo: readonly CargoLot[];
  readonly nowMs: number;
  readonly escapePodCaptainId?: string;
  readonly hasCloneBackup?: boolean;
}): WreckDebris {
  const hasPod = args.escapePodCaptainId !== undefined;
  return {
    wreckId: args.wreckId,
    routeArea: args.routeArea,
    cargo: args.cargo,
    escapePodCaptainId: args.escapePodCaptainId ?? null,
    podState: hasPod ? 'AVAILABLE' : null,
    recoveryDueAt: hasPod ? args.nowMs + PHASE0_TUNING.escapePodRecoveryMs : null,
    expiresAt: args.nowMs + PHASE0_TUNING.wreckLifetimeMs,
  };
}

export function scoopCargo(
  wreck: WreckDebris,
  freeCapacity: number,
  requested: readonly CargoLot[],
): { wreck: WreckDebris; scooped: CargoLot[] } {
  if (freeCapacity <= 0) return { wreck, scooped: [] };
  let remaining = freeCapacity;
  const scooped: CargoLot[] = [];
  const left = wreck.cargo.map((lot) => ({ ...lot }));
  for (const req of requested) {
    const idx = left.findIndex((l) => l.good === req.good);
    if (idx < 0) continue;
    const available = left[idx]!;
    const take = Math.min(available.qty, req.qty, remaining);
    if (take <= 0) continue;
    scooped.push({ good: req.good, qty: take });
    available.qty -= take;
    remaining -= take;
  }
  return {
    wreck: { ...wreck, cargo: left.filter((l) => l.qty > 0) },
    scooped,
  };
}

export function transitionEscapePod(
  wreck: WreckDebris,
  next: EscapePodState,
  nowMs: number,
): WreckDebris {
  if (!wreck.podState || wreck.podState === 'COMPLETE') return wreck;
  const terminal = new Set(['RESCUED', 'DESTROYED', 'EXPIRED', 'AUTOMATED_RECOVERY', 'COMPLETE']);
  if (terminal.has(wreck.podState) && next !== 'COMPLETE') return wreck;

  let recoveryDueAt = wreck.recoveryDueAt;
  if (next === 'DESTROYED' || next === 'EXPIRED') {
    // Destroying/expiring the physical pod does not change scheduled clone recovery.
    recoveryDueAt = wreck.recoveryDueAt;
  }
  if (next === 'RESCUED') {
    recoveryDueAt = nowMs;
  }
  return { ...wreck, podState: next, recoveryDueAt };
}

export function dueAutomatedRecovery(wreck: WreckDebris, nowMs: number): boolean {
  return wreck.podState === 'AVAILABLE'
    || wreck.podState === 'DESTROYED'
    || wreck.podState === 'EXPIRED'
    || wreck.podState === 'RESCUE_CLAIMED'
      ? (wreck.recoveryDueAt !== null && nowMs >= wreck.recoveryDueAt && wreck.escapePodCaptainId !== null)
      : false;
}
