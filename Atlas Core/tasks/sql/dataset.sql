-- Tasks: Task records, cancellation requests and each Asset's queue aggregate.
-- Terminal Tasks remain execution records until Reset.
CREATE TABLE IF NOT EXISTS tasks (
 task_id TEXT PRIMARY KEY,
 asset_id TEXT NOT NULL,
 command TEXT NOT NULL,
 scheduling TEXT NOT NULL,
 input TEXT NOT NULL,
 submission_sequence INTEGER NOT NULL,
 status TEXT NOT NULL,
 execution_status TEXT NOT NULL,
 version INTEGER NOT NULL,
 created_by_id TEXT NOT NULL,
 created_by_kind TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 acknowledged TEXT,
 started TEXT,
 finished TEXT,
 progress TEXT,
 progress_generation INTEGER,
 progress_sequence INTEGER,
 failure TEXT,
 UNIQUE (asset_id, submission_sequence)
);
CREATE INDEX IF NOT EXISTS tasks_by_asset ON tasks (asset_id, submission_sequence);
CREATE TABLE IF NOT EXISTS task_cancellations (
 task_id TEXT NOT NULL,
 cancellation_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 requested_by_id TEXT NOT NULL,
 requested_by_kind TEXT NOT NULL,
 requested_at TEXT NOT NULL,
 reason TEXT,
 state TEXT NOT NULL,
 resolution TEXT,
 PRIMARY KEY (task_id, cancellation_id)
);
CREATE TABLE IF NOT EXISTS asset_queues (
 asset_id TEXT PRIMARY KEY,
 next_submission INTEGER NOT NULL,
 revision INTEGER NOT NULL,
 requested_revision INTEGER NOT NULL,
 slots TEXT NOT NULL,
 confirmed_revision INTEGER,
 confirmed_task_ids TEXT NOT NULL,
 adoption_state TEXT NOT NULL,
 adoption_revision INTEGER,
 adoption_reason TEXT,
 active_task_id TEXT,
 active_generation INTEGER,
 active_sequence INTEGER,
 suspended_task_id TEXT
);
