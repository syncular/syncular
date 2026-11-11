-- listTodos reads one list at a time; this index lets SQLite search it.
CREATE INDEX idx_todos_list ON todos (list_id);
