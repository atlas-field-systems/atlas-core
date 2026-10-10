CREATE TABLE IF NOT EXISTS core_metadata (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), installation_format INTEGER NOT NULL DEFAULT 1, dataset_format INTEGER NOT NULL DEFAULT 1, installation_id TEXT NOT NULL DEFAULT '', dataset_id TEXT NOT NULL DEFAULT '', last_reset_id TEXT NOT NULL DEFAULT '', writing_release TEXT NOT NULL, dataset_fingerprint TEXT NOT NULL, installation_fingerprint TEXT NOT NULL, configuration TEXT NOT NULL DEFAULT '{}', commit_position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS core_changes (position INTEGER NOT NULL, item INTEGER NOT NULL, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(position,item));
CREATE TABLE IF NOT EXISTS core_activity (position INTEGER NOT NULL,item INTEGER NOT NULL, action_id TEXT NOT NULL,actor TEXT NOT NULL,actor_type TEXT NOT NULL,action TEXT NOT NULL,outcome TEXT NOT NULL,resources TEXT NOT NULL,occurred_at TEXT NOT NULL, PRIMARY KEY(position,item));
CREATE TABLE IF NOT EXISTS core_local_actions(action_id TEXT PRIMARY KEY);
