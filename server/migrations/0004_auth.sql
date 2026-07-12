-- Magic-link tokens for Phase 0 email authentication (design §13.6)

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links(email);
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions(account_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
