-- Native/Rust query-codegen fidelity for bool, exact i64, float, and JSON.
SELECT id, done, priority, estimate, meta
FROM tasks
WHERE id = :id;
