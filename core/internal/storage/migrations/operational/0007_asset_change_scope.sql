-- Index the direct Asset owner of each change so scoped recovery never reads
-- unrelated payloads. Existing rows receive their owner from retained state.
ALTER TABLE changes ADD COLUMN scope_asset_id TEXT;
UPDATE changes SET scope_asset_id = resource_id WHERE resource_type = 'entity' AND json_extract(entity, '$.kind') = 'asset';
UPDATE changes SET scope_asset_id = json_extract(task, '$.asset_id') WHERE resource_type = 'task';
CREATE INDEX changes_scope_asset_sequence ON changes(scope_asset_id, sequence);
CREATE TABLE asset_change_pruned (
    asset_id TEXT PRIMARY KEY,
    through_sequence INTEGER NOT NULL
);
