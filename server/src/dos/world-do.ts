import type { Env } from '../env.js';
import { PHASE0_TUNING } from '@sto/ruleset-phase0-v1';
import { DEMO_SYSTEMS } from '../galaxy/bootstrap.js';
import { selectAmbientCohort } from '../ambient-npc.js';
import {
  processDueTasks,
  rescheduleAlarm,
  scheduleTask,
  type ScheduledTask,
} from '../scheduled-tasks.js';

const WORLD_ID = 'galaxy-0';

export class WorldDurableObject implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    await processDueTasks(
      this.ctx.storage.sql,
      this.ctx.storage,
      nowMs,
      async (task) => this.handleTask(task, nowMs),
      (task, error) => {
        console.error(JSON.stringify({
          alert: 'world_scheduled_task',
          taskType: task.taskType,
          key: task.idempotencyKey,
          attempts: task.attemptCount,
          error,
        }));
      },
    );
  }

  private async handleTask(task: ScheduledTask, nowMs: number): Promise<{ done: boolean; error?: string }> {
    if (task.taskType !== 'ambient_npc' && task.taskType !== 'ambient_npc_tick') return { done: true };
    try {
      await this.runAmbientTick(nowMs);
      scheduleTask(this.ctx.storage.sql, {
        taskType: 'ambient_npc',
        idempotencyKey: 'ambient',
        dueAt: nowMs + PHASE0_TUNING.travelWindowMs,
        payload: {},
      });
      return { done: true };
    } catch (err) {
      return { done: false, error: err instanceof Error ? err.message : 'ambient failed' };
    }
  }

  private async listNpcIds(): Promise<string[]> {
    const rows = await this.env.DB.prepare(
      `SELECT captain_id FROM captain_controller_private WHERE kind = 'npc'`,
    ).all<{ captain_id: string }>();
    return (rows.results ?? []).map((r) => r.captain_id);
  }

  private async runAmbientTick(nowMs: number): Promise<void> {
    const npcIds = await this.listNpcIds();
    const cohort = selectAmbientCohort(npcIds, nowMs, 4);
    const destinations = DEMO_SYSTEMS.map((s) => s.systemId);
    for (const captainId of cohort) {
      const stub = this.env.CAPTAIN.get(this.env.CAPTAIN.idFromName(captainId));
      await stub.fetch(new Request('https://captain/ambient/step', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
        body: JSON.stringify({ seed: nowMs, destinations }),
      }));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const nowMs = Number(request.headers.get('x-now-ms') ?? Date.now());
    if (url.pathname === '/start' && request.method === 'POST') {
      scheduleTask(this.ctx.storage.sql, {
        taskType: 'ambient_npc',
        idempotencyKey: 'ambient',
        dueAt: nowMs + PHASE0_TUNING.travelWindowMs,
        payload: {},
      });
      await rescheduleAlarm(this.ctx.storage, this.ctx.storage.sql);
      return json({ ok: true, worldId: WORLD_ID });
    }
    if (url.pathname === '/tick' && request.method === 'POST') {
      await this.runAmbientTick(nowMs);
      return json({ ok: true });
    }
    return json({ ok: false, error: 'not found' }, 404);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function worldStub(env: Env) {
  return env.WORLD.get(env.WORLD.idFromName(WORLD_ID));
}
