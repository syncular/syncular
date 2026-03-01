/**
 * @syncular/client - Mutations API (Proxy-based, typed)
 *
 * Provides a dynamic `Proxy` mutation interface with Kysely typings:
 * - `mutations.tasks.insert({ ... })` (auto-generates id)
 * - `mutations.tasks.update(id, { ... })`
 * - `mutations.tasks.delete(id)`
 * - `mutations.$commit(async (tx) => { ... })` for batching
 *
 * Under the hood this compiles to sync `upsert/delete` operations.
 *
 * This module is framework-agnostic. `@syncular/client-react` wraps it to add
 * React state and automatic sync triggering.
 */

import type {
  ColumnCodecDialect,
  ColumnCodecSource,
  SyncOperation,
  SyncPushRequest,
  SyncPushResponse,
  SyncTransport,
} from '@syncular/core';
import {
  applyCodecsToDbRow,
  isRecord,
  randomId,
  toTableColumnCodecs,
} from '@syncular/core';
import type { Insertable, Kysely, Transaction, Updateable } from 'kysely';
import { sql } from 'kysely';
import { enqueueOutboxCommit } from './outbox';
import type {
  SyncClientLocalMutationArgs,
  SyncClientPlugin,
  SyncClientPluginContext,
} from './plugins/types';
import type { SyncClientDb } from './schema';

/**
 * Base type for any database schema.
 * Uses an index signature to support runtime-determined table names.
 */
type AnyDb = Record<string, Record<string, unknown>>;

type SyncOpKind = 'upsert' | 'delete';

type ReservedKeys = '$commit' | '$table';
type KnownKeys<T> = string extends keyof T ? never : keyof T & string;
type KnownTableKey<DB> = Exclude<KnownKeys<DB>, ReservedKeys>;

type InsertPayload<Row> =
  Insertable<Row> extends { id?: infer I }
    ? Omit<Insertable<Row>, 'id'> & { id?: I }
    : Insertable<Row>;

type UpdatePayload<Row> = Omit<Updateable<Row>, 'id'> & { id?: never };

type BaseVersionOptions = { baseVersion?: number | null };

export interface MutationReceipt {
  /**
   * Outbox commit id (when using outbox) or a generated id (when pushing directly).
   */
  commitId: string;
  /**
   * Protocol-level client commit id (sent to the server in push requests).
   */
  clientCommitId: string;
}

export interface OutboxCommitMeta {
  operations: SyncOperation[];
  localMutations: Array<{ table: string; rowId: string; op: SyncOpKind }>;
}

export interface PushCommitMeta {
  operations: SyncOperation[];
  localMutations: Array<{ table: string; rowId: string; op: SyncOpKind }>;
  response: SyncPushResponse;
}

export type TableMutations<DB, T extends keyof DB & string> = {
  insert: (
    values: InsertPayload<DB[T]>
  ) => Promise<MutationReceipt & { id: string }>;
  insertMany: (
    rows: Array<InsertPayload<DB[T]>>
  ) => Promise<MutationReceipt & { ids: string[] }>;
  update: (
    id: string,
    patch: UpdatePayload<DB[T]>,
    options?: BaseVersionOptions
  ) => Promise<MutationReceipt>;
  delete: (
    id: string,
    options?: BaseVersionOptions
  ) => Promise<MutationReceipt>;
  /**
   * Explicit upsert escape hatch. Prefer insert/update for clarity.
   */
  upsert: (
    id: string,
    patch: UpdatePayload<DB[T]>,
    options?: BaseVersionOptions
  ) => Promise<MutationReceipt>;
};

export type TableMutationsTx<DB, T extends keyof DB & string> = {
  insert: (values: InsertPayload<DB[T]>) => Promise<string>;
  insertMany: (rows: Array<InsertPayload<DB[T]>>) => Promise<string[]>;
  update: (
    id: string,
    patch: UpdatePayload<DB[T]>,
    options?: BaseVersionOptions
  ) => Promise<void>;
  delete: (id: string, options?: BaseVersionOptions) => Promise<void>;
  upsert: (
    id: string,
    patch: UpdatePayload<DB[T]>,
    options?: BaseVersionOptions
  ) => Promise<void>;
};

export type MutationsTx<DB> = {
  [T in KnownTableKey<DB>]: TableMutationsTx<DB, T>;
} & {
  // Index signature for dynamic access via Proxy
  [table: string]: TableMutationsTx<AnyDb, string>;
};

export type MutationsCommitFn<DB, Meta = unknown, Options = unknown> = <R>(
  fn: (tx: MutationsTx<DB>) => Promise<R> | R,
  options?: Options
) => Promise<{ result: R; receipt: MutationReceipt; meta: Meta }>;

export type MutationsApi<DB, CommitOptions = unknown> = {
  $commit: <R>(
    fn: (tx: MutationsTx<DB>) => Promise<R> | R,
    options?: CommitOptions
  ) => Promise<{ result: R; commit: MutationReceipt }>;
  $table: {
    <T extends KnownTableKey<DB>>(table: T): TableMutations<DB, T>;
    (table: string): TableMutations<AnyDb, string>;
  };
} & {
  [T in KnownTableKey<DB>]: TableMutations<DB, T>;
};

function sanitizePayload(
  payload: Record<string, unknown>,
  args: { omit: string[] }
): Record<string, unknown> {
  if (args.omit.length === 0) return payload;
  const omitSet = new Set(args.omit);
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (omitSet.has(k)) {
      changed = true;
      continue;
    }
    out[k] = v;
  }
  return changed ? out : payload;
}

function coerceBaseVersion(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return n;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.hasOwn(obj, key);
}

/**
 * Valid SQL identifier regex.
 * Allows: alphanumeric, underscore, cannot start with digit
 */
const VALID_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate table name to prevent SQL injection.
 * Table names are inserted directly into SQL, so they must be validated.
 */
function validateTableName(table: string): void {
  if (!VALID_IDENTIFIER_REGEX.test(table)) {
    throw new Error(
      `Invalid table name "${table}". Table names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`
    );
  }
}

/**
 * Internal helpers for dynamic table operations.
 *
 * Kysely's query builder is typed around compile-time table names. For the
 * Proxy-based mutations API, we need runtime table/column names. We use
 * Kysely's `sql` builder with strict identifier validation to avoid unsafe
 * `any`/`unknown` casts while keeping the public API typed.
 */
function validateColumnName(column: string): void {
  if (!VALID_IDENTIFIER_REGEX.test(column)) {
    throw new Error(
      `Invalid column name "${column}". Column names must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`
    );
  }
}

async function readBaseVersion<T>(args: {
  trx: Transaction<T>;
  table: string;
  rowId: string;
  idColumn: string;
  versionColumn: string;
}): Promise<number | null> {
  validateTableName(args.table);
  validateColumnName(args.idColumn);
  validateColumnName(args.versionColumn);

  const res = await sql<{ v: unknown }>`
    select ${sql.ref(args.versionColumn)} as v
    from ${sql.table(args.table)}
    where ${sql.ref(args.idColumn)} = ${sql.val(args.rowId)}
    limit 1
  `.execute(args.trx);

  return coerceBaseVersion(res.rows[0]?.v);
}

async function dynamicInsert<T>(
  trx: Transaction<T>,
  table: string,
  values: Record<string, unknown> | Record<string, unknown>[]
): Promise<void> {
  validateTableName(table);
  const rows = Array.isArray(values) ? values : [values];
  if (rows.length === 0) return;

  const columnsSet = new Set<string>();
  for (const row of rows) {
    for (const col of Object.keys(row)) {
      validateColumnName(col);
      columnsSet.add(col);
    }
  }

  const columns = Array.from(columnsSet);
  if (columns.length === 0) return;

  await sql`
    insert into ${sql.table(table)} (${sql.join(columns.map((c) => sql.ref(c)))})
    values ${sql.join(
      rows.map(
        (row) => sql`(${sql.join(columns.map((c) => sql.val(row[c] ?? null)))})`
      )
    )}
  `.execute(trx);
}

async function dynamicUpsert<T>(
  trx: Transaction<T>,
  table: string,
  idColumn: string,
  id: string,
  values: Record<string, unknown>
): Promise<void> {
  validateTableName(table);
  validateColumnName(idColumn);

  // Check if the row already exists
  const existing = await sql`
    select 1 from ${sql.table(table)}
    where ${sql.ref(idColumn)} = ${sql.val(id)}
    limit 1
  `.execute(trx);

  if (existing.rows.length > 0) {
    // Row exists: just update the provided columns
    await dynamicUpdate(trx, table, idColumn, id, values);
  } else {
    // Row doesn't exist: insert with all provided columns + id
    await dynamicInsert(trx, table, { ...values, [idColumn]: id });
  }
}

async function dynamicUpdate<T>(
  trx: Transaction<T>,
  table: string,
  idColumn: string,
  id: string,
  values: Record<string, unknown>
): Promise<void> {
  validateTableName(table);
  validateColumnName(idColumn);

  const setParts = Object.entries(values).map(([col, value]) => {
    validateColumnName(col);
    return sql`${sql.ref(col)} = ${sql.val(value)}`;
  });

  if (setParts.length === 0) return;

  await sql`
    update ${sql.table(table)}
    set ${sql.join(setParts)}
    where ${sql.ref(idColumn)} = ${sql.val(id)}
  `.execute(trx);
}

async function dynamicDelete<T>(
  trx: Transaction<T>,
  table: string,
  idColumn: string,
  id: string
): Promise<void> {
  validateTableName(table);
  validateColumnName(idColumn);
  await sql`
    delete from ${sql.table(table)}
    where ${sql.ref(idColumn)} = ${sql.val(id)}
  `.execute(trx);
}

export function createMutationsApi<DB, Meta = unknown, CommitOptions = unknown>(
  commit: MutationsCommitFn<DB, Meta, CommitOptions>
): MutationsApi<DB, CommitOptions> {
  const rootTableCache = new Map<string, any>();

  const apiBase = {
    $commit: async <R>(
      fn: (tx: MutationsTx<DB>) => Promise<R> | R,
      options?: CommitOptions
    ) => {
      const { result, receipt } = await commit(fn, options);
      return { result, commit: receipt };
    },
    $table: (table: string) => {
      const cached = rootTableCache.get(table);
      if (cached) return cached;

      const tableApi: TableMutations<any, any> = {
        async insert(values) {
          const { result, receipt } = await commit(
            async (tx) => await tx[table]!.insert(values)
          );
          return { ...receipt, id: result };
        },
        async insertMany(rows) {
          const { result, receipt } = await commit(
            async (tx) => await tx[table]!.insertMany(rows)
          );
          return { ...receipt, ids: result };
        },
        async update(id, patch, opts) {
          const { receipt } = await commit(async (tx) => {
            await tx[table]!.update(id, patch, opts);
            return null;
          });
          return receipt;
        },
        async delete(id, opts) {
          const { receipt } = await commit(async (tx) => {
            await tx[table]!.delete(id, opts);
            return null;
          });
          return receipt;
        },
        async upsert(id, patch, opts) {
          const { receipt } = await commit(async (tx) => {
            await tx[table]!.upsert(id, patch, opts);
            return null;
          });
          return receipt;
        },
      };

      rootTableCache.set(table, tableApi);
      return tableApi;
    },
  };

  return new Proxy(apiBase, {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop !== 'string') return undefined;
      if (hasOwn(target, prop)) {
        return (target as Record<string, unknown>)[prop];
      }
      return target.$table(prop);
    },
  }) as MutationsApi<DB, CommitOptions>;
}

export interface OutboxCommitConfig<DB extends SyncClientDb> {
  db: Kysely<DB>;
  idColumn?: string;
  versionColumn?: string | null;
  omitColumns?: string[];
  codecs?: ColumnCodecSource;
  codecDialect?: ColumnCodecDialect;
  plugins?: SyncClientPlugin[];
  actorId?: string;
  clientId?: string;
}

export function createOutboxCommit<DB extends SyncClientDb>(
  config: OutboxCommitConfig<DB>
): MutationsCommitFn<DB, OutboxCommitMeta, undefined> {
  const idColumn = config.idColumn ?? 'id';
  const versionColumn = config.versionColumn ?? 'server_version';
  const omitColumns = config.omitColumns ?? [];
  const codecDialect = config.codecDialect ?? 'sqlite';
  const sortedPlugins = sortPlugins(config.plugins ?? []);
  const pluginContext: SyncClientPluginContext = {
    actorId: config.actorId ?? 'unknown',
    clientId: config.clientId ?? 'unknown',
  };

  return async (fn) => {
    const operations: SyncOperation[] = [];
    const localMutations: Array<{
      table: string;
      rowId: string;
      op: SyncOpKind;
    }> = [];

    const transformLocalOperation = async (
      operation: SyncOperation
    ): Promise<SyncOperation> => {
      if (sortedPlugins.length === 0) return operation;

      const transformed = await runBeforeApplyLocalMutationsPlugins({
        plugins: sortedPlugins,
        ctx: pluginContext,
        operations: [operation],
      });

      if (transformed.length !== 1) {
        throw new Error(
          'beforeApplyLocalMutations must return exactly one operation per input operation'
        );
      }

      const [nextOperation] = transformed;
      if (!nextOperation) {
        throw new Error(
          'beforeApplyLocalMutations returned an empty operation'
        );
      }
      if (
        nextOperation.table !== operation.table ||
        nextOperation.row_id !== operation.row_id ||
        nextOperation.op !== operation.op
      ) {
        throw new Error(
          'beforeApplyLocalMutations cannot change operation table, row_id, or op'
        );
      }

      return nextOperation;
    };

    const { result, receipt } = await config.db
      .transaction()
      .execute(async (trx) => {
        const txTableCache = new Map<string, any>();
        const tableCodecCache = new Map<
          string,
          Map<string, ReturnType<typeof toTableColumnCodecs>>
        >();
        const resolveTableCodecs = (
          table: string,
          row: Record<string, unknown>
        ) => {
          const codecs = config.codecs;
          if (!codecs) return {};
          const columns = Object.keys(row);
          if (columns.length === 0) return {};

          let tableCache = tableCodecCache.get(table);
          if (!tableCache) {
            tableCache = new Map<
              string,
              ReturnType<typeof toTableColumnCodecs>
            >();
            tableCodecCache.set(table, tableCache);
          }

          const cacheKey = columns.slice().sort().join('\u0000');
          const cached = tableCache.get(cacheKey);
          if (cached) return cached;

          const resolved = toTableColumnCodecs(table, codecs, columns, {
            dialect: codecDialect,
          });
          tableCache.set(cacheKey, resolved);
          return resolved;
        };

        const makeTxTable = (table: string) => {
          const cached = txTableCache.get(table);
          if (cached) return cached;

          const tableApi: TableMutationsTx<any, any> = {
            async insert(values) {
              const raw = isRecord(values) ? values : {};
              const rawId = raw[idColumn];
              const id =
                typeof rawId === 'string' && rawId ? rawId : randomId();

              const row = { ...raw, [idColumn]: id };
              const payload = sanitizePayload(row, {
                omit: [
                  idColumn,
                  ...(versionColumn ? [versionColumn] : []),
                  ...omitColumns,
                ],
              });
              const localSanitized = sanitizePayload(row, {
                omit: [idColumn, ...(versionColumn ? [versionColumn] : [])],
              });
              const localOp = await transformLocalOperation({
                table,
                row_id: id,
                op: 'upsert',
                payload: localSanitized,
                base_version: null,
              });
              const localPayload = isRecord(localOp.payload)
                ? localOp.payload
                : {};
              const localRow = { ...localPayload, [idColumn]: id };
              const dbRow = applyCodecsToDbRow(
                localRow,
                resolveTableCodecs(table, localRow),
                codecDialect
              );

              await dynamicInsert(trx, table, dbRow);

              operations.push({
                table: table,
                row_id: id,
                op: 'upsert',
                payload,
                base_version: null,
              });

              localMutations.push({ table, rowId: id, op: 'upsert' });
              return id;
            },

            async insertMany(rows) {
              if (rows.length === 0) {
                throw new Error('insertMany requires at least one row');
              }
              const ids: string[] = [];
              const toInsert: Record<string, unknown>[] = [];
              const toLocalInsert: Record<string, unknown>[] = [];

              for (const values of rows) {
                const raw = isRecord(values) ? values : {};
                const rawId = raw[idColumn];
                const id =
                  typeof rawId === 'string' && rawId ? rawId : randomId();
                ids.push(id);
                toInsert.push({ ...raw, [idColumn]: id });
              }

              for (let i = 0; i < toInsert.length; i++) {
                const row = toInsert[i]!;
                const id = ids[i]!;
                const payload = sanitizePayload(row, {
                  omit: [
                    idColumn,
                    ...(versionColumn ? [versionColumn] : []),
                    ...omitColumns,
                  ],
                });
                const localSanitized = sanitizePayload(row, {
                  omit: [idColumn, ...(versionColumn ? [versionColumn] : [])],
                });
                const localOp = await transformLocalOperation({
                  table,
                  row_id: id,
                  op: 'upsert',
                  payload: localSanitized,
                  base_version: null,
                });
                const localPayload = isRecord(localOp.payload)
                  ? localOp.payload
                  : {};
                toLocalInsert.push({ ...localPayload, [idColumn]: id });

                operations.push({
                  table: table,
                  row_id: id,
                  op: 'upsert',
                  payload,
                  base_version: null,
                });

                localMutations.push({ table, rowId: id, op: 'upsert' });
              }

              const dbRows = toLocalInsert.map((row) =>
                applyCodecsToDbRow(
                  row,
                  resolveTableCodecs(table, row),
                  codecDialect
                )
              );

              if (dbRows.length > 0) {
                await dynamicInsert(trx, table, dbRows);
              }

              return ids;
            },

            async update(id, patch, opts) {
              const rawPatch = isRecord(patch) ? patch : {};
              const sanitized = sanitizePayload(rawPatch, {
                omit: [
                  idColumn,
                  ...(versionColumn ? [versionColumn] : []),
                  ...omitColumns,
                ],
              });
              const localSanitized = sanitizePayload(rawPatch, {
                omit: [idColumn, ...(versionColumn ? [versionColumn] : [])],
              });

              const hasExplicitBaseVersion =
                !!opts && hasOwn(opts, 'baseVersion');
              const localOp = await transformLocalOperation({
                table,
                row_id: id,
                op: 'upsert',
                payload: localSanitized,
                base_version: null,
              });
              const localPayload = isRecord(localOp.payload)
                ? localOp.payload
                : {};
              const dbPatch = applyCodecsToDbRow(
                localPayload,
                resolveTableCodecs(table, localPayload),
                codecDialect
              );

              await dynamicUpdate(trx, table, idColumn, id, dbPatch);

              const baseVersion = hasExplicitBaseVersion
                ? (opts!.baseVersion ?? null)
                : versionColumn
                  ? await readBaseVersion({
                      trx: trx,
                      table,
                      rowId: id,
                      idColumn,
                      versionColumn,
                    })
                  : null;

              operations.push({
                table: table,
                row_id: id,
                op: 'upsert',
                payload: sanitized,
                base_version: coerceBaseVersion(baseVersion),
              });

              localMutations.push({ table, rowId: id, op: 'upsert' });
            },

            async delete(id, opts) {
              const hasExplicitBaseVersion =
                !!opts && hasOwn(opts, 'baseVersion');
              const baseVersion = hasExplicitBaseVersion
                ? (opts!.baseVersion ?? null)
                : versionColumn
                  ? await readBaseVersion({
                      trx: trx,
                      table,
                      rowId: id,
                      idColumn,
                      versionColumn,
                    })
                  : null;

              await dynamicDelete(trx, table, idColumn, id);

              operations.push({
                table: table,
                row_id: id,
                op: 'delete',
                payload: null,
                base_version: coerceBaseVersion(baseVersion),
              });

              localMutations.push({ table, rowId: id, op: 'delete' });
            },

            async upsert(id, patch, opts) {
              const rawPatch = isRecord(patch) ? patch : {};
              const sanitized = sanitizePayload(rawPatch, {
                omit: [
                  idColumn,
                  ...(versionColumn ? [versionColumn] : []),
                  ...omitColumns,
                ],
              });
              const localSanitized = sanitizePayload(rawPatch, {
                omit: [idColumn, ...(versionColumn ? [versionColumn] : [])],
              });

              const hasExplicitBaseVersion =
                !!opts && hasOwn(opts, 'baseVersion');
              const localOp = await transformLocalOperation({
                table,
                row_id: id,
                op: 'upsert',
                payload: localSanitized,
                base_version: null,
              });
              const localPayload = isRecord(localOp.payload)
                ? localOp.payload
                : {};
              const dbPatch = applyCodecsToDbRow(
                localPayload,
                resolveTableCodecs(table, localPayload),
                codecDialect
              );

              await dynamicUpsert(trx, table, idColumn, id, dbPatch);

              const baseVersion = hasExplicitBaseVersion
                ? (opts!.baseVersion ?? null)
                : versionColumn
                  ? await readBaseVersion({
                      trx: trx,
                      table,
                      rowId: id,
                      idColumn,
                      versionColumn,
                    })
                  : null;

              operations.push({
                table: table,
                row_id: id,
                op: 'upsert',
                payload: sanitized,
                base_version: coerceBaseVersion(baseVersion),
              });

              localMutations.push({ table, rowId: id, op: 'upsert' });
            },
          };

          txTableCache.set(table, tableApi);
          return tableApi;
        };

        const txProxy = new Proxy(
          {},
          {
            get(_target, prop) {
              if (prop === 'then') return undefined;
              if (typeof prop !== 'string') return undefined;
              validateTableName(prop);
              return makeTxTable(prop);
            },
          }
        ) as MutationsTx<DB>;

        const result = await fn(txProxy);

        if (operations.length === 0) {
          throw new Error('No mutations were enqueued');
        }

        // Enqueue outbox commit within this transaction
        const receipt = await enqueueOutboxCommit(trx, { operations });
        return {
          result,
          receipt: { id: receipt.id, clientCommitId: receipt.clientCommitId },
        };
      });

    return {
      result,
      receipt: { commitId: receipt.id, clientCommitId: receipt.clientCommitId },
      meta: { operations, localMutations },
    };
  };
}

export function createOutboxMutations<DB extends SyncClientDb>(
  config: OutboxCommitConfig<DB>
): MutationsApi<DB, undefined> {
  return createMutationsApi(createOutboxCommit(config));
}

export interface PushCommitConfig {
  transport: SyncTransport;
  clientId: string;
  actorId?: string;
  plugins?: SyncClientPlugin[];
  idColumn?: string;
  versionColumn?: string | null;
  omitColumns?: string[];
  /** Client schema version (default: 1) */
  schemaVersion?: number;
  readBaseVersion?: (args: {
    table: string;
    rowId: string;
    idColumn: string;
    versionColumn: string;
  }) => Promise<number | null>;
}

function clonePushRequest(request: SyncPushRequest): SyncPushRequest {
  if (typeof structuredClone === 'function') return structuredClone(request);
  return JSON.parse(JSON.stringify(request)) as SyncPushRequest;
}

function cloneLocalMutationArgs(
  args: SyncClientLocalMutationArgs
): SyncClientLocalMutationArgs {
  if (typeof structuredClone === 'function') {
    return structuredClone(args);
  }
  return JSON.parse(JSON.stringify(args)) as SyncClientLocalMutationArgs;
}

function sortPlugins(plugins: readonly SyncClientPlugin[]): SyncClientPlugin[] {
  return [...plugins].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
}

async function runBeforeApplyLocalMutationsPlugins(args: {
  plugins: readonly SyncClientPlugin[];
  ctx: SyncClientPluginContext;
  operations: SyncOperation[];
}): Promise<SyncOperation[]> {
  if (args.plugins.length === 0) {
    return args.operations;
  }

  let transformedArgs: SyncClientLocalMutationArgs = cloneLocalMutationArgs({
    operations: args.operations,
  });

  for (const plugin of args.plugins) {
    if (!plugin.beforeApplyLocalMutations) continue;
    transformedArgs = await plugin.beforeApplyLocalMutations(
      args.ctx,
      transformedArgs
    );
  }

  return transformedArgs.operations;
}

export function createPushCommit<DB = AnyDb>(
  config: PushCommitConfig
): MutationsCommitFn<DB, PushCommitMeta, undefined> {
  const idColumn = config.idColumn ?? 'id';
  const versionColumn = config.versionColumn ?? 'server_version';
  const omitColumns = config.omitColumns ?? [];

  return async (fn) => {
    const operations: SyncOperation[] = [];
    const localMutations: Array<{
      table: string;
      rowId: string;
      op: SyncOpKind;
    }> = [];

    const txTableCache = new Map<string, any>();
    const makeTxTable = (table: string) => {
      const cached = txTableCache.get(table);
      if (cached) return cached;

      const tableApi: TableMutationsTx<any, any> = {
        async insert(values) {
          const raw = isRecord(values) ? values : {};
          const rawId = raw[idColumn];
          const id = typeof rawId === 'string' && rawId ? rawId : randomId();

          const row = { ...raw, [idColumn]: id } as Record<string, unknown>;

          const payload = sanitizePayload(row, {
            omit: [
              idColumn,
              ...(versionColumn ? [versionColumn] : []),
              ...omitColumns,
            ],
          });

          operations.push({
            table: table,
            row_id: id,
            op: 'upsert',
            payload,
            base_version: null,
          });

          localMutations.push({ table, rowId: id, op: 'upsert' });
          return id;
        },

        async insertMany(rows) {
          if (rows.length === 0) {
            throw new Error('insertMany requires at least one row');
          }
          const ids: string[] = [];
          const toUpsert: Record<string, unknown>[] = [];

          for (const values of rows) {
            const raw = isRecord(values) ? values : {};
            const rawId = raw[idColumn];
            const id = typeof rawId === 'string' && rawId ? rawId : randomId();
            ids.push(id);
            toUpsert.push({ ...raw, [idColumn]: id });
          }

          for (let i = 0; i < toUpsert.length; i++) {
            const row = toUpsert[i]!;
            const id = ids[i]!;
            const payload = sanitizePayload(row, {
              omit: [
                idColumn,
                ...(versionColumn ? [versionColumn] : []),
                ...omitColumns,
              ],
            });

            operations.push({
              table: table,
              row_id: id,
              op: 'upsert',
              payload,
              base_version: null,
            });

            localMutations.push({ table, rowId: id, op: 'upsert' });
          }

          return ids;
        },

        async update(id, patch, opts) {
          const rawPatch = isRecord(patch) ? patch : {};
          const sanitized = sanitizePayload(rawPatch, {
            omit: [
              idColumn,
              ...(versionColumn ? [versionColumn] : []),
              ...omitColumns,
            ],
          });

          const hasExplicitBaseVersion = !!opts && hasOwn(opts, 'baseVersion');
          const baseVersion = hasExplicitBaseVersion
            ? (opts!.baseVersion ?? null)
            : versionColumn && config.readBaseVersion
              ? await config.readBaseVersion({
                  table,
                  rowId: id,
                  idColumn,
                  versionColumn,
                })
              : null;

          operations.push({
            table: table,
            row_id: id,
            op: 'upsert',
            payload: sanitized,
            base_version: coerceBaseVersion(baseVersion),
          });

          localMutations.push({ table, rowId: id, op: 'upsert' });
        },

        async delete(id, opts) {
          const hasExplicitBaseVersion = !!opts && hasOwn(opts, 'baseVersion');
          const baseVersion = hasExplicitBaseVersion
            ? (opts!.baseVersion ?? null)
            : versionColumn && config.readBaseVersion
              ? await config.readBaseVersion({
                  table,
                  rowId: id,
                  idColumn,
                  versionColumn,
                })
              : null;

          operations.push({
            table: table,
            row_id: id,
            op: 'delete',
            payload: null,
            base_version: coerceBaseVersion(baseVersion),
          });

          localMutations.push({ table, rowId: id, op: 'delete' });
        },

        async upsert(id, patch, opts) {
          await tableApi.update(id, patch, opts);
        },
      };

      txTableCache.set(table, tableApi);
      return tableApi;
    };

    const txProxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return undefined;
          if (typeof prop !== 'string') return undefined;
          validateTableName(prop);
          return makeTxTable(prop);
        },
      }
    ) as MutationsTx<DB>;

    const result = await fn(txProxy);

    if (operations.length === 0) {
      throw new Error('No mutations were enqueued');
    }

    const commitId = randomId();
    const clientCommitId = randomId();

    const request: SyncPushRequest = {
      clientId: config.clientId,
      clientCommitId,
      operations,
      schemaVersion: config.schemaVersion ?? 1,
    };

    const plugins = config.plugins ?? [];
    const sortedPlugins = sortPlugins(plugins);
    const ctx: SyncClientPluginContext = {
      actorId: config.actorId ?? 'unknown',
      clientId: config.clientId,
    };

    let requestToSend = request;
    if (sortedPlugins.length > 0) {
      requestToSend = clonePushRequest(request);
      for (const plugin of sortedPlugins) {
        if (!plugin.beforePush) continue;
        requestToSend = await plugin.beforePush(ctx, requestToSend);
      }
    }

    const combined = await config.transport.sync({
      clientId: requestToSend.clientId,
      push: {
        clientCommitId: requestToSend.clientCommitId,
        operations: requestToSend.operations,
        schemaVersion: requestToSend.schemaVersion,
      },
    });
    if (!combined.push) {
      throw new Error('Server returned no push response');
    }
    const rawResponse = combined.push;

    let response = rawResponse;
    if (sortedPlugins.length > 0) {
      // Run afterPush in reverse priority order (higher numbers first)
      for (const plugin of [...sortedPlugins].reverse()) {
        if (!plugin.afterPush) continue;
        response = await plugin.afterPush(ctx, {
          request: requestToSend,
          response,
        });
      }
    }

    if (response.status !== 'applied' && response.status !== 'cached') {
      const conflictCount = response.results.filter(
        (r) => r.status === 'conflict'
      ).length;
      const errorCount = response.results.filter(
        (r) => r.status === 'error'
      ).length;
      throw new Error(
        `Push rejected (${conflictCount} conflicts, ${errorCount} errors)`
      );
    }

    return {
      result,
      receipt: { commitId, clientCommitId },
      meta: { operations, localMutations, response },
    };
  };
}

export function createPushMutations<DB = AnyDb>(
  config: PushCommitConfig
): MutationsApi<DB, undefined> {
  return createMutationsApi(createPushCommit(config));
}
