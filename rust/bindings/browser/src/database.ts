import {
  applyCodecsToDbRow,
  type BlobRef,
  type ColumnCodecDialect,
  type ColumnCodecSource,
  createColumnCodecsPlugin,
  createTableColumnCodecsResolver,
  randomId,
  type SyncOperation,
} from '@syncular/core';
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  Kysely,
  CompiledQuery as KyselyCompiledQuery,
  type QueryResult,
} from 'kysely';
import { BaseSqliteDialect, BaseSqliteDriver } from 'kysely-generic-sqlite';
import {
  createMutationsApi,
  type MutationsApi,
  type MutationsCommitFn,
  type MutationsTx,
} from './mutations';
import { assertSyncularV2ReadonlySql } from './sql-safety';
import type {
  CreateSyncularV2DatabaseOptions,
  SyncularV2Blobs,
  SyncularV2BlobStoreOptions,
  SyncularV2Client,
  SyncularV2CrdtYjsFieldConfig,
  SyncularV2LiveQueries,
  SyncularV2LiveQueryEvent,
  SyncularV2LiveQueryOptions,
  SyncularV2LiveQuerySubscription,
  SyncularV2SqlClient,
  SyncularV2TableConfigMap,
  SyncularV2UnsafeSqlClient,
} from './types';
import { createSyncularV2WorkerClient } from './worker-client';

type SyncularV2DriverClient = SyncularV2Client &
  Partial<SyncularV2UnsafeSqlClient>;
type SyncularV2ConnectionClient = SyncularV2SqlClient &
  Partial<SyncularV2UnsafeSqlClient>;

export interface SyncularV2Dialect extends Dialect, SyncularV2LiveQueries {
  destroyLiveQueries(): Promise<void>;
}

export interface SyncularV2DialectOptions {
  appTables?: readonly string[];
  unsafeWrites?: boolean;
}

export interface SyncularV2Database<DB> extends SyncularV2LiveQueries {
  db: Kysely<DB>;
  client: SyncularV2Client;
  dialect: SyncularV2Dialect;
  mutations: MutationsApi<DB, undefined>;
  blobs: SyncularV2Blobs;
  close(): Promise<void>;
}

export async function withSyncularV2SchemaWrites<DB, Result>(
  database: Pick<SyncularV2Database<DB>, 'client'>,
  callback: (db: Kysely<any>) => Promise<Result>
): Promise<Result> {
  const client = assertUnsafeSqlClient(database.client);
  const dialect = createSyncularV2Dialect(client, { unsafeWrites: true });
  const db = new Kysely<any>({ dialect });
  try {
    return await callback(db);
  } finally {
    await dialect.destroyLiveQueries();
    await db.destroy();
  }
}

export interface SyncularV2MutationsMeta {
  operations: SyncOperation[];
  localMutations: Array<{
    table: string;
    rowId: string;
    op: 'upsert' | 'delete';
  }>;
  clientCommitIds: string[];
}

export interface SyncularV2MutationsOptions {
  client: Pick<
    SyncularV2Client,
    | 'applyLocalOperation'
    | 'applyLocalOperationsBatch'
    | 'applyLocalOperationsCommit'
    | 'applyYjsEnvelopeToPayload'
    | 'executeSql'
  >;
  codecs?: ColumnCodecSource;
  codecDialect?: ColumnCodecDialect;
  idColumn?: string;
  versionColumn?: string | null;
  omitColumns?: string[];
  tableConfig?: SyncularV2TableConfigMap;
  readBaseVersion?: (args: {
    table: string;
    rowId: string;
    idColumn: string;
    versionColumn: string;
  }) => Promise<number | null>;
  afterCommit?: (meta: SyncularV2MutationsMeta) => void | Promise<void>;
}

export type CreateSyncularRustSqliteDatabaseOptions =
  CreateSyncularV2DatabaseOptions;
export type SyncularRustSqliteDatabase<DB> = SyncularV2Database<DB>;

export async function createSyncularV2Database<DB>(
  options: CreateSyncularV2DatabaseOptions
): Promise<SyncularV2Database<DB>> {
  const client = await createSyncularV2WorkerClient(options);
  const dialect = createSyncularV2Dialect(client, {
    appTables: options.appTables,
  });
  const db = new Kysely<DB>({
    dialect,
    plugins: options.codecs
      ? [
          createColumnCodecsPlugin({
            codecs: options.codecs,
            dialect: 'sqlite',
          }),
        ]
      : undefined,
  });
  let closed = false;
  const mutationSyncScheduler = createMutationSyncScheduler(client, {
    enabled: options.sync?.autoSyncAfterMutation ?? true,
    debounceMs: options.sync?.mutationSyncDebounceMs ?? 10,
    isClosed: () => closed,
  });
  const blobUploadScheduler = createBlobUploadScheduler(client, {
    enabled: options.sync?.autoProcessBlobUploadsAfterStore ?? false,
    debounceMs: options.sync?.blobUploadDebounceMs ?? 10,
    isClosed: () => closed,
  });
  const mutations = createSyncularV2Mutations<DB>({
    client,
    codecs: options.codecs,
    codecDialect: 'sqlite',
    tableConfig: options.tableConfig,
    readBaseVersion: (args) => readCurrentBaseVersion(client, args),
    afterCommit: () => mutationSyncScheduler.schedule(),
  });
  const blobs = createSyncularV2BlobClient(client, {
    afterStore: ({ options }) => {
      if (options?.immediate) return;
      blobUploadScheduler.schedule();
    },
  });

  return {
    db,
    client,
    dialect,
    mutations,
    blobs,
    live: (query, liveOptions) => dialect.live(query, liveOptions),
    async close() {
      if (closed) return;
      closed = true;
      mutationSyncScheduler.destroy();
      blobUploadScheduler.destroy();
      try {
        await dialect.destroyLiveQueries();
        await db.destroy();
      } finally {
        await client.close();
      }
    },
  };
}

export const createSyncularRustSqliteDatabase = createSyncularV2Database;

function createMutationSyncScheduler(
  client: Pick<SyncularV2Client, 'syncOnce'>,
  options: {
    enabled: boolean;
    debounceMs: number | false;
    isClosed: () => boolean;
  }
): { schedule(): void; destroy(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let queued = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const run = async () => {
    if (options.isClosed()) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = client
      .syncOnce()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
        if (queued && !options.isClosed()) {
          queued = false;
          schedule();
        }
      });
    await inFlight;
  };
  const schedule = () => {
    if (!options.enabled || options.isClosed()) return;
    if (inFlight) {
      queued = true;
      return;
    }
    clear();
    if (options.debounceMs === false || options.debounceMs <= 0) {
      queueMicrotask(() => void run());
      return;
    }
    timer = setTimeout(() => void run(), options.debounceMs);
  };
  return {
    schedule,
    destroy() {
      clear();
      queued = false;
    },
  };
}

function createBlobUploadScheduler(
  client: Pick<SyncularV2Client, 'processBlobUploadQueue'>,
  options: {
    enabled: boolean;
    debounceMs: number | false;
    isClosed: () => boolean;
  }
): { schedule(): void; destroy(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let queued = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const run = async () => {
    if (options.isClosed()) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = client
      .processBlobUploadQueue()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        inFlight = undefined;
        if (queued && !options.isClosed()) {
          queued = false;
          schedule();
        }
      });
    await inFlight;
  };
  const schedule = () => {
    if (!options.enabled || options.isClosed()) return;
    if (inFlight) {
      queued = true;
      return;
    }
    clear();
    if (options.debounceMs === false || options.debounceMs <= 0) {
      queueMicrotask(() => void run());
      return;
    }
    timer = setTimeout(() => void run(), options.debounceMs);
  };
  return {
    schedule,
    destroy() {
      clear();
      queued = false;
    },
  };
}

export function createSyncularV2BlobClient(
  client: Pick<
    SyncularV2Client,
    | 'storeBlob'
    | 'retrieveBlob'
    | 'isBlobLocal'
    | 'processBlobUploadQueue'
    | 'blobUploadQueueStats'
    | 'blobCacheStats'
    | 'pruneBlobCache'
    | 'clearBlobCache'
  >,
  hooks: {
    afterStore?: (args: {
      ref: BlobRef;
      options?: SyncularV2BlobStoreOptions;
    }) => void | Promise<void>;
  } = {}
): SyncularV2Blobs {
  return {
    async store(data, storeOptions) {
      const ref = await client.storeBlob(await toUint8Array(data), storeOptions);
      await hooks.afterStore?.({
        ref,
        ...(storeOptions === undefined ? {} : { options: storeOptions }),
      });
      return ref;
    },
    retrieve(ref) {
      return client.retrieveBlob(ref);
    },
    isLocal(hash) {
      return client.isBlobLocal(hash);
    },
    async preload(refs) {
      await Promise.all(refs.map((ref) => client.retrieveBlob(ref)));
    },
    processUploadQueue() {
      return client.processBlobUploadQueue();
    },
    getUploadQueueStats() {
      return client.blobUploadQueueStats();
    },
    getCacheStats() {
      return client.blobCacheStats();
    },
    pruneCache(maxBytes) {
      return client.pruneBlobCache(maxBytes);
    },
    clearCache() {
      return client.clearBlobCache();
    },
  };
}

export function createSyncularV2Dialect(
  client: SyncularV2Client,
  options: SyncularV2DialectOptions = {}
): SyncularV2Dialect {
  const driver = new SyncularV2Driver(client, options);
  const dialect = new BaseSqliteDialect(() => driver) as SyncularV2Dialect;
  dialect.live = (query, liveOptions) => driver.live(query, liveOptions);
  dialect.destroyLiveQueries = () => driver.destroy();
  return dialect;
}

export function createSyncularV2Mutations<DB>(
  options: SyncularV2MutationsOptions
): MutationsApi<DB, undefined> {
  return createMutationsApi(createSyncularV2Commit<DB>(options));
}

export function createSyncularV2Commit<DB>(
  options: SyncularV2MutationsOptions
): MutationsCommitFn<DB, SyncularV2MutationsMeta, undefined> {
  const idColumn = options.idColumn ?? 'id';
  const versionColumn = options.versionColumn ?? 'server_version';
  const omitColumns = options.omitColumns ?? [];
  const codecDialect = options.codecDialect ?? 'sqlite';
  const resolveTableCodecs = createTableColumnCodecsResolver(options.codecs, {
    dialect: codecDialect,
  });

  return async (fn) => {
    const operations: SyncOperation[] = [];
    const batch: Array<{
      operation: SyncOperation;
      localRow?: unknown | null;
    }> = [];
    const localMutations: SyncularV2MutationsMeta['localMutations'] = [];
    const txTableCache = new Map<string, unknown>();

    const makeTxTable = (table: string) => {
      const cached = txTableCache.get(table);
      if (cached) return cached;
      const tableConfig = options.tableConfig?.[table];
      const tableIdColumn = tableConfig?.primaryKeyColumn ?? idColumn;
      const tableVersionColumn =
        tableConfig?.serverVersionColumn === undefined
          ? versionColumn
          : tableConfig.serverVersionColumn;
      const softDeleteColumn = tableConfig?.softDeleteColumn ?? null;
      const crdtYjsFields = serverMergeCrdtYjsFields(
        tableConfig?.crdtYjsFields ?? []
      );

      const prepareInsert = async (values: unknown) => {
        const raw = objectRecord(values);
        const rawId = raw[tableIdColumn];
        const id = typeof rawId === 'string' && rawId ? rawId : randomId();
        const row = { ...raw, [tableIdColumn]: id };
        const payload = sanitizeOperationPayload(row, {
          omit: [
            tableIdColumn,
            ...(tableVersionColumn ? [tableVersionColumn] : []),
            ...omitColumns,
          ],
        });
        const syncPayload = stripCrdtYjsMaterializedPayloadFields(
          payload,
          crdtYjsFields
        );
        const localPayload = sanitizeOperationPayload(row, {
          omit: [
            tableIdColumn,
            ...(tableVersionColumn ? [tableVersionColumn] : []),
          ],
        });
        const transformedLocalPayload = await transformCrdtYjsMutationPayload({
          client: options.client,
          table,
          rowId: id,
          payload: localPayload,
          crdtYjsFields,
        });
        const localDbPayload = applyCodecsToDbRow(
          transformedLocalPayload,
          resolveTableCodecs(table, transformedLocalPayload),
          codecDialect
        );
        const operation: SyncOperation = {
          table,
          row_id: id,
          op: 'upsert',
          payload: syncPayload,
          base_version: null,
        };
        return {
          id,
          operation,
          localRow: { ...localDbPayload, [tableIdColumn]: id },
        };
      };

      const tableApi = {
        async insert(values: unknown) {
          const prepared = await prepareInsert(values);
          const { id, operation, localRow } = prepared;
          operations.push(operation);
          batch.push({ operation, localRow });
          localMutations.push({ table, rowId: id, op: 'upsert' });
          return id;
        },
        async insertMany(rows: unknown[]) {
          if (rows.length === 0) {
            throw new Error('insertMany requires at least one row');
          }
          const ids: string[] = [];
          for (const row of rows) {
            const { id, operation, localRow } = await prepareInsert(row);
            ids.push(id);
            operations.push(operation);
            batch.push({ operation, localRow });
            localMutations.push({ table, rowId: id, op: 'upsert' });
          }
          return ids;
        },
        async update(
          id: string,
          patch: unknown,
          opts?: { baseVersion?: number | null }
        ) {
          await tableApi.upsert(id, patch, opts);
        },
        async delete(id: string, opts?: { baseVersion?: number | null }) {
          const baseVersion = await resolveBaseVersion({
            options,
            table,
            rowId: id,
            idColumn: tableIdColumn,
            versionColumn: tableVersionColumn,
            explicit: opts?.baseVersion,
          });
          if (softDeleteColumn) {
            const payload = { [softDeleteColumn]: 1 };
            const localDbPayload = applyCodecsToDbRow(
              payload,
              resolveTableCodecs(table, payload),
              codecDialect
            );
            const operation: SyncOperation = {
              table,
              row_id: id,
              op: 'upsert',
              payload,
              base_version: baseVersion,
            };
            operations.push(operation);
            batch.push({
              operation,
              localRow: { ...localDbPayload, [tableIdColumn]: id },
            });
            localMutations.push({ table, rowId: id, op: 'upsert' });
            return;
          }
          const operation: SyncOperation = {
            table,
            row_id: id,
            op: 'delete',
            payload: null,
            base_version: baseVersion,
          };
          operations.push(operation);
          batch.push({ operation, localRow: null });
          localMutations.push({ table, rowId: id, op: 'delete' });
        },
        async upsert(
          id: string,
          patch: unknown,
          opts?: { baseVersion?: number | null }
        ) {
          const rawPatch = objectRecord(patch);
          const payload = sanitizeOperationPayload(rawPatch, {
            omit: [
              tableIdColumn,
              ...(tableVersionColumn ? [tableVersionColumn] : []),
              ...omitColumns,
            ],
          });
          const syncPayload = stripCrdtYjsMaterializedPayloadFields(
            payload,
            crdtYjsFields
          );
          const localPayload = sanitizeOperationPayload(rawPatch, {
            omit: [
              tableIdColumn,
              ...(tableVersionColumn ? [tableVersionColumn] : []),
            ],
          });
          const existingRow = await readCrdtYjsExistingRow({
            client: options.client,
            table,
            rowId: id,
            idColumn: tableIdColumn,
            crdtYjsFields,
          });
          const transformedLocalPayload = await transformCrdtYjsMutationPayload(
            {
              client: options.client,
              table,
              rowId: id,
              payload: localPayload,
              existingRow,
              crdtYjsFields,
            }
          );
          const localDbPayload = applyCodecsToDbRow(
            transformedLocalPayload,
            resolveTableCodecs(table, transformedLocalPayload),
            codecDialect
          );
          const operation: SyncOperation = {
            table,
            row_id: id,
            op: 'upsert',
            payload: syncPayload,
            base_version: await resolveBaseVersion({
              options,
              table,
              rowId: id,
              idColumn: tableIdColumn,
              versionColumn: tableVersionColumn,
              explicit: opts?.baseVersion,
            }),
          };
          operations.push(operation);
          batch.push({
            operation,
            localRow: { ...localDbPayload, [tableIdColumn]: id },
          });
          localMutations.push({ table, rowId: id, op: 'upsert' });
        },
      };

      txTableCache.set(table, tableApi);
      return tableApi;
    };

    const tx = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return undefined;
          if (typeof prop !== 'string') return undefined;
          return makeTxTable(prop);
        },
      }
    );

    const result = await fn(tx as MutationsTx<DB>);
    if (operations.length === 0) throw new Error('No mutations were enqueued');
    const clientCommitId =
      await options.client.applyLocalOperationsCommit(batch);
    const meta = {
      operations,
      localMutations,
      clientCommitIds: [clientCommitId],
    };
    await options.afterCommit?.(meta);
    return {
      result,
      receipt: { commitId: clientCommitId, clientCommitId },
      meta,
    };
  };
}

class SyncularV2Driver extends BaseSqliteDriver {
  #listeners = new Map<
    string,
    (event: SyncularV2LiveQueryEvent<Record<string, unknown>>) => void
  >();
  readonly #appTables: Set<string> | undefined;

  constructor(
    private readonly client: SyncularV2DriverClient,
    options: SyncularV2DialectOptions = {}
  ) {
    super(async () => {
      this.conn = new SyncularV2Connection(
        client,
        options.unsafeWrites ?? false
      );
    });
    this.#appTables =
      options.appTables == null
        ? undefined
        : new Set(normalizeLiveQueryTables(options.appTables));
  }

  async live<Row extends Record<string, unknown>>(
    query: { compile(): CompiledQuery },
    options: SyncularV2LiveQueryOptions<Row>
  ): Promise<SyncularV2LiveQuerySubscription> {
    const compiled = query.compile();
    const tables = normalizeLiveQueryTables(
      options.tables ?? inferTablesFromCompiledQuery(compiled, this.#appTables),
      this.#appTables
    );
    if (tables.length === 0) {
      throw new Error(
        'Could not infer live query table dependencies. Pass { tables: [...] } explicitly.'
      );
    }
    const snapshot = await this.client.subscribeQuery<Row>(
      compiled.sql,
      compiled.parameters,
      tables
    );
    const listener = (
      event: SyncularV2LiveQueryEvent<Record<string, unknown>>
    ) => {
      const typed = event as SyncularV2LiveQueryEvent<Row>;
      options.onChange(typed.rows, { ...typed, initial: false });
    };
    this.#listeners.set(snapshot.id, listener);
    this.client.addLiveQueryListener(snapshot.id, listener);
    options.onChange(snapshot.rows, {
      queryId: snapshot.id,
      version: Date.now(),
      changedRows: [],
      rows: snapshot.rows,
      initial: true,
    });

    return {
      id: snapshot.id,
      unsubscribe: () => {
        void this.#unsubscribeQuery(snapshot.id).catch(() => undefined);
      },
    };
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(KyselyCompiledQuery.raw('begin'));
  }

  override async destroy(): Promise<void> {
    const ids = [...this.#listeners.keys()];
    for (const id of ids) this.client.removeLiveQueryListener(id);
    this.#listeners.clear();
    await Promise.allSettled(ids.map((id) => this.client.unsubscribeQuery(id)));
  }

  async #unsubscribeQuery(id: string): Promise<void> {
    if (!this.#listeners.has(id)) return;
    this.#listeners.delete(id);
    this.client.removeLiveQueryListener(id);
    await this.client.unsubscribeQuery(id);
  }
}

class SyncularV2Connection implements DatabaseConnection {
  constructor(
    private readonly client: SyncularV2ConnectionClient,
    private readonly unsafeWrites: boolean
  ) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    if (!this.unsafeWrites) assertSyncularV2ReadonlySql(compiledQuery.sql);
    const result = this.unsafeWrites
      ? await assertUnsafeSqlClient(this.client).executeUnsafeSql<
          R & Record<string, unknown>
        >(compiledQuery.sql, compiledQuery.parameters)
      : await this.client.executeSql<R & Record<string, unknown>>(
          compiledQuery.sql,
          compiledQuery.parameters
        );
    return {
      rows: result.rows as R[],
      numAffectedRows:
        result.numAffectedRows == null
          ? undefined
          : BigInt(result.numAffectedRows),
      insertId: result.insertId == null ? undefined : BigInt(result.insertId),
    };
  }

  streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize?: number
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('syncular v2 sqlite dialect does not support streaming');
  }
}

function assertUnsafeSqlClient<Client extends SyncularV2SqlClient>(
  client: Client
): Client & SyncularV2UnsafeSqlClient {
  const maybe = client as Partial<SyncularV2UnsafeSqlClient>;
  if (typeof maybe.executeUnsafeSql === 'function') {
    return client as Client & SyncularV2UnsafeSqlClient;
  }
  throw new Error(
    'Syncular v2 schema installation requires an internal unsafe SQL client.'
  );
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

async function toUint8Array(
  data: Blob | File | Uint8Array
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(await data.arrayBuffer());
}

function sanitizeOperationPayload(
  payload: Record<string, unknown>,
  args: { omit: readonly string[] }
): Record<string, unknown> {
  if (args.omit.length === 0) return payload;
  const omit = new Set(args.omit);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!omit.has(key)) out[key] = value;
  }
  return out;
}

function serverMergeCrdtYjsFields(
  fields: readonly SyncularV2CrdtYjsFieldConfig[]
): readonly SyncularV2CrdtYjsFieldConfig[] {
  return fields.filter(
    (field) => field.syncMode === undefined || field.syncMode === 'server-merge'
  );
}

async function transformCrdtYjsMutationPayload(args: {
  client: Pick<SyncularV2Client, 'applyYjsEnvelopeToPayload'>;
  table: string;
  rowId: string;
  payload: Record<string, unknown>;
  existingRow?: Record<string, unknown> | null;
  crdtYjsFields: readonly SyncularV2CrdtYjsFieldConfig[];
}): Promise<Record<string, unknown>> {
  if (args.crdtYjsFields.length === 0 || !('__yjs' in args.payload)) {
    return args.payload;
  }
  return args.client.applyYjsEnvelopeToPayload({
    table: args.table,
    rowId: args.rowId,
    payload: args.payload,
    existingRow: args.existingRow ?? null,
    rules: args.crdtYjsFields.map((field) => ({
      table: args.table,
      field: field.field,
      stateColumn: field.stateColumn,
      containerKey: field.containerKey ?? field.field,
      rowIdField: field.rowIdField ?? 'id',
      kind: field.kind ?? 'text',
    })),
    stripEnvelope: true,
  });
}

function stripCrdtYjsMaterializedPayloadFields(
  payload: Record<string, unknown>,
  crdtYjsFields: readonly SyncularV2CrdtYjsFieldConfig[]
): Record<string, unknown> {
  const envelope = objectRecord(payload.__yjs);
  if (crdtYjsFields.length === 0 || Object.keys(envelope).length === 0) {
    return payload;
  }
  let next: Record<string, unknown> | null = null;
  const ensureNext = () => {
    next ??= { ...payload };
    return next;
  };
  for (const field of crdtYjsFields) {
    if (!(field.field in envelope)) continue;
    delete ensureNext()[field.field];
    delete ensureNext()[field.stateColumn];
  }
  return next ?? payload;
}

async function readCrdtYjsExistingRow(args: {
  client: Pick<SyncularV2Client, 'executeSql'>;
  table: string;
  rowId: string;
  idColumn: string;
  crdtYjsFields: readonly SyncularV2CrdtYjsFieldConfig[];
}): Promise<Record<string, unknown> | null> {
  if (args.crdtYjsFields.length === 0) return null;
  const columns = new Set<string>([args.idColumn]);
  for (const field of args.crdtYjsFields) {
    columns.add(field.field);
    columns.add(field.stateColumn);
  }
  const result = await args.client.executeSql(
    `select ${[...columns].map(quoteSqlIdentifier).join(', ')} from ${quoteSqlIdentifier(args.table)} where ${quoteSqlIdentifier(args.idColumn)} = ? limit 1`,
    [args.rowId]
  );
  return result.rows[0] ?? null;
}

function quoteSqlIdentifier(identifier: string): string {
  if (!identifier) throw new Error('SQLite identifier cannot be empty');
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function readCurrentBaseVersion(
  client: Pick<SyncularV2Client, 'executeSql'>,
  args: {
    table: string;
    rowId: string;
    idColumn: string;
    versionColumn: string;
  }
): Promise<number | null> {
  const result = await client.executeSql(
    `select ${quoteSqlIdentifier(args.versionColumn)} as version from ${quoteSqlIdentifier(args.table)} where ${quoteSqlIdentifier(args.idColumn)} = ? limit 1`,
    [args.rowId]
  );
  return coerceBaseVersion(result.rows[0]?.version);
}

function coerceBaseVersion(value: unknown): number | null {
  if (value == null) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

async function resolveBaseVersion(args: {
  options: SyncularV2MutationsOptions;
  table: string;
  rowId: string;
  idColumn: string;
  versionColumn: string | null;
  explicit?: number | null;
}): Promise<number | null> {
  if (args.explicit !== undefined) return coerceBaseVersion(args.explicit);
  if (!args.versionColumn || !args.options.readBaseVersion) return null;
  return args.options.readBaseVersion({
    table: args.table,
    rowId: args.rowId,
    idColumn: args.idColumn,
    versionColumn: args.versionColumn,
  });
}

function inferTablesFromCompiledQuery(
  query: CompiledQuery,
  appTables?: ReadonlySet<string>
): string[] {
  const tables = new Set<string>();
  collectTables(query.query as OperationNodeLike, tables);
  return [...tables].filter(
    (table) => appTables == null || appTables.has(table)
  );
}

interface OperationNodeLike {
  kind?: string;
  [key: string]: unknown;
}

function collectTables(node: unknown, tables: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTables(item, tables);
    return;
  }
  if (!isOperationNode(node)) return;

  if (node.kind === 'TableNode') collectTableNode(node, tables);
  for (const value of Object.values(node)) collectTables(value, tables);
}

function collectTableNode(node: unknown, tables: Set<string>): void {
  if (!isOperationNode(node)) return;
  if (node.kind === 'AliasNode') {
    collectTableNode(node.node, tables);
    return;
  }
  if (node.kind !== 'TableNode') return;
  const table = node.table;
  if (!isOperationNode(table) || table.kind !== 'SchemableIdentifierNode') {
    return;
  }
  const identifier = table.identifier;
  if (!isOperationNode(identifier) || identifier.kind !== 'IdentifierNode') {
    return;
  }
  if (typeof identifier.name === 'string') tables.add(identifier.name);
}

function isOperationNode(value: unknown): value is OperationNodeLike {
  return Boolean(value && typeof value === 'object' && 'kind' in value);
}

function normalizeLiveQueryTables(
  tables: readonly string[],
  appTables?: ReadonlySet<string>
): string[] {
  const normalized: string[] = [];
  for (const table of tables) {
    if (table.length === 0) {
      throw new Error(
        'Live query table dependencies must not contain empty names.'
      );
    }
    if (appTables != null && !appTables.has(table)) {
      throw new Error(
        `Live query table ${table} is not part of the generated app schema.`
      );
    }
    if (!normalized.includes(table)) normalized.push(table);
  }
  return normalized;
}
