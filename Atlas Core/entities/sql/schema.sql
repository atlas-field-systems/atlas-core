CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY,alias TEXT,alias_key TEXT UNIQUE,value TEXT NOT NULL,revision INTEGER NOT NULL,edit_revision INTEGER NOT NULL,CHECK((alias IS NULL AND alias_key IS NULL) OR (alias IS NOT NULL AND alias_key IS NOT NULL)));
CREATE TABLE IF NOT EXISTS entity_generations(asset_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,process_id TEXT NOT NULL,public_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entity_transfers(transfer_id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,generation INTEGER NOT NULL,original TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entity_reports(asset_id TEXT NOT NULL,generation INTEGER NOT NULL,sequence TEXT NOT NULL,original TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(asset_id,generation,sequence));
CREATE TABLE IF NOT EXISTS entity_evidence(asset_id TEXT NOT NULL,identity TEXT NOT NULL,quantity TEXT NOT NULL,original TEXT NOT NULL,sample_id TEXT NOT NULL,PRIMARY KEY(asset_id,identity,quantity));
CREATE TABLE IF NOT EXISTS entity_movement(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,quantity TEXT NOT NULL,value TEXT NOT NULL,observed_at TEXT,received_at TEXT NOT NULL,received_seconds INTEGER NOT NULL,received_nanos INTEGER NOT NULL,sequence INTEGER NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS entity_ordering(asset_id TEXT NOT NULL,unit TEXT NOT NULL,generation INTEGER NOT NULL,sequence TEXT NOT NULL,PRIMARY KEY(asset_id,unit));
CREATE TABLE IF NOT EXISTS entity_tombstones(id TEXT PRIMARY KEY);

CREATE INDEX IF NOT EXISTS entity_movement_receipt_page ON entity_movement(asset_id,received_seconds,received_nanos,id);
CREATE TABLE IF NOT EXISTS entity_movement_observations(sample_id TEXT NOT NULL,quantity TEXT NOT NULL,observed_seconds INTEGER NOT NULL,observed_nanos INTEGER NOT NULL,PRIMARY KEY(sample_id,quantity));
CREATE INDEX IF NOT EXISTS entity_movement_observation_page ON entity_movement_observations(observed_seconds,observed_nanos,sample_id);
