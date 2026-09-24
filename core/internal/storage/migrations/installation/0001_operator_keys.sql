CREATE TABLE operator_keys (
    id TEXT PRIMARY KEY,
    verifier BLOB NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE
);
