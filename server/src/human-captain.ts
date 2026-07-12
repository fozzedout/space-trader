/**
 * Ensure the account's bound human captain is playable (ACTIVE), succeeding
 * past RETIRED/DEAD identities and bootstrapping the Captain DO when needed.
 */
import { DEMO_SYSTEMS } from './galaxy/bootstrap.js';
import { resolveCaptainIdForAccount, succeedIfTerminalCaptain } from './auth.js';

export interface CaptainStub {
  fetch(request: Request): Promise<Response>;
}

export interface HumanCaptainEnv {
  DB: D1Database;
  CAPTAIN: {
    idFromName(name: string): unknown;
    get(id: unknown): CaptainStub;
  };
}

export async function resolveActiveHumanCaptain(
  env: HumanCaptainEnv,
  args: {
    accountId: string;
    email: string;
    /** When known (e.g. from session/verify); otherwise looked up from D1. */
    captainId?: string | null;
    nowMs: number;
  },
): Promise<{ ok: true; captainId: string } | { ok: false; error: string }> {
  let captainId = args.captainId ?? await resolveCaptainIdForAccount(env.DB, args.accountId);
  if (!captainId) {
    return { ok: false, error: 'no captain bound to account' };
  }

  const handle = args.email.split('@')[0] || 'Captain';
  const systemId = DEMO_SYSTEMS[0]!.systemId;
  let stub = env.CAPTAIN.get(env.CAPTAIN.idFromName(captainId));

  const viewRes = await stub.fetch(new Request('https://captain/view', {
    headers: { 'x-now-ms': String(args.nowMs) },
  }));

  if (viewRes.ok) {
    const viewBody = await viewRes.json() as {
      ok?: boolean;
      captain?: { lifecycleState?: string };
    };
    const lifecycleState = viewBody.captain?.lifecycleState ?? 'ACTIVE';
    const succession = await succeedIfTerminalCaptain(env.DB, {
      accountId: args.accountId,
      captainId,
      lifecycleState,
      nowMs: args.nowMs,
    });
    if (succession.succeeded) {
      captainId = succession.captainId;
      stub = env.CAPTAIN.get(env.CAPTAIN.idFromName(captainId));
      const boot = await stub.fetch(new Request('https://captain/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-now-ms': String(args.nowMs) },
        body: JSON.stringify({
          captainId,
          kind: 'human',
          handle,
          systemId,
          credits: 12_000,
          accountId: args.accountId,
        }),
      }));
      if (!boot.ok) {
        return { ok: false, error: await boot.text() };
      }
    }
  } else {
    const boot = await stub.fetch(new Request('https://captain/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-now-ms': String(args.nowMs) },
      body: JSON.stringify({
        captainId,
        kind: 'human',
        handle,
        systemId,
        credits: 12_000,
        accountId: args.accountId,
      }),
    }));
    if (!boot.ok) {
      return { ok: false, error: await boot.text() };
    }
  }

  return { ok: true, captainId };
}
