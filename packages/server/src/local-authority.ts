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
import type { SqliteDatabase } from './sqlite-driver';
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
   * §12.3: leave the attaching state and serve the client again. The remote
   * server keeps the commits it already applied; the host discards that
   * partition before the next attach.
   */
  readonly abandonAttach: () => void;
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
  const storage = new SqliteServerStorage(database);
  const compiled = compileSchema(schema);
  // §12.2: the authority reaches the running schema before it serves.
  await storage.ensureSchema(compiled);
  if ((await storage.getPartitionLogEpoch(LOCAL)) !== undefined) {
    await pruneCommitLog({ storage, partition: LOCAL, nowMs: clock() });
  }
  const allowed = Object.fromEntries(
    [...compiled.declaredVariables].map((variable) => [variable, ['*']]),
  );
  const ctx: SyncRequestContext = {
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

  const stored = readMeta('state') ?? 'local';
  if (stored !== 'local' && stored !== 'attaching' && stored !== 'attached') {
    throw new SyncError(
      'sync.internal_error',
      'the local authority state is unreadable',
      JSON.stringify({ state: stored }),
    );
  }
  let state: LocalAuthorityState = stored;
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
  const admit = <T>(work: () => Promise<T>): Promise<T> => {
    if (state !== 'local') {
      return Promise.reject(
        new SyncError(
          'sync.authority_unavailable',
          'the local authority serves no requests',
          JSON.stringify({ state }),
        ),
      );
    }
    const promise = work();
    const settle = () => inflight.delete(promise);
    inflight.add(promise);
    promise.then(settle, settle);
    return promise;
  };
  const writeState = (next: LocalAuthorityState, attachId?: string) => {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.run(
        'INSERT OR REPLACE INTO sync_local_authority(key,value) VALUES (?,?)',
        ['state', next],
      );
      if (attachId === undefined) {
        database.run("DELETE FROM sync_local_authority WHERE key='attach_id'");
      } else {
        database.run(
          'INSERT OR REPLACE INTO sync_local_authority(key,value) VALUES (?,?)',
          ['attach_id', attachId],
        );
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    state = next;
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

  const authority: LocalAuthority = {
    get state() {
      return state;
    },
    sync: (request) => admit(() => handleSyncRequest(request, ctx)),
    downloadSegment: (request) =>
      admit(async () => {
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
    abandonAttach() {
      refuseDuringUpload();
      if (state === 'attached') {
        throw new SyncError(
          'sync.authority_unavailable',
          'the local authority serves no requests',
          JSON.stringify({ state }),
        );
      }
      writeState('local');
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
        writeState('attaching', crypto.randomUUID());
      } catch (error) {
        state = 'local';
        throw error;
      }
    }
    const attachId = readMeta('attach_id');
    if (attachId === undefined) {
      throw new SyncError(
        'sync.internal_error',
        'the attaching local authority has no attach id',
      );
    }
    const commits = planAttach(database, compiled, attachId);
    const clientId = `authority-${attachId}`;
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
    for (const commit of commits) {
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
      if (result?.status === 'applied' || result?.status === 'cached') {
        continue;
      }
      const failed = result?.results.find((r) => r.status !== 'applied');
      throw new LocalAuthorityAttachError({
        reason: 'commit_rejected',
        clientCommitId: commit.clientCommitId,
        opIndex: failed?.opIndex ?? 0,
        code: failed?.code ?? 'sync.invalid_request',
      });
    }
    writeState('attached');
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
