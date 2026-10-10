-- name: GetInstallation :one
SELECT installation_id, installation_format, installation_fingerprint, token_key, created_at
FROM installation WHERE singleton = 1;

-- name: InsertInstallation :exec
INSERT INTO installation (singleton, installation_id, installation_format, installation_fingerprint, token_key, created_at)
VALUES (1, ?, ?, ?, ?, ?);

-- name: GetDatasetMetadata :one
SELECT dataset_id, dataset_format, dataset_fingerprint, writing_release, reset_id, established_at
FROM dataset_metadata WHERE singleton = 1;

-- name: ReplaceDatasetMetadata :exec
INSERT OR REPLACE INTO dataset_metadata (singleton, dataset_id, dataset_format, dataset_fingerprint, writing_release, reset_id, established_at)
VALUES (1, ?, ?, ?, ?, ?, ?);

-- name: LastCommit :one
SELECT CAST(COALESCE(MAX(seq), 0) AS INTEGER) AS seq FROM commits;

-- name: InsertCommit :exec
INSERT INTO commits (seq, committed_at, operation) VALUES (?, ?, ?);

-- name: InsertChange :exec
INSERT INTO changes (commit_seq, ordinal, resource_kind, resource_id, version, deleted, image)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: InsertActivity :execrows
INSERT INTO activity (action_id, commit_seq, actor_kind, actor_id, actor_display, action, target_kind, target_id, occurred_at, outcome, summary)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (action_id) DO NOTHING;

-- name: ListActivity :many
SELECT action_id, commit_seq, actor_kind, actor_id, actor_display, action, target_kind, target_id, occurred_at, outcome, summary
FROM activity ORDER BY commit_seq, action_id;

-- name: GetClaim :one
SELECT kind, identity, facts, result, result_ref, commit_seq, ended_at
FROM retry_claims WHERE kind = ? AND identity = ?;

-- name: InsertClaim :exec
INSERT INTO retry_claims (kind, identity, facts, result, result_ref, commit_seq, ended_at)
VALUES (?, ?, ?, ?, ?, ?, NULL);

-- name: EndClaims :exec
UPDATE retry_claims SET ended_at = ? WHERE kind = ? AND result_ref = ? AND ended_at IS NULL;

-- name: ClearCommits :exec
DELETE FROM commits;

-- name: ClearChanges :exec
DELETE FROM changes;

-- name: ClearActivity :exec
DELETE FROM activity;

-- name: ClearClaims :exec
DELETE FROM retry_claims;
