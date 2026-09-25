-- Integration credentials of managed Plugins; only verifiers are stored.
CREATE TABLE plugin_keys (
    plugin_id TEXT PRIMARY KEY,
    verifier BLOB NOT NULL UNIQUE,
    revoked BOOLEAN NOT NULL DEFAULT FALSE
);

-- The verifier of the secret local management presents to Core.
CREATE TABLE management_secret (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    verifier BLOB NOT NULL
);

-- Installed Plugins, as declared by their manifests.
CREATE TABLE plugins (
    id TEXT PRIMARY KEY,
    release TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    -- Core presents this to the Plugin container. It grants nothing in Core,
    -- so it is kept in plaintext for Core to send.
    dispatch_secret TEXT NOT NULL,
    installed_at INTEGER NOT NULL
);

CREATE TABLE plugin_capabilities (
    plugin_id TEXT NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    -- The manifest's JSON Schema for Operation input, applied as declared.
    input_schema TEXT NOT NULL,
    PRIMARY KEY (plugin_id, name)
);
