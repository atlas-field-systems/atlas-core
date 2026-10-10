-- name: ReadClaim :one
SELECT * FROM dataset_retry WHERE kind=? AND scope=? AND identity=?;
-- name: PutClaim :exec
INSERT INTO dataset_retry(kind,scope,identity,original,result_id) VALUES(?,?,?,?,?);
-- name: EndResult :exec
UPDATE dataset_retry SET ended=1 WHERE result_id=?;
-- name: ClearDataset :exec
DELETE FROM dataset_retry;
