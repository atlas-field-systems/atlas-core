CREATE TABLE plugin_operations (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL UNIQUE,
    facts_digest BLOB NOT NULL,
    plugin_id TEXT NOT NULL,
    plugin_release TEXT NOT NULL,
    capability TEXT NOT NULL,
    -- Input and output are opaque to Core: passed to and reported by the Plugin.
    input TEXT NOT NULL,
    status TEXT NOT NULL,
    dispatched BOOLEAN NOT NULL DEFAULT FALSE,
    output TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX plugin_operations_by_plugin ON plugin_operations (plugin_id, created_at DESC, id DESC);

-- Whether each Plugin admits new Operations, and why it is faulted.
CREATE TABLE plugin_runtime (
    plugin_id TEXT PRIMARY KEY,
    admission_open BOOLEAN NOT NULL,
    fault TEXT
);
