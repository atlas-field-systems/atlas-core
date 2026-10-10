-- name: ReadTask :one
SELECT value FROM tasks WHERE id=?;
-- name: ListTasks :many
SELECT value FROM tasks ORDER BY asset_id,submission_sequence;
-- name: ListAssigned :many
SELECT value FROM tasks WHERE asset_id=? ORDER BY submission_sequence;
-- name: SaveTask :exec
INSERT INTO tasks(id,asset_id,submission_sequence,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value;
-- name: ReadQueue :one
SELECT * FROM task_queues WHERE asset_id=?;
-- name: SaveQueue :exec
INSERT INTO task_queues(asset_id,value,next_sequence) VALUES(?,?,?) ON CONFLICT(asset_id) DO UPDATE SET value=excluded.value,next_sequence=excluded.next_sequence;
-- name: ClearTasks :exec
DELETE FROM tasks;
-- name: ClearQueues :exec
DELETE FROM task_queues;
-- name: ReadOrder :one
SELECT generation,sequence FROM task_report_order WHERE task_id=?;
-- name: SaveOrder :exec
INSERT INTO task_report_order(task_id,generation,sequence) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET generation=excluded.generation,sequence=excluded.sequence;
-- name: ReadEvidence :one
SELECT original FROM task_execution_evidence WHERE task_id=? AND identity=?;
-- name: PutEvidence :exec
INSERT INTO task_execution_evidence(task_id,identity,original) VALUES(?,?,?);
-- name: ClearOrder :exec
DELETE FROM task_report_order;
-- name: ClearEvidence :exec
DELETE FROM task_execution_evidence;

-- name: ListOrdinaryTaskPage :many
SELECT value FROM tasks WHERE id>sqlc.arg(after_id)
 AND (json_type(sqlc.arg(filters),'$.ids') IS NULL OR id IN (SELECT value FROM json_each(sqlc.arg(filters),'$.ids')))
 AND (json_type(sqlc.arg(filters),'$.asset_id') IS NULL OR asset_id IN (SELECT value FROM json_each(sqlc.arg(filters),'$.asset_id')))
 AND (json_type(sqlc.arg(filters),'$.status') IS NULL OR json_extract(value,'$.status') IN (SELECT value FROM json_each(sqlc.arg(filters),'$.status')))
 AND (json_type(sqlc.arg(filters),'$.scheduling') IS NULL OR json_extract(value,'$.scheduling') IN (SELECT value FROM json_each(sqlc.arg(filters),'$.scheduling')))
 AND (json_extract(sqlc.arg(filters),'$.outstanding')=0 OR json_extract(value,'$.status') NOT IN ('completed','failed','cancelled'))
ORDER BY id LIMIT sqlc.arg(page_limit);

-- name: ListAssignedTaskPage :many
SELECT value FROM tasks
WHERE asset_id=sqlc.arg(asset_id) AND (asset_id || '/' || printf('%020d',submission_sequence) || '/' || id)>sqlc.arg(after_key)
 AND (json_type(sqlc.arg(filters),'$.ids') IS NULL OR id IN (SELECT value FROM json_each(sqlc.arg(filters),'$.ids')))
 AND (json_type(sqlc.arg(filters),'$.asset_id') IS NULL OR asset_id IN (SELECT value FROM json_each(sqlc.arg(filters),'$.asset_id')))
 AND (json_type(sqlc.arg(filters),'$.status') IS NULL OR json_extract(value,'$.status') IN (SELECT value FROM json_each(sqlc.arg(filters),'$.status')))
 AND (json_type(sqlc.arg(filters),'$.scheduling') IS NULL OR json_extract(value,'$.scheduling') IN (SELECT value FROM json_each(sqlc.arg(filters),'$.scheduling')))
 AND (json_extract(sqlc.arg(filters),'$.outstanding')=0 OR json_extract(value,'$.status') NOT IN ('completed','failed','cancelled'))
ORDER BY submission_sequence,id LIMIT sqlc.arg(page_limit);

-- name: CountOutstanding :one
SELECT COUNT(*) FROM tasks WHERE asset_id=? AND json_extract(value,'$.status') NOT IN ('completed','failed','cancelled');
