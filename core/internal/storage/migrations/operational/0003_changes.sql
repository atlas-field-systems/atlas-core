-- created_sequence places an Entity in snapshots taken at or after its
-- creation; change_sequence is the change that produced its current state.
ALTER TABLE entities ADD COLUMN created_sequence INTEGER;
ALTER TABLE entities ADD COLUMN change_sequence INTEGER NOT NULL DEFAULT 0;

-- The retained change log that replay and the feed read. Each row keeps the
-- Entity exactly as committed, because replay must return past states rather
-- than the current one. Older rows are pruned to a configured length.
CREATE TABLE changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'update')),
    entity TEXT NOT NULL
);
