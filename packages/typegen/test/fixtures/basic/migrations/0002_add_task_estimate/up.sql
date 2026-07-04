/* Schema version 2: estimates on tasks. */
ALTER TABLE tasks ADD COLUMN estimate FLOAT;
ALTER TABLE tasks ADD estimated_at BIGINT;
