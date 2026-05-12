import type {
  ScopeValues,
  SyncOperation,
  SyncOperationResult,
} from '@syncular/core';
import type {
  SyncularV2ClientConfig,
  SyncularV2SqlResult,
  SyncularV2Storage,
} from './types';
import {
  getSyncularV2WasmUrl,
  loadSyncularV2WasmGlue,
  type SyncularV2WasmGlue,
} from './wasm-runtime';

export interface SyncularRustOwnedSqliteConfig {
  fileName?: string;
  storage?: SyncularV2Storage;
  clearOnInit?: boolean;
  stateId?: string;
  schemaVersion?: number;
}

export interface SyncularRustOwnedSqliteClientConfig
  extends SyncularV2ClientConfig {}

export interface CreateSyncularRustOwnedSqliteOptions {
  module?: SyncularV2WasmGlue | Promise<SyncularV2WasmGlue>;
  wasmUrl?: string | URL | Request;
  config?: SyncularRustOwnedSqliteConfig;
}

export interface RustSubscriptionState {
  subscription_id: string;
  table: string;
  scopes: ScopeValues;
  cursor: number;
  bootstrap_state: unknown | null;
  status: string;
}

export interface RustOutboxCommit {
  id: string;
  client_commit_id: string;
  status: string;
  operations_json: string;
  last_response_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  attempt_count: number;
  acked_commit_seq: number | null;
  schema_version: number;
}

export interface RustConflictSummary {
  id: string;
  client_commit_id: string;
  op_index: number;
  result_status: string;
  message: string;
  code: string | null;
  server_version: number | null;
  resolved_at: number | null;
  resolution: string | null;
}

export type RustOperationResult =
  | (Extract<SyncOperationResult, { status: 'conflict' }> & { opIndex: number })
  | (Extract<SyncOperationResult, { status: 'error' }> & { opIndex: number })
  | {
      opIndex: number;
      status: string;
      message?: string | null;
      error?: string | null;
      code?: string | null;
      server_version?: number | null;
      server_row?: unknown;
    };

export interface RawSyncularRustOwnedSqlite {
  executeSqlJson(sql: string, paramsJson: string): string;
  generatedSchemaStateJson(): string;
  subscribeQueryJson(
    sql: string,
    paramsJson: string,
    tablesJson: string
  ): string;
  unsubscribeQuery(id: string): void;
  drainLiveQueryEventsJson(): string;
  applyLocalOperationsBatchJson(operationsJson: string): string;
  applyLocalOperationsCommitJson(operationsJson: string): string;
  pendingOutboxJson(limit: number): Promise<string>;
  insertConflictJson(outboxJson: string, resultJson: string): Promise<void>;
  conflictSummariesJson(): Promise<string>;
  retryConflictKeepLocal(id: string): Promise<string>;
  resolveConflict(id: string, resolution: string): Promise<void>;
  subscriptionStateJson(subscriptionId: string): Promise<string>;
  upsertSubscriptionStateJson(stateJson: string): Promise<void>;
  deleteSubscriptionState(subscriptionId: string): Promise<void>;
  clearTableForScopesJson(table: string, scopesJson: string): Promise<void>;
  applyChangeJson(changeJson: string): Promise<void>;
  listTableJson(table: string): Promise<string>;
  countRows(table: string): number;
  close(): void;
}

export interface SyncularRustOwnedSchemaState {
  schemaId: string;
  schemaVersion: number | null;
  currentSchemaVersion: number;
  updatedAt: number | null;
}

export interface SyncularRustSqliteExecutor {
  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): SyncularV2SqlResult<Row>;
  subscribeQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
    tables: readonly string[]
  ): RustOwnedLiveQuerySnapshot<Row>;
  unsubscribeQuery(id: string): void;
  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Array<RustOwnedLiveQueryEvent<Row>>;
  close?(): void;
}

export interface RustOwnedLiveQuerySnapshot<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  rows: Row[];
}

export interface RustOwnedLiveQueryEvent<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  queryId: string;
  version: number;
  rows: Row[];
}

export async function createSyncularRustOwnedSqlite(
  options: CreateSyncularRustOwnedSqliteOptions
): Promise<SyncularRustOwnedSqlite> {
  const mod = await (options.module ?? loadSyncularV2WasmGlue());
  await mod.default(options.wasmUrl ?? getSyncularV2WasmUrl());
  return new SyncularRustOwnedSqlite(
    await mod.openSyncularRustOwnedSqlite(options.config ?? {})
  );
}

export class SyncularRustOwnedSqlite implements SyncularRustSqliteExecutor {
  constructor(private readonly raw: RawSyncularRustOwnedSqlite) {}

  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): SyncularV2SqlResult<Row> {
    return parseJson(this.raw.executeSqlJson(sql, stringifyParams(params)));
  }

  subscribeQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
    tables: readonly string[]
  ): RustOwnedLiveQuerySnapshot<Row> {
    return parseJson(
      this.raw.subscribeQueryJson(
        sql,
        stringifyParams(params),
        JSON.stringify(tables)
      )
    );
  }

  unsubscribeQuery(id: string): void {
    this.raw.unsubscribeQuery(id);
  }

  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Array<RustOwnedLiveQueryEvent<Row>> {
    return parseJson(this.raw.drainLiveQueryEventsJson());
  }

  generatedSchemaState(): SyncularRustOwnedSchemaState {
    return parseJson(this.raw.generatedSchemaStateJson());
  }

  applyLocalOperationsBatch(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): string[] {
    return parseJson(
      this.raw.applyLocalOperationsBatchJson(JSON.stringify(operations))
    );
  }

  applyLocalOperationsCommit(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): string {
    return parseJson(
      this.raw.applyLocalOperationsCommitJson(JSON.stringify(operations))
    );
  }

  async pendingOutbox(limit: number): Promise<RustOutboxCommit[]> {
    return parseJson(await this.raw.pendingOutboxJson(limit));
  }

  insertConflict(
    outbox: RustOutboxCommit,
    result: RustOperationResult
  ): Promise<void> {
    return this.raw.insertConflictJson(
      JSON.stringify(outbox),
      JSON.stringify(result)
    );
  }

  async conflictSummaries(): Promise<RustConflictSummary[]> {
    return parseJson(await this.raw.conflictSummariesJson());
  }

  retryConflictKeepLocal(id: string): Promise<string> {
    return this.raw.retryConflictKeepLocal(id);
  }

  resolveConflict(id: string, resolution: string): Promise<void> {
    return this.raw.resolveConflict(id, resolution);
  }

  async subscriptionState(
    subscriptionId: string
  ): Promise<RustSubscriptionState | null> {
    return parseJson(await this.raw.subscriptionStateJson(subscriptionId));
  }

  upsertSubscriptionState(state: RustSubscriptionState): Promise<void> {
    return this.raw.upsertSubscriptionStateJson(JSON.stringify(state));
  }

  deleteSubscriptionState(subscriptionId: string): Promise<void> {
    return this.raw.deleteSubscriptionState(subscriptionId);
  }

  clearTableForScopes(
    table: string,
    scopes: Record<string, unknown>
  ): Promise<void> {
    return this.raw.clearTableForScopesJson(table, JSON.stringify(scopes));
  }

  applyChange(change: unknown): Promise<void> {
    return this.raw.applyChangeJson(JSON.stringify(change));
  }

  async listTable<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(table: string): Promise<Row[]> {
    return parseJson(await this.raw.listTableJson(table));
  }

  countRows(table: string): number {
    return this.raw.countRows(table);
  }

  close(): void {
    this.raw.close();
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyParams(params: readonly unknown[]): string {
  return JSON.stringify(params, (_key, value) => {
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Uint8Array) return Array.from(value);
    return value;
  });
}
