import { randomId } from '@syncular/core';
import {
  createMutationsApi,
  type MutationReceipt,
  type MutationsApi,
  type MutationsCommitFn,
  type MutationsTx,
  type TableMutationsTx,
} from './mutations';
import type {
  SyncularV2SqlClient,
  SyncularV2TableConfigMap,
  SyncularV2UnsafeSqlClient,
} from './types';

type AnyDb = Record<string, Record<string, unknown>>;
type MutationScope = 'mutations' | 'leasedMutations';
type RowSnapshot = Record<string, unknown> | null;

interface HistoryRow extends Record<string, unknown> {
  id: string;
  mutation_scope: MutationScope;
  state: 'done' | 'undone';
  entries_json: string;
  client_commit_id: string;
  undo_client_commit_id: string | null;
  redo_client_commit_id: string | null;
  created_at: number;
  updated_at: number;
}

interface CommandEntry {
  table: string;
  rowId: string;
  before: RowSnapshot;
  after: RowSnapshot;
}

interface PendingCommandEntry {
  table: string;
  rowId: string;
  before: RowSnapshot;
}

export type SyncularV2CommandHistoryErrorCode =
  | 'sync.command_history_empty'
  | 'sync.command_history_conflict'
  | 'sync.command_history_storage_unavailable'
  | 'sync.command_history_table_unsupported'
  | 'sync.command_history_unsafe_field';

export class SyncularV2CommandHistoryError extends Error {
  readonly code: SyncularV2CommandHistoryErrorCode;
  readonly commandId?: string;

  constructor(
    code: SyncularV2CommandHistoryErrorCode,
    message: string,
    options: { commandId?: string } = {}
  ) {
    super(message);
    this.name = 'SyncularV2CommandHistoryError';
    this.code = code;
    this.commandId = options.commandId;
  }
}

export interface SyncularV2CommandHistoryReceipt extends MutationReceipt {
  commandId: string;
}

export interface SyncularV2CommandHistory {
  canUndo(): Promise<boolean>;
  canRedo(): Promise<boolean>;
  undoLast(): Promise<SyncularV2CommandHistoryReceipt>;
  redoLast(): Promise<SyncularV2CommandHistoryReceipt>;
}

export interface SyncularV2CommandHistoryController<DB> {
  history: SyncularV2CommandHistory;
  wrapMutations(
    mutations: MutationsApi<DB, undefined>,
    scope: MutationScope
  ): MutationsApi<DB, undefined>;
}

export interface CreateSyncularV2CommandHistoryOptions<DB> {
  client: SyncularV2SqlClient & Partial<SyncularV2UnsafeSqlClient>;
  tableConfig: SyncularV2TableConfigMap;
  mutations: MutationsApi<DB, undefined>;
  leasedMutations: MutationsApi<DB, undefined>;
  nowMs?: () => number;
  idFactory?: () => string;
}

export function createSyncularV2CommandHistory<DB>(
  options: CreateSyncularV2CommandHistoryOptions<DB>
): SyncularV2CommandHistoryController<DB> {
  const store = new CommandHistoryStore(options);
  const history = new CommandHistory(options, store);

  return {
    history,
    wrapMutations(mutations, scope) {
      return createMutationsApi(createTrackedCommit(mutations, scope, history));
    },
  };
}

function createTrackedCommit<DB>(
  mutations: MutationsApi<DB, undefined>,
  scope: MutationScope,
  history: CommandHistory<DB>
): MutationsCommitFn<DB, void, undefined> {
  return async (fn) => {
    await history.ensureReady();
    const recorder = new PendingCommandRecorder(history);
    const { result, commit } = await mutations.$commit(async (tx) =>
      fn(createTrackedTx(tx, recorder) as MutationsTx<DB>)
    );
    await recorder.recordCommitted(scope, commit);
    return { result, receipt: commit, meta: undefined };
  };
}

function createTrackedTx<DB>(
  tx: MutationsTx<DB>,
  recorder: PendingCommandRecorder<DB>
): MutationsTx<DB> {
  const tableCache = new Map<string, TableMutationsTx<AnyDb, string>>();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        if (typeof prop !== 'string') return undefined;
        const cached = tableCache.get(prop);
        if (cached) return cached;
        const tableTx = tx[prop] as TableMutationsTx<AnyDb, string> | undefined;
        if (!tableTx) return undefined;
        const tracked = createTrackedTableTx(prop, tableTx, recorder);
        tableCache.set(prop, tracked);
        return tracked;
      },
    }
  ) as MutationsTx<DB>;
}

function createTrackedTableTx<DB>(
  table: string,
  tableTx: TableMutationsTx<AnyDb, string>,
  recorder: PendingCommandRecorder<DB>
): TableMutationsTx<AnyDb, string> {
  return {
    async insert(values) {
      const id = await tableTx.insert(values);
      await recorder.track(table, id);
      return id;
    },
    async insertMany(rows) {
      const ids = await tableTx.insertMany(rows);
      for (const id of ids) await recorder.track(table, id);
      return ids;
    },
    async update(id, patch, options) {
      await recorder.track(table, id);
      await tableTx.update(id, patch, options);
    },
    async delete(id, options) {
      await recorder.track(table, id);
      await tableTx.delete(id, options);
    },
    async upsert(id, patch, options) {
      await recorder.track(table, id);
      await tableTx.upsert(id, patch, options);
    },
  };
}

class PendingCommandRecorder<DB> {
  readonly #entries = new Map<string, PendingCommandEntry>();

  constructor(private readonly history: CommandHistory<DB>) {}

  async track(table: string, rowId: string): Promise<void> {
    const key = `${table}\0${rowId}`;
    if (this.#entries.has(key)) return;
    this.#entries.set(key, {
      table,
      rowId,
      before: await this.history.readRow(table, rowId),
    });
  }

  async recordCommitted(
    scope: MutationScope,
    receipt: MutationReceipt
  ): Promise<void> {
    if (this.#entries.size === 0) return;
    const entries: CommandEntry[] = [];
    for (const entry of this.#entries.values()) {
      const after = await this.history.readRow(entry.table, entry.rowId);
      if (sameSnapshot(entry.before, after)) continue;
      entries.push({ ...entry, after });
    }
    if (entries.length === 0) return;
    await this.history.record(scope, entries, receipt);
  }
}

class CommandHistory<DB> implements SyncularV2CommandHistory {
  constructor(
    private readonly options: CreateSyncularV2CommandHistoryOptions<DB>,
    private readonly store: CommandHistoryStore<DB>
  ) {}

  ensureReady(): Promise<void> {
    return this.store.ensureReady();
  }

  readRow(table: string, rowId: string): Promise<RowSnapshot> {
    const config = this.options.tableConfig[table];
    if (!config) {
      throw new SyncularV2CommandHistoryError(
        'sync.command_history_table_unsupported',
        `Cannot record undo history for unsupported table ${table}`
      );
    }
    return readCurrentRow(
      this.options.client,
      table,
      config.primaryKeyColumn ?? 'id',
      rowId
    );
  }

  record(
    scope: MutationScope,
    entries: CommandEntry[],
    receipt: MutationReceipt
  ): Promise<void> {
    return this.store.insert(scope, entries, receipt);
  }

  async canUndo(): Promise<boolean> {
    await this.ensureReady();
    return (await this.store.latest('done')) !== null;
  }

  async canRedo(): Promise<boolean> {
    await this.ensureReady();
    return (await this.store.latest('undone')) !== null;
  }

  async undoLast(): Promise<SyncularV2CommandHistoryReceipt> {
    await this.ensureReady();
    const command = await this.store.latest('done');
    if (!command) {
      throw new SyncularV2CommandHistoryError(
        'sync.command_history_empty',
        'There is no Syncular command to undo'
      );
    }
    const entries = decodeEntries(command);
    this.assertSafeReplay(command.id, entries);
    await this.assertCurrentRows(command.id, entries, 'after');
    const commit = await this.applySnapshots(
      command.mutation_scope,
      [...entries].reverse().map((entry) => ({
        table: entry.table,
        rowId: entry.rowId,
        snapshot: entry.before,
      }))
    );
    await this.store.mark(command.id, 'undone', commit);
    return { ...commit, commandId: command.id };
  }

  async redoLast(): Promise<SyncularV2CommandHistoryReceipt> {
    await this.ensureReady();
    const command = await this.store.latest('undone');
    if (!command) {
      throw new SyncularV2CommandHistoryError(
        'sync.command_history_empty',
        'There is no Syncular command to redo'
      );
    }
    const entries = decodeEntries(command);
    this.assertSafeReplay(command.id, entries);
    await this.assertCurrentRows(command.id, entries, 'before');
    const commit = await this.applySnapshots(
      command.mutation_scope,
      entries.map((entry) => ({
        table: entry.table,
        rowId: entry.rowId,
        snapshot: entry.after,
      }))
    );
    await this.store.mark(command.id, 'done', commit);
    return { ...commit, commandId: command.id };
  }

  private async assertCurrentRows(
    commandId: string,
    entries: readonly CommandEntry[],
    expected: 'before' | 'after'
  ): Promise<void> {
    for (const entry of entries) {
      const config = this.options.tableConfig[entry.table];
      if (!config) {
        throw new SyncularV2CommandHistoryError(
          'sync.command_history_table_unsupported',
          `Cannot replay undo history for unsupported table ${entry.table}`,
          { commandId }
        );
      }
      const current = await this.readRow(entry.table, entry.rowId);
      if (!sameReplaySnapshot(config, current, entry[expected])) {
        throw new SyncularV2CommandHistoryError(
          'sync.command_history_conflict',
          `Cannot ${expected === 'after' ? 'undo' : 'redo'} Syncular command ${commandId}; ${entry.table}.${entry.rowId} changed since the command was recorded`,
          { commandId }
        );
      }
    }
  }

  private assertSafeReplay(
    commandId: string,
    entries: readonly CommandEntry[]
  ): void {
    for (const entry of entries) {
      const config = this.options.tableConfig[entry.table];
      if (!config) {
        throw new SyncularV2CommandHistoryError(
          'sync.command_history_table_unsupported',
          `Cannot replay undo history for unsupported table ${entry.table}`,
          { commandId }
        );
      }
      const unsafeFields = unsafeChangedFields(config, entry);
      if (unsafeFields.length > 0) {
        throw new SyncularV2CommandHistoryError(
          'sync.command_history_unsafe_field',
          `Cannot replay Syncular command ${commandId}; ${entry.table}.${entry.rowId} changed unsafe fields: ${unsafeFields.join(', ')}`,
          { commandId }
        );
      }
    }
  }

  private async applySnapshots(
    scope: MutationScope,
    snapshots: Array<{ table: string; rowId: string; snapshot: RowSnapshot }>
  ): Promise<MutationReceipt> {
    const mutations =
      scope === 'leasedMutations'
        ? this.options.leasedMutations
        : this.options.mutations;
    const { commit } = await mutations.$commit(async (tx) => {
      for (const snapshot of snapshots) {
        const table = tx[snapshot.table] as
          | TableMutationsTx<AnyDb, string>
          | undefined;
        if (!table) {
          throw new SyncularV2CommandHistoryError(
            'sync.command_history_table_unsupported',
            `Cannot apply undo history for unsupported table ${snapshot.table}`
          );
        }
        if (snapshot.snapshot === null) {
          await table.delete(snapshot.rowId);
        } else {
          await table.upsert(
            snapshot.rowId,
            this.mutationPayloadForSnapshot(snapshot.table, snapshot.snapshot)
          );
        }
      }
    });
    return commit;
  }

  private mutationPayloadForSnapshot(
    table: string,
    snapshot: Record<string, unknown>
  ): Record<string, unknown> {
    const config = this.options.tableConfig[table];
    if (!config) {
      throw new SyncularV2CommandHistoryError(
        'sync.command_history_table_unsupported',
        `Cannot apply undo history for unsupported table ${table}`
      );
    }
    const payload = { ...snapshot };
    delete payload[config.primaryKeyColumn ?? 'id'];
    if (config.serverVersionColumn) delete payload[config.serverVersionColumn];
    for (const field of config.crdtYjsFields ?? []) {
      delete payload[field.stateColumn];
    }
    return payload;
  }
}

class CommandHistoryStore<DB> {
  #ready: Promise<void> | undefined;

  constructor(
    private readonly options: CreateSyncularV2CommandHistoryOptions<DB>
  ) {}

  ensureReady(): Promise<void> {
    this.#ready ??= this.#ensureReady();
    return this.#ready;
  }

  async insert(
    scope: MutationScope,
    entries: readonly CommandEntry[],
    receipt: MutationReceipt
  ): Promise<void> {
    await this.ensureReady();
    const now = this.now();
    const id = this.options.idFactory?.() ?? `cmd_${randomId()}`;
    const client = this.unsafeClient();
    await client.executeUnsafeSql(
      "delete from sync_command_history where state = 'undone'"
    );
    await client.executeUnsafeSql(
      `insert into sync_command_history (
        id,
        mutation_scope,
        state,
        entries_json,
        client_commit_id,
        created_at,
        updated_at
      ) values (?, ?, 'done', ?, ?, ?, ?)`,
      [id, scope, JSON.stringify(entries), receipt.clientCommitId, now, now]
    );
  }

  async latest(state: 'done' | 'undone'): Promise<HistoryRow | null> {
    await this.ensureReady();
    const result = await this.options.client.executeSql<HistoryRow>(
      `select id, mutation_scope, state, entries_json, client_commit_id,
              undo_client_commit_id, redo_client_commit_id, created_at, updated_at
       from sync_command_history
       where state = ?
       order by updated_at desc, created_at desc, id desc
       limit 1`,
      [state]
    );
    return result.rows[0] ?? null;
  }

  async mark(
    id: string,
    state: 'done' | 'undone',
    receipt: MutationReceipt
  ): Promise<void> {
    await this.ensureReady();
    const replayColumn =
      state === 'undone' ? 'undo_client_commit_id' : 'redo_client_commit_id';
    await this.unsafeClient().executeUnsafeSql(
      `update sync_command_history
       set state = ?, updated_at = ?, ${replayColumn} = ?
       where id = ?`,
      [state, this.now(), receipt.clientCommitId, id]
    );
  }

  async #ensureReady(): Promise<void> {
    const client = this.unsafeClient();
    await client.executeUnsafeSql(
      `create table if not exists sync_command_history (
        id text primary key,
        mutation_scope text not null,
        state text not null check (state in ('done', 'undone')),
        entries_json text not null,
        client_commit_id text not null,
        undo_client_commit_id text null,
        redo_client_commit_id text null,
        created_at integer not null,
        updated_at integer not null
      )`
    );
    await client.executeUnsafeSql(
      `create index if not exists idx_sync_command_history_state_updated
       on sync_command_history (state, updated_at, created_at)`
    );
  }

  private unsafeClient(): SyncularV2UnsafeSqlClient {
    const client = this.options.client;
    if (typeof client.executeUnsafeSql === 'function') {
      return client as SyncularV2UnsafeSqlClient;
    }
    throw new SyncularV2CommandHistoryError(
      'sync.command_history_storage_unavailable',
      'Syncular command history requires internal SQLite write access'
    );
  }

  private now(): number {
    return Math.trunc(this.options.nowMs?.() ?? Date.now());
  }
}

async function readCurrentRow(
  client: SyncularV2SqlClient,
  table: string,
  idColumn: string,
  rowId: string
): Promise<RowSnapshot> {
  const result = await client.executeSql(
    `select * from ${quoteIdentifier(table)} where ${quoteIdentifier(idColumn)} = ? limit 1`,
    [rowId]
  );
  const row = result.rows[0];
  return row ? normalizeSnapshot(row) : null;
}

function decodeEntries(row: HistoryRow): CommandEntry[] {
  const entries = JSON.parse(row.entries_json) as CommandEntry[];
  if (!Array.isArray(entries)) {
    throw new SyncularV2CommandHistoryError(
      'sync.command_history_conflict',
      `Syncular command history row ${row.id} is malformed`,
      { commandId: row.id }
    );
  }
  return entries;
}

function normalizeSnapshot(
  row: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).sort(([a], [b]) => a.localeCompare(b))
  );
}

function sameSnapshot(left: RowSnapshot, right: RowSnapshot): boolean {
  return stableJson(left) === stableJson(right);
}

function sameReplaySnapshot(
  config: SyncularV2TableConfigMap[string],
  left: RowSnapshot,
  right: RowSnapshot
): boolean {
  return (
    stableJson(replayComparableSnapshot(config, left)) ===
    stableJson(replayComparableSnapshot(config, right))
  );
}

function replayComparableSnapshot(
  config: SyncularV2TableConfigMap[string],
  snapshot: RowSnapshot
): RowSnapshot {
  if (snapshot === null) return null;
  const comparable = { ...snapshot };
  if (config.serverVersionColumn) delete comparable[config.serverVersionColumn];
  for (const field of config.crdtYjsFields ?? []) {
    delete comparable[field.stateColumn];
  }
  return comparable;
}

function unsafeChangedFields(
  config: SyncularV2TableConfigMap[string],
  entry: CommandEntry
): string[] {
  const rowLifecycleReplay = entry.before === null || entry.after === null;
  const unsafeFields = new Set<string>();
  for (const column of config.blobColumns ?? []) unsafeFields.add(column);
  for (const field of config.encryptedFields ?? [])
    unsafeFields.add(field.field);
  if (!rowLifecycleReplay) {
    for (const field of config.crdtYjsFields ?? []) {
      unsafeFields.add(field.field);
      unsafeFields.add(field.stateColumn);
    }
  }

  const changed: string[] = [];
  for (const field of unsafeFields) {
    const before = entry.before?.[field];
    const after = entry.after?.[field];
    if (
      stableJson(nullishToNull(before)) === stableJson(nullishToNull(after))
    ) {
      continue;
    }
    if (rowLifecycleReplay && before == null && after == null) continue;
    changed.push(field);
  }
  return changed;
}

function nullishToNull(value: unknown): unknown {
  return value == null ? null : value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortValue(nested)])
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
