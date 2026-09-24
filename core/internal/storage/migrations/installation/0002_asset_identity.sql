-- The deployment credential that may enroll Assets. One per installation.
CREATE TABLE enrollment_authority (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    verifier BLOB NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE
);

-- An Asset ID bound to its own credential. A binding is reserved inactive
-- before the Entity commits and activated after, so a crash between the two
-- stores never leaves a usable credential without its Asset. Bindings are
-- installation state and survive Reset.
CREATE TABLE asset_bindings (
    asset_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL UNIQUE,
    credential_id TEXT NOT NULL UNIQUE,
    verifier BLOB NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    revoked BOOLEAN NOT NULL DEFAULT FALSE
);
