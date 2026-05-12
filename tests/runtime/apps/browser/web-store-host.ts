import {
  ensureClientSyncSchema,
  outbox,
  type SyncClientDb,
} from '@syncular/client';
import type {
  ScopeValues,
  SyncChange,
  SyncOperation,
  SyncOperationResult,
  SyncPushResponse,
} from '@syncular/core';
import { randomId } from '@syncular/core';
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';

type AnyRow = Record<string, unknown>;
type HostDb = SyncClientDb & Record<string, AnyRow>;
type DbExecutor = Kysely<HostDb> | Transaction<HostDb>;
type TableConfigResolver = (
  table: string
) => Required<SyncularWebStoreTableConfig>;

export interface SyncularWebStoreTableConfig {
  primaryKeyColumn?: string;
  serverVersionColumn?: string;
  scopeColumns?: Record<string, string>;
}

export interface SyncularWebStoreHostConfig {
  tables: Record<string, SyncularWebStoreTableConfig>;
  stateId?: string;
  schemaVersion?: number;
}

export interface WebSubscriptionState {
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

export interface SyncularWebStoreLocalOperation {
  operation: SyncOperation;
  localRow?: unknown | null;
}

export interface SyncularWebStoreHost {
  applyLocalOperation(
    operation: SyncOperation,
    localRow: unknown | null
  ): Promise<string>;
  applyLocalOperationsBatch(
    operations: SyncularWebStoreLocalOperation[]
  ): Promise<string[]>;
  applyLocalOperationsCommit(
    operations: SyncularWebStoreLocalOperation[]
  ): Promise<string>;
  pendingOutbox(limit: number): Promise<RustOutboxCommit[]>;
  markOutboxSending(rowId: string): Promise<void>;
  markOutboxAcked(rowId: string, response: SyncPushResponse): Promise<void>;
  markOutboxFailed(
    rowId: string,
    error: string,
    response: SyncPushResponse
  ): Promise<void>;
  insertConflict(
    outboxCommit: RustOutboxCommit,
    result: RustOperationResult
  ): Promise<void>;
  conflictSummaries(): Promise<RustConflictSummary[]>;
  resolveConflict(id: string, resolution: string): Promise<void>;
  retryConflictKeepLocal(id: string): Promise<string>;
  subscriptionState(
    subscriptionId: string
  ): Promise<WebSubscriptionState | null>;
  upsertSubscriptionState(state: WebSubscriptionState): Promise<void>;
  deleteSubscriptionState(subscriptionId: string): Promise<void>;
  clearTableForScopes(table: string, scopes: ScopeValues): Promise<void>;
  upsertRow(table: string, row: unknown): Promise<void>;
  applyChange(change: SyncChange): Promise<void>;
  listTableJson(table: string): Promise<string>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_STATE_ID = 'default';

export async function createSyncularWebStoreHost<DB extends object>(
  inputDb: Kysely<DB>,
  config: SyncularWebStoreHostConfig
): Promise<SyncularWebStoreHost> {
  const db = inputDb as unknown as Kysely<HostDb>;
  await ensureClientSyncSchema(db);
  const stateId = config.stateId ?? DEFAULT_STATE_ID;
  const schemaVersion = config.schemaVersion ?? 1;

  const tableConfig = (
    table: string
  ): Required<SyncularWebStoreTableConfig> => {
    assertIdentifier(table, 'table');
    const entry = config.tables[table];
    if (!entry) {
      throw new Error(`No Syncular web store table config for "${table}"`);
    }
    const primaryKeyColumn = entry.primaryKeyColumn ?? 'id';
    assertIdentifier(primaryKeyColumn, `${table} primary key`);
    if (entry.serverVersionColumn) {
      assertIdentifier(entry.serverVersionColumn, `${table} server version`);
    }
    for (const [scopeName, column] of Object.entries(
      entry.scopeColumns ?? {}
    )) {
      assertIdentifier(scopeName, `${table} scope name`);
      assertIdentifier(column, `${table} scope column`);
    }
    return {
      primaryKeyColumn,
      serverVersionColumn: entry.serverVersionColumn ?? 'server_version',
      scopeColumns: entry.scopeColumns ?? {},
    };
  };

  return {
    async applyLocalOperation(operation, localRow) {
      const [clientCommitId] = await applyLocalOperationsBatch(
        db,
        tableConfig,
        {
          schemaVersion,
          operations: [{ operation, localRow }],
        }
      );
      if (!clientCommitId) throw new Error('Failed to queue outbox commit');
      return clientCommitId;
    },

    applyLocalOperationsBatch(operations) {
      return applyLocalOperationsBatch(db, tableConfig, {
        schemaVersion,
        operations,
      });
    },
    applyLocalOperationsCommit(operations) {
      return applyLocalOperationsCommit(db, tableConfig, {
        schemaVersion,
        operations,
      });
    },

    pendingOutbox(limit) {
      return outboxRows(db, limit);
    },

    async markOutboxSending(rowId) {
      await outbox.mark.sending(db, rowId);
    },

    async markOutboxAcked(rowId, response) {
      await outbox.mark.acked(db, {
        id: rowId,
        commitSeq: response.commitSeq ?? null,
        responseJson: JSON.stringify(response),
      });
    },

    async markOutboxFailed(rowId, error, response) {
      await outbox.mark.failed(db, {
        id: rowId,
        error,
        responseJson: JSON.stringify(response),
      });
    },

    async insertConflict(outboxCommit, result) {
      await insertConflictRow(db, outboxCommit, result);
    },

    conflictSummaries() {
      return conflictSummaryRows(db);
    },

    async resolveConflict(id, resolution) {
      await resolveConflictRow(db, id, resolution);
    },

    async retryConflictKeepLocal(id) {
      return retryConflictKeepLocal(db, id, schemaVersion);
    },

    async subscriptionState(subscriptionId) {
      const rows = await sql<{
        subscription_id: string;
        table: string;
        scopes_json: string;
        cursor: number;
        bootstrap_state_json: string | null;
        status: string;
      }>`
        select
          ${sql.ref('subscription_id')},
          ${sql.ref('table')},
          ${sql.ref('scopes_json')},
          ${sql.ref('cursor')},
          ${sql.ref('bootstrap_state_json')},
          ${sql.ref('status')}
        from ${sql.table('sync_subscription_state')}
        where ${sql.ref('state_id')} = ${sql.val(stateId)}
          and ${sql.ref('subscription_id')} = ${sql.val(subscriptionId)}
        limit 1
      `.execute(db);
      const row = rows.rows[0];
      if (!row) return null;
      return {
        subscription_id: row.subscription_id,
        table: row.table,
        scopes: parseJsonObject(row.scopes_json),
        cursor: Number(row.cursor),
        bootstrap_state: parseJsonValue(row.bootstrap_state_json),
        status: row.status,
      };
    },

    async upsertSubscriptionState(state) {
      const now = Date.now();
      await sql`
        insert into ${sql.table('sync_subscription_state')} (
          ${sql.ref('state_id')},
          ${sql.ref('subscription_id')},
          ${sql.ref('table')},
          ${sql.ref('scopes_json')},
          ${sql.ref('params_json')},
          ${sql.ref('cursor')},
          ${sql.ref('bootstrap_state_json')},
          ${sql.ref('status')},
          ${sql.ref('created_at')},
          ${sql.ref('updated_at')}
        ) values (
          ${sql.val(stateId)},
          ${sql.val(state.subscription_id)},
          ${sql.val(state.table)},
          ${sql.val(JSON.stringify(state.scopes ?? {}))},
          ${sql.val('{}')},
          ${sql.val(state.cursor)},
          ${sql.val(state.bootstrap_state == null ? null : JSON.stringify(state.bootstrap_state))},
          ${sql.val(state.status)},
          ${sql.val(now)},
          ${sql.val(now)}
        )
        on conflict (${sql.ref('state_id')}, ${sql.ref('subscription_id')})
        do update set
          ${sql.ref('table')} = ${sql.val(state.table)},
          ${sql.ref('scopes_json')} = ${sql.val(JSON.stringify(state.scopes ?? {}))},
          ${sql.ref('cursor')} = ${sql.val(state.cursor)},
          ${sql.ref('bootstrap_state_json')} = ${sql.val(
            state.bootstrap_state == null
              ? null
              : JSON.stringify(state.bootstrap_state)
          )},
          ${sql.ref('status')} = ${sql.val(state.status)},
          ${sql.ref('updated_at')} = ${sql.val(now)}
      `.execute(db);
    },

    async deleteSubscriptionState(subscriptionId) {
      await sql`
        delete from ${sql.table('sync_subscription_state')}
        where ${sql.ref('state_id')} = ${sql.val(stateId)}
          and ${sql.ref('subscription_id')} = ${sql.val(subscriptionId)}
      `.execute(db);
    },

    async clearTableForScopes(table, scopes) {
      const cfg = tableConfig(table);
      const filters = Object.entries(scopes ?? {}).map(([scopeName, value]) => {
        const column = cfg.scopeColumns[scopeName] ?? scopeName;
        assertIdentifier(scopeName, `${table} scope name`);
        assertIdentifier(column, `${table} scope column`);
        if (Array.isArray(value)) {
          return sql`${sql.ref(column)} in (${sql.join(value.map((item) => sql.val(item)))})`;
        }
        return sql`${sql.ref(column)} = ${sql.val(value)}`;
      });
      if (filters.length === 0) {
        await sql`delete from ${sql.table(table)}`.execute(db);
        return;
      }
      await sql`
        delete from ${sql.table(table)}
        where ${sql.join(filters, sql` and `)}
      `.execute(db);
    },

    async upsertRow(table, row) {
      const cfg = tableConfig(table);
      await upsertRowByPrimaryKey(
        db,
        table,
        cfg.primaryKeyColumn,
        objectRow(row)
      );
    },

    async applyChange(change) {
      const cfg = tableConfig(change.table);
      if (change.op === 'delete') {
        await deleteRow(db, change.table, cfg.primaryKeyColumn, change.row_id);
        return;
      }
      const row = objectRow(change.row_json ?? {});
      row[cfg.primaryKeyColumn] = change.row_id;
      if (change.row_version != null) {
        row[cfg.serverVersionColumn] = change.row_version;
      }
      await upsertRowByPrimaryKey(db, change.table, cfg.primaryKeyColumn, row);
    },

    async listTableJson(table) {
      tableConfig(table);
      const rows = await sql<AnyRow>`
        select * from ${sql.table(table)}
      `.execute(db);
      return JSON.stringify(rows.rows);
    },
  };
}

async function applyLocalOperationsBatch(
  db: Kysely<HostDb>,
  tableConfig: TableConfigResolver,
  args: {
    schemaVersion: number;
    operations: SyncularWebStoreLocalOperation[];
  }
): Promise<string[]> {
  if (args.operations.length === 0) return [];

  const clientCommitIds: string[] = [];
  await db.transaction().execute(async (trx) => {
    for (const item of args.operations) {
      const operation = item.operation;
      const table = tableConfig(operation.table);
      if (operation.op === 'delete') {
        await deleteRow(
          trx,
          operation.table,
          table.primaryKeyColumn,
          operation.row_id
        );
      } else if (operation.op === 'upsert') {
        const row = rowFromLocalOperation(
          operation,
          item.localRow ?? null,
          table.primaryKeyColumn
        );
        await upsertRowByPrimaryKey(
          trx,
          operation.table,
          table.primaryKeyColumn,
          row
        );
      } else {
        throw new Error(`Unsupported Syncular operation "${operation.op}"`);
      }

      const queued = await outbox.enqueue(
        trx as unknown as Kysely<SyncClientDb>,
        {
          operations: [operation],
          schemaVersion: args.schemaVersion,
        }
      );
      clientCommitIds.push(queued.clientCommitId);
    }
  });

  return clientCommitIds;
}

async function applyLocalOperationsCommit(
  db: Kysely<HostDb>,
  tableConfig: TableConfigResolver,
  args: {
    schemaVersion: number;
    operations: SyncularWebStoreLocalOperation[];
  }
): Promise<string> {
  if (args.operations.length === 0) {
    throw new Error(
      'applyLocalOperationsCommit requires at least one operation'
    );
  }

  return await db.transaction().execute(async (trx) => {
    const operations: SyncOperation[] = [];
    for (const item of args.operations) {
      const operation = item.operation;
      await applyLocalOperationRow(trx, tableConfig, item);
      operations.push(operation);
    }

    const queued = await outbox.enqueue(
      trx as unknown as Kysely<SyncClientDb>,
      {
        operations,
        schemaVersion: args.schemaVersion,
      }
    );
    return queued.clientCommitId;
  });
}

async function applyLocalOperationRow(
  db: DbExecutor,
  tableConfig: TableConfigResolver,
  item: SyncularWebStoreLocalOperation
): Promise<void> {
  const operation = item.operation;
  const table = tableConfig(operation.table);
  if (operation.op === 'delete') {
    await deleteRow(
      db,
      operation.table,
      table.primaryKeyColumn,
      operation.row_id
    );
    return;
  }

  if (operation.op === 'upsert') {
    const row = rowFromLocalOperation(
      operation,
      item.localRow ?? null,
      table.primaryKeyColumn
    );
    await upsertRowByPrimaryKey(
      db,
      operation.table,
      table.primaryKeyColumn,
      row
    );
    return;
  }

  throw new Error(`Unsupported Syncular operation "${operation.op}"`);
}

function assertIdentifier(identifier: string, label: string): void {
  if (!IDENTIFIER.test(identifier)) {
    throw new Error(`Invalid ${label} identifier "${identifier}"`);
  }
}

function objectRow(value: unknown): AnyRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as AnyRow) };
}

function rowFromLocalOperation(
  operation: SyncOperation,
  localRow: unknown,
  primaryKeyColumn: string
): AnyRow {
  const row = Object.keys(objectRow(localRow)).length
    ? objectRow(localRow)
    : objectRow(operation.payload);
  row[primaryKeyColumn] = operation.row_id;
  return row;
}

async function upsertRowByPrimaryKey(
  db: DbExecutor,
  table: string,
  primaryKeyColumn: string,
  row: AnyRow
): Promise<void> {
  assertIdentifier(table, 'table');
  assertIdentifier(primaryKeyColumn, `${table} primary key`);
  const next = { ...row };
  const primaryKey = next[primaryKeyColumn];
  if (typeof primaryKey !== 'string') {
    throw new Error(
      `Row for "${table}" must include string ${primaryKeyColumn}`
    );
  }
  const columns = Object.keys(next);
  for (const column of columns) assertIdentifier(column, `${table} column`);
  if (columns.length === 0) return;
  const updateColumns = columns.filter((column) => column !== primaryKeyColumn);
  const onConflict =
    updateColumns.length === 0
      ? sql`do nothing`
      : sql`do update set ${sql.join(
          updateColumns.map(
            (column) =>
              sql`${sql.ref(column)} = ${sql.ref(`excluded.${column}`)}`
          ),
          sql`, `
        )}`;

  await sql`
    insert into ${sql.table(table)} (${sql.join(columns.map((column) => sql.ref(column)))})
    values (${sql.join(columns.map((column) => sql.val(next[column] ?? null)))})
    on conflict (${sql.ref(primaryKeyColumn)}) ${onConflict}
  `.execute(db);
}

async function deleteRow(
  db: DbExecutor,
  table: string,
  primaryKeyColumn: string,
  rowId: string
): Promise<void> {
  assertIdentifier(table, 'table');
  assertIdentifier(primaryKeyColumn, `${table} primary key`);
  await sql`
    delete from ${sql.table(table)}
    where ${sql.ref(primaryKeyColumn)} = ${sql.val(rowId)}
  `.execute(db);
}

async function outboxRows(
  db: Kysely<HostDb>,
  limit: number,
  options: { newestFirst?: boolean } = {}
): Promise<RustOutboxCommit[]> {
  const rows = await sql<RustOutboxCommit>`
    select
      ${sql.ref('id')},
      ${sql.ref('client_commit_id')},
      ${sql.ref('status')},
      ${sql.ref('operations_json')},
      ${sql.ref('last_response_json')},
      ${sql.ref('error')},
      ${sql.ref('created_at')},
      ${sql.ref('updated_at')},
      ${sql.ref('attempt_count')},
      ${sql.ref('acked_commit_seq')},
      ${sql.ref('schema_version')}
    from ${sql.table('sync_outbox_commits')}
    where ${sql.ref('status')} = ${sql.val('pending')}
    order by ${sql.ref('created_at')} ${options.newestFirst ? sql`desc` : sql`asc`}
    limit ${sql.val(Math.max(0, Math.floor(limit)))}
  `.execute(db);
  return rows.rows.map(normalizeOutboxRow);
}

function normalizeOutboxRow(row: RustOutboxCommit): RustOutboxCommit {
  return {
    ...row,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    attempt_count: Number(row.attempt_count),
    acked_commit_seq:
      row.acked_commit_seq == null ? null : Number(row.acked_commit_seq),
    schema_version: row.schema_version == null ? 1 : Number(row.schema_version),
  };
}

async function insertConflictRow(
  db: Kysely<HostDb>,
  outboxCommit: RustOutboxCommit,
  result: RustOperationResult
): Promise<void> {
  const now = Date.now();
  const message =
    'message' in result && result.message
      ? result.message
      : 'error' in result && result.error
        ? result.error
        : result.status;
  await sql`
    insert into ${sql.table('sync_conflicts')} (
      ${sql.ref('id')},
      ${sql.ref('outbox_commit_id')},
      ${sql.ref('client_commit_id')},
      ${sql.ref('op_index')},
      ${sql.ref('result_status')},
      ${sql.ref('message')},
      ${sql.ref('code')},
      ${sql.ref('server_version')},
      ${sql.ref('server_row_json')},
      ${sql.ref('created_at')},
      ${sql.ref('resolved_at')},
      ${sql.ref('resolution')}
    ) values (
      ${sql.val(randomId())},
      ${sql.val(outboxCommit.id)},
      ${sql.val(outboxCommit.client_commit_id)},
      ${sql.val(result.opIndex)},
      ${sql.val(result.status)},
      ${sql.val(message)},
      ${sql.val('code' in result ? (result.code ?? null) : null)},
      ${sql.val('server_version' in result ? (result.server_version ?? null) : null)},
      ${sql.val(
        'server_row' in result && result.server_row !== undefined
          ? JSON.stringify(result.server_row)
          : null
      )},
      ${sql.val(now)},
      ${sql.val(null)},
      ${sql.val(null)}
    )
  `.execute(db);
}

async function conflictSummaryRows(
  db: Kysely<HostDb>
): Promise<RustConflictSummary[]> {
  const rows = await sql<RustConflictSummary>`
    select
      ${sql.ref('id')},
      ${sql.ref('client_commit_id')},
      ${sql.ref('op_index')},
      ${sql.ref('result_status')},
      ${sql.ref('message')},
      ${sql.ref('code')},
      ${sql.ref('server_version')},
      ${sql.ref('resolved_at')},
      ${sql.ref('resolution')}
    from ${sql.table('sync_conflicts')}
    where ${sql.ref('resolved_at')} is null
    order by ${sql.ref('created_at')} desc
  `.execute(db);
  return rows.rows.map((row) => ({
    ...row,
    op_index: Number(row.op_index),
    server_version:
      row.server_version == null ? null : Number(row.server_version),
    resolved_at: row.resolved_at == null ? null : Number(row.resolved_at),
  }));
}

async function resolveConflictRow(
  db: Kysely<HostDb>,
  id: string,
  resolution: string
): Promise<void> {
  await sql`
    update ${sql.table('sync_conflicts')}
    set
      ${sql.ref('resolved_at')} = ${sql.val(Date.now())},
      ${sql.ref('resolution')} = ${sql.val(resolution)}
    where ${sql.ref('id')} = ${sql.val(id)}
      and ${sql.ref('resolved_at')} is null
  `.execute(db);
}

async function retryConflictKeepLocal(
  db: Kysely<HostDb>,
  id: string,
  schemaVersion: number
): Promise<string> {
  let clientCommitId = '';
  await db.transaction().execute(async (trx) => {
    const rows = await sql<{
      op_index: number;
      server_version: number | null;
      operations_json: string;
    }>`
      select
        ${sql.ref('c.op_index')} as ${sql.ref('op_index')},
        ${sql.ref('c.server_version')} as ${sql.ref('server_version')},
        ${sql.ref('o.operations_json')} as ${sql.ref('operations_json')}
      from ${sql.table('sync_conflicts')} as ${sql.ref('c')}
      join ${sql.table('sync_outbox_commits')} as ${sql.ref('o')}
        on ${sql.ref('o.id')} = ${sql.ref('c.outbox_commit_id')}
      where ${sql.ref('c.id')} = ${sql.val(id)}
        and ${sql.ref('c.resolved_at')} is null
      limit 1
    `.execute(trx);
    const row = rows.rows[0];
    if (!row) throw new Error(`Pending conflict not found: ${id}`);
    if (row.server_version == null) {
      throw new Error(
        `Conflict ${id} cannot be retried keep-local without server version`
      );
    }
    const operations = parseOperations(row.operations_json);
    const opIndex = Number(row.op_index);
    const operation = operations[opIndex];
    if (!operation) {
      throw new Error(
        `Conflict ${id} references missing operation index ${opIndex}`
      );
    }
    const retryOperation: SyncOperation = {
      ...operation,
      base_version: Number(row.server_version),
    };
    const queued = await outbox.enqueue(
      trx as unknown as Kysely<SyncClientDb>,
      {
        operations: [retryOperation],
        schemaVersion,
      }
    );
    clientCommitId = queued.clientCommitId;
    await sql`
      update ${sql.table('sync_conflicts')}
      set
        ${sql.ref('resolved_at')} = ${sql.val(Date.now())},
        ${sql.ref('resolution')} = ${sql.val('keep-local')}
      where ${sql.ref('id')} = ${sql.val(id)}
    `.execute(trx);
  });
  return clientCommitId;
}

function parseOperations(value: string): SyncOperation[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isSyncOperation);
}

function isSyncOperation(value: unknown): value is SyncOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.table === 'string' &&
    typeof row.row_id === 'string' &&
    (row.op === 'upsert' || row.op === 'delete')
  );
}

function parseJsonValue(value: string | null): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseJsonObject(value: string): ScopeValues {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as ScopeValues)
    : {};
}
