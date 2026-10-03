-- name: PutValue :exec
INSERT INTO fixture_values (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- name: ReadValue :one
SELECT value FROM fixture_values WHERE key = ?;
