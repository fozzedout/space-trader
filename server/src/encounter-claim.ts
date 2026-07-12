import { PHASE0_TUNING, CommodityId, fnv1a32 } from '@sto/ruleset-phase0-v1';

/** Minimal bindings needed to claim captains and start an encounter. */
export interface EncounterClaimEnv {
  CAPTAIN: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  SYSTEM: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  ENCOUNTER: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

export type EncounterPairClaim = {
  encounterId: string;
  captainAId: string;
  captainBId: string;
  routeArea: string;
};

export type ClaimAndStartResult = {
  ok: boolean;
  reason?: string;
  encounterId?: string;
};

/**
 * Two-captain claim + Encounter DO start (design §4.4).
 * Optional `markClaim` avoids System DO self-fetch deadlock when invoked from
 * the System DO alarm path — callers mark presence locally instead.
 */
export async function claimAndStartEncounter(
  env: EncounterClaimEnv,
  systemId: string,
  pair: EncounterPairClaim,
  nowMs: number,
  options?: {
    markClaim?: (captainId: string, encounterId: string) => Promise<void> | void;
  },
): Promise<ClaimAndStartResult> {
  const expiresAt = nowMs + PHASE0_TUNING.encounterClaimTimeoutMs;
  const claimOne = async (captainId: string) => {
    const stub = env.CAPTAIN.get(env.CAPTAIN.idFromName(captainId));
    const res = await stub.fetch(new Request('https://captain/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
      body: JSON.stringify({
        encounterId: pair.encounterId,
        routeArea: pair.routeArea,
        expiresAt,
      }),
    }));
    const data = await res.json() as { ok: boolean };
    return data.ok;
  };
  const releaseOne = async (captainId: string) => {
    const stub = env.CAPTAIN.get(env.CAPTAIN.idFromName(captainId));
    await stub.fetch(new Request('https://captain/claim/release', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
      body: JSON.stringify({ encounterId: pair.encounterId }),
    }));
  };

  const aOk = await claimOne(pair.captainAId);
  const bOk = await claimOne(pair.captainBId);
  if (!(aOk && bOk)) {
    if (aOk) await releaseOne(pair.captainAId);
    if (bOk) await releaseOne(pair.captainBId);
    return { ok: false, reason: 'partial_or_rejected_claim' };
  }

  const markClaim = options?.markClaim ?? (async (captainId: string, encounterId: string) => {
    const system = env.SYSTEM.get(env.SYSTEM.idFromName(systemId));
    await system.fetch(new Request('https://system/claim/mark', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
      body: JSON.stringify({ captainId, encounterId }),
    }));
  });
  await markClaim(pair.captainAId, pair.encounterId);
  await markClaim(pair.captainBId, pair.encounterId);

  const bootA = await captainBootstrapPayload(env, pair.captainAId, nowMs);
  const bootB = await captainBootstrapPayload(env, pair.captainBId, nowMs);
  if (!bootA || !bootB) {
    await releaseOne(pair.captainAId);
    await releaseOne(pair.captainBId);
    return { ok: false, reason: 'missing_captain_view' };
  }

  const relationships: Record<string, unknown> = {};
  for (const boot of [bootA, bootB]) {
    if (boot.kind !== 'npc') continue;
    for (const rel of boot.relationships ?? []) {
      relationships[`${boot.captainId}::${rel.otherCaptainId}`] = rel;
    }
  }

  const seed = fnv1a32(`${pair.encounterId}:${nowMs}`) || 1;
  const encounter = env.ENCOUNTER.get(env.ENCOUNTER.idFromName(pair.encounterId));
  const startRes = await encounter.fetch(new Request('https://encounter/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
    body: JSON.stringify({
      encounterId: pair.encounterId,
      systemId,
      routeArea: pair.routeArea,
      seed,
      a: bootA,
      b: bootB,
      relationships,
    }),
  }));
  if (!startRes.ok) {
    await releaseOne(pair.captainAId);
    await releaseOne(pair.captainBId);
    return { ok: false, reason: await startRes.text() };
  }
  return { ok: true, encounterId: pair.encounterId };
}

async function captainBootstrapPayload(env: EncounterClaimEnv, captainId: string, nowMs: number) {
  const stub = env.CAPTAIN.get(env.CAPTAIN.idFromName(captainId));
  const res = await stub.fetch(new Request('https://captain/internal/snapshot', {
    headers: { 'x-now-ms': String(nowMs) },
  }));
  if (!res.ok) return null;
  const data = await res.json() as {
    ok: boolean;
    snapshot: {
      captainId: string;
      kind: 'human' | 'npc';
      handle: string;
      proxyMode: 'learned' | 'coward';
      hull: number;
      maxHull: number;
      shields: number[];
      credits: number;
      cargo: Array<{ good: CommodityId; qty: number }>;
      combatProfile: number;
      tradeProfile: number;
      policeRecord: number;
      hasEscapePod: boolean;
      relationships: Array<{
        otherCaptainId: string;
        hostilityScore: number;
        facts: string[];
        lockedExtreme: boolean;
        updatedAt: number;
      }>;
    };
  };
  if (!data.ok || !data.snapshot) return null;
  // Controller type stays on the private snapshot for Encounter DO only — never in public APIs.
  return data.snapshot;
}
