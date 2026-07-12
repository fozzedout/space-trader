/**
 * Explicit allowlists for paths reachable through the public Worker HTTP router.
 * Internal DO-to-DO paths must NOT appear here — they are invoked via Durable
 * Object stub `.fetch()` only and must 404 when hit through `/captains/:id/*`,
 * `/systems/:id/*`, or `/encounters/:id/*`.
 */

export const PUBLIC_CAPTAIN_MUTATIONS = new Set([
  'trade',
  'travel/start',
  'travel/advance',
  'dock/refuel',
  'dock/repair',
  'dock/upgrade',
  'retire',
  'equipment/escape-pod',
  'police/respond',
]);

export const PUBLIC_SYSTEM_MUTATIONS = new Set([
  'wrecks/rescue',
  'wrecks/process-recovery',
  'match',
]);

export const PUBLIC_ENCOUNTER_MUTATIONS = new Set([
  'action',
  'disconnect',
  'reconnect',
]);

/** True when this method+path may be forwarded to the Captain DO from the public Worker. */
export function isPublicCaptainRoute(method: string, rest: string): boolean {
  const path = rest === '' ? 'view' : rest;
  if (method === 'GET' || method === 'HEAD') {
    return path === 'view';
  }
  if (method === 'POST') {
    return PUBLIC_CAPTAIN_MUTATIONS.has(path);
  }
  return false;
}

/** True when this method+path may be forwarded/handled for a System DO from the public Worker. */
export function isPublicSystemRoute(method: string, rest: string): boolean {
  const path = rest === '' ? 'market' : rest;
  if (method === 'GET' || method === 'HEAD') {
    return path === 'market' || path === 'wrecks';
  }
  if (method === 'POST') {
    return PUBLIC_SYSTEM_MUTATIONS.has(path);
  }
  return false;
}

/** True when this method+path may be forwarded to the Encounter DO from the public Worker. */
export function isPublicEncounterRoute(method: string, rest: string): boolean {
  const path = rest === '' ? 'view' : rest;
  if (method === 'GET' || method === 'HEAD') {
    return path === 'view' || path === 'summary';
  }
  if (method === 'POST') {
    return PUBLIC_ENCOUNTER_MUTATIONS.has(path);
  }
  return false;
}

function notFound(): Response {
  return new Response(JSON.stringify({ ok: false, error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Public Worker gate for `/captains/:id/*`, `/systems/:id/*`, and `/encounters/:id/*`.
 * Returns a 404 Response when the path must not be forwarded to a DO;
 * returns null when the Worker may continue (auth + forward / special handlers).
 * Used by the Worker fetch handler — callers never reach the DO stub on a non-null result.
 */
export function publicDurableObjectRouteGate(request: Request): Response | null {
  const url = new URL(request.url);
  const captainMatch = url.pathname.match(/^\/captains\/([^/]+)(?:\/(.*))?$/);
  if (captainMatch) {
    const rest = captainMatch[2] ?? 'view';
    if (!isPublicCaptainRoute(request.method, rest)) return notFound();
    return null;
  }
  const systemMatch = url.pathname.match(/^\/systems\/([^/]+)(?:\/(.*))?$/);
  if (systemMatch) {
    const rest = systemMatch[2] ?? 'market';
    if (!isPublicSystemRoute(request.method, rest)) return notFound();
    return null;
  }
  const encounterMatch = url.pathname.match(/^\/encounters\/([^/]+)(?:\/(.*))?$/);
  if (encounterMatch) {
    const rest = encounterMatch[2] ?? 'view';
    if (!isPublicEncounterRoute(request.method, rest)) return notFound();
    return null;
  }
  return null;
}
