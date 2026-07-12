/** Phase 0 email magic-link + D1 session helpers (design §13.6). */

export const SESSION_COOKIE = 'sto_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

export interface AuthEnv {
  DB: D1Database;
}

export interface AccountRow {
  id: string;
  email: string;
  created_at: number;
}

export interface SessionRow {
  id: string;
  account_id: string;
  expires_at: number;
  created_at: number;
}

export interface AuthSession {
  sessionId: string;
  accountId: string;
  email: string;
  captainId: string | null;
  expiresAt: number;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export { normalizeEmail };

export function isDevelopmentMode(env: { ENVIRONMENT?: string; ALLOW_ADMIN?: string }): boolean {
  if (env.ALLOW_ADMIN === '1' || env.ALLOW_ADMIN === 'true') return true;
  const e = (env.ENVIRONMENT ?? 'development').toLowerCase();
  return e === 'development' || e === 'dev' || e === 'local' || e === 'test';
}

export function isValidEmail(email: string): boolean {
  const e = normalizeEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

export async function randomToken(bytes = 32): Promise<string> {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function sessionCookieHeader(
  sessionId: string,
  expiresAt: number,
  opts: { secure: boolean },
): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookieHeader(opts: { secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export async function ensureAccount(db: D1Database, email: string, nowMs: number): Promise<AccountRow> {
  const normalized = normalizeEmail(email);
  const existing = await db.prepare(
    'SELECT id, email, created_at FROM accounts WHERE email = ?',
  ).bind(normalized).first<AccountRow>();
  if (existing) return existing;

  const id = `acct-${await randomToken(8)}`;
  await db.prepare(
    'INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)',
  ).bind(id, normalized, nowMs).run();
  return { id, email: normalized, created_at: nowMs };
}

export async function createMagicLink(
  db: D1Database,
  email: string,
  nowMs: number,
): Promise<{ token: string; expiresAt: number }> {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    throw new Error('invalid email');
  }
  const token = await randomToken(24);
  const tokenHash = await hashToken(token);
  const expiresAt = nowMs + MAGIC_LINK_TTL_MS;
  await db.prepare(
    `INSERT INTO magic_links (token_hash, email, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  ).bind(tokenHash, normalized, expiresAt, nowMs).run();
  return { token, expiresAt };
}

export async function consumeMagicLink(
  db: D1Database,
  token: string,
  nowMs: number,
): Promise<{ email: string } | { error: string }> {
  const tokenHash = await hashToken(token);
  const row = await db.prepare(
    `SELECT token_hash, email, expires_at, consumed_at FROM magic_links WHERE token_hash = ?`,
  ).bind(tokenHash).first<{
    token_hash: string;
    email: string;
    expires_at: number;
    consumed_at: number | null;
  }>();
  if (!row) return { error: 'invalid token' };
  if (row.consumed_at != null) return { error: 'token already used' };
  if (row.expires_at < nowMs) return { error: 'token expired' };

  const updated = (await db.prepare(
    `UPDATE magic_links SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL`,
  ).bind(nowMs, tokenHash).run()) as { meta?: { changes?: number } };
  if (!updated.meta?.changes) return { error: 'token already used' };
  return { email: row.email };
}

export async function createSession(
  db: D1Database,
  accountId: string,
  nowMs: number,
): Promise<SessionRow> {
  const id = await randomToken(24);
  const expiresAt = nowMs + SESSION_TTL_MS;
  await db.prepare(
    `INSERT INTO sessions (id, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
  ).bind(id, accountId, expiresAt, nowMs).run();
  return { id, account_id: accountId, expires_at: expiresAt, created_at: nowMs };
}

export async function revokeSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

export async function resolveCaptainIdForAccount(
  db: D1Database,
  accountId: string,
): Promise<string | null> {
  const row = await db.prepare(
    `SELECT captain_id FROM captain_controller_private
     WHERE account_id = ? AND kind = 'human' AND active = 1
     ORDER BY updated_at DESC LIMIT 1`,
  ).bind(accountId).first<{ captain_id: string }>();
  return row?.captain_id ?? null;
}

export async function deactivateCaptainMapping(
  db: D1Database,
  captainId: string,
  nowMs: number,
): Promise<void> {
  await db.prepare(
    `UPDATE captain_controller_private SET active = 0, updated_at = ? WHERE captain_id = ?`,
  ).bind(nowMs, captainId).run();
}

export function isTerminalCaptainLifecycle(lifecycle: string): boolean {
  return lifecycle === 'RETIRED' || lifecycle === 'DEAD';
}

/** Deactivate a dead/retired mapping and insert a fresh active human captain row. */
export async function allocateSuccessorCaptain(
  db: D1Database,
  accountId: string,
  oldCaptainId: string,
  nowMs: number,
): Promise<string> {
  await deactivateCaptainMapping(db, oldCaptainId, nowMs);
  const captainId = `captain-human-${await randomToken(8)}`;
  await db.prepare(
    `INSERT INTO captain_controller_private (captain_id, kind, account_id, updated_at, active)
     VALUES (?, 'human', ?, ?, 1)`,
  ).bind(captainId, accountId, nowMs).run();
  return captainId;
}

/**
 * If the bound captain is RETIRED/DEAD, deactivate it and allocate a successor id.
 * Caller must bootstrap the new Captain DO. Non-terminal lifecycles are unchanged.
 */
export async function succeedIfTerminalCaptain(
  db: D1Database,
  args: {
    accountId: string;
    captainId: string;
    lifecycleState: string;
    nowMs: number;
  },
): Promise<{ captainId: string; succeeded: boolean }> {
  if (!isTerminalCaptainLifecycle(args.lifecycleState)) {
    return { captainId: args.captainId, succeeded: false };
  }
  const captainId = await allocateSuccessorCaptain(
    db,
    args.accountId,
    args.captainId,
    args.nowMs,
  );
  return { captainId, succeeded: true };
}

/** Bind the demo human captain to an account if unclaimed; otherwise require ownership. */
export async function claimOrResolveHumanCaptain(
  db: D1Database,
  accountId: string,
  nowMs: number,
  preferredCaptainId = 'captain-human-1',
): Promise<string> {
  const existing = await resolveCaptainIdForAccount(db, accountId);
  if (existing) return existing;

  const preferred = await db.prepare(
    `SELECT captain_id, account_id, active FROM captain_controller_private WHERE captain_id = ?`,
  ).bind(preferredCaptainId).first<{ captain_id: string; account_id: string | null; active: number }>();

  if (
    preferred
    && (preferred.active ?? 1) === 1
    && (preferred.account_id == null || preferred.account_id === accountId)
  ) {
    await db.prepare(
      `UPDATE captain_controller_private SET account_id = ?, updated_at = ?, active = 1 WHERE captain_id = ?`,
    ).bind(accountId, nowMs, preferredCaptainId).run();
    return preferredCaptainId;
  }

  // Create a fresh human captain mapping if the preferred slot is taken.
  const captainId = `captain-${accountId}`;
  await db.prepare(
    `INSERT OR REPLACE INTO captain_controller_private (captain_id, kind, account_id, updated_at, active)
     VALUES (?, 'human', ?, ?, 1)`,
  ).bind(captainId, accountId, nowMs).run();
  return captainId;
}

export async function accountOwnsCaptain(
  db: D1Database,
  accountId: string,
  captainId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT captain_id FROM captain_controller_private
     WHERE captain_id = ? AND account_id = ? AND kind = 'human'`,
  ).bind(captainId, accountId).first<{ captain_id: string }>();
  return row != null;
}

export async function resolveSession(
  db: D1Database,
  request: Request,
  nowMs: number,
): Promise<AuthSession | null> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;

  const row = await db.prepare(
    `SELECT s.id, s.account_id, s.expires_at, a.email
     FROM sessions s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.id = ?`,
  ).bind(sessionId).first<{
    id: string;
    account_id: string;
    expires_at: number;
    email: string;
  }>();
  if (!row) return null;
  if (row.expires_at < nowMs) {
    await revokeSession(db, sessionId);
    return null;
  }
  const captainId = await resolveCaptainIdForAccount(db, row.account_id);
  return {
    sessionId: row.id,
    accountId: row.account_id,
    email: row.email,
    captainId,
    expiresAt: row.expires_at,
  };
}

export async function completeMagicLinkSignIn(
  db: D1Database,
  token: string,
  nowMs: number,
): Promise<
  | { ok: true; session: SessionRow; account: AccountRow; captainId: string }
  | { ok: false; error: string }
> {
  const consumed = await consumeMagicLink(db, token, nowMs);
  if ('error' in consumed) return { ok: false, error: consumed.error };
  const account = await ensureAccount(db, consumed.email, nowMs);
  const captainId = await claimOrResolveHumanCaptain(db, account.id, nowMs);
  const session = await createSession(db, account.id, nowMs);
  return { ok: true, session, account, captainId };
}
