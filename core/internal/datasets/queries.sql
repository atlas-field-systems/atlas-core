-- name: GetDataset :one
SELECT id, writing_release FROM dataset WHERE singleton = 1;

-- name: CreateDataset :exec
INSERT INTO dataset (singleton, id, writing_release) VALUES (1, ?, ?);
