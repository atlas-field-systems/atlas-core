-- Cancellation retains the last acknowledged or started execution report.
ALTER TABLE tasks ADD COLUMN execution_status TEXT;
UPDATE tasks SET execution_status = status WHERE status IN ('acknowledged', 'in_progress');
