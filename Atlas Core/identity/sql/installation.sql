-- Identity and access: principals, credential verifiers, Asset bindings and
-- deployment enrollment authority. All are installation setup, retained
-- across Restart and ordinary Reset until Hard Reset.
CREATE TABLE IF NOT EXISTS principals (
 principal_id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK (kind IN ('operator', 'asset')),
 provenance TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
 credential_id TEXT PRIMARY KEY,
 principal_id TEXT NOT NULL REFERENCES principals (principal_id),
 verifier TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 created_at TEXT NOT NULL,
 revoked_at TEXT,
 revocation_reason TEXT
);
CREATE INDEX IF NOT EXISTS credentials_by_principal ON credentials (principal_id);
CREATE TABLE IF NOT EXISTS asset_bindings (
 asset_id TEXT PRIMARY KEY,
 principal_id TEXT NOT NULL UNIQUE REFERENCES principals (principal_id),
 recovery_public_key TEXT NOT NULL,
 bound_at TEXT NOT NULL,
 denied_at TEXT,
 denial_reason TEXT
);
CREATE TABLE IF NOT EXISTS enrollment_authority (
 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
 public_key TEXT NOT NULL,
 configured_at TEXT NOT NULL
);
