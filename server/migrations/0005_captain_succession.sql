-- Captain succession: inactive mappings free the account to bind a fresh captain
-- after RETIRED / DEAD (design § Permanent death / Retirement).

ALTER TABLE captain_controller_private ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
