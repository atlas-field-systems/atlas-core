-- System operations Dataset tables, cleared by fresh opening.
CREATE TABLE IF NOT EXISTS commits (
 seq INTEGER PRIMARY KEY,
 committed_at TEXT NOT NULL,
 operation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (
 commit_seq INTEGER NOT NULL,
 ordinal INTEGER NOT NULL,
 resource_kind TEXT NOT NULL,
 resource_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 deleted INTEGER NOT NULL,
 image TEXT,
 PRIMARY KEY (commit_seq, ordinal)
);
CREATE TABLE IF NOT EXISTS activity (
 action_id TEXT PRIMARY KEY,
 commit_seq INTEGER NOT NULL,
 actor_kind TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 actor_display TEXT NOT NULL,
 action TEXT NOT NULL,
 target_kind TEXT NOT NULL,
 target_id TEXT NOT NULL,
 occurred_at TEXT NOT NULL,
 outcome TEXT NOT NULL,
 summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS retry_claims (
 kind TEXT NOT NULL,
 identity TEXT NOT NULL,
 facts TEXT NOT NULL,
 result TEXT NOT NULL,
 result_ref TEXT NOT NULL,
 commit_seq INTEGER NOT NULL,
 ended_at TEXT,
 PRIMARY KEY (kind, identity)
);
CREATE INDEX IF NOT EXISTS retry_claims_by_result ON retry_claims (kind, result_ref);
