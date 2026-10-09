-- name: ReadMetadata :one
SELECT dataset_id, core_release FROM plugin_bookkeeping_metadata WHERE singleton = 1;
-- name: PutMetadata :exec
INSERT INTO plugin_bookkeeping_metadata(singleton, dataset_id, core_release) VALUES(1, ?, ?);
-- name: ReadOperation :one
SELECT * FROM plugin_operations WHERE id = ?;
-- name: ReadSubmission :one
SELECT * FROM plugin_operations WHERE dataset_id = ? AND plugin_id = ? AND request_id = ?;
-- name: PutOperation :exec
INSERT INTO plugin_operations(id, dataset_id, plugin_id, request_id, value) VALUES(?, ?, ?, ?, ?);
-- name: UpdateOperation :exec
UPDATE plugin_operations SET value = ? WHERE id = ?;
-- name: ListOperations :many
SELECT * FROM plugin_operations WHERE dataset_id = ? AND plugin_id = ? ORDER BY rowid LIMIT ? OFFSET ?;
-- name: ScanOperations :many
SELECT * FROM plugin_operations ORDER BY rowid LIMIT ? OFFSET ?;
-- name: RuntimeWork :many
SELECT * FROM plugin_operations
WHERE dataset_id = sqlc.arg(dataset_id) AND plugin_id = sqlc.arg(plugin_id)
 AND json_extract(value, '$.Execution.binding.core_run_id') = sqlc.arg(core_run_id)
 AND json_extract(value, '$.Execution.binding.principal_id') = sqlc.arg(principal_id)
 AND json_extract(value, '$.Execution.binding.runtime_generation') = sqlc.arg(runtime_generation)
 AND json_extract(value, '$.Status') IN ('pending', 'in_progress', 'cancellation_requested')
ORDER BY rowid LIMIT sqlc.arg(capacity);
-- name: CountOperations :one
SELECT count(*) FROM plugin_operations;
