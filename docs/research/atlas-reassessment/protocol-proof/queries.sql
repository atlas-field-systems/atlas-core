-- name: PutEntity :exec
INSERT INTO proof_entity (id, value) VALUES (?, ?)
ON CONFLICT(id) DO UPDATE SET value = excluded.value;

-- name: ReadEntity :one
SELECT value FROM proof_entity WHERE id = ?;
