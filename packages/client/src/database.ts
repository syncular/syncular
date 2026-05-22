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
  assertSyncularBlobPayloadLimit,
  type SyncularBlobLimitInput,
  syncularBlobInputSize,
} from './blob-limits';
import { createSyncularConsoleDiagnosticsPublisher } from './console-diagnostics';
import { isSyncularOfflineError } from './errors';
import {
  createMutationsApi,
  type MutationsApi,
  type MutationsCommitFn,
  type MutationsTx,
} from './mutations';
import { browserSyncularNetworkStatusSource } from './network';
import { assertSyncularReadonlySql } from './sql-safety';
import type {
  CreateSyncularDatabaseOptions,
  SyncularBlobStoreOptions,
  SyncularBlobs,
  SyncularCrdtYjsFieldConfig,
  SyncularLiveQueries,
  SyncularLiveQueryDependencyHint,
  SyncularLiveQueryEvent,
  SyncularLiveQueryOptions,
  SyncularLiveQuerySubscription,
  SyncularNetworkStatusSource,
  SyncularRuntimeClient,
  SyncularSqlClient,
  SyncularTableConfigMap,
  SyncularUnsafeSqlClient,
} from './types';
import { createSyncularWorkerClient } from './worker-client';

type SyncularDriverClient = SyncularRuntimeClient &
  Partial<SyncularUnsafeSqlClient>;
type SyncularConnectionClient = SyncularSqlClient &
  Partial<SyncularUnsafeSqlClient>;

export interface SyncularDialect extends Dialect, SyncularLiveQueries {
  destroyLiveQueries(): Promise<void>;
}

export interface SyncularDialectOptions {
  appTables?: readonly string[];
  tableConfig?: SyncularTableConfigMap;
  unsafeWrites?: boolean;
}

export interface SyncularDatabase<DB> extends SyncularLiveQueries {
  db: Kysely<DB>;
  client: SyncularRuntimeClient;
  dialect: SyncularDialect;
  mutations: MutationsApi<DB, undefined>;
  leasedMutations: MutationsApi<DB, undefined>;
  blobs: SyncularBlobs;
  close(): Promise<void>;
}

export async function withSyncularSchemaWrites<DB, Result>(
  database: Pick<SyncularDatabase<DB>, 'client'>,
  callback: (db: Kysely<any>) => Promise<Result>
): Promise<Result> {
  const client = assertUnsafeSqlClient(database.client);
  const dialect = createSyncularDialect(client, { unsafeWrites: true });
  const db = new Kysely<any>({ dialect });
  try {
    return await callback(db);
  } finally {
    await dialect.destroyLiveQueries();
    await db.destroy();
  }
}

export interface SyncularMutationsMeta {
  operations: SyncOperation[];
  localMutations: Array<{
    table: string;
    rowId: string;
    op: 'upsert' | 'delete';
  }>;
  clientCommitIds: string[];
}

export interface SyncularMutationsOptions {
  client: Pick<
    SyncularRuntimeClient,
    | 'applyMutation'
    | 'applyMutationsBatch'
    | 'applyMutationsCommit'
    | 'applyYjsEnvelopeToPayload'
    | 'executeSql'
  > &
    Partial<
      Pick<
        SyncularRuntimeClient,
        'applyLeasedMutation' | 'applyLeasedMutationsCommit'
      >
    >;
  requireAuthLease?: boolean;
  codecs?: ColumnCodecSource;
  codecDialect?: ColumnCodecDialect;
  idColumn?: string;
  versionColumn?: string | null;
  omitColumns?: string[];
  tableConfig?: SyncularTableConfigMap;
  readBaseVersion?: (args: {
    table: string;
    rowId: string;
    idColumn: string;
    versionColumn: string;
  }) => Promise<number | null>;
  afterCommit?: (meta: SyncularMutationsMeta) => void | Promise<void>;
}

export async function createSyncularDatabase<DB>(
  options: CreateSyncularDatabaseOptions
): Promise<SyncularDatabase<DB>> {
  const client = await createSyncularWorkerClient(options);
  const dialect = createSyncularDialect(client, {
    appTables: options.appTables,
    tableConfig: options.tableConfig,
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
    network:
      options.sync?.network === false
        ? undefined
        : (options.sync?.network ?? browserSyncularNetworkStatusSource()),
    isClosed: () => closed,
  });
  const blobUploadScheduler = createBlobUploadScheduler(client, {
    enabled: options.sync?.autoProcessBlobUploadsAfterStore ?? false,
    debounceMs: options.sync?.blobUploadDebounceMs ?? 10,
    isClosed: () => closed,
  });
  const consoleDiagnostics =
    options.consoleDiagnostics === undefined ||
    options.consoleDiagnostics === false
      ? undefined
      : createSyncularConsoleDiagnosticsPublisher(client, {
          ...(options.consoleDiagnostics === true
            ? {}
            : options.consoleDiagnostics),
          config: options.config,
          isClosed: () => closed,
        });
  const mutations = createSyncularMutations<DB>({
    client,
    codecs: options.codecs,
    codecDialect: 'sqlite',
    tableConfig: options.tableConfig,
    readBaseVersion: (args) => readCurrentBaseVersion(client, args),
    afterCommit: () => mutationSyncScheduler.schedule(),
  });
  const leasedMutations = createSyncularMutations<DB>({
    client,
    requireAuthLease: true,
    codecs: options.codecs,
    codecDialect: 'sqlite',
    tableConfig: options.tableConfig,
    readBaseVersion: (args) => readCurrentBaseVersion(client, args),
    afterCommit: () => mutationSyncScheduler.schedule(),
  });
  const blobs = createSyncularBlobClient(client, {
    diagnostics: options.diagnostics,
    limits: options.blobLimits,
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
    leasedMutations,
    blobs,
    live: (query, liveOptions) => dialect.live(query, liveOptions),
    async close() {
      if (closed) return;
      closed = true;
      mutationSyncScheduler.destroy();
      blobUploadScheduler.destroy();
      consoleDiagnostics?.destroy();
      try {
        await dialect.destroyLiveQueries();
        await db.destroy();
      } finally {
        await client.close();
      }
    },
  };
}

function createMutationSyncScheduler(
  client: Pick<SyncularRuntimeClient, 'syncOnce'>,
  options: {
    enabled: boolean;
    debounceMs: number | false;
    network: SyncularNetworkStatusSource | undefined;
    isClosed: () => boolean;
  }
): { schedule(): void; destroy(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let queued = false;
  const isOnline = () => options.network?.isOnline() !== false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const run = async () => {
    if (options.isClosed()) return;
    if (!isOnline()) {
      queued = true;
      return;
    }
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = client
      .syncOnce()
      .then(() => undefined)
      .catch((error) => {
        if (!isOnline() || isSyncularOfflineError(error)) queued = true;
      })
      .finally(() => {
        inFlight = undefined;
        if (queued && !options.isClosed() && isOnline()) {
          queued = false;
          schedule();
        }
      });
    await inFlight;
  };
  const schedule = () => {
    if (!options.enabled || options.isClosed()) return;
    if (!isOnline()) {
      queued = true;
      clear();
      return;
    }
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
  const handleOnline = () => {
    if (!queued || options.isClosed()) return;
    queued = false;
    schedule();
  };
  options.network?.addEventListener?.('online', handleOnline);
  return {
    schedule,
    destroy() {
      clear();
      queued = false;
      options.network?.removeEventListener?.('online', handleOnline);
    },
  };
}

function createBlobUploadScheduler(
  client: Pick<SyncularRuntimeClient, 'processBlobUploadQueue'>,
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

export function createSyncularBlobClient(
  client: Pick<
    SyncularRuntimeClient,
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
    limits?: CreateSyncularDatabaseOptions['blobLimits'];
    diagnostics?: CreateSyncularDatabaseOptions['diagnostics'];
    afterStore?: (args: {
      ref: BlobRef;
      options?: SyncularBlobStoreOptions;
    }) => void | Promise<void>;
  } = {}
): SyncularBlobs {
  const assertRetrieveWithinLimit = (ref: BlobRef) =>
    assertSyncularBlobPayloadLimit({
      operation: 'retrieve',
      size: ref.size,
      limits: hooks.limits,
      refHash: ref.hash,
      diagnostics: hooks.diagnostics,
    });
  return {
    async store(data, storeOptions) {
      assertSyncularBlobPayloadLimit({
        operation: 'store',
        size: syncularBlobInputSize(data as SyncularBlobLimitInput),
        limits: hooks.limits,
        options: storeOptions,
        diagnostics: hooks.diagnostics,
      });
      const ref = await client.storeBlob(
        await toUint8Array(data),
        storeOptions
      );
      await hooks.afterStore?.({
        ref,
        ...(storeOptions === undefined ? {} : { options: storeOptions }),
      });
      return ref;
    },
    async retrieve(ref) {
      assertRetrieveWithinLimit(ref);
      return client.retrieveBlob(ref);
    },
    isLocal(hash) {
      return client.isBlobLocal(hash);
    },
    async preload(refs) {
      for (const ref of refs) assertRetrieveWithinLimit(ref);
      await Promise.all(refs.map((ref) => client.retrieveBlob(ref)));
    },
    processUploadQueue(options) {
      return client.processBlobUploadQueue(options);
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

export function createSyncularDialect(
  client: SyncularRuntimeClient,
  options: SyncularDialectOptions = {}
): SyncularDialect {
  const driver = new SyncularDriver(client, options);
  const dialect = new BaseSqliteDialect(() => driver) as SyncularDialect;
  dialect.live = (query, liveOptions) => driver.live(query, liveOptions);
  dialect.destroyLiveQueries = () => driver.destroy();
  return dialect;
}

export function createSyncularMutations<DB>(
  options: SyncularMutationsOptions
): MutationsApi<DB, undefined> {
  return createMutationsApi(createSyncularCommit<DB>(options));
}

export function createSyncularCommit<DB>(
  options: SyncularMutationsOptions
): MutationsCommitFn<DB, SyncularMutationsMeta, undefined> {
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
    const localMutations: SyncularMutationsMeta['localMutations'] = [];
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
          await applyUpsert(id, patch, opts, { mergeExistingLocalRow: true });
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
          await applyUpsert(id, patch, opts, { mergeExistingLocalRow: false });
        },
      };

      const applyUpsert = async (
        id: string,
        patch: unknown,
        opts: { baseVersion?: number | null } | undefined,
        behavior: { mergeExistingLocalRow: boolean }
      ) => {
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
        const existingLocalRow = behavior.mergeExistingLocalRow
          ? await readExistingLocalRow({
              client: options.client,
              table,
              rowId: id,
              idColumn: tableIdColumn,
            })
          : null;
        const rawLocalPayload = existingLocalRow
          ? { ...existingLocalRow, ...rawPatch }
          : rawPatch;
        const localPayload = sanitizeOperationPayload(rawLocalPayload, {
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
        const transformedLocalPayload = await transformCrdtYjsMutationPayload({
          client: options.client,
          table,
          rowId: id,
          payload: localPayload,
          existingRow,
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
    const clientCommitId = options.requireAuthLease
      ? await requireLeasedMutationClient(
          options.client
        ).applyLeasedMutationsCommit(batch)
      : await options.client.applyMutationsCommit(batch);
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

function requireLeasedMutationClient(
  client: SyncularMutationsOptions['client']
): Required<
  Pick<
    SyncularRuntimeClient,
    'applyLeasedMutation' | 'applyLeasedMutationsCommit'
  >
> {
  if (typeof client.applyLeasedMutationsCommit !== 'function') {
    throw new Error(
      'Syncular leased mutations require applyLeasedMutationsCommit support'
    );
  }
  if (typeof client.applyLeasedMutation !== 'function') {
    throw new Error(
      'Syncular leased mutations require applyLeasedMutation support'
    );
  }
  return client as Required<
    Pick<
      SyncularRuntimeClient,
      'applyLeasedMutation' | 'applyLeasedMutationsCommit'
    >
  >;
}

class SyncularDriver extends BaseSqliteDriver {
  #listeners = new Map<
    string,
    (event: SyncularLiveQueryEvent<Record<string, unknown>>) => void
  >();
  readonly #appTables: Set<string> | undefined;
  readonly #tableConfig: SyncularTableConfigMap | undefined;

  constructor(
    private readonly client: SyncularDriverClient,
    options: SyncularDialectOptions = {}
  ) {
    super(async () => {
      this.conn = new SyncularConnection(client, options.unsafeWrites ?? false);
    });
    this.#appTables =
      options.appTables == null
        ? undefined
        : new Set(normalizeLiveQueryTables(options.appTables));
    this.#tableConfig = options.tableConfig;
  }

  async live<Row extends Record<string, unknown>>(
    query: { compile(): CompiledQuery },
    options: SyncularLiveQueryOptions<Row>
  ): Promise<SyncularLiveQuerySubscription> {
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
      tables,
      inferDependencyHintsFromCompiledQuery(compiled, tables, this.#tableConfig)
    );
    const listener = (
      event: SyncularLiveQueryEvent<Record<string, unknown>>
    ) => {
      const typed = event as SyncularLiveQueryEvent<Row>;
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

class SyncularConnection implements DatabaseConnection {
  constructor(
    private readonly client: SyncularConnectionClient,
    private readonly unsafeWrites: boolean
  ) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    if (!this.unsafeWrites) assertSyncularReadonlySql(compiledQuery.sql);
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
    throw new Error('syncular sqlite dialect does not support streaming');
  }
}

function assertUnsafeSqlClient<Client extends SyncularSqlClient>(
  client: Client
): Client & SyncularUnsafeSqlClient {
  const maybe = client as Partial<SyncularUnsafeSqlClient>;
  if (typeof maybe.executeUnsafeSql === 'function') {
    return client as Client & SyncularUnsafeSqlClient;
  }
  throw new Error(
    'Syncular schema installation requires an internal unsafe SQL client.'
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
  fields: readonly SyncularCrdtYjsFieldConfig[]
): readonly SyncularCrdtYjsFieldConfig[] {
  return fields.filter(
    (field) => field.syncMode === undefined || field.syncMode === 'server-merge'
  );
}

async function transformCrdtYjsMutationPayload(args: {
  client: Pick<SyncularRuntimeClient, 'applyYjsEnvelopeToPayload'>;
  table: string;
  rowId: string;
  payload: Record<string, unknown>;
  existingRow?: Record<string, unknown> | null;
  crdtYjsFields: readonly SyncularCrdtYjsFieldConfig[];
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
  crdtYjsFields: readonly SyncularCrdtYjsFieldConfig[]
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
  client: Pick<SyncularRuntimeClient, 'executeSql'>;
  table: string;
  rowId: string;
  idColumn: string;
  crdtYjsFields: readonly SyncularCrdtYjsFieldConfig[];
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

async function readExistingLocalRow(args: {
  client: Pick<SyncularRuntimeClient, 'executeSql'>;
  table: string;
  rowId: string;
  idColumn: string;
}): Promise<Record<string, unknown> | null> {
  const result = await args.client.executeSql(
    `select * from ${quoteSqlIdentifier(args.table)} where ${quoteSqlIdentifier(args.idColumn)} = ? limit 1`,
    [args.rowId]
  );
  return result.rows[0] ?? null;
}

function quoteSqlIdentifier(identifier: string): string {
  if (!identifier) throw new Error('SQLite identifier cannot be empty');
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function readCurrentBaseVersion(
  client: Pick<SyncularRuntimeClient, 'executeSql'>,
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
  options: SyncularMutationsOptions;
  table: string;
  rowId: string;
  idColumn: string;
  versionColumn: string | null;
  explicit?: number | null;
}): Promise<number | null> {
  if (args.explicit !== undefined) return coerceBaseVersion(args.explicit);
  if (!args.versionColumn) return null;
  const readBaseVersion =
    args.options.readBaseVersion ??
    ((readArgs: {
      table: string;
      rowId: string;
      idColumn: string;
      versionColumn: string;
    }) => readCurrentBaseVersion(args.options.client, readArgs));
  return readBaseVersion({
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

function inferDependencyHintsFromCompiledQuery(
  query: CompiledQuery,
  tables: readonly string[],
  tableConfig?: SyncularTableConfigMap
): SyncularLiveQueryDependencyHint[] {
  if (tables.length !== 1) return [];
  const table = tables[0]!;
  const primaryKey = tableConfig?.[table]?.primaryKeyColumn ?? 'id';
  const rowIds = primaryKeyEqualityValues(query.query, table, primaryKey);
  return rowIds.length > 0 ? [{ table, rowIds }] : [];
}

function primaryKeyEqualityValues(
  query: unknown,
  table: string,
  primaryKey: string
): string[] {
  if (!isOperationNode(query) || query.kind !== 'SelectQueryNode') return [];
  const where = query.where;
  if (!isOperationNode(where) || where.kind !== 'WhereNode') return [];
  return collectConjunctivePrimaryKeyValues(where.where, table, primaryKey);
}

function collectConjunctivePrimaryKeyValues(
  node: unknown,
  table: string,
  primaryKey: string
): string[] {
  if (!isOperationNode(node)) return [];
  if (node.kind === 'AndNode') {
    return uniqueStrings([
      ...collectConjunctivePrimaryKeyValues(node.left, table, primaryKey),
      ...collectConjunctivePrimaryKeyValues(node.right, table, primaryKey),
    ]);
  }
  const equality = primaryKeyEqualityValue(node, table, primaryKey);
  return equality == null ? [] : [equality];
}

function primaryKeyEqualityValue(
  node: unknown,
  table: string,
  primaryKey: string
): string | undefined {
  if (!isOperationNode(node) || node.kind !== 'BinaryOperationNode') {
    return undefined;
  }
  const operator = node.operator;
  if (
    !isOperationNode(operator) ||
    operator.kind !== 'OperatorNode' ||
    operator.operator !== '='
  ) {
    return undefined;
  }
  return (
    equalityValueForReference(
      node.leftOperand,
      node.rightOperand,
      table,
      primaryKey
    ) ??
    equalityValueForReference(
      node.rightOperand,
      node.leftOperand,
      table,
      primaryKey
    )
  );
}

function equalityValueForReference(
  reference: unknown,
  value: unknown,
  table: string,
  primaryKey: string
): string | undefined {
  if (!referenceMatchesColumn(reference, table, primaryKey)) return undefined;
  if (!isOperationNode(value) || value.kind !== 'ValueNode') return undefined;
  if (typeof value.value === 'string') return value.value;
  if (typeof value.value === 'number' && Number.isFinite(value.value)) {
    return String(value.value);
  }
  return undefined;
}

function referenceMatchesColumn(
  reference: unknown,
  table: string,
  column: string
): boolean {
  if (!isOperationNode(reference) || reference.kind !== 'ReferenceNode') {
    return false;
  }
  if (
    reference.table != null &&
    tableNameFromTableNode(reference.table) !== table
  ) {
    return false;
  }
  const columnNode = reference.column;
  if (!isOperationNode(columnNode) || columnNode.kind !== 'ColumnNode') {
    return false;
  }
  const identifier = columnNode.column;
  return (
    isOperationNode(identifier) &&
    identifier.kind === 'IdentifierNode' &&
    identifier.name === column
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
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
  const table = tableNameFromTableNode(node);
  if (table != null) tables.add(table);
}

function tableNameFromTableNode(node: unknown): string | undefined {
  if (!isOperationNode(node)) return undefined;
  if (node.kind === 'AliasNode') return tableNameFromTableNode(node.node);
  if (node.kind !== 'TableNode') return undefined;
  const table = node.table;
  if (!isOperationNode(table) || table.kind !== 'SchemableIdentifierNode') {
    return undefined;
  }
  const identifier = table.identifier;
  if (!isOperationNode(identifier) || identifier.kind !== 'IdentifierNode') {
    return undefined;
  }
  return typeof identifier.name === 'string' ? identifier.name : undefined;
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
