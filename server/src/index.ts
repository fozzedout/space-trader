import { CaptainDurableObject } from './dos/captain-do.js';
import { SystemDurableObject } from './dos/system-do.js';
import { EncounterDurableObject } from './dos/encounter-do.js';
import { WorldDurableObject, worldStub } from './dos/world-do.js';
import type { Env } from './env.js';
import { bootstrapGalaxy, DEMO_SYSTEMS } from './galaxy/bootstrap.js';
import { PHASE0_TUNING, fnv1a32 } from '@sto/ruleset-phase0-v1';
import {
  createMagicLink,
  completeMagicLinkSignIn,
  resolveSession,
  revokeSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  accountOwnsCaptain,
  isDevelopmentMode,
  isValidEmail,
} from './auth.js';
import { resolveActiveHumanCaptain } from './human-captain.js';
import { PUBLIC_CAPTAIN_MUTATIONS, publicDurableObjectRouteGate } from './public-routes.js';
import { claimAndStartEncounter } from './encounter-claim.js';

export { CaptainDurableObject, SystemDurableObject, EncounterDurableObject, WorldDurableObject };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const secure = url.protocol === 'https:';
    const dev = isDevelopmentMode(env);
    // Tests and local playtests can inject time, but production clients must
    // never control expiry, grace, recovery, or matching clocks.
    const nowMsHeader = request.headers.get('x-now-ms');
    const requestedNow = nowMsHeader === null ? NaN : Number(nowMsHeader);
    const nowMs = dev && Number.isFinite(requestedNow) ? requestedNow : Date.now();

    try {
      if (url.pathname === '/health') {
        return json({ ok: true, service: 'sto-server', slice: '20.5', auth: true });
      }

      // —— Auth ——
      if (url.pathname === '/auth/request-link' && request.method === 'POST') {
        const body = await request.json() as { email?: string };
        const email = body.email ?? '';
        if (!isValidEmail(email)) return json({ ok: false, error: 'invalid email' }, 400);
        const result = await createMagicLink(env.DB, email, nowMs);
        return json({
          ok: true,
          expiresAt: result.expiresAt,
          ...(dev ? { magicLinkToken: result.token, verifyPath: `/auth/verify?token=${result.token}` } : {}),
          message: dev
            ? 'Development mode: use magicLinkToken to verify.'
            : 'If that email is eligible, a sign-in link was issued.',
        });
      }

      if (url.pathname === '/auth/verify' && (request.method === 'POST' || request.method === 'GET')) {
        let token = url.searchParams.get('token') ?? '';
        if (request.method === 'POST') {
          const body = await request.json() as { token?: string };
          token = body.token ?? token;
        }
        const result = await completeMagicLinkSignIn(env.DB, token, nowMs);
        if (!result.ok) return json(result, 400);

        const resolved = await resolveActiveHumanCaptain(env, {
          accountId: result.account.id,
          email: result.account.email,
          captainId: result.captainId,
          nowMs,
        });
        if (!resolved.ok) return json({ ok: false, error: resolved.error }, 500);
        const captainId = resolved.captainId;

        const headers = new Headers({ 'content-type': 'application/json' });
        headers.append(
          'set-cookie',
          sessionCookieHeader(result.session.id, result.session.expires_at, { secure }),
        );
        return new Response(JSON.stringify({
          ok: true,
          accountId: result.account.id,
          email: result.account.email,
          captainId,
        }), { status: 200, headers });
      }

      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        const auth = await resolveSession(env.DB, request, nowMs);
        if (auth) await revokeSession(env.DB, auth.sessionId);
        const headers = new Headers({ 'content-type': 'application/json' });
        headers.append('set-cookie', clearSessionCookieHeader({ secure }));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
      }

      if (url.pathname === '/auth/me' && request.method === 'GET') {
        const auth = await resolveSession(env.DB, request, nowMs);
        if (!auth) return json({ ok: false, error: 'unauthenticated' }, 401);
        const resolved = await resolveActiveHumanCaptain(env, {
          accountId: auth.accountId,
          email: auth.email,
          captainId: auth.captainId,
          nowMs,
        });
        if (!resolved.ok) return json({ ok: false, error: resolved.error }, 500);
        return json({
          ok: true,
          accountId: auth.accountId,
          email: auth.email,
          captainId: resolved.captainId,
        });
      }

      // —— Admin / playtest (development only) ——
      if (url.pathname === '/admin/bootstrap' && request.method === 'POST') {
        if (!dev) return json({ ok: false, error: 'bootstrap disabled outside development' }, 403);
        const galaxy = bootstrapGalaxy(nowMs);
        for (const spec of DEMO_SYSTEMS) {
          const system = env.SYSTEM.get(env.SYSTEM.idFromName(spec.systemId));
          const res = await system.fetch(new Request('https://system/bootstrap', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
            body: JSON.stringify({
              systemId: spec.systemId,
              name: spec.name,
              techLevel: spec.techLevel,
              politicsId: spec.politicsId,
              size: spec.size,
              goods: spec.goods,
            }),
          }));
          if (!res.ok) return json({ ok: false, error: await res.text() }, 500);
        }

        // Seed NPCs only — human captains are created via magic-link auth.
        for (const captain of Object.values(galaxy.captains)) {
          if (captain.kind !== 'npc') continue;
          const stub = env.CAPTAIN.get(env.CAPTAIN.idFromName(captain.captainId));
          const res = await stub.fetch(new Request('https://captain/bootstrap', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
            body: JSON.stringify({
              captainId: captain.captainId,
              kind: captain.kind,
              handle: captain.handle,
              systemId: captain.systemId,
              credits: captain.credits,
              combatProfile: captain.combatProfile,
              tradeProfile: captain.tradeProfile,
            }),
          }));
          if (!res.ok) return json({ ok: false, error: await res.text() }, 500);
        }

        for (const spec of DEMO_SYSTEMS) {
          await env.DB.prepare(
            `INSERT OR REPLACE INTO systems (id, name, tech_level, politics_id, size, x, y)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(spec.systemId, spec.name, spec.techLevel, spec.politicsId, spec.size,
            spec.systemId === 'sol' ? 0 : 10, 0).run();
        }

        await worldStub(env).fetch(new Request('https://world/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
        }));

        return json({
          ok: true,
          systems: DEMO_SYSTEMS.map((s) => s.systemId),
          npcs: Object.values(galaxy.captains).filter((c) => c.kind === 'npc').map((c) => c.captainId),
        });
      }

      if (url.pathname === '/admin/ambient-tick' && request.method === 'POST') {
        if (!dev) return json({ ok: false, error: 'admin disabled outside development' }, 403);
        const res = await worldStub(env).fetch(new Request('https://world/tick', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
        }));
        return json(await res.json());
      }

      if (url.pathname === '/admin/seed-traffic' && request.method === 'POST') {
        if (!dev) return json({ ok: false, error: 'admin disabled outside development' }, 403);
        // Dev-only fallback; production uses ambient NPC travel + /systems/:id/match.
        const body = await request.json() as {
          systemId: string;
          routeArea: string;
          humanCaptainId: string;
        };
        const auth = await resolveSession(env.DB, request, nowMs);
        if (!auth?.captainId || auth.captainId !== body.humanCaptainId) {
          return json({ ok: false, error: 'forbidden' }, 403);
        }
        const now = nowMs;
        const npcId = body.systemId === 'sol' ? 'captain-npc-1' : 'captain-npc-2';
        const system = env.SYSTEM.get(env.SYSTEM.idFromName(body.systemId));

        for (const captainId of [body.humanCaptainId, npcId]) {
          const cap = env.CAPTAIN.get(env.CAPTAIN.idFromName(captainId));
          await cap.fetch(new Request('https://captain/playtest/force-approach', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-now-ms': String(now) },
            body: JSON.stringify({
              destinationSystemId: body.systemId,
              routeArea: body.routeArea,
            }),
          }));
          await system.fetch(new Request('https://system/presence', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-now-ms': String(now) },
            body: JSON.stringify({
              captainId,
              routeArea: body.routeArea,
              approachTick: 1,
              occupancyStartedAt: now,
              occupancyEndsAt: now + PHASE0_TUNING.travelWindowMs,
              matchable: true,
            }),
          }));
        }

        const [a, b] = body.humanCaptainId < npcId
          ? [body.humanCaptainId, npcId]
          : [npcId, body.humanCaptainId];
        const encounterId = `enc-play-${fnv1a32(`${body.routeArea}|${now}|${a}|${b}`).toString(16)}`;
        const started = await claimAndStartEncounter(env, body.systemId, {
          encounterId,
          captainAId: a,
          captainBId: b,
          routeArea: body.routeArea,
        }, now);
        return json({ ok: started.ok, encounterId: started.encounterId ?? null, reason: started.reason });
      }

      const encounterMatch = url.pathname.match(/^\/encounters\/([^/]+)(?:\/(.*))?$/);
      if (encounterMatch) {
        const blocked = publicDurableObjectRouteGate(request);
        if (blocked) return blocked;
        const encounterId = decodeURIComponent(encounterMatch[1]!);
        const rest = encounterMatch[2] ?? 'view';
        const auth = await resolveSession(env.DB, request, nowMs);
        // Encounter views are perspective-specific (they hide the caller's
        // locked action).  Treat every player-facing encounter endpoint as
        // authenticated, including reconnect summaries and manual ticks.
        if (!auth?.captainId) {
          return json({ ok: false, error: 'unauthenticated' }, 401);
        }
        const stub = env.ENCOUNTER.get(env.ENCOUNTER.idFromName(encounterId));
        const path = `/${rest}`;
        const headers = new Headers(request.headers);
        headers.set('x-now-ms', String(nowMs));
        if (request.method === 'GET' || request.method === 'HEAD') {
          const requestedCaptainId = url.searchParams.get('captainId');
          if (!requestedCaptainId || requestedCaptainId !== auth.captainId) {
            return json({ ok: false, error: 'forbidden' }, 403);
          }
          const qs = url.search;
          return stub.fetch(new Request(`https://encounter${path}${qs}`, { method: request.method, headers }));
        }
        let bodyText = await request.text();
        if (rest === 'action' || rest === 'disconnect' || rest === 'reconnect') {
          const parsed = JSON.parse(bodyText || '{}') as { captainId?: string };
          if (!auth?.captainId || parsed.captainId !== auth.captainId) {
            return json({ ok: false, error: 'forbidden' }, 403);
          }
        }
        if (rest === 'tick') {
          // Alarm processing is the authoritative timer.  A player cannot
          // advance an encounter on demand.
          return json({ ok: false, error: 'tick is internal' }, 403);
        }
        return stub.fetch(new Request(`https://encounter${path}`, {
          method: request.method,
          headers,
          body: bodyText,
        }));
      }

      const captainMatch = url.pathname.match(/^\/captains\/([^/]+)(?:\/(.*))?$/);
      if (captainMatch) {
        const blocked = publicDurableObjectRouteGate(request);
        if (blocked) return blocked;
        const captainId = decodeURIComponent(captainMatch[1]!);
        const rest = captainMatch[2] ?? 'view';

        const stub = env.CAPTAIN.get(env.CAPTAIN.idFromName(captainId));
        const path = rest === 'view' || rest === '' ? '/view' : `/${rest}`;

        if (request.method !== 'GET' && request.method !== 'HEAD' && PUBLIC_CAPTAIN_MUTATIONS.has(rest)) {
          const auth = await resolveSession(env.DB, request, nowMs);
          if (!auth) return json({ ok: false, error: 'unauthenticated' }, 401);
          if (!(await accountOwnsCaptain(env.DB, auth.accountId, captainId))) {
            return json({ ok: false, error: 'forbidden' }, 403);
          }
        }

        const method = request.method;
        const headers = new Headers(request.headers);
        headers.set('x-now-ms', String(nowMs));
        if (method === 'GET' || method === 'HEAD') {
          return stub.fetch(new Request(`https://captain${path}`, { method, headers }));
        }
        headers.set('content-type', 'application/json');
        return stub.fetch(new Request(`https://captain${path}`, {
          method,
          headers,
          body: await request.text(),
        }));
      }

      const systemMatch = url.pathname.match(/^\/systems\/([^/]+)(?:\/(.*))?$/);
      if (systemMatch) {
        const blocked = publicDurableObjectRouteGate(request);
        if (blocked) return blocked;
        const systemId = decodeURIComponent(systemMatch[1]!);
        const rest = systemMatch[2] ?? 'market';

        const stub = env.SYSTEM.get(env.SYSTEM.idFromName(systemId));

        if (rest === 'wrecks/rescue' && request.method === 'POST') {
          const auth = await resolveSession(env.DB, request, nowMs);
          if (!auth?.captainId) return json({ ok: false, error: 'unauthenticated' }, 401);
          const body = await request.json() as { wreckId: string; rescuerId: string };
          if (body.rescuerId !== auth.captainId) return json({ ok: false, error: 'forbidden' }, 403);
          const rescueRes = await stub.fetch(new Request('https://system/wrecks/rescue', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
            body: JSON.stringify(body),
          }));
          const rescued = await rescueRes.json();
          return json(rescued, rescueRes.ok ? 200 : 400);
        }

        if (rest === 'wrecks/process-recovery' && request.method === 'POST') {
          if (!dev) return json({ ok: false, error: 'admin disabled outside development' }, 403);
          const proc = await stub.fetch(new Request('https://system/wrecks/process-recovery', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
          }));
          const data = await proc.json() as { ok: boolean; due: Array<{ wreckId: string; captainId: string }> };
          for (const row of data.due ?? []) {
            const captain = env.CAPTAIN.get(env.CAPTAIN.idFromName(row.captainId));
            await captain.fetch(new Request('https://captain/recovery/complete', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
              body: JSON.stringify({
                operationId: `auto-${row.wreckId}`,
                safeSystemId: systemId,
                source: 'automated',
              }),
            }));
          }
          return json(data);
        }

        if (rest === 'match' && request.method === 'POST') {
          const auth = await resolveSession(env.DB, request, nowMs);
          if (!auth?.captainId) return json({ ok: false, error: 'unauthenticated' }, 401);
          const body = await request.json() as { routeArea: string; globalTick: number };
          const matchRes = await stub.fetch(new Request('https://system/match', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
            body: JSON.stringify(body),
          }));
          const matched = await matchRes.json() as {
            ok: boolean;
            pairs?: Array<{ encounterId: string; captainAId: string; captainBId: string; routeArea: string }>;
          };
          if (!matched.ok || !matched.pairs) return json(matched, 400);

          const claimed = [];
          for (const pair of matched.pairs) {
            const outcome = await claimAndStartEncounter(env, systemId, pair, nowMs);
            claimed.push({ pair, ...outcome });
          }
          return json({ ok: true, pairs: matched.pairs, claimed });
        }

        // Remaining allowlisted system routes: market GET/HEAD, wrecks GET/HEAD
        const headers = new Headers(request.headers);
        headers.set('x-now-ms', String(nowMs));
        const systemPath = rest === '' || rest === 'market' ? 'market' : rest;
        return stub.fetch(new Request(`https://system/${systemPath}`, { method: request.method, headers }));
      }

      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/app.js' || url.pathname === '/styles.css') {
        return env.ASSETS.fetch(request);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : 'error' }, 500);
    }
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
