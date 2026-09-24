-- name: CreatePlugin :exec
INSERT INTO plugins (id, release, endpoint, dispatch_secret, installed_at) VALUES (?, ?, ?, ?, ?);

-- name: CreateCapability :exec
INSERT INTO plugin_capabilities (plugin_id, name, input_schema) VALUES (?, ?, ?);

-- name: GetPlugin :one
SELECT * FROM plugins WHERE id = ?;

-- name: ListPluginsAfter :many
SELECT * FROM plugins WHERE id > ? ORDER BY id LIMIT ?;

-- name: ListAllPlugins :many
SELECT * FROM plugins ORDER BY id;

-- name: ListCapabilities :many
SELECT * FROM plugin_capabilities WHERE plugin_id = ? ORDER BY name;

-- name: GetCapability :one
SELECT * FROM plugin_capabilities WHERE plugin_id = ? AND name = ?;
