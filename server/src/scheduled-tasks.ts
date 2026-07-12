/**
 * Multiplexed Durable Object scheduled-task queue (design §14.4).
 * One alarm slot; tasks persist in DO-local SQLite.
 */

export type ScheduledTaskType =
  | 'd1_project_trade'
  | 'd1_project_operation'
  | 'd1_project_captain'
  | 'd1_project_encounter'
  | 'd1_project_market'
  | 'd1_projection_retry'
  | 'reconcile_trade'
  | 'trade_reconcile'
  | 'claim_expiry'
  | 'disconnect_grace'
  | 'encounter_deadline'
  | 'escape_pod_recovery'
  | 'market_recovery'
  | 'ambient_npc'
  | 'ambient_npc_tick'
  | 'settlement_retry'
  | 'window_match'
  | 'rescue_recovery_retry';

export interface ScheduledTask {
  id: string;
  taskType: ScheduledTaskType;
  idempotencyKey: string;
  dueAt: number;
  attemptCount: number;
  payloadJson: string;
  lastError: string | null;
}

export interface TaskSqlStorage {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): unknown[];
  };
}

const MAX_ATTEMPTS_BEFORE_ALERT = 12;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const WORK_BUDGET = 8;

export function ensureTaskSchema(sql: TaskSqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      last_error TEXT,
      UNIQUE(task_type, idempotency_key)
    )
  `);
  sql.exec('CREATE INDEX IF NOT EXISTS scheduled_tasks_due_idx ON scheduled_tasks(due_at)');
}

export function backoffMs(attemptCount: number, idempotencyKey: string): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** Math.max(0, attemptCount)));
  // Deterministic jitter from key so retries stay reproducible.
  let h = 2166136261;
  for (let i = 0; i < idempotencyKey.length; i += 1) {
    h ^= idempotencyKey.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const jitter = (h >>> 0) % Math.max(1, Math.floor(exp * 0.25));
  return exp + jitter;
}

export function upsertTask(
  sql: TaskSqlStorage,
  task: {
    taskType: ScheduledTaskType;
    idempotencyKey: string;
    dueAt: number;
    payload: unknown;
    resetAttempts?: boolean;
  },
): void {
  ensureTaskSchema(sql);
  const id = `${task.taskType}:${task.idempotencyKey}`;
  const payloadJson = JSON.stringify(task.payload);
  if (task.resetAttempts) {
    sql.exec(
      `INSERT INTO scheduled_tasks (id, task_type, idempotency_key, due_at, attempt_count, payload_json, last_error)
       VALUES (?, ?, ?, ?, 0, ?, NULL)
       ON CONFLICT(task_type, idempotency_key) DO UPDATE SET
         due_at = excluded.due_at,
         attempt_count = 0,
         payload_json = excluded.payload_json,
         last_error = NULL`,
      id,
      task.taskType,
      task.idempotencyKey,
      task.dueAt,
      payloadJson,
    );
  } else {
    sql.exec(
      `INSERT INTO scheduled_tasks (id, task_type, idempotency_key, due_at, attempt_count, payload_json, last_error)
       VALUES (?, ?, ?, ?, 0, ?, NULL)
       ON CONFLICT(task_type, idempotency_key) DO UPDATE SET
         due_at = excluded.due_at,
         payload_json = excluded.payload_json`,
      id,
      task.taskType,
      task.idempotencyKey,
      task.dueAt,
      payloadJson,
    );
  }
}

export function listDueTasks(sql: TaskSqlStorage, nowMs: number, limit = WORK_BUDGET): ScheduledTask[] {
  ensureTaskSchema(sql);
  const rows = sql.exec(
    `SELECT id, task_type, idempotency_key, due_at, attempt_count, payload_json, last_error
     FROM scheduled_tasks
     WHERE due_at <= ?
     ORDER BY due_at ASC
     LIMIT ?`,
    nowMs,
    limit,
  ).toArray() as Array<{
    id: string;
    task_type: string;
    idempotency_key: string;
    due_at: number;
    attempt_count: number;
    payload_json: string;
    last_error: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    taskType: r.task_type as ScheduledTaskType,
    idempotencyKey: r.idempotency_key,
    dueAt: r.due_at,
    attemptCount: r.attempt_count,
    payloadJson: r.payload_json,
    lastError: r.last_error,
  }));
}

export function earliestDueAt(sql: TaskSqlStorage): number | null {
  ensureTaskSchema(sql);
  const row = sql.exec(
    'SELECT due_at FROM scheduled_tasks ORDER BY due_at ASC LIMIT 1',
  ).toArray()[0] as { due_at: number } | undefined;
  return row?.due_at ?? null;
}

export function completeTask(sql: TaskSqlStorage, id: string): void {
  ensureTaskSchema(sql);
  sql.exec('DELETE FROM scheduled_tasks WHERE id = ?', id);
}

export function rescheduleTask(
  sql: TaskSqlStorage,
  task: ScheduledTask,
  nowMs: number,
  error: string,
): { alert: boolean; nextDueAt: number } {
  ensureTaskSchema(sql);
  const attemptCount = task.attemptCount + 1;
  const nextDueAt = nowMs + backoffMs(attemptCount, task.idempotencyKey);
  sql.exec(
    `UPDATE scheduled_tasks
     SET attempt_count = ?, due_at = ?, last_error = ?
     WHERE id = ?`,
    attemptCount,
    nextDueAt,
    error.slice(0, 500),
    task.id,
  );
  return { alert: attemptCount >= MAX_ATTEMPTS_BEFORE_ALERT, nextDueAt };
}

export async function scheduleNextAlarm(
  storage: { setAlarm(dueAt: number): Promise<void>; deleteAlarm?(): Promise<void>; getAlarm?(): Promise<number | null> },
  sql: TaskSqlStorage,
): Promise<void> {
  const next = earliestDueAt(sql);
  if (next == null) {
    if (storage.deleteAlarm) await storage.deleteAlarm();
    return;
  }
  await storage.setAlarm(next);
}

/** Convenience aliases used by DO alarm handlers. */
export function scheduleTask(
  sql: TaskSqlStorage,
  args: {
    taskType: ScheduledTaskType;
    idempotencyKey: string;
    dueAt: number;
    payload?: unknown;
    attemptCount?: number;
  },
): void {
  upsertTask(sql, {
    taskType: args.taskType,
    idempotencyKey: args.idempotencyKey,
    dueAt: args.dueAt,
    payload: args.payload ?? {},
    resetAttempts: true,
  });
}

export const rescheduleAlarm = scheduleNextAlarm;

export async function processDueTasks(
  sql: TaskSqlStorage,
  storage: { setAlarm(dueAt: number): Promise<void>; deleteAlarm?(): Promise<void> },
  nowMs: number,
  handler: (task: ScheduledTask) => Promise<{ done: boolean; error?: string }>,
  onAlert?: (task: ScheduledTask, error: string) => void,
): Promise<{ processed: number; alerts: number }> {
  const due = listDueTasks(sql, nowMs);
  let processed = 0;
  let alerts = 0;
  for (const task of due) {
    const outcome = await handler(task);
    processed += 1;
    if (outcome.done) {
      completeTask(sql, task.id);
      continue;
    }
    const error = outcome.error ?? 'retry';
    const { alert } = rescheduleTask(sql, task, nowMs, error);
    if (alert && onAlert) {
      alerts += 1;
      onAlert(task, error);
    }
  }
  await scheduleNextAlarm(storage, sql);
  return { processed, alerts };
}

export { WORK_BUDGET, MAX_ATTEMPTS_BEFORE_ALERT };
