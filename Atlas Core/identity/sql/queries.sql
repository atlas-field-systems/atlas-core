-- name: ReadCredential :one
SELECT * FROM identity_installation_credentials WHERE verifier=?;
-- name: PutCredential :exec
INSERT INTO identity_installation_credentials(verifier,principal_id,kind,asset_id) VALUES(?,?,?,?);
-- name: ReadBinding :one
SELECT * FROM identity_asset_bindings WHERE asset_id=?;
-- name: PutBinding :exec
INSERT INTO identity_asset_bindings(asset_id,principal_id,recovery_public_key,credential_verifier,registration_id,original,open_enrollment) VALUES(?,?,?,?,?,?,?);
-- name: RevokeBinding :exec
UPDATE identity_asset_bindings SET revoked=1 WHERE asset_id=?;
-- name: RevokeCredentials :exec
UPDATE identity_installation_credentials SET revoked=1 WHERE asset_id=?;
-- name: PutEnrollment :exec
INSERT INTO identity_enrollment(singleton,verifier,public_key,page_key) VALUES(1,?,?,?);
-- name: ReadEnrollment :one
SELECT verifier,public_key FROM identity_enrollment WHERE singleton=1;
-- name: CountOpenIdentities :one
SELECT COUNT(*) FROM identity_asset_bindings WHERE open_enrollment=1 AND revoked=0;

-- name: ReadPageKey :one
SELECT page_key FROM identity_enrollment WHERE singleton=1;
