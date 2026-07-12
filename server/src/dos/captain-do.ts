import {
  createCaptainState,
  executeTrade,
  startTravel,
  advanceTravel,
  claimEncounter,
  releaseEncounterClaim,
  bindEncounter,
  applyEncounterSettlement,
  applyPoliceAndBounty,
  respondPoliceEncounter,
  retryPoliceProjection,
  upsertRelationship,
  retireCaptain,
  completeRecovery,
  installEscapePod,
  forceApproachForPlaytest,
  publicCaptainView,
  privateCaptainSnapshot,
  refuelShip,
  repairShip,
  upgradeShip,
  retryTradeProjection,
  retryDockProjection,
  type CaptainState,
  type SystemPort,
  type ProjectionPort,
} from '../captain-authority.js';
import type { CommodityId, PoliceResponse } from '@sto/ruleset-phase0-v1';
import type { Env } from '../env.js';
import {
  projectCaptainRow,
  projectCompletedTrade,
  projectCompletedOperation,
  projectEncounterHistory,
} from '../projections.js';
import {
  processDueTasks,
  rescheduleAlarm,
  scheduleTask,
  type ScheduledTask,
} from '../scheduled-tasks.js';

export class CaptainDurableObject implements DurableObject {
  private state: CaptainState | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private load(): CaptainState {
    if (this.state) return this.state;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS captain_blob (id INTEGER PRIMARY KEY, json TEXT NOT NULL)',
    );
    const stored = this.ctx.storage.sql.exec('SELECT json FROM captain_blob WHERE id = 1').toArray()[0] as
      | { json: string }
      | undefined;
    if (!stored) throw new Error('captain not bootstrapped');
    this.state = deserializeCaptain(stored.json);
    return this.state;
  }

  private save(): void {
    if (!this.state) return;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS captain_blob (id INTEGER PRIMARY KEY, json TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO captain_blob (id, json) VALUES (1, ?)',
      serializeCaptain(this.state),
    );
  }

  private systemPort(systemId: string, nowMs: number): SystemPort {
    const stub = this.env.SYSTEM.get(this.env.SYSTEM.idFromName(systemId));
    const post = async (path: string, body: unknown) => {
      const res = await stub.fetch(new Request(`https://system${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-now-ms': String(nowMs) },
        body: JSON.stringify(body),
      }));
      return await res.json();
    };
    return {
      reserveTrade: async (args) => post('/reserve', args) as ReturnType<SystemPort['reserveTrade']>,
      promoteReservation: async (operationId, requestHash) =>
        post('/promote', { operationId, requestHash }) as ReturnType<SystemPort['promoteReservation']>,
      commitReservation: async (operationId, requestHash, commitNow) =>
        post('/commit', { operationId, requestHash, nowMs: commitNow }) as ReturnType<SystemPort['commitReservation']>,
      getReservation: async (operationId) => {
        const res = await stub.fetch(new Request(`https://system/reservation?operationId=${encodeURIComponent(operationId)}`, {
          headers: { 'x-now-ms': String(nowMs) },
        }));
        const data = await res.json() as { reservation: Awaited<ReturnType<SystemPort['getReservation']>> };
        return data.reservation;
      },
      registerPresence: async (args) => post('/presence', args) as ReturnType<SystemPort['registerPresence']>,
      closePresence: async (captainId) => {
        await post('/presence/close', { captainId });
      },
      getPolitics: async () => {
        const res = await stub.fetch(new Request('https://system/politics', {
          headers: { 'x-now-ms': String(nowMs) },
        }));
        const data = await res.json() as { ok: boolean; politicsId: number; strengthPolice: number };
        return { politicsId: data.politicsId, strengthPolice: data.strengthPolice };
      },
      listWrecksInRouteArea: async (routeArea) => {
        const res = await stub.fetch(new Request(
          `https://system/wrecks?routeArea=${encodeURIComponent(routeArea)}`,
          { headers: { 'x-now-ms': String(nowMs) } },
        ));
        const data = await res.json() as {
          ok: boolean;
          wrecks: Array<{
            wreckId: string;
            routeArea: string;
            cargo: Array<{ good: string; qty: number }>;
            escapePodCaptainId: string | null;
            podState: string | null;
          }>;
        };
        return data.wrecks ?? [];
      },
    };
  }

  private projectionPort(): ProjectionPort {
    return {
      projectCaptain: async (row) => {
        const res = await projectCaptainRow(this.env.DB, row as Parameters<typeof projectCaptainRow>[1]);
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      },
      projectTrade: async (row) => {
        const res = await projectCompletedTrade(this.env.DB, row as Parameters<typeof projectCompletedTrade>[1]);
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      },
      projectOperation: async (row) => {
        const res = await projectCompletedOperation(this.env.DB, row as Parameters<typeof projectCompletedOperation>[1]);
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      },
      projectEncounter: async (row, crimes) => {
        const res = await projectEncounterHistory(this.env.DB, row, crimes);
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      },
    };
  }

  private async scheduleRetry(
    taskType: 'd1_projection_retry' | 'trade_reconcile' | 'reconcile_trade' | 'claim_expiry' | 'escape_pod_recovery' | 'd1_project_trade',
    key: string,
    dueAt: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
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
          alert: 'captain_scheduled_task',
          captainId: this.state?.captainId,
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
      const projections = this.projectionPort();
      const payload = JSON.parse(task.payloadJson) as Record<string, unknown>;

      if (task.taskType === 'claim_expiry') {
        const encounterId = String(payload.encounterId ?? '');
        if (state.activeEncounterId === encounterId && state.lifecycle === 'ENCOUNTER_CLAIMED') {
          if (state.claimExpiresAt != null && state.claimExpiresAt <= nowMs) {
            const result = releaseEncounterClaim(state, { encounterId, nowMs });
            this.state = result.state;
            this.save();
          }
        }
        return { done: true };
      }

      if (task.taskType === 'escape_pod_recovery') {
        if (state.lifecycle === 'AWAITING_RECOVERY' && state.recoveryDueAt != null && state.recoveryDueAt <= nowMs) {
          const result = completeRecovery(state, {
            operationId: `auto-pod-${state.captainId}-${state.recoveryDueAt}`,
            safeSystemId: state.systemId,
            source: 'automated',
            nowMs,
          });
          this.state = result.state;
          this.save();
          if (!result.ok) return { done: false, error: result.error };
          await projections.projectCaptain({
            id: result.state.captainId,
            handle: result.state.handle,
            system_id: result.state.systemId,
            status: result.state.lifecycle,
            ship_type: result.state.shipType,
            police_record: result.state.policeRecord,
            active_bounty: 0,
            public_disposition: publicCaptainView(result.state).publicDisposition,
            lifecycle_state: result.state.lifecycle,
            credits: result.state.credits,
            updated_at: nowMs,
          });
        }
        return { done: true };
      }

      if (task.taskType === 'd1_projection_retry' || task.taskType === 'trade_reconcile' || task.taskType === 'reconcile_trade' || task.taskType === 'd1_project_trade') {
        const operationId = String(payload.operationId ?? task.idempotencyKey);
        if (state.pendingTrade?.operationId === operationId) {
          const result = await retryTradeProjection(
            state,
            this.systemPort(state.pendingTrade.systemId, nowMs),
            projections,
            { operationId, nowMs },
          );
          this.state = result.state;
          this.save();
          return result.ok ? { done: true } : { done: false, error: result.error };
        }
        if (state.pendingDockOp?.operationId === operationId) {
          const result = await retryDockProjection(state, projections, { operationId, nowMs });
          this.state = result.state;
          this.save();
          return result.ok ? { done: true } : { done: false, error: result.error };
        }
        if (state.pendingPoliceProjection?.operationId === operationId) {
          const result = await retryPoliceProjection(state, projections, { operationId, nowMs });
          this.state = result.state;
          this.save();
          return result.ok ? { done: true } : { done: false, error: result.error };
        }
        return { done: true };
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
      if (url.pathname === '/bootstrap' && request.method === 'POST') {
        const body = await request.json() as {
          captainId: string;
          kind: 'human' | 'npc';
          handle: string;
          systemId: string;
          credits?: number;
          combatProfile?: number;
          tradeProfile?: number;
          accountId?: string | null;
          shipTypeId?: number;
        };
        this.state = createCaptainState({ ...body, nowMs });
        this.save();
        const view = publicCaptainView(this.state);
        await this.env.DB.prepare(
          `INSERT OR REPLACE INTO captains_projection
            (id, handle, system_id, status, ship_type, police_record, active_bounty,
             public_disposition, lifecycle_state, credits, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          view.id, view.handle, view.systemId, view.status, view.shipType,
          view.policeRecord, view.activeBounty, view.publicDisposition,
          view.lifecycleState, view.credits, nowMs,
        ).run();
        await this.env.DB.prepare(
          `INSERT OR REPLACE INTO captain_controller_private (captain_id, kind, account_id, updated_at, active)
           VALUES (?, ?, ?, ?, 1)`,
        ).bind(body.captainId, body.kind, body.accountId ?? null, nowMs).run();
        return json({ ok: true, captainId: body.captainId });
      }

      const state = this.load();
      const projections = this.projectionPort();

      if (url.pathname === '/view' && request.method === 'GET') {
        return json({ ok: true, captain: publicCaptainView(state) });
      }

      if (url.pathname === '/internal/snapshot' && request.method === 'GET') {
        return json({ ok: true, snapshot: privateCaptainSnapshot(state) });
      }

      if (url.pathname === '/trade' && request.method === 'POST') {
        const body = await request.json() as {
          operationId: string;
          good: CommodityId;
          side: 'buy' | 'sell';
          quantity: number;
        };
        const result = await executeTrade(state, this.systemPort(state.systemId, nowMs), projections, { ...body, nowMs });
        this.state = result.state;
        this.save();
        if (!result.ok && result.code === 'RETRY') {
          await this.scheduleRetry('trade_reconcile', body.operationId, nowMs + 500, { operationId: body.operationId });
        }
        return json(captainMutationResponse(result), result.ok ? 200 : result.code === 'INTEGRITY' ? 409 : 400);
      }

      if (url.pathname === '/dock/refuel' && request.method === 'POST') {
        const body = await request.json() as { operationId: string; units?: number };
        const result = await refuelShip(state, projections, { ...body, nowMs });
        this.state = result.state;
        this.save();
        if (!result.ok && result.code === 'RETRY') {
          await this.scheduleRetry('d1_projection_retry', body.operationId, nowMs + 500, { operationId: body.operationId });
        }
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      if (url.pathname === '/dock/repair' && request.method === 'POST') {
        const body = await request.json() as { operationId: string; hullPoints?: number };
        const result = await repairShip(state, projections, { ...body, nowMs });
        this.state = result.state;
        this.save();
        if (!result.ok && result.code === 'RETRY') {
          await this.scheduleRetry('d1_projection_retry', body.operationId, nowMs + 500, { operationId: body.operationId });
        }
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      if (url.pathname === '/dock/upgrade' && request.method === 'POST') {
        const body = await request.json() as {
          operationId: string;
          shipTypeId: number;
          systemTechLevel?: number;
        };
        const result = await upgradeShip(state, projections, { ...body, nowMs });
        this.state = result.state;
        this.save();
        if (!result.ok && result.code === 'RETRY') {
          await this.scheduleRetry('d1_projection_retry', body.operationId, nowMs + 500, { operationId: body.operationId });
        }
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      if (url.pathname === '/travel/start' && request.method === 'POST') {
        const body = await request.json() as {
          operationId: string;
          destinationSystemId: string;
          seed: number;
        };
        const result = await startTravel(
          state,
          this.systemPort(body.destinationSystemId, nowMs),
          projections,
          { ...body, nowMs },
        );
        this.state = result.state;
        this.save();
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      if (url.pathname === '/travel/advance' && request.method === 'POST') {
        const body = await request.json() as { operationId: string };
        if (!state.activeTrip) return json({ ok: false, error: 'no trip' }, 400);
        const result = await advanceTravel(
          state,
          this.systemPort(state.activeTrip.destinationSystemId, nowMs),
          projections,
          { ...body, nowMs },
        );
        this.state = result.state;
        this.save();
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      if (url.pathname === '/claim' && request.method === 'POST') {
        const body = await request.json() as {
          encounterId: string;
          routeArea: string;
          expiresAt: number;
        };
        const result = claimEncounter(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        if (result.ok) {
          await this.scheduleRetry('claim_expiry', body.encounterId, body.expiresAt, {
            encounterId: body.encounterId,
          });
        }
        return json(captainMutationResponse(result), result.ok ? 200 : 409);
      }

      if (url.pathname === '/claim/release' && request.method === 'POST') {
        const body = await request.json() as { encounterId: string };
        const result = releaseEncounterClaim(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        return json(captainMutationResponse(result), result.ok ? 200 : 409);
      }

      if (url.pathname === '/encounter/bind' && request.method === 'POST') {
        const body = await request.json() as { encounterId: string };
        const result = bindEncounter(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      if (url.pathname === '/encounter/settle' && request.method === 'POST') {
        const body = await request.json() as {
          encounterId: string;
          deltaHash: string;
          credits: number;
          cargo: Array<{ good: CommodityId; qty: number }>;
          hull: number;
          shields: number[];
          lifecycleAfter: 'TRAVELLING' | 'ACTIVE' | 'AWAITING_RECOVERY' | 'DEAD';
          combatProfileAfter?: number;
          tradeProfileAfter?: number;
        };
        const result = applyEncounterSettlement(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        if (result.ok && result.state.lifecycle === 'AWAITING_RECOVERY' && result.state.recoveryDueAt != null) {
          await this.scheduleRetry('escape_pod_recovery', body.encounterId, result.state.recoveryDueAt, {
            encounterId: body.encounterId,
          });
        }
        if (result.ok && result.state.lifecycle === 'DEAD') {
          await projections.projectCaptain({
            id: result.state.captainId,
            handle: result.state.handle,
            system_id: result.state.systemId,
            status: result.state.lifecycle,
            ship_type: result.state.shipType,
            police_record: result.state.policeRecord,
            active_bounty: 0,
            public_disposition: publicCaptainView(result.state).publicDisposition,
            lifecycle_state: result.state.lifecycle,
            credits: result.state.credits,
            updated_at: nowMs,
          });
        }
        return json(captainMutationResponse(result), result.ok ? 200 : result.code === 'INTEGRITY' ? 409 : 400);
      }

      if (url.pathname === '/police/apply' && request.method === 'POST') {
        const body = await request.json() as {
          operationId: string;
          policeDelta: number;
          creditsAward: number;
          postRecoveryNeutral?: boolean;
        };
        const result = applyPoliceAndBounty(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        return json(captainMutationResponse(result), result.ok ? 200 : 409);
      }

      if (url.pathname === '/police/respond' && request.method === 'POST') {
        const body = await request.json() as {
          operationId: string;
          response: PoliceResponse;
        };
        const result = await respondPoliceEncounter(state, projections, { ...body, nowMs });
        this.state = result.state;
        this.save();
        if (!result.ok && result.code === 'RETRY') {
          await this.scheduleRetry('d1_projection_retry', body.operationId, nowMs + 500, {
            operationId: body.operationId,
          });
        }
        if (result.ok && result.state.lifecycle === 'AWAITING_RECOVERY' && result.state.recoveryDueAt != null) {
          await this.scheduleRetry(
            'escape_pod_recovery',
            `police-pod-${result.state.captainId}-${result.state.recoveryDueAt}`,
            result.state.recoveryDueAt,
            { encounterId: `police-${result.state.captainId}` },
          );
        }
        if (result.ok && result.state.lifecycle === 'DEAD') {
          await projections.projectCaptain({
            id: result.state.captainId,
            handle: result.state.handle,
            system_id: result.state.systemId,
            status: result.state.lifecycle,
            ship_type: result.state.shipType,
            police_record: result.state.policeRecord,
            active_bounty: 0,
            public_disposition: publicCaptainView(result.state).publicDisposition,
            lifecycle_state: result.state.lifecycle,
            credits: result.state.credits,
            updated_at: nowMs,
          });
        }
        const status = result.ok || result.code === 'RETRY'
          ? 200
          : result.code === 'INTEGRITY'
            ? 409
            : 400;
        return json(captainMutationResponse(result), status);
      }

      if (url.pathname === '/relationship/upsert' && request.method === 'POST') {
        const body = await request.json() as { relationship: import('@sto/ruleset-phase0-v1').RelationshipState };
        const result = upsertRelationship(state, body.relationship, nowMs);
        this.state = result.state;
        this.save();
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      if (url.pathname === '/retire' && request.method === 'POST') {
        const body = await request.json() as { operationId: string };
        const result = retireCaptain(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        if (result.ok) {
          await projections.projectCaptain({
            id: result.state.captainId,
            handle: result.state.handle,
            system_id: result.state.systemId,
            status: result.state.lifecycle,
            ship_type: result.state.shipType,
            police_record: result.state.policeRecord,
            active_bounty: 0,
            public_disposition: publicCaptainView(result.state).publicDisposition,
            lifecycle_state: result.state.lifecycle,
            credits: result.state.credits,
            updated_at: nowMs,
          });
        }
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      if (url.pathname === '/equipment/escape-pod' && request.method === 'POST') {
        const body = await request.json() as { operationId: string };
        const result = installEscapePod(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      if (url.pathname === '/recovery/complete' && request.method === 'POST') {
        const body = await request.json() as {
          operationId: string;
          safeSystemId: string;
          source: 'rescue' | 'automated';
          resetPoliceToNeutralBoundary?: boolean;
        };
        const result = completeRecovery(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      if (url.pathname === '/ambient/step' && request.method === 'POST') {
        const { ambientNpcStep } = await import('../ambient-npc.js');
        const body = await request.json() as { seed: number; destinations: string[] };
        const { state: next, step } = await ambientNpcStep(
          state,
          this.systemPort(state.systemId, nowMs),
          projections,
          { nowMs, seed: body.seed, destinations: body.destinations },
        );
        this.state = next;
        this.save();
        if (next.pendingTrade || next.pendingDockOp) {
          const opId = next.pendingTrade?.operationId ?? next.pendingDockOp!.operationId;
          await this.scheduleRetry('d1_projection_retry', opId, nowMs + 500, { operationId: opId });
        }
        return json({ ok: true, step, captain: publicCaptainView(next) });
      }

      if (url.pathname === '/playtest/force-approach' && request.method === 'POST') {
        const body = await request.json() as {
          destinationSystemId: string;
          routeArea: string;
        };
        const result = forceApproachForPlaytest(state, { ...body, nowMs });
        this.state = result.state;
        this.save();
        return json(captainMutationResponse(result), result.ok ? 200 : 400);
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : 'error' }, 500);
    }
  }
}

function captainMutationResponse(result: {
  ok: boolean;
  state: CaptainState;
  result?: Record<string, unknown>;
  error?: string;
  code?: string;
}) {
  const { state, ...rest } = result;
  return {
    ...rest,
    captain: publicCaptainView(state),
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function serializeCaptain(state: CaptainState): string {
  return JSON.stringify({
    ...state,
    cargo: [...state.cargo.entries()],
    operations: [...state.operations.entries()],
    relationships: [...state.relationships.entries()],
  });
}

function deserializeCaptain(jsonText: string): CaptainState {
  const raw = JSON.parse(jsonText) as Omit<CaptainState, 'cargo' | 'operations' | 'relationships'> & {
    cargo: [CommodityId, NonNullable<CaptainState['cargo'] extends Map<CommodityId, infer V> ? V : never>][];
    operations: [string, NonNullable<CaptainState['operations'] extends Map<string, infer V> ? V : never>][];
    relationships?: [string, import('@sto/ruleset-phase0-v1').RelationshipState][];
    hasEscapePod?: boolean;
    recoveryDueAt?: number | null;
    shipTypeId?: number;
    pendingDockOp?: CaptainState['pendingDockOp'];
    pendingTrade?: CaptainState['pendingTrade'];
    activePoliceEncounter?: CaptainState['activePoliceEncounter'];
    policeRngSeed?: number;
    policeRngDrawPosition?: number;
    pendingPoliceProjection?: CaptainState['pendingPoliceProjection'];
  };
  return {
    ...raw,
    shipTypeId: raw.shipTypeId ?? 1,
    hasEscapePod: raw.hasEscapePod ?? false,
    recoveryDueAt: raw.recoveryDueAt ?? null,
    pendingDockOp: raw.pendingDockOp ?? null,
    activePoliceEncounter: raw.activePoliceEncounter ?? null,
    policeRngSeed: raw.policeRngSeed ?? 1,
    policeRngDrawPosition: raw.policeRngDrawPosition ?? 0,
    pendingPoliceProjection: raw.pendingPoliceProjection ?? null,
    pendingTrade: raw.pendingTrade
      ? {
          ...raw.pendingTrade,
          projectionHash: raw.pendingTrade.projectionHash ?? '',
          unitPrices: raw.pendingTrade.unitPrices ?? [],
        }
      : null,
    cargo: new Map(raw.cargo),
    operations: new Map(raw.operations),
    relationships: new Map(raw.relationships ?? []),
  };
}
