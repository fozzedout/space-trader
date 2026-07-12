import type { Env } from '../env.js';
import {
  createSystemState,
  getMarketSnapshot,
  reserveTrade,
  promoteReservation,
  commitReservation,
  getReservation,
  registerPresence,
  closePresence,
  matchWindow,
  markClaimed,
  releaseClaim,
  marketProjectionRows,
  addWreck,
  rescueEscapePod,
  destroyEscapePod,
  scoopWreckCargo,
  processDuePodRecoveries,
  listWrecks,
  listWrecksInRouteArea,
  type SystemState,
} from '../system-authority.js';
import type { CommodityId, WreckDebris } from '@sto/ruleset-phase0-v1';
import { PHASE0_TUNING, POLITICS, windowsOverlapping } from '@sto/ruleset-phase0-v1';
import { projectMarketRows } from '../projections.js';
import {
  processDueTasks,
  rescheduleAlarm,
  scheduleTask,
  type ScheduledTask,
} from '../scheduled-tasks.js';
import { claimAndStartEncounter } from '../encounter-claim.js';

export class SystemDurableObject implements DurableObject {
  private state: SystemState | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private load(): SystemState {
    if (this.state) return this.state;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS system_blob (id INTEGER PRIMARY KEY, json TEXT NOT NULL)',
    );
    const stored = this.ctx.storage.sql.exec('SELECT json FROM system_blob WHERE id = 1').toArray()[0] as
      | { json: string }
      | undefined;
    if (!stored) {
      throw new Error('system not bootstrapped');
    }
    this.state = deserializeSystem(stored.json);
    return this.state;
  }

  private save(): void {
    if (!this.state) return;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS system_blob (id INTEGER PRIMARY KEY, json TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO system_blob (id, json) VALUES (1, ?)',
      serializeSystem(this.state),
    );
  }

  private async ensureMarketRecoveryAlarm(nowMs: number): Promise<void> {
    scheduleTask(this.ctx.storage.sql, {
      taskType: 'market_recovery',
      idempotencyKey: 'market',
      dueAt: nowMs + PHASE0_TUNING.recoveryPeriodMs,
      payload: {},
    });
    scheduleTask(this.ctx.storage.sql, {
      taskType: 'escape_pod_recovery',
      idempotencyKey: 'pods',
      dueAt: nowMs + Math.min(30_000, PHASE0_TUNING.escapePodRecoveryMs),
      payload: {},
    });
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
          alert: 'system_scheduled_task',
          systemId: this.state?.systemId,
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
      if (task.taskType === 'market_recovery') {
        getMarketSnapshot(state, nowMs); // applies recovery via wake
        this.save();
        const projected = await this.projectMarkets(nowMs);
        scheduleTask(this.ctx.storage.sql, {
          taskType: 'market_recovery',
          idempotencyKey: 'market',
          dueAt: nowMs + PHASE0_TUNING.recoveryPeriodMs,
          payload: {},
        });
        return projected.ok ? { done: true } : { done: false, error: projected.error ?? 'market projection failed' };
      }
      if (task.taskType === 'escape_pod_recovery') {
        const due = processDuePodRecoveries(state, nowMs);
        this.save();
        for (const row of due) {
          const captain = this.env.CAPTAIN.get(this.env.CAPTAIN.idFromName(row.captainId));
          await captain.fetch(new Request('https://captain/recovery/complete', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
            body: JSON.stringify({
              operationId: `auto-${row.wreckId}`,
              safeSystemId: state.systemId,
              source: 'automated',
            }),
          }));
        }
        scheduleTask(this.ctx.storage.sql, {
          taskType: 'escape_pod_recovery',
          idempotencyKey: 'pods',
          dueAt: nowMs + 30_000,
          payload: {},
        });
        return { done: true };
      }
      if (task.taskType === 'd1_projection_retry' || task.taskType === 'd1_project_market') {
        const projected = await this.projectMarkets(nowMs);
        return projected.ok ? { done: true } : { done: false, error: projected.error ?? 'market projection failed' };
      }
      if (task.taskType === 'window_match') {
        const payload = JSON.parse(task.payloadJson) as { routeArea: string; globalTick: number };
        const matched = matchWindow(state, {
          routeArea: payload.routeArea,
          globalTick: payload.globalTick,
          nowMs,
        });
        this.save();
        if (matched.ok && 'pairs' in matched) {
          for (const pair of matched.pairs) {
            await claimAndStartEncounter(this.env, state.systemId, pair, nowMs, {
              markClaim: (captainId, encounterId) => {
                markClaimed(state, captainId, encounterId);
                this.save();
              },
            });
          }
        }
        return { done: true };
      }
      if (task.taskType === 'rescue_recovery_retry') {
        const payload = JSON.parse(task.payloadJson) as {
          wreckId: string;
          captainId: string;
          systemId: string;
        };
        const completed = await this.completeRescuedCaptainRecovery({
          captainId: payload.captainId,
          wreckId: payload.wreckId,
          systemId: payload.systemId,
          nowMs,
        });
        return completed.ok
          ? { done: true }
          : { done: false, error: completed.error ?? 'rescue recovery incomplete' };
      }
      return { done: true };
    } catch (err) {
      return { done: false, error: err instanceof Error ? err.message : 'task error' };
    }
  }

  private async completeRescuedCaptainRecovery(args: {
    captainId: string;
    wreckId: string;
    systemId: string;
    nowMs: number;
  }): Promise<{ ok: boolean; error?: string }> {
    const captain = this.env.CAPTAIN.get(this.env.CAPTAIN.idFromName(args.captainId));
    const res = await captain.fetch(new Request('https://captain/recovery/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-now-ms': String(args.nowMs) },
      body: JSON.stringify({
        operationId: `rescue-${args.wreckId}`,
        safeSystemId: args.systemId,
        source: 'rescue',
      }),
    }));
    let body: { ok?: boolean; error?: string } = {};
    try {
      body = await res.json() as { ok?: boolean; error?: string };
    } catch {
      return { ok: false, error: `recovery/complete non-json status ${res.status}` };
    }
    if (!res.ok || !body.ok) {
      return { ok: false, error: body.error ?? `recovery/complete status ${res.status}` };
    }
    return { ok: true };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const nowMs = Number(request.headers.get('x-now-ms') ?? Date.now());

    try {
      if (url.pathname === '/bootstrap' && request.method === 'POST') {
        const body = await request.json() as {
          systemId: string;
          name: string;
          techLevel: number;
          politicsId: number;
          size: number;
          goods: Array<{ good: CommodityId; equilibriumPrice: number; targetStock: number }>;
        };
        this.state = createSystemState({ ...body, nowMs });
        this.save();
        await this.projectMarkets(nowMs);
        await this.ensureMarketRecoveryAlarm(nowMs);
        return json({ ok: true, systemId: body.systemId });
      }

      const state = this.load();

      if (url.pathname === '/market' && request.method === 'GET') {
        return json({ ok: true, market: getMarketSnapshot(state, nowMs) });
      }

      if (url.pathname === '/politics' && request.method === 'GET') {
        const strengthPolice = POLITICS[state.politicsId]?.strengthPolice ?? state.policePresence;
        return json({ ok: true, politicsId: state.politicsId, strengthPolice });
      }

      if (url.pathname === '/reserve' && request.method === 'POST') {
        const body = await request.json() as Parameters<typeof reserveTrade>[1];
        const result = reserveTrade(state, { ...body, nowMs });
        this.save();
        return json(result, result.ok ? 200 : 409);
      }

      if (url.pathname === '/promote' && request.method === 'POST') {
        const body = await request.json() as { operationId: string; requestHash: string };
        const result = promoteReservation(state, body.operationId, body.requestHash);
        this.save();
        return json(result, result.ok ? 200 : 409);
      }

      if (url.pathname === '/commit' && request.method === 'POST') {
        const body = await request.json() as { operationId: string; requestHash: string };
        const result = commitReservation(state, body.operationId, body.requestHash, nowMs);
        this.save();
        if (result.ok) {
          const projected = await this.projectMarkets(nowMs);
          if (!projected.ok) {
            scheduleTask(this.ctx.storage.sql, {
              taskType: 'd1_projection_retry',
              idempotencyKey: `market-${body.operationId}`,
              dueAt: nowMs + 500,
              payload: { operationId: body.operationId },
            });
            await rescheduleAlarm(this.ctx.storage, this.ctx.storage.sql);
          }
        }
        return json(result, result.ok ? 200 : 409);
      }

      if (url.pathname === '/reservation' && request.method === 'GET') {
        const operationId = url.searchParams.get('operationId');
        if (!operationId) return json({ ok: false, error: 'missing operationId' }, 400);
        return json({ ok: true, reservation: getReservation(state, operationId) });
      }

      if (url.pathname === '/presence' && request.method === 'POST') {
        const body = await request.json() as Parameters<typeof registerPresence>[1];
        const result = registerPresence(state, { ...body, encounterId: null, status: 'present' });
        this.save();
        if (result.ok) {
          for (const tick of windowsOverlapping(body.occupancyStartedAt, body.occupancyEndsAt)) {
            scheduleTask(this.ctx.storage.sql, {
              taskType: 'window_match',
              idempotencyKey: `${body.routeArea}:${tick}`,
              dueAt: (tick + 1) * PHASE0_TUNING.travelWindowMs,
              payload: { routeArea: body.routeArea, globalTick: tick },
            });
          }
          await rescheduleAlarm(this.ctx.storage, this.ctx.storage.sql);
        }
        return json(result, result.ok ? 200 : 409);
      }

      if (url.pathname === '/presence/close' && request.method === 'POST') {
        const body = await request.json() as { captainId: string };
        closePresence(state, body.captainId);
        this.save();
        return json({ ok: true });
      }

      if (url.pathname === '/match' && request.method === 'POST') {
        const body = await request.json() as { routeArea: string; globalTick: number };
        const result = matchWindow(state, { ...body, nowMs });
        this.save();
        return json(result, result.ok ? 200 : 409);
      }

      if (url.pathname === '/claim/mark' && request.method === 'POST') {
        const body = await request.json() as { captainId: string; encounterId: string };
        const ok = markClaimed(state, body.captainId, body.encounterId);
        this.save();
        return json({ ok });
      }

      if (url.pathname === '/claim/release' && request.method === 'POST') {
        const body = await request.json() as { captainId: string; encounterId: string };
        releaseClaim(state, body.captainId, body.encounterId);
        this.save();
        return json({ ok: true });
      }

      if (url.pathname === '/wrecks' && request.method === 'GET') {
        const routeArea = url.searchParams.get('routeArea');
        const wrecks = routeArea
          ? listWrecksInRouteArea(state, routeArea)
          : listWrecks(state);
        return json({ ok: true, wrecks });
      }

      if (url.pathname === '/wrecks/add' && request.method === 'POST') {
        const body = await request.json() as { wreck: WreckDebris };
        addWreck(state, body.wreck);
        this.save();
        return json({ ok: true });
      }

      if (url.pathname === '/wrecks/rescue' && request.method === 'POST') {
        const body = await request.json() as { wreckId: string; rescuerId: string };
        const result = rescueEscapePod(state, { ...body, nowMs });
        this.save();
        if (!result.ok) return json(result, 400);

        const recovered = await this.completeRescuedCaptainRecovery({
          captainId: result.rescuedCaptainId,
          wreckId: body.wreckId,
          systemId: state.systemId,
          nowMs,
        });
        if (!recovered.ok) {
          scheduleTask(this.ctx.storage.sql, {
            taskType: 'rescue_recovery_retry',
            idempotencyKey: body.wreckId,
            dueAt: nowMs + 1_000,
            payload: {
              wreckId: body.wreckId,
              captainId: result.rescuedCaptainId,
              systemId: state.systemId,
            },
          });
          await rescheduleAlarm(this.ctx.storage, this.ctx.storage.sql);
        }
        return json({ ok: true, rescuedCaptainId: result.rescuedCaptainId });
      }

      if (url.pathname === '/wrecks/destroy-pod' && request.method === 'POST') {
        const body = await request.json() as { wreckId: string };
        const result = destroyEscapePod(state, { ...body, nowMs });
        this.save();
        return json(result, result.ok ? 200 : 400);
      }

      if (url.pathname === '/wrecks/scoop' && request.method === 'POST') {
        const body = await request.json() as {
          wreckId: string;
          freeCapacity: number;
          requested: Array<{ good: CommodityId; qty: number }>;
        };
        const result = scoopWreckCargo(state, body);
        this.save();
        return json(result, result.ok ? 200 : 400);
      }

      if (url.pathname === '/wrecks/process-recovery' && request.method === 'POST') {
        const due = processDuePodRecoveries(state, nowMs);
        this.save();
        return json({ ok: true, due });
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : 'error' }, 500);
    }
  }

  private async projectMarkets(nowMs: number): Promise<{ ok: boolean; error?: string }> {
    if (!this.state) return { ok: false, error: 'no state' };
    const rows = marketProjectionRows(this.state, nowMs);
    const res = await projectMarketRows(this.env.DB, rows);
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function serializeSystem(state: SystemState): string {
  return JSON.stringify({
    ...state,
    markets: [...state.markets.entries()],
    reservations: [...state.reservations.entries()],
    presence: [...state.presence.entries()],
    docked: [...state.docked],
    completedMatches: [...state.completedMatches.entries()],
    wrecks: [...state.wrecks.entries()],
  });
}

function deserializeSystem(jsonText: string): SystemState {
  const raw = JSON.parse(jsonText) as Omit<SystemState, 'markets' | 'reservations' | 'presence' | 'docked' | 'completedMatches' | 'wrecks'> & {
    markets: [CommodityId, SystemState['markets'] extends Map<CommodityId, infer V> ? V : never][];
    reservations: [string, SystemState['reservations'] extends Map<string, infer V> ? V : never][];
    presence: [string, SystemState['presence'] extends Map<string, infer V> ? V : never][];
    docked: string[];
    completedMatches: [string, SystemState['completedMatches'] extends Map<string, infer V> ? V : never][];
    wrecks?: [string, WreckDebris][];
  };
  return {
    ...raw,
    markets: new Map(raw.markets),
    reservations: new Map(raw.reservations),
    presence: new Map(raw.presence),
    docked: new Set(raw.docked),
    completedMatches: new Map(raw.completedMatches),
    wrecks: new Map(raw.wrecks ?? []),
  };
}
