-- Entities: current Entity state, identity reservations with deletion markers,
-- shared Asset report acceptance and movement history. Reset clears them.
CREATE TABLE IF NOT EXISTS entities (
 entity_id TEXT PRIMARY KEY,
 entity_type TEXT NOT NULL,
 alias TEXT,
 alias_key TEXT UNIQUE,
 subtype TEXT,
 version INTEGER NOT NULL,
 edit_revision INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 command_manifest TEXT NOT NULL,
 status_value TEXT NOT NULL,
 status_reason TEXT,
 status_reported_at TEXT,
 status_received_at TEXT,
 status_changed_at TEXT,
 communication_state TEXT NOT NULL,
 last_seen TEXT,
 telemetry TEXT,
 reporting TEXT NOT NULL,
 deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS entities_contact ON entities (communication_state, last_seen) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS process_generations (
 asset_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 transfer_id TEXT NOT NULL UNIQUE,
 process_id TEXT NOT NULL,
 process_public_key TEXT NOT NULL,
 claim_facts TEXT NOT NULL,
 established_at TEXT NOT NULL,
 PRIMARY KEY (asset_id, generation)
);
CREATE TABLE IF NOT EXISTS accepted_reports (
 asset_id TEXT NOT NULL,
 generation INTEGER NOT NULL,
 sequence INTEGER NOT NULL,
 facts TEXT NOT NULL,
 result TEXT NOT NULL,
 commit_cursor TEXT NOT NULL,
 PRIMARY KEY (asset_id, generation, sequence)
);
CREATE TABLE IF NOT EXISTS unit_boundaries (
 asset_id TEXT NOT NULL,
 unit TEXT NOT NULL,
 generation INTEGER NOT NULL,
 sequence INTEGER NOT NULL,
 PRIMARY KEY (asset_id, unit)
);
CREATE TABLE IF NOT EXISTS movement_samples (
 sample_id TEXT PRIMARY KEY,
 entity_id TEXT NOT NULL,
 received_order INTEGER NOT NULL UNIQUE,
 received_at TEXT NOT NULL,
 origin_generation INTEGER,
 origin_sequence INTEGER,
 retained_evidence_id TEXT,
 quantities TEXT NOT NULL,
 earliest_observed_at TEXT
);
CREATE INDEX IF NOT EXISTS movement_by_receipt ON movement_samples (entity_id, received_at, sample_id);
CREATE TABLE IF NOT EXISTS movement_facts (
 entity_id TEXT NOT NULL,
 evidence_key TEXT NOT NULL,
 quantity TEXT NOT NULL,
 facts TEXT NOT NULL,
 sample_id TEXT NOT NULL,
 PRIMARY KEY (entity_id, evidence_key, quantity)
);
