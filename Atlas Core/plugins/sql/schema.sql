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
CREATE INDEX IF NOT EXISTS plugin_runtime_work ON plugin_operations (
 dataset_id, plugin_id,
 json_extract(value, '$.Execution.binding.core_run_id'),
 json_extract(value, '$.Execution.binding.principal_id'),
 json_extract(value, '$.Execution.binding.runtime_generation')
) WHERE json_extract(value, '$.Status') IN ('pending', 'in_progress', 'cancellation_requested');
