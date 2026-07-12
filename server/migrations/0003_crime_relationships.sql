-- Crime / bounty / relationship history projections (design §18.5)

CREATE TABLE IF NOT EXISTS crime_events (
  id TEXT PRIMARY KEY,
  encounter_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  target_id TEXT NULL,
  police_delta INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bounty_events (
  id TEXT PRIMARY KEY,
  encounter_id TEXT NOT NULL,
  killer_id TEXT NOT NULL,
  victim_id TEXT NOT NULL,
  bounty_paid INTEGER NOT NULL,
  lawful INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relationship_projection (
  npc_captain_id TEXT NOT NULL,
  other_captain_id TEXT NOT NULL,
  hostility_score INTEGER NOT NULL,
  facts_json TEXT NOT NULL,
  locked_extreme INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (npc_captain_id, other_captain_id)
);
