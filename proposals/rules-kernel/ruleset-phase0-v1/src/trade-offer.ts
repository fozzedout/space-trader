import type { BilateralExchange, CargoTransfer } from './types.js';
import { fnv1a32 } from './prng.js';

function normalizeCargo(cargo: readonly CargoTransfer[]): CargoTransfer[] {
  const map = new Map<number, number>();
  for (const lot of cargo) {
    if (!Number.isSafeInteger(lot.qty) || lot.qty < 0) {
      throw new RangeError('cargo qty must be a non-negative safe integer');
    }
    if (lot.qty === 0) continue;
    map.set(lot.good, (map.get(lot.good) ?? 0) + lot.qty);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([good, qty]) => ({ good, qty }));
}

/**
 * Canonicalise a bilateral exchange: net same-asset flows both ways and reject
 * zero-effect or negative amounts (design §5.2).
 */
export function canonicalizeExchange(raw: BilateralExchange): BilateralExchange {
  if (raw.aToB.credits < 0 || raw.bToA.credits < 0) {
    throw new RangeError('negative credits invalid');
  }
  const aCargo = normalizeCargo(raw.aToB.cargo);
  const bCargo = normalizeCargo(raw.bToA.cargo);
  const goods = new Set<number>([...aCargo.map((c) => c.good), ...bCargo.map((c) => c.good)]);

  const netAtoB: CargoTransfer[] = [];
  const netBtoA: CargoTransfer[] = [];
  for (const good of [...goods].sort((a, b) => a - b)) {
    const aQty = aCargo.find((c) => c.good === good)?.qty ?? 0;
    const bQty = bCargo.find((c) => c.good === good)?.qty ?? 0;
    const net = aQty - bQty;
    if (net > 0) netAtoB.push({ good, qty: net });
    else if (net < 0) netBtoA.push({ good, qty: -net });
  }

  const creditNet = raw.aToB.credits - raw.bToA.credits;
  const aCredits = creditNet > 0 ? creditNet : 0;
  const bCredits = creditNet < 0 ? -creditNet : 0;

  if (aCredits === 0 && bCredits === 0 && netAtoB.length === 0 && netBtoA.length === 0) {
    throw new Error('zero-effect exchange');
  }

  return {
    aToB: { credits: aCredits, cargo: netAtoB },
    bToA: { credits: bCredits, cargo: netBtoA },
  };
}

export function proposalHash(exchange: BilateralExchange): string {
  const canonical = canonicalizeExchange(exchange);
  const payload = JSON.stringify(canonical);
  return `to-${fnv1a32(payload).toString(16).padStart(8, '0')}`;
}

export function exchangesEqual(a: BilateralExchange, b: BilateralExchange): boolean {
  return proposalHash(a) === proposalHash(b);
}

/** Reverse A/B roles so both captains can describe the same deal from their side. */
export function reverseExchange(exchange: BilateralExchange): BilateralExchange {
  return canonicalizeExchange({
    aToB: exchange.bToA,
    bToA: exchange.aToB,
  });
}

export function holdingsCover(
  credits: number,
  cargo: ReadonlyMap<number, number> | readonly { good: number; qty: number }[],
  neededCredits: number,
  neededCargo: readonly CargoTransfer[],
): boolean {
  if (credits < neededCredits) return false;
  const map: ReadonlyMap<number, number> = cargo instanceof Map
    ? cargo
    : new Map((cargo as readonly { good: number; qty: number }[]).map((c) => [c.good, c.qty]));
  for (const lot of neededCargo) {
    if ((map.get(lot.good) ?? 0) < lot.qty) return false;
  }
  return true;
}
