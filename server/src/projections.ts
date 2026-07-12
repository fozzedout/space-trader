/**
 * Durable, idempotent D1 projection helpers (design §14.3).
 * Duplicate insert with same projection hash = success; conflicting hash = integrity fault.
 */

export type ProjectionResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; error: string; integrity?: boolean };

export async function projectCompletedTrade(
  db: D1Database,
  row: {
    operation_id: string;
    captain_id: string;
    system_id: string;
    side: string;
    good: number;
    quantity: number;
    total: number;
    projection_hash: string;
    created_at: number;
  },
): Promise<ProjectionResult> {
  const existing = await db.prepare(
    'SELECT projection_hash FROM completed_trades WHERE operation_id = ?',
  ).bind(row.operation_id).first<{ projection_hash: string }>();
  if (existing) {
    if (existing.projection_hash !== row.projection_hash) {
      return { ok: false, error: 'projection hash conflict', integrity: true };
    }
    return { ok: true, duplicate: true };
  }
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO completed_trades
          (operation_id, captain_id, system_id, side, good, quantity, total, projection_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.operation_id, row.captain_id, row.system_id, row.side, row.good,
        row.quantity, row.total, row.projection_hash, row.created_at,
      ),
      db.prepare(
        `INSERT INTO completed_operations
          (operation_id, operation_type, projection_hash, payload_json, created_at)
         VALUES (?, 'trade', ?, ?, ?)
         ON CONFLICT(operation_id) DO NOTHING`,
      ).bind(
        row.operation_id,
        row.projection_hash,
        JSON.stringify({
          captainId: row.captain_id,
          systemId: row.system_id,
          side: row.side,
          good: row.good,
          quantity: row.quantity,
          total: row.total,
        }),
        row.created_at,
      ),
    ]);
    return { ok: true, duplicate: false };
  } catch (err) {
    const again = await db.prepare(
      'SELECT projection_hash FROM completed_trades WHERE operation_id = ?',
    ).bind(row.operation_id).first<{ projection_hash: string }>();
    if (again && again.projection_hash === row.projection_hash) {
      return { ok: true, duplicate: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'projection failed' };
  }
}

export async function projectCaptainRow(
  db: D1Database,
  row: {
    id: string;
    handle: string;
    system_id: string;
    status: string;
    ship_type: string;
    police_record: number;
    active_bounty: number;
    public_disposition: string;
    lifecycle_state: string;
    credits: number;
    updated_at: number;
  },
): Promise<ProjectionResult> {
  try {
    await db.prepare(
      `INSERT OR REPLACE INTO captains_projection
        (id, handle, system_id, status, ship_type, police_record, active_bounty,
         public_disposition, lifecycle_state, credits, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id, row.handle, row.system_id, row.status, row.ship_type,
      row.police_record, row.active_bounty, row.public_disposition,
      row.lifecycle_state, row.credits, row.updated_at,
    ).run();
    return { ok: true, duplicate: false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'captain projection failed' };
  }
}

export async function projectCompletedOperation(
  db: D1Database,
  row: {
    operation_id: string;
    operation_type: string;
    projection_hash: string;
    payload_json: string;
    created_at: number;
  },
): Promise<ProjectionResult> {
  const existing = await db.prepare(
    'SELECT projection_hash FROM completed_operations WHERE operation_id = ?',
  ).bind(row.operation_id).first<{ projection_hash: string }>();
  if (existing) {
    if (existing.projection_hash !== row.projection_hash) {
      return { ok: false, error: 'operation projection hash conflict', integrity: true };
    }
    return { ok: true, duplicate: true };
  }
  try {
    await db.prepare(
      `INSERT INTO completed_operations
        (operation_id, operation_type, projection_hash, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      row.operation_id, row.operation_type, row.projection_hash, row.payload_json, row.created_at,
    ).run();
    return { ok: true, duplicate: false };
  } catch (err) {
    const again = await db.prepare(
      'SELECT projection_hash FROM completed_operations WHERE operation_id = ?',
    ).bind(row.operation_id).first<{ projection_hash: string }>();
    if (again && again.projection_hash === row.projection_hash) {
      return { ok: true, duplicate: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'operation projection failed' };
  }
}

export async function projectEncounterHistory(
  db: D1Database,
  row: {
    encounter_id: string;
    system_id: string;
    route_area: string;
    result_hash: string;
    payload_json: string;
    created_at: number;
  },
  crimes: Array<{
    id: string;
    encounter_id: string;
    kind: string;
    actor_id: string;
    target_id: string | null;
    police_delta: number;
    created_at: number;
  }>,
  bounty?: {
    id: string;
    encounter_id: string;
    killer_id: string;
    victim_id: string;
    bounty_paid: number;
    lawful: number;
    created_at: number;
  } | null,
): Promise<ProjectionResult> {
  const existing = await db.prepare(
    'SELECT result_hash FROM completed_encounters WHERE encounter_id = ?',
  ).bind(row.encounter_id).first<{ result_hash: string }>();
  if (existing) {
    if (existing.result_hash !== row.result_hash) {
      return { ok: false, error: 'encounter projection hash conflict', integrity: true };
    }
    return { ok: true, duplicate: true };
  }
  try {
    const stmts: D1PreparedStatement[] = [
      db.prepare(
        `INSERT INTO completed_encounters
          (encounter_id, system_id, route_area, result_hash, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.encounter_id, row.system_id, row.route_area, row.result_hash, row.payload_json, row.created_at,
      ),
    ];
    for (const crime of crimes) {
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO crime_events
            (id, encounter_id, kind, actor_id, target_id, police_delta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crime.id, crime.encounter_id, crime.kind, crime.actor_id,
          crime.target_id, crime.police_delta, crime.created_at,
        ),
      );
    }
    if (bounty) {
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO bounty_events
            (id, encounter_id, killer_id, victim_id, bounty_paid, lawful, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          bounty.id, bounty.encounter_id, bounty.killer_id, bounty.victim_id,
          bounty.bounty_paid, bounty.lawful, bounty.created_at,
        ),
      );
    }
    await db.batch(stmts);
    return { ok: true, duplicate: false };
  } catch (err) {
    const again = await db.prepare(
      'SELECT result_hash FROM completed_encounters WHERE encounter_id = ?',
    ).bind(row.encounter_id).first<{ result_hash: string }>();
    if (again && again.result_hash === row.result_hash) {
      return { ok: true, duplicate: true };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'encounter projection failed' };
  }
}

export async function projectMarketRows(
  db: D1Database,
  rows: Array<{
    system_id: string;
    good: number;
    equilibrium_price: number;
    stock: number;
    target_stock: number;
    pressure_bps: number;
    updated_at: number;
  }>,
): Promise<ProjectionResult> {
  if (rows.length === 0) return { ok: true, duplicate: false };
  try {
    await db.batch(rows.map((row) => db.prepare(
      `INSERT OR REPLACE INTO market_projection
        (system_id, good, equilibrium_price, stock, target_stock, pressure_bps, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.system_id, row.good, row.equilibrium_price, row.stock,
      row.target_stock, row.pressure_bps, row.updated_at,
    )));
    return { ok: true, duplicate: false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'market projection failed' };
  }
}
