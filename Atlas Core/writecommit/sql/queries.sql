-- name: ReadMetadata :one
SELECT * FROM core_metadata WHERE singleton=1;
-- name: InsertMetadata :exec
INSERT INTO core_metadata(singleton,writing_release,dataset_fingerprint,installation_fingerprint) VALUES(1,?,?,?);
-- name: EstablishSetup :exec
UPDATE core_metadata SET installation_id=?,dataset_id=?,configuration=? WHERE singleton=1;
-- name: EstablishReset :exec
UPDATE core_metadata SET dataset_id=?,last_reset_id=?,commit_position=0 WHERE singleton=1;
-- name: SetPosition :exec
UPDATE core_metadata SET commit_position=? WHERE singleton=1;
-- name: RecordChange :exec
INSERT INTO core_changes(position,item,resource_kind,resource_id,value) VALUES(?,?,?,?,?);
-- name: RecordActivity :exec
INSERT INTO core_activity(position,item,action_id,actor,actor_type,action,outcome,resources,occurred_at) VALUES(?,?,?,?,?,?,?,?,?);
-- name: ClearChanges :exec
DELETE FROM core_changes;
-- name: ClearActivity :exec
DELETE FROM core_activity;
-- name: ReadLocalAction :one
SELECT action_id FROM core_local_actions WHERE action_id=?;
-- name: PutLocalAction :exec
INSERT INTO core_local_actions(action_id) VALUES(?);
-- name: ClearLocalActions :exec
DELETE FROM core_local_actions;
-- name: CountChanges :one
SELECT COUNT(*) FROM core_changes;
-- name: CountActivity :one
SELECT COUNT(*) FROM core_activity;

-- name: ReadActivityFacts :many
SELECT action_id,actor,actor_type,action,outcome,resources,occurred_at FROM core_activity ORDER BY position,item;
