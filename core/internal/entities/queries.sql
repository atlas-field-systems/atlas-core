-- name: GetEntity :one
SELECT * FROM entities WHERE id = ?;

-- name: EntityExists :one
SELECT EXISTS (SELECT 1 FROM entities WHERE id = ?);

-- name: CreateAsset :exec
INSERT INTO entities (id, kind, alias, subtype, status, link_state, latitude, longitude, altitude_m, speed_mps, heading_deg, battery_percent, command_manifest, version)
VALUES (?, 'asset', ?, ?, ?, 'offline', ?, ?, ?, ?, ?, ?, ?, 1);

-- name: GetRegistration :one
SELECT * FROM asset_registrations WHERE request_id = ?;

-- name: CreateRegistration :exec
INSERT INTO asset_registrations (request_id, asset_id, facts_digest) VALUES (?, ?, ?);

-- name: GetReport :one
SELECT * FROM asset_reports WHERE report_id = ?;

-- name: CreateReport :exec
INSERT INTO asset_reports (report_id, asset_id, sequence, facts_digest) VALUES (?, ?, ?, ?);

-- name: RecordContact :exec
UPDATE entities
SET last_seen = sqlc.arg(received_at), link_state = 'healthy', version = version + 1, last_report_sequence = sqlc.arg(sequence)
WHERE id = sqlc.arg(id);

-- name: SetStatus :exec
UPDATE entities SET status = ?, status_reported_at = ? WHERE id = ?;

-- name: SetChangeSequence :exec
UPDATE entities SET change_sequence = sqlc.arg(sequence), created_sequence = COALESCE(created_sequence, sqlc.arg(sequence))
WHERE id = sqlc.arg(id);

-- name: SetComponents :exec
UPDATE entities
SET latitude = ?, longitude = ?, altitude_m = ?, speed_mps = ?, heading_deg = ?, battery_percent = ?, command_manifest = ?
WHERE id = ?;

-- name: ListEntitiesAtBaseline :many
SELECT * FROM entities WHERE created_sequence <= sqlc.arg(baseline) AND id > sqlc.arg(after_id) ORDER BY id LIMIT sqlc.arg(limit);

-- name: ListAssetAtBaseline :many
SELECT * FROM entities WHERE id = sqlc.arg(asset_id) AND created_sequence <= sqlc.arg(baseline)
AND id > sqlc.arg(after_id) ORDER BY id LIMIT sqlc.arg(limit);
