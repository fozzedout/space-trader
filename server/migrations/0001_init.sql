-- D1 projections and authoritative galaxy/account tables (design §18.5)

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS systems (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tech_level INTEGER NOT NULL,
  politics_id INTEGER NOT NULL,
  size INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS captains_projection (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  system_id TEXT NOT NULL,
  status TEXT NOT NULL,
  ship_type TEXT NOT NULL,
  police_record INTEGER NOT NULL,
  active_bounty INTEGER NOT NULL,
  public_disposition TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  credits INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Never exposed through public player APIs
CREATE TABLE IF NOT EXISTS captain_controller_private (
  captain_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('human', 'npc')),
  account_id TEXT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS market_projection (
  system_id TEXT NOT NULL,
  good INTEGER NOT NULL,
  equilibrium_price INTEGER NOT NULL,
  stock INTEGER NOT NULL,
  target_stock INTEGER NOT NULL,
  pressure_bps INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (system_id, good)
);

CREATE TABLE IF NOT EXISTS completed_trades (
  operation_id TEXT PRIMARY KEY,
  captain_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  side TEXT NOT NULL,
  good INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  total INTEGER NOT NULL,
  projection_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS completed_operations (
  operation_id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  projection_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
