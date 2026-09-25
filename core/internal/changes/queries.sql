-- name: InsertChange :one
INSERT INTO changes (resource_id, kind, entity) VALUES (?, ?, ?) RETURNING sequence;

-- name: PruneChanges :exec
DELETE FROM changes WHERE sequence <= ?;

-- name: LatestSequence :one
SELECT CAST(COALESCE(MAX(sequence), 0) AS INTEGER) FROM changes;

-- name: OldestSequence :one
SELECT CAST(COALESCE(MIN(sequence), 0) AS INTEGER) FROM changes;

-- name: ListChangesAfter :many
SELECT * FROM changes WHERE sequence > ? ORDER BY sequence LIMIT ?;
