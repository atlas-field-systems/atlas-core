-- name: GetTask :one
SELECT * FROM tasks WHERE task_id = ?;

-- name: InsertTask :exec
INSERT INTO tasks (task_id, asset_id, command, scheduling, input, submission_sequence, status, execution_status, version,
 created_by_id, created_by_kind, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: UpdateTask :exec
UPDATE tasks SET status = ?, execution_status = ?, version = ?, updated_at = ?, acknowledged = ?, started = ?, finished = ?,
 progress = ?, progress_generation = ?, progress_sequence = ?, failure = ?
WHERE task_id = ?;

-- name: ListTasks :many
SELECT * FROM tasks WHERE task_id > ? ORDER BY task_id LIMIT ?;

-- name: AssetTasks :many
SELECT * FROM tasks WHERE asset_id = ? ORDER BY submission_sequence;

-- name: NonterminalTaskIDs :many
SELECT task_id FROM tasks WHERE asset_id = ? AND status NOT IN ('completed', 'failed', 'cancelled') ORDER BY submission_sequence;

-- name: OutstandingCount :one
SELECT COUNT(*) FROM tasks WHERE asset_id = ? AND status NOT IN ('completed', 'failed', 'cancelled');

-- name: TaskCancellations :many
SELECT * FROM task_cancellations WHERE task_id = ? ORDER BY ordinal;

-- name: InsertCancellation :exec
INSERT INTO task_cancellations (task_id, cancellation_id, ordinal, requested_by_id, requested_by_kind, requested_at, reason, state, resolution)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL);

-- name: ResolveCancellation :exec
UPDATE task_cancellations SET state = ?, resolution = ? WHERE task_id = ? AND cancellation_id = ?;

-- name: GetQueue :one
SELECT * FROM asset_queues WHERE asset_id = ?;

-- name: PutQueue :exec
INSERT INTO asset_queues (asset_id, next_submission, revision, requested_revision, slots, confirmed_revision, confirmed_task_ids,
 adoption_state, adoption_revision, adoption_reason, active_task_id, active_generation, active_sequence, suspended_task_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (asset_id) DO UPDATE SET next_submission = excluded.next_submission, revision = excluded.revision,
 requested_revision = excluded.requested_revision, slots = excluded.slots, confirmed_revision = excluded.confirmed_revision,
 confirmed_task_ids = excluded.confirmed_task_ids, adoption_state = excluded.adoption_state,
 adoption_revision = excluded.adoption_revision, adoption_reason = excluded.adoption_reason,
 active_task_id = excluded.active_task_id, active_generation = excluded.active_generation,
 active_sequence = excluded.active_sequence, suspended_task_id = excluded.suspended_task_id;
