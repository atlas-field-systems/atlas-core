CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,submission_sequence INTEGER NOT NULL,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_queues(asset_id TEXT PRIMARY KEY,value TEXT NOT NULL,next_sequence INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS task_report_order(task_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,sequence TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_execution_evidence(task_id TEXT NOT NULL,identity TEXT NOT NULL,original TEXT NOT NULL,PRIMARY KEY(task_id,identity));
