/**
 * Local authority (SPEC.md §12): the reference server running in the client's
 * process over its own SQLite database. An app syncs its client against it
 * with no remote server, and later moves the authority's rows to a remote
 * server with `attach` (§12.3).
 */
import {
  decodeMessage,
  decodeRow,
  encodeMessage,
  encodeSparseRow,
  PROTOCOL_WIRE_VERSION,
  type PushCommitFrame,
  type PushOperation,
  type PushResultFrame,
  type RequestFrame,
  type ResponseFrame,
  type RowValue,
} from '@syncular/core';
import type { SyncRequestContext } from './context';
import type { CrdtMergerRegistry } from './crdt-merger';
import { SyncError } from './errors';
import { handleSyncRequest } from './handler';
import { pruneCommitLog } from './prune';
import {
  type CompiledSchema,
  compileSchema,
  type ServerSchema,
} from './schema';
import { renderScopeValue } from './scopes';
import { handleSegmentDownload } from './segment-download';
import { MemorySegmentStore } from './segment-store';
import type {
  SqliteDatabase,
  SqliteRunResult,
  SqliteValue,
} from './sqlite-driver';
import type { SqliteImageBuilder } from './sqlite-image';
import { SqliteServerStorage } from './sqlite-storage';

/** The one partition and actor a local authority serves (§12.2). */
const LOCAL = 'local';
/** Operations per attach commit: the reference server's request cap (§6.1). */
const ATTACH_OPERATION_BUDGET = 500;

export type LocalAuthorityState = 'local' | 'attaching' | 'attached';

export interface LocalAuthorityOptions {
  /** The authority's own database. Never the client replica (§12.1). */
  readonly database: SqliteDatabase;
  readonly schema: ServerSchema;
  /** §5.10 mergers for `crdt` columns, as a remote server would take them. */
  readonly crdtMergers?: CrdtMergerRegistry;
  /** §5.3 image builder from `@syncular/server/sqlite`; absent ⇒ rows segments. */
  readonly sqliteImageBuilder?: SqliteImageBuilder;
  readonly clock?: () => number;
}

export interface LocalAuthority {
  /** Current §12.3 state, persisted in the authority database. */
  readonly state: LocalAuthorityState;
  /** The client's sync transport: one combined push+pull round (§1.5). */
  readonly sync: (request: Uint8Array) => Promise<Uint8Array>;
  /** The client's segment downloader (§5.5). */
  readonly downloadSegment: (request: {
    readonly segmentId: string;
    readonly requestedScopesJson: string;
  }) => Promise<Uint8Array>;
  /**
   * §12.3: upload every live row to the remote server behind `transport`
   * (an authenticated `POST <mount>/sync` round trip). Resolves once every
   * commit is applied; a second call after a failure resumes the same plan.
   */
  readonly attach: (
    transport: (request: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<void>;
  /**
   * §12.3: delete the rows the remote server applied from this attach, then
   * serve the client again. `transport` reaches the same remote server and is
   * required once an upload request may have reached it.
   */
  readonly abandonAttach: (
    transport?: (request: Uint8Array) => Promise<Uint8Array>,
  ) => Promise<void>;
}

export type LocalAuthorityAttachDetails =
  | {
      readonly reason: 'commit_rejected';
      readonly clientCommitId: string;
      readonly opIndex: number;
      readonly code: string;
    }
  | {
      readonly reason: 'cycle_too_large';
      readonly table: string;
      readonly size: number;
    }
  | {
      readonly reason: 'request_failed';
      readonly code: string;
      readonly retryable: boolean;
    }
  | { readonly reason: 'log_epoch_changed' }
  | {
      readonly reason: 'schema_floor';
      readonly requiredSchemaVersion: number;
      readonly latestSchemaVersion?: number;
    };

/** §10.3 client-local `sync.attach_rejected`: the attach upload stopped. */
export class LocalAuthorityAttachError extends Error {
  override readonly name = 'LocalAuthorityAttachError';
  readonly code = 'sync.attach_rejected';
  readonly details: LocalAuthorityAttachDetails;

  constructor(details: LocalAuthorityAttachDetails) {
    super('the remote server did not accept the attach upload');
    this.details = details;
  }
}

/** The `ClientDatabase` surface of `@syncular/client`, as a browser worker opens it. */
export interface LocalAuthorityClientDatabase {
  exec(sql: string, params?: readonly SqliteValue[]): void;
  query(
    sql: string,
    params?: readonly SqliteValue[],
  ): Record<string, SqliteValue>[];
  close(): void;
}

/**
 * Serve a local authority from a client-side database, such as the sibling
 * file a browser worker opens beside its replica. `exec` without parameters
 * must run several statements, as the sqlite-wasm database does.
 */
export function clientSqliteDatabase(
  database: LocalAuthorityClientDatabase,
): SqliteDatabase {
  const run = (
    sql: string,
    params: readonly SqliteValue[],
  ): SqliteRunResult => {
    database.exec(sql, params);
    const result = database.query(
      'SELECT changes() AS changes, last_insert_rowid() AS id',
    )[0];
    return {
      changes: Number(result?.changes ?? 0),
      lastInsertRowid: Number(result?.id ?? 0),
    };
  };
  return {
    exec: (sql) => database.exec(sql),
    run: (sql, bindings = []) => run(sql, bindings),
    query: <Row, Params extends readonly SqliteValue[]>(sql: string) => ({
      run: (...params: Params) => run(sql, params),
      get: (...params: Params) =>
        (database.query(sql, params)[0] ?? null) as Row | null,
      all: (...params: Params) => database.query(sql, params) as Row[],
    }),
    close: () => database.close(),
  };
}

export async function openLocalAuthority(
  options: LocalAuthorityOptions,
): Promise<LocalAuthority> {
  const { database, schema } = options;
  const clock = options.clock ?? Date.now;
  database.exec(
    'CREATE TABLE IF NOT EXISTS sync_local_authority(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  const readMeta = (key: string): string | undefined =>
    database
      .query<{ value: string }, [string]>(
        'SELECT value FROM sync_local_authority WHERE key=?',
      )
      .get(key)?.value;
  const stored = readMeta('state') ?? 'local';
  if (stored !== 'local' && stored !== 'attaching' && stored !== 'attached') {
    throw new SyncError(
      'sync.internal_error',
      'the local authority state is unreadable',
      JSON.stringify({ state: stored }),
    );
  }
  let state: LocalAuthorityState = stored;
  const compiled = compileSchema(schema);
  // §12.3: an attached authority keeps only its state across reopens, so it
  // opens no server storage; the storage constructor creates the server tables.
  const storage =
    stored === 'attached' ? undefined : new SqliteServerStorage(database);
  if (storage !== undefined) {
    // §12.2: the authority reaches the running schema before it serves.
    await storage.ensureSchema(compiled);
    if ((await storage.getPartitionLogEpoch(LOCAL)) !== undefined) {
      await pruneCommitLog({ storage, partition: LOCAL, nowMs: clock() });
    }
  }
  const allowed = Object.fromEntries(
    [...compiled.declaredVariables].map((variable) => [variable, ['*']]),
  );
  const ctx: SyncRequestContext | undefined =
    storage === undefined
      ? undefined
      : {
          partition: LOCAL,
          actorId: LOCAL,
          schema,
          storage,
          segments: new MemorySegmentStore(),
          resolveScopes: () => allowed,
          clock,
          ...(options.crdtMergers !== undefined
            ? { crdtMergers: options.crdtMergers }
            : {}),
          ...(options.sqliteImageBuilder !== undefined
            ? { sqliteImageBuilder: options.sqliteImageBuilder }
            : {}),
        };
  let uploading = false;
  const refuseDuringUpload = () => {
    if (uploading) {
      throw new SyncError(
        'sync.invalid_request',
        'an attach upload is already running',
      );
    }
  };
  const inflight = new Set<Promise<unknown>>();
  const admit = <T>(
    work: (ctx: SyncRequestContext) => Promise<T>,
  ): Promise<T> => {
    if (state !== 'local' || ctx === undefined) {
      return Promise.reject(
        new SyncError(
          'sync.authority_unavailable',
          'the local authority serves no requests',
          JSON.stringify({ state }),
        ),
      );
    }
    const promise = work(ctx);
    const settle = () => inflight.delete(promise);
    inflight.add(promise);
    promise.then(settle, settle);
    return promise;
  };
  /** One transaction; a `null` value removes the key. */
  const writeMeta = (entries: Readonly<Record<string, string | null>>) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(entries)) {
        if (value === null) {
          database.run('DELETE FROM sync_local_authority WHERE key=?', [key]);
        } else {
          database.run(
            'INSERT OR REPLACE INTO sync_local_authority(key,value) VALUES (?,?)',
            [key, value],
          );
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  const ordinal = (key: string): number => Number(readMeta(key) ?? -1);
  const attachIdOf = (): string => {
    const attachId = readMeta('attach_id');
    if (attachId === undefined) {
      throw new SyncError(
        'sync.internal_error',
        'the attaching local authority has no attach id',
      );
    }
    return attachId;
  };

  const exchange = async (
    transport: (request: Uint8Array) => Promise<Uint8Array>,
    frames: RequestFrame[],
  ): Promise<ResponseFrame[]> => {
    const message = decodeMessage(
      await transport(
        encodeMessage({
          wireVersion: PROTOCOL_WIRE_VERSION,
          msgKind: 'request',
          frames,
        }),
      ),
    );
    if (message.msgKind !== 'response') {
      throw new LocalAuthorityAttachError({
        reason: 'request_failed',
        code: 'sync.invalid_request',
        retryable: false,
      });
    }
    const header = message.frames[0];
    if (header?.type === 'RESP_HEADER' && header.requiredSchemaVersion) {
      throw new LocalAuthorityAttachError({
        reason: 'schema_floor',
        requiredSchemaVersion: header.requiredSchemaVersion,
        ...(header.latestSchemaVersion !== undefined
          ? { latestSchemaVersion: header.latestSchemaVersion }
          : {}),
      });
    }
    const error = message.frames.find((frame) => frame.type === 'ERROR');
    if (error !== undefined) {
      throw new LocalAuthorityAttachError({
        reason: 'request_failed',
        code: error.code,
        retryable: error.retryable,
      });
    }
    return message.frames;
  };

  /** Acquire the remote `logEpoch` (§2.1), then send one commit per request. */
  const connect = async (
    transport: (request: Uint8Array) => Promise<Uint8Array>,
    clientId: string,
  ): Promise<(commit: PushCommitFrame) => Promise<PushResultFrame>> => {
    const acquired = (
      await exchange(transport, [
        { type: 'REQ_HEADER', clientId, schemaVersion: schema.version },
        {
          type: 'PULL_HEADER',
          limitCommits: 0,
          limitSnapshotRows: 0,
          maxSnapshotPages: 0,
          accept: 0b0011,
        },
      ])
    )[0];
    const logEpoch =
      acquired?.type === 'RESP_HEADER' ? acquired.logEpoch : undefined;
    if (logEpoch === undefined) {
      throw new LocalAuthorityAttachError({
        reason: 'request_failed',
        code: 'sync.invalid_request',
        retryable: false,
      });
    }
    return async (commit) => {
      const frames = await exchange(transport, [
        {
          type: 'REQ_HEADER',
          clientId,
          schemaVersion: schema.version,
          logEpoch,
        },
        commit,
      ]);
      const header = frames[0];
      if (header?.type === 'RESP_HEADER' && header.resetRequired === true) {
        throw new LocalAuthorityAttachError({ reason: 'log_epoch_changed' });
      }
      const result = frames.find((frame) => frame.type === 'PUSH_RESULT');
      if (result === undefined) {
        throw new LocalAuthorityAttachError({
          reason: 'request_failed',
          code: 'sync.invalid_request',
          retryable: false,
        });
      }
      return result;
    };
  };
  const applied = (result: PushResultFrame) =>
    result.status === 'applied' || result.status === 'cached';
  const rejected = (commit: PushCommitFrame, result: PushResultFrame) => {
    const failed = result.results.find((r) => r.status !== 'applied');
    return new LocalAuthorityAttachError({
      reason: 'commit_rejected',
      clientCommitId: commit.clientCommitId,
      opIndex: failed?.opIndex ?? 0,
      code: failed?.code ?? 'sync.invalid_request',
    });
  };

  const authority: LocalAuthority = {
    get state() {
      return state;
    },
    sync: (request) => admit((ctx) => handleSyncRequest(request, ctx)),
    downloadSegment: (request) =>
      admit(async (ctx) => {
        const result = await handleSegmentDownload(ctx, {
          segmentId: request.segmentId,
          scopesHeader: request.requestedScopesJson,
        });
        return result.bytes;
      }),
    async attach(transport) {
      refuseDuringUpload();
      if (state === 'attached') return;
      uploading = true;
      try {
        await upload(transport);
      } finally {
        uploading = false;
      }
    },
    async abandonAttach(transport) {
      refuseDuringUpload();
      if (state === 'attached') {
        throw new SyncError(
          'sync.authority_unavailable',
          'the local authority serves no requests',
          JSON.stringify({ state }),
        );
      }
      if (state === 'local') return;
      if (ordinal('sent') >= 0) {
        if (transport === undefined) {
          throw new SyncError(
            'sync.invalid_request',
            'abandoning an attach that reached the remote server needs its transport',
          );
        }
        uploading = true;
        try {
          await rollback(transport);
        } finally {
          uploading = false;
        }
      }
      writeMeta({ state: 'local', attach_id: null, sent: null, applied: null });
      state = 'local';
    },
  };
  return authority;

  async function upload(
    transport: (request: Uint8Array) => Promise<Uint8Array>,
  ): Promise<void> {
    if (state === 'local') {
      // Refuse new rounds first, then let admitted rounds finish: the plan
      // reads the authority database on the connection a round writes on.
      state = 'attaching';
      try {
        await Promise.allSettled([...inflight]);
        writeMeta({ state: 'attaching', attach_id: crypto.randomUUID() });
      } catch (error) {
        state = 'local';
        throw error;
      }
    }
    const attachId = attachIdOf();
    const commits = planAttach(database, compiled, attachId);
    const send = await connect(transport, `authority-${attachId}`);
    for (const [index, commit] of commits.entries()) {
      // §12.3: `sent` before the request, `applied` after its result, so an
      // abandon knows which commits may have reached the remote server.
      writeMeta({ sent: String(Math.max(index, ordinal('sent'))) });
      const result = await send(commit);
      if (!applied(result)) throw rejected(commit, result);
      writeMeta({ applied: String(Math.max(index, ordinal('applied'))) });
    }
    writeMeta({ state: 'attached', sent: null, applied: null });
    state = 'attached';
    // §12.3: the retired authority keeps only its state.
    const tables = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'sync_local_authority'",
      )
      .all();
    for (const { name } of tables) {
      database.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
    }
    database.exec('VACUUM');
  }

  /**
   * §12.3 abandon: settle the one commit whose outcome may be unknown, then
   * delete the rows of every applied commit, children before parents.
   */
  async function rollback(
    transport: (request: Uint8Array) => Promise<Uint8Array>,
  ): Promise<void> {
    const attachId = attachIdOf();
    const commits = planAttach(database, compiled, attachId);
    const send = await connect(transport, `authority-${attachId}`);
    let through = ordinal('applied');
    const sent = ordinal('sent');
    if (sent > through) {
      const commit = commits[sent]!;
      if (applied(await send(commit))) through = sent;
      writeMeta({ applied: String(through) });
    }
    const deletes = commits
      .slice(0, through + 1)
      .flatMap((commit) => commit.operations)
      .reverse()
      .map(
        (operation): PushOperation => ({
          table: operation.table,
          rowId: operation.rowId,
          op: 'delete',
        }),
      );
    for (
      let start = 0;
      start < deletes.length;
      start += ATTACH_OPERATION_BUDGET
    ) {
      const commit: PushCommitFrame = {
        type: 'PUSH_COMMIT',
        clientCommitId: `${attachId}:undo:${start / ATTACH_OPERATION_BUDGET}`,
        operations: deletes.slice(start, start + ATTACH_OPERATION_BUDGET),
      };
      const result = await send(commit);
      if (!applied(result)) throw rejected(commit, result);
    }
  }
}

/**
 * §12.3 upload plan: every live row as one insert, rows visited in
 * (table name, row id) byte order, strongly connected components of the
 * row-level reference graph emitted in Tarjan completion order (every
 * parent before its children) and packed whole into commits.
 */
function planAttach(
  database: SqliteDatabase,
  schema: CompiledSchema,
  attachId: string,
): PushCommitFrame[] {
  const tables = [...schema.tables.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const nodeTable: (typeof tables)[number][] = [];
  const nodeRowId: string[] = [];
  const nodeValues: RowValue[][] = [];
  const index = new Map<string, number>();
  for (const table of tables) {
    const rows = database
      .query<{ row_id: string; payload: Uint8Array }, [string]>(
        `SELECT _sync_row_id AS row_id, _sync_payload AS payload
           FROM "${table.name.replaceAll('"', '""')}"
          WHERE _sync_partition=? ORDER BY _sync_row_id`,
      )
      .all(LOCAL);
    for (const row of rows) {
      index.set(`${table.name}\u0000${row.row_id}`, nodeRowId.length);
      nodeTable.push(table);
      nodeRowId.push(row.row_id);
      nodeValues.push(decodeRow(table.columns, new Uint8Array(row.payload)));
    }
  }
  const parents = nodeValues.map((values, node) => {
    const edges: number[] = [];
    for (const reference of nodeTable[node]!.references) {
      const parentId = renderScopeValue(values[reference.columnIndex]);
      const parent =
        parentId === undefined
          ? undefined
          : index.get(`${reference.parentTable}\u0000${parentId}`);
      if (parent !== undefined) edges.push(parent);
    }
    return edges;
  });

  // Iterative Tarjan: a deep parent chain must not exhaust the call stack.
  const order = new Array<number>(nodeRowId.length).fill(-1);
  const low = new Array<number>(nodeRowId.length).fill(0);
  const onStack = new Array<boolean>(nodeRowId.length).fill(false);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;
  for (let root = 0; root < nodeRowId.length; root++) {
    if (order[root] !== -1) continue;
    const frames: { node: number; edge: number }[] = [{ node: root, edge: 0 }];
    order[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const edges = parents[frame.node]!;
      if (frame.edge < edges.length) {
        const next = edges[frame.edge++]!;
        if (order[next] === -1) {
          order[next] = low[next] = counter++;
          stack.push(next);
          onStack[next] = true;
          frames.push({ node: next, edge: 0 });
        } else if (onStack[next]) {
          low[frame.node] = Math.min(low[frame.node]!, order[next]!);
        }
        continue;
      }
      frames.pop();
      const caller = frames[frames.length - 1];
      if (caller !== undefined) {
        low[caller.node] = Math.min(low[caller.node]!, low[frame.node]!);
      }
      if (low[frame.node] !== order[frame.node]) continue;
      const component: number[] = [];
      let member: number;
      do {
        member = stack.pop()!;
        onStack[member] = false;
        component.push(member);
      } while (member !== frame.node);
      components.push(component.sort((a, b) => a - b));
    }
  }

  const commits: PushCommitFrame[] = [];
  let operations: PushOperation[] = [];
  const flush = () => {
    if (operations.length === 0) return;
    commits.push({
      type: 'PUSH_COMMIT',
      clientCommitId: `${attachId}:${commits.length}`,
      operations,
    });
    operations = [];
  };
  for (const component of components) {
    if (component.length > ATTACH_OPERATION_BUDGET) {
      throw new LocalAuthorityAttachError({
        reason: 'cycle_too_large',
        table: nodeTable[component[0]!]!.name,
        size: component.length,
      });
    }
    if (operations.length + component.length > ATTACH_OPERATION_BUDGET) {
      flush();
    }
    for (const node of component) {
      const table = nodeTable[node]!;
      operations.push({
        table: table.name,
        rowId: nodeRowId[node]!,
        op: 'upsert',
        baseVersion: 0,
        payload: encodeSparseRow(
          table.columns,
          table.primaryKeyIndex,
          nodeValues[node]!,
        ),
      });
    }
  }
  flush();
  return commits;
}
