/**
 * Reference ClientDriver: the TypeScript web client
 * (`@syncular/client`) on the `bun:sqlite` backend, wired to
 * whatever transport endpoints the harness supplies. All driver inputs
 * and outputs stay JSON-able + bytes; row values convert at this edge.
 */

import {
  type ClientChangeBatch,
  type ClientSchema,
  ClientSyncError,
  type EncryptionConfig,
  type MutationInput,
  SYNC_VERSION_COLUMN,
  SyncClient,
  type SyncIntent,
  type SyncSummary,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import type { RowValue, ScopeMap } from '@syncular/core';
import { YjsColumn } from '@syncular/crdt-yjs';
import type {
  ClientConflict,
  ClientCreateOptions,
  ClientDriver,
  ClientInstance,
  ClientMutation,
  ClientPresencePeer,
  ClientRejection,
  ClientRowState,
  ClientSubscriptionState,
  ClientSyncResult,
  DriverChangeBatch,
  DriverColumn,
  DriverEncryptionConfig,
  DriverRow,
  DriverRowValue,
  DriverSchema,
  DriverScopeMap,
  DriverSyncIntent,
  DriverWindowBase,
} from '../driver';
import { bytesToHex, hexToBytes } from '../raw';

/** §5.11: driver `{ keyId: {$bytes} }` → a client key provider. */
function buildEncryption(
  config: DriverEncryptionConfig | undefined,
): EncryptionConfig | undefined {
  if (config === undefined) return undefined;
  const keys = new Map<string, Uint8Array>();
  for (const [keyId, val] of Object.entries(config.keys)) {
    keys.set(keyId, hexToBytes(val.$bytes));
  }
  return { keyProvider: (keyId) => keys.get(keyId) };
}

function toClientSchema(schema: DriverSchema): ClientSchema {
  return {
    version: schema.version,
    tables: schema.tables.map((table) => ({
      name: table.name,
      columns: table.columns,
      primaryKey: table.primaryKey,
      scopes: table.scopes.map((scope) =>
        scope.column !== undefined
          ? { pattern: scope.pattern, column: scope.column }
          : scope.pattern,
      ),
    })),
  };
}

function toRowValue(value: DriverRowValue | undefined): RowValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return hexToBytes(value.$bytes);
  return value;
}

function toDriverValue(value: RowValue): DriverRowValue {
  if (value instanceof Uint8Array) return { $bytes: bytesToHex(value) };
  return value;
}

/** Normalize a raw SQLite value by its schema column type. */
function normalizeSqlValue(
  column: DriverColumn,
  value: unknown,
): DriverRowValue {
  if (value === null || value === undefined) return null;
  // §5.11: the local mirror stores an encrypted column as its DECLARED type
  // (plaintext), not the wire `bytes` — normalize by declaredType.
  const localType =
    column.encrypted === true && column.declaredType !== undefined
      ? column.declaredType
      : column.type;
  if (localType === 'boolean') return value !== 0 && value !== false;
  if (localType === 'bytes' || localType === 'crdt') {
    // §5.10: a crdt column is stored as BLOB and crosses the seam as $bytes.
    return { $bytes: bytesToHex(value as Uint8Array) };
  }
  if (typeof value === 'bigint') return Number(value);
  return value as DriverRowValue;
}

function errorCodeOf(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      code: typeof code === 'string' ? code : 'transport.failed',
      message: error.message,
    };
  }
  return { code: 'transport.failed', message: String(error) };
}

function toReport(summary: SyncSummary): ClientSyncResult {
  return {
    ok: true,
    report: {
      pushed: summary.pushed,
      applied: summary.applied,
      rejected: summary.rejected,
      retryable: summary.retryable,
      conflicts: summary.conflicts.length,
      commitsApplied: summary.commitsApplied,
      segmentRowsApplied: summary.segmentRowsApplied,
      bootstrapping: summary.bootstrapping,
      resets: summary.resets,
      revoked: summary.revoked,
      failed: summary.failed,
      ...(summary.schemaFloor !== undefined
        ? { schemaFloor: summary.schemaFloor }
        : {}),
    },
  };
}

/**
 * Build a `SyncClient` on a given database + schema, wiring the harness
 * endpoints. Shared by `create` (fresh DB) and `recreateWithSchema`
 * (§7.4.2 — new schema, SAME DB), so an upgrade reuses the exact same
 * transport seam the fresh client had.
 */
async function constructClient(
  db: BunClientDatabase,
  schema: DriverSchema,
  options: ClientCreateOptions,
): Promise<SyncClient> {
  const endpoints = options.endpoints;
  const nowMs = options.nowMs;
  const fetchSegmentUrl = endpoints.fetchSegmentUrl?.bind(endpoints);
  const segments = Object.assign(
    (request: {
      segmentId: string;
      table: string;
      requestedScopesJson: string;
    }) => endpoints.downloadSegment(request),
    fetchSegmentUrl !== undefined ? { fetchUrl: fetchSegmentUrl } : {},
  );
  const uploadBlob = endpoints.uploadBlob?.bind(endpoints);
  const downloadBlob = endpoints.downloadBlob?.bind(endpoints);
  const fetchBlobUrl = endpoints.fetchBlobUrl?.bind(endpoints);
  const uploadBlobGrant = endpoints.uploadBlobGrant?.bind(endpoints);
  const putBlobUrl = endpoints.putBlobUrl?.bind(endpoints);
  const blobs =
    uploadBlob !== undefined && downloadBlob !== undefined
      ? {
          upload: (blobId: string, bytes: Uint8Array, mediaType?: string) =>
            uploadBlob(blobId, bytes, mediaType),
          // §5.9.5: the endpoint returns the discriminated bytes/url arm.
          download: (blobId: string) => downloadBlob(blobId),
          // §5.9.5/§5.9.3 presign seams — present iff the harness exposes them.
          ...(fetchBlobUrl !== undefined
            ? { fetchUrl: (url: string) => fetchBlobUrl(url) }
            : {}),
          ...(uploadBlobGrant !== undefined
            ? {
                uploadGrant: (
                  blobId: string,
                  byteLength: number,
                  mediaType?: string,
                ) => uploadBlobGrant(blobId, byteLength, mediaType),
              }
            : {}),
          ...(putBlobUrl !== undefined
            ? {
                uploadToUrl: (
                  url: string,
                  bytes: Uint8Array,
                  mediaType?: string,
                ) => putBlobUrl(url, bytes, mediaType),
              }
            : {}),
        }
      : undefined;
  // §5.9.7 B1: the blob-cache cap is a top-level config field, not a §4.2
  // request limit — pull it out of the driver's limits bag.
  const blobCacheMaxBytes = options.limits?.blobCacheMaxBytes;
  // §5.11: build a key provider from the driver's `{ $bytes: hex }` keys.
  const encryption = buildEncryption(options.encryption);
  const client = new SyncClient({
    database: db,
    schema: toClientSchema(schema),
    clientId: options.clientId,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(blobCacheMaxBytes !== undefined ? { blobCacheMaxBytes } : {}),
    ...(nowMs !== undefined ? { now: () => nowMs } : {}),
    ...(encryption !== undefined ? { encryption } : {}),
    transport: (bytes) => endpoints.sync(bytes),
    segments,
    ...(blobs !== undefined ? { blobs } : {}),
    realtime: async (handlers) => {
      const connection = await endpoints.connectRealtime({
        onText: (text) => handlers.onText(text),
        onBinary: (bytes) => handlers.onBinary(bytes),
        onClose: () => handlers.onClose?.(),
      });
      return {
        send: (text) => connection.send(text),
        sendBytes: (bytes) => connection.sendBinary(bytes),
        close: () => {
          connection.close();
          handlers.onClose?.();
        },
      };
    },
  });
  await client.start();
  return client;
}

class TsClientInstance implements ClientInstance {
  #client: SyncClient;
  readonly #db: BunClientDatabase;
  #schema: DriverSchema;
  readonly #options: ClientCreateOptions;
  readonly #changes: ClientChangeBatch[] = [];
  readonly #intents: SyncIntent[] = [];

  constructor(
    client: SyncClient,
    db: BunClientDatabase,
    schema: DriverSchema,
    options: ClientCreateOptions,
  ) {
    this.#client = client;
    this.#db = db;
    this.#schema = schema;
    this.#options = options;
    client.onChange((batch) => this.#changes.push(batch));
  }

  async subscribe(input: {
    readonly id: string;
    readonly table: string;
    readonly scopes: DriverScopeMap;
    readonly params?: string;
  }): Promise<void> {
    this.#client.subscribe({
      id: input.id,
      table: input.table,
      scopes: input.scopes as ScopeMap,
      ...(input.params !== undefined ? { params: input.params } : {}),
    });
  }

  async unsubscribe(id: string): Promise<void> {
    this.#client.unsubscribe(id);
  }

  async setWindow(
    base: DriverWindowBase,
    units: readonly string[],
  ): Promise<void> {
    const result = await this.#client.setWindowCommand(
      {
        table: base.table,
        variable: base.variable,
        ...(base.fixedScopes !== undefined
          ? { fixedScopes: base.fixedScopes as ScopeMap }
          : {}),
        ...(base.params !== undefined ? { params: base.params } : {}),
      },
      units,
    );
    this.#intents.push(result.effects.sync);
  }

  async windowState(base: DriverWindowBase): Promise<{
    readonly units: readonly string[];
    readonly pending: readonly string[];
  }> {
    return this.#client.windowState({
      table: base.table,
      variable: base.variable,
      ...(base.fixedScopes !== undefined
        ? { fixedScopes: base.fixedScopes as ScopeMap }
        : {}),
      ...(base.params !== undefined ? { params: base.params } : {}),
    });
  }

  async mutate(mutations: readonly ClientMutation[]): Promise<string> {
    const inputs: MutationInput[] = mutations.map((mutation) => {
      if (mutation.op === 'delete') {
        return {
          table: mutation.table,
          op: 'delete',
          rowId: mutation.rowId,
          ...(mutation.baseVersion !== undefined
            ? { baseVersion: mutation.baseVersion }
            : {}),
        };
      }
      const values: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(mutation.values)) {
        values[key] = toRowValue(value);
      }
      return {
        table: mutation.table,
        op: 'upsert',
        values,
        ...(mutation.baseVersion !== undefined
          ? { baseVersion: mutation.baseVersion }
          : {}),
      };
    });
    const result = this.#client.mutateCommand(inputs);
    this.#intents.push(result.effects.sync);
    return result.value;
  }

  async patch(
    table: string,
    rowId: string,
    partial: DriverRow,
    baseVersion?: number,
  ): Promise<string> {
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(partial)) {
      values[key] = toRowValue(value);
    }
    const result = this.#client.patchCommand(
      table,
      rowId,
      values,
      baseVersion !== undefined ? { baseVersion } : undefined,
    );
    this.#intents.push(result.effects.sync);
    return result.value;
  }

  async localRevision(): Promise<string> {
    return this.#client.localRevision.toString();
  }

  async statusSnapshot(): Promise<{
    readonly currentSchemaVersion: number;
    readonly outbox: number;
    readonly upgrading: boolean;
    readonly syncNeeded: boolean;
  }> {
    const status = this.#client.statusSnapshot();
    return {
      currentSchemaVersion: status.currentSchemaVersion,
      outbox: status.outbox,
      upgrading: status.upgrading,
      syncNeeded: status.syncNeeded,
    };
  }

  async querySnapshot(
    sql: string,
    params: readonly DriverRowValue[] = [],
    coverage: readonly {
      readonly base: DriverWindowBase;
      readonly units: readonly string[];
    }[] = [],
  ) {
    const snapshot = this.#client.querySnapshot({
      sql,
      params: params.map((value) =>
        value !== null && typeof value === 'object'
          ? hexToBytes(value.$bytes)
          : value,
      ),
      coverage: coverage.map((item) => ({
        base: {
          table: item.base.table,
          variable: item.base.variable,
          ...(item.base.fixedScopes !== undefined
            ? { fixedScopes: item.base.fixedScopes as ScopeMap }
            : {}),
          ...(item.base.params !== undefined
            ? { params: item.base.params }
            : {}),
        },
        units: item.units,
      })),
    });
    return {
      revision: snapshot.revision.toString(),
      rows: snapshot.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value instanceof Uint8Array
              ? { $bytes: bytesToHex(value) }
              : typeof value === 'bigint'
                ? Number(value)
                : value,
          ]),
        ),
      ),
      coverage: snapshot.coverage,
    };
  }

  async drainChangeBatches(): Promise<readonly DriverChangeBatch[]> {
    return this.#changes.splice(0).map((batch) => ({
      revision: batch.revision.toString(),
      tables: batch.tables.map((table) => ({
        table: table.table,
        ...(table.scopeKeys !== undefined
          ? { scopeKeys: [...table.scopeKeys].sort() }
          : {}),
      })),
      windows: batch.windows.map((window) => ({
        baseKey: window.baseKey,
        table: window.table,
        units: [...window.units].sort(),
      })),
      ...(batch.status !== undefined
        ? {
            status: {
              currentSchemaVersion: batch.status.currentSchemaVersion,
              outbox: batch.status.outbox,
              upgrading: batch.status.upgrading,
              syncNeeded: batch.status.syncNeeded,
            },
          }
        : {}),
      conflictsChanged: batch.conflictsChanged,
      rejectionsChanged: batch.rejectionsChanged,
      outcomesChanged: batch.outcomesChanged,
    }));
  }

  async drainSyncIntents(): Promise<readonly DriverSyncIntent[]> {
    return this.#intents.splice(0);
  }

  async sync(): Promise<ClientSyncResult> {
    try {
      return toReport(await this.#client.sync());
    } catch (error) {
      const { code, message } = errorCodeOf(error);
      return { ok: false, errorCode: code, message };
    }
  }

  async syncUntilIdle(maxRounds?: number): Promise<ClientSyncResult> {
    try {
      return toReport(await this.#client.syncUntilIdle(maxRounds));
    } catch (error) {
      const { code, message } = errorCodeOf(error);
      return { ok: false, errorCode: code, message };
    }
  }

  async readRows(table: string): Promise<ClientRowState[]> {
    const schemaTable = this.#schema.tables.find((t) => t.name === table);
    if (schemaTable === undefined) throw new Error(`unknown table ${table}`);
    // The raw database tier, deliberately: the driver's row state carries
    // `_sync_version`, which the app-facing `client.query()` strips from
    // `SELECT *` results (RFC 0002 §2.1).
    const rows = this.#client.database.query(
      `SELECT * FROM "${table}" ORDER BY "${schemaTable.primaryKey}" ASC`,
    );
    return rows.map((row) => {
      const values: Record<string, DriverRowValue> = {};
      for (const column of schemaTable.columns) {
        values[column.name] = normalizeSqlValue(column, row[column.name]);
      }
      const rowId = row[schemaTable.primaryKey];
      return {
        rowId: String(rowId),
        version: Number(row[SYNC_VERSION_COLUMN] ?? 0),
        values: values as DriverRow,
      };
    });
  }

  async conflicts(): Promise<ClientConflict[]> {
    return this.#client.conflicts.map((conflict) => {
      const serverRow: Record<string, DriverRowValue> = {};
      for (const [key, value] of Object.entries(conflict.serverRow)) {
        serverRow[key] = toDriverValue(value);
      }
      return {
        clientCommitId: conflict.clientCommitId,
        opIndex: conflict.opIndex,
        table: conflict.table,
        rowId: conflict.rowId,
        code: conflict.code,
        serverVersion: conflict.serverVersion,
        serverRow: serverRow as DriverRow,
        ...(conflict.operation !== undefined
          ? {
              operation: {
                ...(conflict.operation.changedFields !== undefined
                  ? { changedFields: conflict.operation.changedFields }
                  : {}),
              },
            }
          : {}),
      };
    });
  }

  async rejections(): Promise<ClientRejection[]> {
    return this.#client.rejections.map((rejection) => ({
      clientCommitId: rejection.clientCommitId,
      opIndex: rejection.opIndex,
      code: rejection.code,
      retryable: rejection.retryable,
      ...(rejection.details !== undefined
        ? { details: rejection.details }
        : {}),
      ...(rejection.operation !== undefined
        ? {
            operation: {
              ...(rejection.operation.changedFields !== undefined
                ? { changedFields: rejection.operation.changedFields }
                : {}),
            },
          }
        : {}),
    }));
  }

  async pendingCommitIds(): Promise<string[]> {
    return this.#client.pendingCommits().map((c) => c.clientCommitId);
  }

  async subscriptionState(
    id: string,
  ): Promise<ClientSubscriptionState | undefined> {
    const sub = this.#client.subscription(id);
    if (sub === undefined) return undefined;
    return {
      id: sub.id,
      table: sub.table,
      status: sub.status,
      cursor: sub.cursor,
      hasResumeToken: sub.bootstrapState !== undefined,
      ...(sub.effectiveScopes !== undefined
        ? { effectiveScopes: sub.effectiveScopes }
        : {}),
      ...(sub.reasonCode !== undefined ? { reasonCode: sub.reasonCode } : {}),
    };
  }

  async schemaFloor(): Promise<
    | {
        readonly requiredSchemaVersion?: number;
        readonly latestSchemaVersion?: number;
      }
    | undefined
  > {
    return this.#client.schemaFloor;
  }

  async leaseState(): Promise<
    | {
        readonly leaseId?: string;
        readonly expiresAtMs?: number;
        readonly errorCode?: string;
      }
    | undefined
  > {
    return this.#client.leaseState;
  }

  async upgrading(): Promise<boolean> {
    return this.#client.upgrading;
  }

  /**
   * §7.4.2 "app ships new code": close the current core, then open a new
   * core with the new schema on the SAME database — the boot-time §7.4.1
   * marker check fires and drives the wipe/re-bootstrap. Returns `this`
   * with the swapped core so the driver handle stays stable.
   */
  async recreateWithSchema(schema: DriverSchema): Promise<ClientInstance> {
    // Release the leader lock the old core holds; the DB stays open.
    await this.#client.close();
    this.#client = await constructClient(this.#db, schema, {
      ...this.#options,
      schema,
    });
    if (this.#client.syncNeeded) {
      this.#intents.push({ kind: 'interactive' });
    }
    this.#schema = schema;
    return this;
  }

  async connectRealtime(): Promise<void> {
    await this.#client.connectRealtime();
  }

  async disconnectRealtime(): Promise<void> {
    this.#client.disconnectRealtime();
  }

  async syncNeeded(): Promise<boolean> {
    return this.#client.syncNeeded;
  }

  async setPresence(
    scopeKey: string,
    doc: Record<string, unknown> | null,
  ): Promise<void> {
    this.#client.setPresence(scopeKey, doc);
  }

  async presence(scopeKey: string): Promise<readonly ClientPresencePeer[]> {
    return this.#client.presence(scopeKey);
  }

  async uploadBlob(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<string> {
    const ref = await this.#client.uploadBlob(bytes, options);
    return this.#client.blobRefString(ref);
  }

  async fetchBlob(blobIdOrRef: string): Promise<{ $bytes: string }> {
    const cached = await this.#client.fetchBlob(blobIdOrRef);
    return { $bytes: bytesToHex(cached.bytes) };
  }

  // §5.10.4 native CRDT: the TS core authors edits with `@syncular/crdt-yjs`'s
  // `YjsColumn` — the exact helper the reference client model is built on. The
  // edit loads the row's current merged crdt bytes, applies the op, and pushes
  // the full state baseVersion-less (the §5.10.3 crdt-only-divergence rule),
  // preserving the other columns. This mirrors the Rust driver's yrs path so
  // one scenario runs identically on both cores (byte-identical convergence).

  /** The current merged bytes of a `crdt` column, or `null` (empty document). */
  async #crdtBytes(
    table: string,
    rowId: string,
    column: string,
  ): Promise<Uint8Array | null> {
    const rows = await this.readRows(table);
    const row = rows.find((r) => r.rowId === rowId);
    const cell = row?.values[column];
    if (cell === null || cell === undefined || typeof cell !== 'object') {
      return null;
    }
    return hexToBytes(cell.$bytes);
  }

  /** Push a full-state crdt update baseVersion-less, preserving other cols. */
  async #crdtPush(
    table: string,
    rowId: string,
    column: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const schemaTable = this.#schema.tables.find((t) => t.name === table);
    if (schemaTable === undefined) throw new Error(`unknown table ${table}`);
    const rows = await this.readRows(table);
    const existing = rows.find((r) => r.rowId === rowId)?.values;
    const values: Record<string, DriverRowValue> = existing
      ? { ...existing }
      : { [schemaTable.primaryKey]: rowId };
    values[column] = { $bytes: bytesToHex(bytes) };
    await this.mutate([{ op: 'upsert', table, values: values as DriverRow }]);
  }

  async crdtText(input: {
    readonly table: string;
    readonly rowId: string;
    readonly column: string;
    readonly name?: string;
  }): Promise<string> {
    const bytes = await this.#crdtBytes(input.table, input.rowId, input.column);
    const col = new YjsColumn(bytes);
    const text = col.text(input.name).toString();
    col.destroy();
    return text;
  }

  async crdtInsertText(input: {
    readonly table: string;
    readonly rowId: string;
    readonly column: string;
    readonly name?: string;
    readonly index: number;
    readonly value: string;
  }): Promise<void> {
    const bytes = await this.#crdtBytes(input.table, input.rowId, input.column);
    const col = new YjsColumn(bytes);
    col.text(input.name).insert(input.index, input.value);
    const next = col.columnBytes();
    col.destroy();
    await this.#crdtPush(input.table, input.rowId, input.column, next);
  }

  async crdtDeleteText(input: {
    readonly table: string;
    readonly rowId: string;
    readonly column: string;
    readonly name?: string;
    readonly index: number;
    readonly len: number;
  }): Promise<void> {
    const bytes = await this.#crdtBytes(input.table, input.rowId, input.column);
    const col = new YjsColumn(bytes);
    col.text(input.name).delete(input.index, input.len);
    const next = col.columnBytes();
    col.destroy();
    await this.#crdtPush(input.table, input.rowId, input.column, next);
  }

  async crdtApplyUpdate(input: {
    readonly table: string;
    readonly rowId: string;
    readonly column: string;
    readonly update: Uint8Array;
  }): Promise<void> {
    const bytes = await this.#crdtBytes(input.table, input.rowId, input.column);
    const col = new YjsColumn(bytes);
    col.applyServerBytes(input.update);
    const next = col.columnBytes();
    col.destroy();
    await this.#crdtPush(input.table, input.rowId, input.column, next);
  }

  async close(): Promise<void> {
    await this.#client.close();
    this.#db.close();
  }
}

export const tsClientDriver: ClientDriver = {
  name: 'ts-web-client(bun:sqlite)',
  async create(options: ClientCreateOptions): Promise<ClientInstance> {
    // §5.4 capability negotiation: `constructClient` exposes `fetchUrl` iff
    // the harness endpoints have a URL host — that presence is what makes
    // the client core advertise accept bit 3. §5.9 blob transport likewise.
    const db = new BunClientDatabase();
    const client = await constructClient(db, options.schema, options);
    return new TsClientInstance(client, db, options.schema, options);
  },
};

// Re-exported so scenario assertions can name the client-side error type
// without importing the web client directly.
export { ClientSyncError };
