-- name: ReadMetadata :one
SELECT dataset_id, core_release FROM plugin_bookkeeping_metadata WHERE singleton = 1;
-- name: PutMetadata :exec
INSERT INTO plugin_bookkeeping_metadata(singleton, dataset_id, core_release) VALUES(1, ?, ?);
-- name: ReadOperation :one
SELECT value FROM plugin_operations WHERE id = ?;
-- name: ReadSubmission :one
SELECT value FROM plugin_operations WHERE dataset_id = ? AND plugin_id = ? AND request_id = ?;
-- name: PutOperation :exec
INSERT INTO plugin_operations(id, dataset_id, plugin_id, request_id, value) VALUES(?, ?, ?, ?, ?);
-- name: UpdateOperation :exec
UPDATE plugin_operations SET value = ? WHERE id = ?;
-- name: ListOperations :many
SELECT value FROM plugin_operations WHERE dataset_id = ? AND plugin_id = ? ORDER BY rowid LIMIT ? OFFSET ?;
-- name: ScanOperations :many
SELECT value FROM plugin_operations ORDER BY rowid LIMIT ? OFFSET ?;
-- name: CountOperations :one
SELECT count(*) FROM plugin_operations;
