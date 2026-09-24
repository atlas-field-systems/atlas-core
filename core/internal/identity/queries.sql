-- name: CountOperatorKeys :one
SELECT COUNT(*) FROM operator_keys;

-- name: CreateOperatorKey :exec
INSERT INTO operator_keys (id, verifier, created_at) VALUES (?, ?, ?);

-- name: ActiveOperatorKeyByVerifier :one
SELECT id FROM operator_keys WHERE verifier = ? AND NOT revoked;
