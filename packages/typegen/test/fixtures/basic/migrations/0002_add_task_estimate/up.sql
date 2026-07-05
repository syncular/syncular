/* Schema version 2: estimates on tasks. */
ALTER TABLE tasks ADD COLUMN estimate FLOAT;
ALTER TABLE tasks ADD estimated_at BIGINT;

-- Local secondary indexes (CREATE INDEX subset): a plain index on the scope
-- column and a compound UNIQUE index across two columns.
CREATE INDEX idx_tasks_project ON tasks (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_project_title ON tasks (project_id, title);
