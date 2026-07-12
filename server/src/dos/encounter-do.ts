import type { Env } from '../env.js';
import {
  createEncounter,
  submitAction,
  markDisconnected,
  markReconnected,
  tickEncounter,
  publicEncounterView,
  privateReconnectSummary,
  markEncounterComplete,
  combatantFromCaptain,
  type EncounterState,
} from '../encounter-authority.js';
import { deliverSettlement } from '../settlement-delivery.js';
import { CommodityId, PHASE0_TUNING } from '@sto/ruleset-phase0-v1';
import type { CaptainAction, RelationshipState } from '@sto/ruleset-phase0-v1';
import { projectEncounterHistory } from '../projections.js';
import {
  processDueTasks,
  rescheduleAlarm,
  scheduleTask,
  type ScheduledTask,
} from '../scheduled-tasks.js';

export class EncounterDurableObject implements DurableObject {
  private state: EncounterState | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private load(): EncounterState {
    if (this.state) return this.state;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS encounter_blob (id INTEGER PRIMARY KEY, json TEXT NOT NULL)',
    );
    const stored = this.ctx.storage.sql.exec('SELECT json FROM encounter_blob WHERE id = 1').toArray()[0] as
      | { json: string }
      | undefined;
    if (!stored) throw new Error('encounter not started');
    this.state = JSON.parse(stored.json) as EncounterState;
    return this.state;
  }

  private save(): void {
    if (!this.state) return;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS encounter_blob (id INTEGER PRIMARY KEY, json TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO encounter_blob (id, json) VALUES (1, ?)',
      JSON.stringify(this.state),
    );
  }

  private async scheduleDue(taskType: 'encounter_deadline' | 'disconnect_grace' | 'settlement_retry' | 'd1_projection_retry', key: string, dueAt: number, payload: Record<string, unknown>): Promise<void> {
    scheduleTask(this.ctx.storage.sql, { taskType, idempotencyKey: key, dueAt, payload });
    await rescheduleAlarm(this.ctx.storage, this.ctx.storage.sql);
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    await processDueTasks(
      this.ctx.storage.sql,
      this.ctx.storage,
      nowMs,
      async (task) => this.handleTask(task, nowMs),
      (task, error) => {
        console.error(JSON.stringify({
          alert: 'encounter_scheduled_task',
          encounterId: this.state?.encounterId,
          taskType: task.taskType,
          key: task.idempotencyKey,
          attempts: task.attemptCount,
          error,
        }));
      },
    );
  }

  private async handleTask(task: ScheduledTask, nowMs: number): Promise<{ done: boolean; error?: string }> {
    try {
      const state = this.load();
      if (task.taskType === 'encounter_deadline' || task.taskType === 'disconnect_grace') {
        const result = tickEncounter(state, nowMs);
        this.state = result.state;
        this.save();
        if (result.state.lifecycle === 'SETTLING') {
          const settled = await this.settle(result.state, nowMs);
          return settled ? { done: true } : { done: false, error: 'settlement incomplete' };
        }
        // Reschedule if still waiting on actions / grace
        if (result.state.lifecycle === 'CONTACT' || result.state.lifecycle === 'NEGOTIATION' || result.state.lifecycle === 'COMBAT' || result.state.lifecycle === 'SURRENDER_RESOLUTION') {
          const nextDue = nowMs + Math.min(PHASE0_TUNING.disconnectGraceMs, 2_000);
          scheduleTask(this.ctx.storage.sql, {
            taskType: 'encounter_deadline',
            idempotencyKey: `round-${result.state.roundNo}`,
            dueAt: nextDue,
            payload: { roundNo: result.state.roundNo },
          });
        }
        return { done: true };
      }
      if (task.taskType === 'settlement_retry' || task.taskType === 'd1_projection_retry') {
        const settled = await this.settle(state, nowMs);
        return settled ? { done: true } : { done: false, error: 'settlement incomplete' };
      }
      return { done: true };
    } catch (err) {
      return { done: false, error: err instanceof Error ? err.message : 'task error' };
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const nowMs = Number(request.headers.get('x-now-ms') ?? Date.now());

    try {
      if (url.pathname === '/start' && request.method === 'POST') {
        const body = await request.json() as {
          encounterId: string;
          systemId: string;
          routeArea: string;
          seed: number;
          a: ParticipantBootstrap;
          b: ParticipantBootstrap;
          relationships?: Record<string, RelationshipState>;
        };
        this.state = createEncounter({
          encounterId: body.encounterId,
          systemId: body.systemId,
          routeArea: body.routeArea,
          seed: body.seed,
          nowMs,
          a: toParticipant(body.a),
          b: toParticipant(body.b),
          ...(body.relationships ? { relationships: body.relationships } : {}),
        });
        this.save();

        for (const id of [body.a.captainId, body.b.captainId]) {
          const stub = this.env.CAPTAIN.get(this.env.CAPTAIN.idFromName(id));
          await stub.fetch(new Request('https://captain/encounter/bind', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
            body: JSON.stringify({ encounterId: body.encounterId }),
          }));
        }

        await this.scheduleDue(
          'encounter_deadline',
          `round-${this.state.roundNo}`,
          nowMs + PHASE0_TUNING.disconnectGraceMs,
          { roundNo: this.state.roundNo },
        );

        return json({
          ok: true,
          encounterId: body.encounterId,
          viewA: publicEncounterView(this.state, body.a.captainId),
          viewB: publicEncounterView(this.state, body.b.captainId),
        });
      }

      const state = this.load();

      if (url.pathname === '/view' && request.method === 'GET') {
        const captainId = url.searchParams.get('captainId');
        if (!captainId) return json({ ok: false, error: 'missing captainId' }, 400);
        return json({ ok: true, view: publicEncounterView(state, captainId) });
      }

      if (url.pathname === '/action' && request.method === 'POST') {
        const body = await request.json() as { captainId: string; action: CaptainAction };
        const result = submitAction(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        if (result.ok && result.state.lifecycle === 'SETTLING') {
          const settled = await this.settle(result.state, nowMs);
          if (!settled) {
            await this.scheduleDue('settlement_retry', state.encounterId, nowMs + 500, {});
          }
        } else if (result.ok) {
          await this.scheduleDue(
            'encounter_deadline',
            `round-${result.state.roundNo}`,
            nowMs + PHASE0_TUNING.disconnectGraceMs,
            { roundNo: result.state.roundNo },
          );
        }
        return json({
          ok: result.ok,
          ...(result.ok
            ? { view: publicEncounterView(result.state, body.captainId), lifecycle: result.state.lifecycle }
            : { error: result.error, code: result.code }),
        }, result.ok ? 200 : 400);
      }

      if (url.pathname === '/disconnect' && request.method === 'POST') {
        const body = await request.json() as { captainId: string };
        const result = markDisconnected(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        await this.scheduleDue(
          'disconnect_grace',
          `grace-${body.captainId}-${result.state.roundNo}`,
          nowMs + PHASE0_TUNING.disconnectGraceMs,
          { captainId: body.captainId },
        );
        return json({ ok: result.ok, view: publicEncounterView(result.state, body.captainId) });
      }

      if (url.pathname === '/reconnect' && request.method === 'POST') {
        const body = await request.json() as { captainId: string };
        const result = markReconnected(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        return json({
          ok: result.ok,
          view: publicEncounterView(result.state, body.captainId),
          summary: privateReconnectSummary(result.state, body.captainId),
        });
      }

      if (url.pathname === '/tick' && request.method === 'POST') {
        const result = tickEncounter(state, nowMs);
        this.state = result.state;
        this.save();
        if (result.ok && result.state.lifecycle === 'SETTLING') {
          const settled = await this.settle(result.state, nowMs);
          if (!settled) {
            await this.scheduleDue('settlement_retry', state.encounterId, nowMs + 500, {});
          }
        }
        return json({ ok: true, lifecycle: result.state.lifecycle, roundNo: result.state.roundNo });
      }

      if (url.pathname === '/summary' && request.method === 'GET') {
        const captainId = url.searchParams.get('captainId');
        if (!captainId) return json({ ok: false, error: 'missing captainId' }, 400);
        return json({ ok: true, summary: privateReconnectSummary(state, captainId) });
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : 'error' }, 500);
    }
  }

  /** Returns true when settlement + D1 projection reached COMPLETE. */
  private async settle(state: EncounterState, nowMs: number): Promise<boolean> {
    if (!state.settlementDeltas) return false;
    const effects = state.settlementEffects;
    const env = this.env;

    const readyForD1 = await deliverSettlement(state, nowMs, {
      async settleCaptain({ captainId, body }) {
        const stub = env.CAPTAIN.get(env.CAPTAIN.idFromName(captainId));
        const res = await stub.fetch(new Request('https://captain/encounter/settle', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
          body: JSON.stringify(body),
        }));
        return res.ok;
      },
      async applyPolice({ captainId, body }) {
        const stub = env.CAPTAIN.get(env.CAPTAIN.idFromName(captainId));
        const res = await stub.fetch(new Request('https://captain/police/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
          body: JSON.stringify(body),
        }));
        return res.ok;
      },
      async upsertRelationship({ npcCaptainId, body }) {
        const stub = env.CAPTAIN.get(env.CAPTAIN.idFromName(npcCaptainId));
        const res = await stub.fetch(new Request('https://captain/relationship/upsert', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
          body: JSON.stringify(body),
        }));
        return res.ok;
      },
      async addWreck({ systemId, body }) {
        const system = env.SYSTEM.get(env.SYSTEM.idFromName(systemId));
        const res = await system.fetch(new Request('https://system/wrecks/add', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
          body: JSON.stringify(body),
        }));
        return res.ok;
      },
    });

    this.state = state;
    this.save();

    if (!readyForD1) return false;

    const crimes = (effects?.crimes ?? []).map((crime) => ({
      id: `${state.encounterId}:${crime.kind}:${crime.actorId}`,
      encounter_id: state.encounterId,
      kind: crime.kind,
      actor_id: crime.actorId,
      target_id: crime.targetId ?? null,
      police_delta: crime.policeDelta,
      created_at: nowMs,
    }));
    let bounty: {
      id: string;
      encounter_id: string;
      killer_id: string;
      victim_id: string;
      bounty_paid: number;
      lawful: number;
      created_at: number;
    } | null = null;
    if (effects?.bounty && effects.destroyedCaptainIds.length === 1) {
      const victimId = effects.destroyedCaptainIds[0]!;
      const killerId = state.participants.a.captainId === victimId
        ? state.participants.b.captainId
        : state.participants.a.captainId;
      bounty = {
        id: `${state.encounterId}:bounty`,
        encounter_id: state.encounterId,
        killer_id: killerId,
        victim_id: victimId,
        bounty_paid: effects.bounty.bountyPaid,
        lawful: effects.bounty.lawful ? 1 : 0,
        created_at: nowMs,
      };
    }
    const projected = await projectEncounterHistory(this.env.DB, {
      encounter_id: state.encounterId,
      system_id: state.systemId,
      route_area: state.routeArea,
      result_hash: state.resultHash ?? 'none',
      payload_json: JSON.stringify({
        rounds: state.rounds.length,
        endEvents: state.rounds.at(-1)?.result.events ?? [],
        effectsHash: effects?.effectsHash ?? null,
        crimeCount: effects?.crimes.length ?? 0,
      }),
      created_at: nowMs,
    }, crimes, bounty);
    if (!projected.ok) {
      await this.scheduleDue('d1_projection_retry', state.encounterId, nowMs + 500, {});
      return false;
    }
    markEncounterComplete(state, nowMs);
    this.state = state;
    this.save();
    return true;
  }
}

interface ParticipantBootstrap {
  captainId: string;
  kind: 'human' | 'npc';
  handle: string;
  proxyMode?: 'learned' | 'coward';
  hull: number;
  maxHull: number;
  shields: number[];
  credits: number;
  cargo: Array<{ good: CommodityId; qty: number }>;
  combatProfile: number;
  tradeProfile: number;
  policeRecord: number;
  hasEscapePod?: boolean;
}

function toParticipant(p: ParticipantBootstrap) {
  return {
    captainId: p.captainId,
    controller: (p.kind === 'npc'
      ? 'npc'
      : p.proxyMode === 'coward'
        ? 'proxy_coward'
        : 'human') as 'human' | 'npc' | 'proxy_coward' | 'proxy_learned',
    kind: p.kind,
    handle: p.handle,
    snapshot: combatantFromCaptain(p),
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
