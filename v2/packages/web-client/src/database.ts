/**
 * Storage abstraction (REVISE B3): the client core runs on any SQLite that
 * implements this minimal synchronous surface. Tests use bun:sqlite
 * (`./bun-database`); browsers use sqlite-wasm + OPFS (`./wasm-database`).
 * Methods are synchronous because both backends execute synchronously once
 * open — only opening a database is async, which lives in the factories.
 */
export type SqlValue = string | number | bigint | boolean | Uint8Array | null;

export type SqlRow = Record<string, SqlValue>;

export interface ClientDatabase {
  /** Execute a single statement (no result rows). */
  exec(sql: string, params?: readonly SqlValue[]): void;
  /** Execute a single statement and return its rows as objects. */
  query(sql: string, params?: readonly SqlValue[]): SqlRow[];
  /**
   * Run `fn` atomically. Nested calls are savepoints: an inner failure
   * rolls back only the inner scope.
   */
  transaction<T>(fn: () => T): T;
  /**
   * Optional sqlite-image capability (SPEC §5.3): expose `bytes` as an
   * attached read-only database schema named `alias` for the duration of
   * `fn`, then detach. Presence of this method is what makes the client
   * advertise `accept` bit 2 (§4.2). MUST be called outside any open
   * transaction (SQLite cannot ATTACH inside one); `fn` may open its own.
   */
  withSqliteImage?<T>(bytes: Uint8Array, alias: string, fn: () => T): T;
  close(): void;
}

/** Attach-schema aliases are code-chosen, never user input — enforce it. */
export function assertImageAlias(alias: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`invalid sqlite-image alias ${JSON.stringify(alias)}`);
  }
}

/**
 * Savepoint-based transaction helper shared by database implementations.
 * `run` executes a parameterless statement.
 */
export function runTransaction<T>(
  depthHolder: { depth: number },
  run: (sql: string) => void,
  fn: () => T,
): T {
  const depth = depthHolder.depth;
  const savepoint = `syncular_sp_${depth}`;
  if (depth === 0) run('BEGIN');
  else run(`SAVEPOINT ${savepoint}`);
  depthHolder.depth = depth + 1;
  try {
    const result = fn();
    depthHolder.depth = depth;
    if (depth === 0) run('COMMIT');
    else run(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    depthHolder.depth = depth;
    if (depth === 0) {
      run('ROLLBACK');
    } else {
      run(`ROLLBACK TO ${savepoint}`);
      run(`RELEASE ${savepoint}`);
    }
    throw error;
  }
}
