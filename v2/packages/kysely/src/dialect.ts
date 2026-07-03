/**
 * `SyncularDialect` — a Kysely dialect that runs read-only SELECTs against
 * ANY syncular host through its `query(sql, params)` surface (SPEC B3: local
 * SQL is the read API). It reuses Kysely's built-in SQLite query compiler,
 * adapter, and introspector — the generated SQL is plain SQLite, which is
 * exactly what a `ClientDatabase` runs — and supplies only the driver.
 *
 * Placement rationale: this lives in its OWN package, never a subpath of
 * `@syncular-v2/web-client`, so Kysely (a real dependency, not just types)
 * stays entirely out of the client core's bundle. The core's bundle-entry
 * imports nothing from here, so the 72 KB own-JS budget is untouched by
 * construction.
 *
 * All-hosts proof: the driver targets `SyncularQuerySurface.query` — the one
 * method every host exposes (direct sync, worker/follower/Tauri/RN async).
 * It never touches `ClientDatabase`, so the handle hosts (which expose only
 * `query`, not a database) are first-class. Every result is `await`ed, so a
 * sync `query` (direct `SyncClient`) and an async one (a handle) both work.
 *
 * Read-only rule: the driver rejects any non-SELECT statement loudly
 * (`SyncularReadOnlyError`) — writes MUST go through `client.mutate()` for
 * the outbox (SPEC §7.1). Transactions are rejected too: a Kysely
 * transaction implies writes, and there is no write path here.
 */
import type {
  DatabaseConnection,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryResult,
} from 'kysely';
import {
  type CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';
import type { SyncularQuerySurface } from './query-surface';
import { assertReadOnly, SyncularReadOnlyError } from './read-only';

export interface SyncularDialectConfig {
  /**
   * The syncular client (or worker handle, follower, Tauri/RN bridge) to run
   * reads against. Only its `query(sql, params)` method is used.
   */
  readonly client: SyncularQuerySurface;
}

/** One read-only connection: it forwards SELECTs to the client's `query`. */
class SyncularConnection implements DatabaseConnection {
  readonly #client: SyncularQuerySurface;

  constructor(client: SyncularQuerySurface) {
    this.#client = client;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    assertReadOnly(compiledQuery.sql);
    const rows = await this.#client.query(
      compiledQuery.sql,
      compiledQuery.parameters as readonly (
        | string
        | number
        | bigint
        | boolean
        | Uint8Array
        | null
      )[],
    );
    return { rows: rows as unknown as R[] };
  }

  // Streaming is not supported over the RPC query surface — a read returns
  // its full result set. Kysely only calls this for `.stream()`, which the
  // typed read layer does not offer.
  // biome-ignore lint/correctness/useYield: this generator intentionally throws before yielding
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new SyncularReadOnlyError(
      'stream() is not supported by the syncular kysely read layer',
    );
  }
}

/**
 * The driver: one shared read-only connection (the client is already the
 * single-owner of its database). Transactions are rejected — there is no
 * write path, so a transaction can only be an attempt to write.
 */
class SyncularDriver implements Driver {
  readonly #connection: SyncularConnection;

  constructor(client: SyncularQuerySurface) {
    this.#connection = new SyncularConnection(client);
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.#connection;
  }

  async beginTransaction(): Promise<void> {
    throw new SyncularReadOnlyError(
      'transactions are not supported — the syncular kysely layer is ' +
        'read-only; use client.mutate() for atomic writes (SPEC §7.1)',
    );
  }

  async commitTransaction(): Promise<void> {
    throw new SyncularReadOnlyError('transactions are not supported');
  }

  async rollbackTransaction(): Promise<void> {
    throw new SyncularReadOnlyError('transactions are not supported');
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

export class SyncularDialect implements Dialect {
  readonly #client: SyncularQuerySurface;

  constructor(config: SyncularDialectConfig) {
    this.#client = config.client;
  }

  createDriver(): Driver {
    return new SyncularDriver(this.#client);
  }

  createQueryCompiler(): SqliteQueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  // biome-ignore lint/suspicious/noExplicitAny: matches Kysely's own Dialect signature
  createIntrospector(db: Kysely<any>): SqliteIntrospector {
    return new SqliteIntrospector(db);
  }
}
