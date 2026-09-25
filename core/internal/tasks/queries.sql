-- name: GetTask :one
SELECT * FROM tasks WHERE id = ?;

-- name: GetTaskBySubmission :one
SELECT * FROM tasks WHERE submission_id = ?;

-- name: NextAssetSequence :one
INSERT INTO asset_task_sequences (asset_id, last_sequence) VALUES (?, 1)
ON CONFLICT (asset_id) DO UPDATE SET last_sequence = last_sequence + 1
RETURNING last_sequence;

-- name: CreateTask :exec
INSERT INTO tasks (id, submission_id, asset_id, facts_digest, command_id, destination_latitude, destination_longitude, scheduling, cancellation_supported, progress_supported, acceptance_sequence, status)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending');

-- name: UpdateTaskStatus :exec
UPDATE tasks SET status = sqlc.arg(status), progress_percent = sqlc.arg(progress_percent),
    failure_reason = sqlc.arg(failure_reason), cancellation_request_id = sqlc.arg(cancellation_request_id),
    execution_status = sqlc.arg(execution_status),
    version = version + 1
WHERE id = sqlc.arg(id);

-- name: SetTaskChangeSequence :exec
UPDATE tasks SET change_sequence = sqlc.arg(sequence), created_sequence = COALESCE(NULLIF(created_sequence, 0), sqlc.arg(sequence))
WHERE id = sqlc.arg(id);

-- name: ListTasks :many
SELECT * FROM tasks WHERE created_sequence > sqlc.arg(after_sequence) ORDER BY created_sequence LIMIT sqlc.arg(limit);

-- name: ListAssignedTasks :many
SELECT * FROM tasks WHERE asset_id = sqlc.arg(asset_id) AND acceptance_sequence > sqlc.arg(after_sequence)
ORDER BY acceptance_sequence LIMIT sqlc.arg(limit);

-- name: ListTasksAtBaseline :many
SELECT * FROM tasks WHERE created_sequence <= sqlc.arg(baseline) AND id > sqlc.arg(after_id)
ORDER BY id LIMIT sqlc.arg(limit);
