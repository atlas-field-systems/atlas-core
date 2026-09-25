-- name: Record :exec
INSERT INTO activity (actor_kind, actor_id, action, target_id, recorded_at)
VALUES (?, ?, ?, ?, ?);
