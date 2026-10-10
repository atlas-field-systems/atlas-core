-- name: InsertPrincipal :exec
INSERT INTO principals (principal_id, kind, provenance, created_at) VALUES (?, ?, ?, ?);

-- name: GetPrincipal :one
SELECT principal_id, kind, provenance, created_at FROM principals WHERE principal_id = ?;

-- name: InsertCredential :exec
INSERT INTO credentials (credential_id, principal_id, verifier, name, created_at) VALUES (?, ?, ?, ?, ?);

-- name: CredentialByVerifier :one
SELECT c.credential_id, c.principal_id, c.revoked_at, p.kind, b.asset_id, b.denied_at
FROM credentials c
JOIN principals p ON p.principal_id = c.principal_id
LEFT JOIN asset_bindings b ON b.principal_id = c.principal_id
WHERE c.verifier = ?;

-- name: ActiveCredentialCount :one
SELECT COUNT(*) FROM credentials WHERE principal_id = ? AND revoked_at IS NULL;

-- name: RevokePrincipalCredentials :execrows
UPDATE credentials SET revoked_at = ?, revocation_reason = ? WHERE principal_id = ? AND revoked_at IS NULL;

-- name: InsertBinding :exec
INSERT INTO asset_bindings (asset_id, principal_id, recovery_public_key, bound_at) VALUES (?, ?, ?, ?);

-- name: GetBinding :one
SELECT asset_id, principal_id, recovery_public_key, bound_at, denied_at, denial_reason FROM asset_bindings WHERE asset_id = ?;

-- name: BindingByPrincipal :one
SELECT asset_id, principal_id, recovery_public_key, bound_at, denied_at, denial_reason FROM asset_bindings WHERE principal_id = ?;

-- name: DenyBinding :exec
UPDATE asset_bindings SET denied_at = ?, denial_reason = ? WHERE asset_id = ? AND denied_at IS NULL;

-- name: GetEnrollmentAuthority :one
SELECT public_key, configured_at FROM enrollment_authority WHERE singleton = 1;

-- name: InsertEnrollmentAuthority :exec
INSERT INTO enrollment_authority (singleton, public_key, configured_at) VALUES (1, ?, ?);

-- name: OperatorCredentialByName :one
SELECT c.credential_id, c.principal_id, c.verifier FROM credentials c JOIN principals p ON p.principal_id = c.principal_id
WHERE p.kind = 'operator' AND c.name = ?;
