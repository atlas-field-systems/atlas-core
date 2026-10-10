-- name: ReadEntity :one
SELECT value FROM entities WHERE id=?;
-- name: ReadAlias :one
SELECT value FROM entities WHERE alias_key=?;
-- name: ListEntities :many
SELECT value FROM entities ORDER BY id;
-- name: SaveEntity :exec
INSERT INTO entities(id,alias,alias_key,value,revision,edit_revision) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,alias_key=excluded.alias_key,value=excluded.value,revision=excluded.revision,edit_revision=excluded.edit_revision;
-- name: DeleteEntity :exec
DELETE FROM entities WHERE id=?;
-- name: ReadTombstone :one
SELECT id FROM entity_tombstones WHERE id=?;
-- name: PutTombstone :exec
INSERT INTO entity_tombstones(id) VALUES(?);
-- name: ReadGeneration :one
SELECT * FROM entity_generations WHERE asset_id=?;
-- name: SaveGeneration :exec
INSERT INTO entity_generations(asset_id,generation,process_id,public_key) VALUES(?,?,?,?) ON CONFLICT(asset_id) DO UPDATE SET generation=excluded.generation,process_id=excluded.process_id,public_key=excluded.public_key;
-- name: ReadTransfer :one
SELECT * FROM entity_transfers WHERE transfer_id=?;
-- name: PutTransfer :exec
INSERT INTO entity_transfers(transfer_id,asset_id,generation,original) VALUES(?,?,?,?);
-- name: ReadReport :one
SELECT * FROM entity_reports WHERE asset_id=? AND generation=? AND sequence=?;
-- name: PutReport :exec
INSERT INTO entity_reports(asset_id,generation,sequence,original,receipt) VALUES(?,?,?,?,?);
-- name: ReadOrdering :one
SELECT generation,sequence FROM entity_ordering WHERE asset_id=? AND unit=?;
-- name: SaveOrdering :exec
INSERT INTO entity_ordering(asset_id,unit,generation,sequence) VALUES(?,?,?,?) ON CONFLICT(asset_id,unit) DO UPDATE SET generation=excluded.generation,sequence=excluded.sequence;
-- name: ReadEvidence :one
SELECT * FROM entity_evidence WHERE asset_id=? AND identity=? AND quantity=?;
-- name: PutEvidence :exec
INSERT INTO entity_evidence(asset_id,identity,quantity,original,sample_id) VALUES(?,?,?,?,?);
-- name: NextMovementSequence :one
SELECT COALESCE(MAX(sequence),0)+1 FROM entity_movement;
-- name: PutMovement :exec
INSERT INTO entity_movement(id,asset_id,quantity,value,observed_at,received_at,received_seconds,received_nanos,sequence) VALUES(?,?,?,?,?,?,?,?,?);
-- name: ListMovement :many
SELECT * FROM entity_movement WHERE asset_id=? ORDER BY sequence;
-- name: ClearEntities :exec
DELETE FROM entities;
-- name: ClearGenerations :exec
DELETE FROM entity_generations;
-- name: ClearTransfers :exec
DELETE FROM entity_transfers;
-- name: ClearReports :exec
DELETE FROM entity_reports;
-- name: ClearEvidence :exec
DELETE FROM entity_evidence;
-- name: ClearMovement :exec
DELETE FROM entity_movement;
-- name: ClearOrdering :exec
DELETE FROM entity_ordering;
-- name: ClearTombstones :exec
DELETE FROM entity_tombstones;
-- name: CountReports :one
SELECT COUNT(*) FROM entity_reports;
-- name: CountMovement :one
SELECT COUNT(*) FROM entity_movement;

-- name: ListEntityPage :many
SELECT value FROM entities WHERE id>sqlc.arg(after_id)
 AND (json_type(sqlc.arg(filters),'$.ids') IS NULL OR id IN (SELECT value FROM json_each(sqlc.arg(filters),'$.ids')))
 AND (json_type(sqlc.arg(filters),'$.type') IS NULL OR json_extract(value,'$.type') IN (SELECT value FROM json_each(sqlc.arg(filters),'$.type')))
 AND (json_type(sqlc.arg(filters),'$.alias') IS NULL OR alias_key=json_extract(sqlc.arg(filters),'$.alias'))
 AND (json_type(sqlc.arg(filters),'$.alias_is_set') IS NULL OR (alias IS NOT NULL)=json_extract(sqlc.arg(filters),'$.alias_is_set'))
 ORDER BY id LIMIT sqlc.arg(page_limit);
-- name: MovementUpper :one
SELECT CAST(COALESCE(MAX(sequence),0) AS INTEGER) FROM entity_movement;
-- name: PutMovementObservation :exec
INSERT INTO entity_movement_observations(sample_id,quantity,observed_seconds,observed_nanos) VALUES(?,?,?,?);
-- name: ReceiptMovementPage :many
SELECT id,value,received_seconds AS seconds,received_nanos AS nanos FROM entity_movement
WHERE asset_id=sqlc.arg(asset_id) AND sequence<=sqlc.arg(upper_sequence)
 AND (received_seconds>sqlc.arg(from_seconds) OR (received_seconds=sqlc.arg(from_seconds) AND received_nanos>=sqlc.arg(from_nanos)))
 AND (received_seconds<sqlc.arg(to_seconds) OR (received_seconds=sqlc.arg(to_seconds) AND received_nanos<sqlc.arg(to_nanos)))
 AND (sqlc.arg(has_after)=0 OR received_seconds>sqlc.arg(after_seconds) OR (received_seconds=sqlc.arg(after_seconds) AND received_nanos>sqlc.arg(after_nanos)) OR (received_seconds=sqlc.arg(after_seconds) AND received_nanos=sqlc.arg(after_nanos) AND id>sqlc.arg(after_id)))
ORDER BY received_seconds,received_nanos,id LIMIT sqlc.arg(page_limit);
-- name: ObservedMovementPage :many
WITH matched AS (
 SELECT m.id,m.value,o.observed_seconds,o.observed_nanos,
 ROW_NUMBER() OVER(PARTITION BY m.id ORDER BY o.observed_seconds,o.observed_nanos,o.quantity) AS ordinal
 FROM entity_movement m JOIN entity_movement_observations o ON m.id=o.sample_id
 WHERE m.asset_id=sqlc.arg(asset_id) AND m.sequence<=sqlc.arg(upper_sequence)
 AND (o.observed_seconds>sqlc.arg(from_seconds) OR (o.observed_seconds=sqlc.arg(from_seconds) AND o.observed_nanos>=sqlc.arg(from_nanos)))
 AND (o.observed_seconds<sqlc.arg(to_seconds) OR (o.observed_seconds=sqlc.arg(to_seconds) AND o.observed_nanos<sqlc.arg(to_nanos)))
)
SELECT id,value,observed_seconds AS seconds,observed_nanos AS nanos FROM matched WHERE ordinal=1
 AND (sqlc.arg(has_after)=0 OR observed_seconds>sqlc.arg(after_seconds) OR (observed_seconds=sqlc.arg(after_seconds) AND observed_nanos>sqlc.arg(after_nanos)) OR (observed_seconds=sqlc.arg(after_seconds) AND observed_nanos=sqlc.arg(after_nanos) AND id>sqlc.arg(after_id)))
ORDER BY observed_seconds,observed_nanos,id LIMIT sqlc.arg(page_limit);

-- name: ClearMovementObservations :exec
DELETE FROM entity_movement_observations;
