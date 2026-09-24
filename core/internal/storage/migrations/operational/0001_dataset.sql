CREATE TABLE dataset (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    id TEXT NOT NULL,
    writing_release TEXT NOT NULL
);
