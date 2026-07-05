/**
 * Reference ClientDriver: the TypeScript web client
 * (`@syncular/client`) on the `bun:sqlite` backend, wired to
 * whatever transport endpoints the harness supplies. All driver inputs
 * and outputs stay JSON-able + bytes; row values convert at this edge.
 */

import {
  type ClientSchema,
  ClientSyncError,
  type MutationInput,
  SYNC_VERSION_COLUMN,
  SyncClient,
  type SyncSummary,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import type { RowValue, ScopeMap } from '@syncular/core';
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
  DriverColumn,
  DriverRow,
  DriverRowValue,
  DriverSchema,
  DriverScopeMap,
  DriverWindowBase,
} from '../driver';
import { bytesToHex, hexToBytes } from '../raw';

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
  if (column.type === 'boolean') return value !== 0 && value !== false;
  if (column.type === 'bytes' || column.type === 'crdt') {
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
  const blobs =
    uploadBlob !== undefined && downloadBlob !== undefined
      ? {
          upload: (blobId: string, bytes: Uint8Array, mediaType?: string) =>
            uploadBlob(blobId, bytes, mediaType),
          download: (blobId: string) => downloadBlob(blobId),
        }
      : undefined;
  const client = new SyncClient({
    database: db,
    schema: toClientSchema(schema),
    clientId: options.clientId,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(nowMs !== undefined ? { now: () => nowMs } : {}),
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
    await this.#client.setWindow(
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
  }

  async windowState(
    base: DriverWindowBase,
  ): Promise<{ readonly units: readonly string[] }> {
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
    return this.#client.mutate(inputs);
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
    const rows = this.#client.query(
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
      };
    });
  }

  async rejections(): Promise<ClientRejection[]> {
    return this.#client.rejections.map((rejection) => ({
      clientCommitId: rejection.clientCommitId,
      opIndex: rejection.opIndex,
      code: rejection.code,
      retryable: rejection.retryable,
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
