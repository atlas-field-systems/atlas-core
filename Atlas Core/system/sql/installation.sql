-- System operations: installation identity, Dataset metadata and the shared
-- write-commit records. Installation tables survive ordinary Reset.
CREATE TABLE IF NOT EXISTS installation (
 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
 installation_id TEXT NOT NULL,
 installation_format INTEGER NOT NULL,
 installation_fingerprint TEXT NOT NULL,
 token_key BLOB NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dataset_metadata (
 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
 dataset_id TEXT NOT NULL,
 dataset_format INTEGER NOT NULL,
 dataset_fingerprint TEXT NOT NULL,
 writing_release TEXT NOT NULL,
 reset_id TEXT,
 established_at TEXT NOT NULL
);
