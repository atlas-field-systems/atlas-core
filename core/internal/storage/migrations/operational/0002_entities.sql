CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind = 'asset'),
    alias TEXT,
    subtype TEXT,
    status TEXT NOT NULL,
    status_reported_at INTEGER,
    link_state TEXT NOT NULL,
    last_seen INTEGER,
    latitude REAL,
    longitude REAL,
    altitude_m REAL,
    speed_mps REAL,
    heading_deg REAL,
    battery_percent REAL,
    -- Reported as a whole and returned as reported; Core never queries inside it.
    command_manifest TEXT NOT NULL,
    version INTEGER NOT NULL,
    last_report_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX entities_alias ON entities (lower(alias)) WHERE alias IS NOT NULL;

-- Original enrollment facts, so retries are compared with what was first sent.
CREATE TABLE asset_registrations (
    request_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL UNIQUE REFERENCES entities (id),
    facts_digest BLOB NOT NULL
);

-- Accepted Asset reports, so a resent report is recognized after Restart.
CREATE TABLE asset_reports (
    report_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES entities (id),
    sequence INTEGER NOT NULL,
    facts_digest BLOB NOT NULL,
    UNIQUE (asset_id, sequence)
);
