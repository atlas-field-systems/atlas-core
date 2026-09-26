-- name: InsertChange :one
INSERT INTO changes (resource_id, kind, entity, resource_type, task, scope_asset_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING sequence;

-- name: PruneChanges :exec
DELETE FROM changes WHERE sequence <= ?;

-- name: RecordPrunedAssetChanges :exec
INSERT INTO asset_change_pruned (asset_id, through_sequence)
SELECT scope_asset_id, MAX(sequence) FROM changes
WHERE sequence <= ? AND scope_asset_id IS NOT NULL GROUP BY scope_asset_id
ON CONFLICT (asset_id) DO UPDATE SET through_sequence = excluded.through_sequence;

-- name: AssetPrunedThrough :one
SELECT CAST(COALESCE((SELECT through_sequence FROM asset_change_pruned WHERE asset_id = ?), 0) AS INTEGER);

-- name: LatestSequence :one
SELECT CAST(COALESCE(MAX(sequence), 0) AS INTEGER) FROM changes;

-- name: OldestSequence :one
SELECT CAST(COALESCE(MIN(sequence), 0) AS INTEGER) FROM changes;

-- name: ListChangesAfter :many
SELECT * FROM changes WHERE sequence > ? ORDER BY sequence LIMIT ?;

-- name: ListAssetChangesAfter :many
SELECT * FROM changes WHERE scope_asset_id = sqlc.arg(asset_id) AND sequence > sqlc.arg(after_sequence)
AND sequence <= sqlc.arg(through_sequence) ORDER BY sequence LIMIT sqlc.arg(limit);
