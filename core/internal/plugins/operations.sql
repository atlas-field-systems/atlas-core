-- name: CreateOperation :exec
INSERT INTO plugin_operations (id, submission_id, facts_digest, plugin_id, plugin_release, capability, input, status, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?);

-- name: GetOperationBySubmission :one
SELECT * FROM plugin_operations WHERE submission_id = ?;

-- name: GetOperation :one
SELECT * FROM plugin_operations WHERE plugin_id = ? AND id = ?;

-- name: ListOperationsBefore :many
SELECT * FROM plugin_operations
WHERE plugin_id = sqlc.arg(plugin_id)
  AND (created_at < sqlc.arg(created_at) OR (created_at = sqlc.arg(created_at) AND id < sqlc.arg(id)))
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(limit);

-- name: CountUnfinished :one
SELECT COUNT(*) FROM plugin_operations
WHERE plugin_id = ? AND status IN ('pending', 'in_progress', 'cancellation_requested');

-- name: ClaimDispatch :execrows
UPDATE plugin_operations SET dispatched = TRUE WHERE id = ? AND status = 'pending' AND NOT dispatched;

-- name: SetOutcome :exec
UPDATE plugin_operations SET status = ?, output = ?, error = ? WHERE id = ?;

-- name: SetOutcomeFrom :execrows
UPDATE plugin_operations SET status = sqlc.arg(status), error = sqlc.arg(error)
WHERE id = sqlc.arg(id) AND status = sqlc.arg(expected);

-- name: InterruptUnfinishedOf :exec
UPDATE plugin_operations SET status = 'interrupted', error = ?
WHERE plugin_id = ? AND status IN ('pending', 'in_progress', 'cancellation_requested');

-- name: InterruptAllUnfinished :exec
UPDATE plugin_operations SET status = 'interrupted', error = ?
WHERE status IN ('pending', 'in_progress', 'cancellation_requested');

-- name: GetRuntime :one
SELECT * FROM plugin_runtime WHERE plugin_id = ?;

-- name: SetRuntime :exec
INSERT INTO plugin_runtime (plugin_id, admission_open, fault) VALUES (?, ?, ?)
ON CONFLICT (plugin_id) DO UPDATE SET admission_open = excluded.admission_open, fault = excluded.fault;
