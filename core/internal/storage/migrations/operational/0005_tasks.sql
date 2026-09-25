-- A Task and its Dataset-scoped submission identity are retained together.
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL UNIQUE,
    asset_id TEXT NOT NULL REFERENCES entities (id),
    facts_digest BLOB NOT NULL,
    command_id TEXT NOT NULL,
    destination_latitude REAL NOT NULL,
    destination_longitude REAL NOT NULL,
    scheduling TEXT NOT NULL,
    cancellation_supported BOOLEAN NOT NULL,
    progress_supported BOOLEAN NOT NULL,
    acceptance_sequence INTEGER NOT NULL,
    status TEXT NOT NULL,
    progress_percent REAL,
    failure_reason TEXT,
    cancellation_request_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_sequence INTEGER NOT NULL DEFAULT 0,
    change_sequence INTEGER NOT NULL DEFAULT 0,
    UNIQUE (asset_id, acceptance_sequence)
);
CREATE INDEX tasks_asset_sequence ON tasks (asset_id, acceptance_sequence);
CREATE INDEX tasks_created_sequence ON tasks (created_sequence);
CREATE UNIQUE INDEX tasks_cancellation_request ON tasks (cancellation_request_id) WHERE cancellation_request_id IS NOT NULL;

CREATE TABLE asset_task_sequences (
    asset_id TEXT PRIMARY KEY REFERENCES entities (id),
    last_sequence INTEGER NOT NULL
);

-- Existing Entity rows keep their payload. Task rows use the task column.
ALTER TABLE changes ADD COLUMN resource_type TEXT NOT NULL DEFAULT 'entity';
ALTER TABLE changes ADD COLUMN task TEXT;

CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_kind TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
);
