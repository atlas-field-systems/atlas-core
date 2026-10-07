CREATE TABLE IF NOT EXISTS plugin_bookkeeping_metadata (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 dataset_id TEXT NOT NULL,
 core_release TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_operations (
 id TEXT PRIMARY KEY,
 dataset_id TEXT NOT NULL,
 plugin_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 value TEXT NOT NULL,
 UNIQUE(dataset_id, plugin_id, request_id)
);
