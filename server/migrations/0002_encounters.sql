-- Completed encounter history (design §18.5 / §15)

CREATE TABLE IF NOT EXISTS completed_encounters (
  encounter_id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL,
  route_area TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
