-- name: GetEntity :one
SELECT * FROM entities WHERE entity_id = ?;

-- name: GetEntityByAliasKey :one
SELECT * FROM entities WHERE alias_key = ? AND deleted_at IS NULL;

-- name: InsertEntity :exec
INSERT INTO entities (entity_id, entity_type, alias, alias_key, subtype, version, edit_revision, created_at, updated_at,
 command_manifest, status_value, status_reason, status_reported_at, status_received_at, status_changed_at,
 communication_state, last_seen, telemetry, reporting, deleted_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL);

-- name: UpdateEntity :exec
UPDATE entities SET alias = ?, alias_key = ?, subtype = ?, version = ?, edit_revision = ?, updated_at = ?,
 command_manifest = ?, status_value = ?, status_reason = ?, status_reported_at = ?, status_received_at = ?,
 status_changed_at = ?, communication_state = ?, last_seen = ?, telemetry = ?, reporting = ?
WHERE entity_id = ? AND deleted_at IS NULL;

-- name: MarkEntityDeleted :exec
UPDATE entities SET deleted_at = ?, alias_key = NULL, version = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL;

-- name: ListEntities :many
SELECT * FROM entities WHERE deleted_at IS NULL AND entity_id > ? ORDER BY entity_id LIMIT ?;

-- name: ContactCandidates :many
SELECT * FROM entities WHERE deleted_at IS NULL AND communication_state <> 'offline' AND last_seen IS NOT NULL;

-- name: CurrentGeneration :one
SELECT CAST(COALESCE(MAX(generation), 0) AS INTEGER) AS generation FROM process_generations WHERE asset_id = ?;

-- name: GetGeneration :one
SELECT * FROM process_generations WHERE asset_id = ? AND generation = ?;

-- name: GenerationByTransfer :one
SELECT * FROM process_generations WHERE transfer_id = ?;

-- name: InsertGeneration :exec
INSERT INTO process_generations (asset_id, generation, transfer_id, process_id, process_public_key, claim_facts, established_at)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: GetAcceptedReport :one
SELECT * FROM accepted_reports WHERE asset_id = ? AND generation = ? AND sequence = ?;

-- name: InsertAcceptedReport :exec
INSERT INTO accepted_reports (asset_id, generation, sequence, facts, result, commit_cursor) VALUES (?, ?, ?, ?, ?, ?);

-- name: GetBoundary :one
SELECT generation, sequence FROM unit_boundaries WHERE asset_id = ? AND unit = ?;

-- name: PutBoundary :exec
INSERT INTO unit_boundaries (asset_id, unit, generation, sequence) VALUES (?, ?, ?, ?)
ON CONFLICT (asset_id, unit) DO UPDATE SET generation = excluded.generation, sequence = excluded.sequence;

-- name: GetMovementFact :one
SELECT facts, sample_id FROM movement_facts WHERE entity_id = ? AND evidence_key = ? AND quantity = ?;

-- name: InsertMovementFact :exec
INSERT INTO movement_facts (entity_id, evidence_key, quantity, facts, sample_id) VALUES (?, ?, ?, ?, ?);

-- name: NextReceivedOrder :one
SELECT CAST(COALESCE(MAX(received_order), 0) + 1 AS INTEGER) AS next_order FROM movement_samples;

-- name: InsertMovementSample :exec
INSERT INTO movement_samples (sample_id, entity_id, received_order, received_at, origin_generation, origin_sequence, retained_evidence_id, quantities, earliest_observed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: MovementByReceipt :many
SELECT * FROM movement_samples
WHERE entity_id = ? AND received_order <= ? AND received_at >= ? AND received_at < ?
 AND (received_at > ? OR (received_at = ? AND sample_id > ?))
ORDER BY received_at, sample_id LIMIT ?;

-- name: MovementObserved :many
SELECT * FROM movement_samples
WHERE entity_id = ? AND received_order <= ? AND earliest_observed_at IS NOT NULL
ORDER BY sample_id;

-- name: MaxReceivedOrder :one
SELECT CAST(COALESCE(MAX(received_order), 0) AS INTEGER) AS max_order FROM movement_samples;
