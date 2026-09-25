-- name: CountOperatorKeys :one
SELECT COUNT(*) FROM operator_keys;

-- name: CreateOperatorKey :exec
INSERT INTO operator_keys (id, verifier, created_at) VALUES (?, ?, ?);

-- name: CallerByVerifier :one
SELECT CAST('operator' AS TEXT) AS kind, operator_keys.id FROM operator_keys
WHERE operator_keys.verifier = sqlc.arg(verifier) AND NOT operator_keys.revoked
UNION ALL
SELECT 'enrollment', 'enrollment' FROM enrollment_authority
WHERE enrollment_authority.verifier = sqlc.arg(verifier) AND NOT enrollment_authority.revoked
UNION ALL
SELECT 'asset', asset_bindings.asset_id FROM asset_bindings
WHERE asset_bindings.verifier = sqlc.arg(verifier) AND asset_bindings.active AND NOT asset_bindings.revoked
LIMIT 1;

-- name: CountEnrollmentAuthorities :one
SELECT COUNT(*) FROM enrollment_authority;

-- name: CreateEnrollmentAuthority :exec
INSERT INTO enrollment_authority (singleton, verifier) VALUES (1, ?);

-- name: RevokeEnrollmentAuthority :execrows
UPDATE enrollment_authority SET revoked = TRUE WHERE singleton = 1 AND NOT revoked;

-- name: GetAssetBinding :one
SELECT * FROM asset_bindings WHERE asset_id = ?;

-- name: ReserveAssetBinding :exec
INSERT INTO asset_bindings (asset_id, principal_id, credential_id, verifier) VALUES (?, ?, ?, ?)
ON CONFLICT (asset_id) DO NOTHING;

-- name: ActivateAssetBinding :exec
UPDATE asset_bindings SET active = TRUE WHERE asset_id = ?;

-- name: ListInactiveAssetBindings :many
SELECT asset_id FROM asset_bindings WHERE NOT active;
