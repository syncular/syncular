/**
 * Test harness: hand-written schema IR plus byte-level request/response
 * helpers. The loopback doctrine: the server is driven EXCLUSIVELY through
 * bytes built and decoded with the reference codec — no HTTP, no sockets.
 */
import { buildSqliteImage } from '@syncular/server/sqlite';
import { expect } from 'bun:test';
import {
  type CommitFrame,
  decodeMessage,
  encodeMessage,
  encodeSparseRow,
  type LiveEndFrame,
  type LiveStartFrame,
  PROTOCOL_WIRE_VERSION,
  type ProgressFrame,
  type PullHeaderFrame,
  type PushCommitFrame,
  type PushOperation,
  type PushResultFrame,
  type RequestFrame,
  type ResponseFrame,
  type ResponseMessage,
  type RowColumn,
  registrationDigest,
  type ScopeMap,
  type SubEndFrame,
  type SubStartFrame,
  type UnitFrame,
  type UnitScopes,
  unitId,
} from '@syncular/core';
import {
  handleSyncRequest,
  MemorySegmentStore,
  type ServerSchema,
  type ServerStorage,
  SqliteServerStorage,
  type StorageTransaction,
  SyncError,
  type SyncRequestContext,
} from '@syncular/server';

/**
 * Deterministically pause two deliveries before either opens its storage
 * transaction, so both reach the partition lock and the admission read. Whichever
 * applies first commits; the other's admission read sees the outcome and must
 * replay it instead of applying again.
 */
export function overlapDuplicateDeliveries(
  storage: ServerStorage,
  onOperationRead?: () => void,
): ServerStorage {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return new Proxy(storage, {
    get(target, property) {
      if (property === 'begin') {
        return async (partition: string): Promise<StorageTransaction> => {
          arrivals += 1;
          if (arrivals <= 2) {
            if (arrivals === 2) release();
            await gate;
          }
          const tx = await target.begin(partition);
          if (onOperationRead === undefined) return tx;
          return new Proxy(tx, {
            get(txTarget, txProperty) {
              if (txProperty === 'getRow') {
                return (...args: [string, string]) => {
                  onOperationRead();
                  return txTarget.getRow(...args);
                };
              }
              const value = Reflect.get(txTarget, txProperty, txTarget);
              return typeof value === 'function' ? value.bind(txTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const TASK_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'done', type: 'boolean', nullable: false },
  { name: 'priority', type: 'integer', nullable: true },
  { name: 'meta', type: 'json', nullable: true },
];

export const DOC_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'org_id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'body', type: 'string', nullable: false },
];

export const TEST_SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: TASK_COLUMNS,
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
    },
    {
      name: 'docs',
      columns: DOC_COLUMNS,
      primaryKey: 'id',
      scopes: [
        'org:{org_id}',
        { pattern: 'project:{projectId}', column: 'project_id' },
      ],
    },
  ],
};

export const TEST_LOG_EPOCH = 'test-log-epoch';

export interface ScopeHolder {
  value: ScopeMap;
  error: boolean;
}

export interface TestContext {
  ctx: SyncRequestContext;
  storage: SqliteServerStorage;
  segments: MemorySegmentStore;
  scopes: ScopeHolder;
  now: { ms: number };
}

export function makeContext(
  overrides?: Partial<SyncRequestContext>,
): TestContext {
  const storage = new SqliteServerStorage();
  const segments = new MemorySegmentStore();
  const scopes: ScopeHolder = {
    value: { project_id: ['p1'], projectId: ['p1'], org_id: ['o1'] },
    error: false,
  };
  const now = { ms: 1_750_000_000_000 };
  const ctx: SyncRequestContext = {
    sqliteImageBuilder: buildSqliteImage,
    partition: 'part-1',
    actorId: 'actor-1',
    schema: TEST_SCHEMA,
    storage,
    segments,
    resolveScopes: () => {
      if (scopes.error) throw new Error('resolver failure');
      return scopes.value;
    },
    clock: () => now.ms,
    ...overrides,
  };
  void ctx.storage.touchPartition(ctx.partition, now.ms, TEST_LOG_EPOCH);
  return { ctx, storage, segments, scopes, now };
}

export function taskRow(
  id: string,
  projectId: string,
  title = 'task',
  done = false,
  priority: number | null = null,
  meta: string | null = null,
): Uint8Array {
  // Push payloads are sparse rows at wire version 3 (§2.4); every column
  // present keeps these full-row writes byte-compatible with mutate().
  return encodeSparseRow(TASK_COLUMNS, 0, [
    id,
    projectId,
    title,
    done,
    priority,
    meta,
  ]);
}

export function docRow(
  id: string,
  orgId: string,
  projectId: string,
  body = 'body',
): Uint8Array {
  return encodeSparseRow(DOC_COLUMNS, 0, [id, orgId, projectId, body]);
}

export function upsert(
  table: string,
  rowId: string,
  payload: Uint8Array,
  baseVersion?: number,
): PushOperation {
  return {
    table,
    rowId,
    op: 'upsert',
    payload,
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  };
}

export function del(
  table: string,
  rowId: string,
  baseVersion?: number,
): PushOperation {
  return {
    table,
    rowId,
    op: 'delete',
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  };
}

export function pushCommit(
  clientCommitId: string,
  operations: PushOperation[],
  clientSeq = 0,
): PushCommitFrame {
  return { type: 'PUSH_COMMIT', clientCommitId, clientSeq, operations };
}

/** A pull header for a request that carries the empty list (§4.1). */
export function pullHeader(
  overrides?: Partial<Omit<PullHeaderFrame, 'type'>>,
): PullHeaderFrame {
  return {
    type: 'PULL_HEADER',
    limitCommits: 0,
    limitSnapshotRows: 0,
    maxSnapshotPages: 0,
    accept: 0b0011,
    cursor: -1,
    registrationDigest: registrationDigest([]),
    echoDigest: new Uint8Array(),
    ...overrides,
  };
}

export function unitFrame(scopes: UnitScopes): UnitFrame {
  return { type: 'UNIT', scopes };
}

export function progressFrame(
  scopes: UnitScopes,
  cursor: number,
  bootstrapState?: string,
): ProgressFrame {
  return {
    type: 'PROGRESS',
    id: unitId(scopes),
    cursor,
    ...(bootstrapState !== undefined ? { bootstrapState } : {}),
  };
}

/**
 * A pull whose list travels (§4.1): the header with the list's digest, one
 * UNIT per unit, and a PROGRESS frame per catching-up unit. Every unit
 * catches up from cursor -1 unless `progress` says otherwise.
 */
export function pullFrames(
  units: readonly UnitScopes[],
  options?: Partial<Omit<PullHeaderFrame, 'type' | 'registrationDigest'>> & {
    readonly progress?: readonly ProgressFrame[];
  },
): RequestFrame[] {
  const { progress, ...header } = options ?? {};
  return [
    pullHeader({ registrationDigest: registrationDigest(units), ...header }),
    ...units.map(unitFrame),
    ...(progress ?? units.map((unit) => progressFrame(unit, -1))),
  ];
}

export function requestBytes(
  frames: RequestFrame[],
  clientId = 'client-1',
  schemaVersion = 1,
  logEpoch = TEST_LOG_EPOCH,
  outboxId?: string,
): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      {
        type: 'REQ_HEADER',
        clientId,
        schemaVersion,
        logEpoch,
        ...(outboxId !== undefined ? { outboxId } : {}),
      },
      ...frames,
    ],
  });
}

/** Drive the server through bytes and decode the response. */
export async function sync(
  t: TestContext,
  frames: RequestFrame[],
  options?: { clientId?: string; schemaVersion?: number; outboxId?: string },
): Promise<ResponseMessage> {
  const bytes = requestBytes(
    frames,
    options?.clientId ?? 'client-1',
    options?.schemaVersion ?? 1,
    TEST_LOG_EPOCH,
    options?.outboxId,
  );
  const out = await handleSyncRequest(bytes, t.ctx);
  const message = decodeMessage(out);
  if (message.msgKind !== 'response') throw new Error('expected a response');
  return message;
}

export function pushResults(message: ResponseMessage): PushResultFrame[] {
  return message.frames.filter(
    (f): f is PushResultFrame => f.type === 'PUSH_RESULT',
  );
}

export interface SubSection {
  start: SubStartFrame;
  body: ResponseFrame[];
  end: SubEndFrame;
}

export function sections(message: ResponseMessage): Map<string, SubSection> {
  const result = new Map<string, SubSection>();
  let current: SubSection | undefined;
  for (const frame of message.frames) {
    if (frame.type === 'SUB_START') {
      current = {
        start: frame,
        body: [],
        end: { type: 'SUB_END', nextCursor: 0 },
      };
      result.set(frame.id, current);
    } else if (frame.type === 'SUB_END') {
      if (current !== undefined) current.end = frame;
      current = undefined;
    } else if (current !== undefined) {
      current.body.push(frame);
    }
  }
  return result;
}

/** The unit section of a unit, by scope map or id. */
export function section(
  message: ResponseMessage,
  unit: UnitScopes | string,
): SubSection {
  const id = typeof unit === 'string' ? unit : unitId(unit);
  const s = sections(message).get(id);
  if (s === undefined) throw new Error(`no unit section ${id}`);
  return s;
}

/** The response's live section (§4.4). */
export function live(message: ResponseMessage): {
  start: LiveStartFrame;
  commits: CommitFrame[];
  end: LiveEndFrame;
} {
  const start = message.frames.find(
    (f): f is LiveStartFrame => f.type === 'LIVE_START',
  );
  const end = message.frames.find(
    (f): f is LiveEndFrame => f.type === 'LIVE_END',
  );
  if (start === undefined || end === undefined) {
    throw new Error('no live section');
  }
  return {
    start,
    commits: message.frames.filter(
      (f): f is CommitFrame => f.type === 'COMMIT',
    ),
    end,
  };
}

/** Every change of the live section as `table/rowId/op`. */
export function liveChanges(message: ResponseMessage): string[] {
  return live(message).commits.flatMap((commit) =>
    commit.changes.map(
      (change) =>
        `${commit.tables[change.tableIndex]}/${change.rowId}/${change.op}`,
    ),
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * A reference replica for driving the server (§4.1 to §4.7): the
 * registration list, the replica cursor, catching-up units and the echo
 * digest, advanced by the client rules (`SUB_END`, the join rule J, the
 * resets) from each response it applies.
 */
export class TestReplica {
  units: UnitScopes[] = [];
  /** The replica cursor R. */
  cursor = -1;
  echo: Uint8Array = new Uint8Array();
  /** Catching-up units: id → cursor and resume token. */
  readonly catching = new Map<string, { cursor: number; token?: string }>();
  /** The digest of the list the server stores, after a processed LIVE_END. */
  #stored: Uint8Array | undefined;

  constructor(readonly clientId = 'client-1') {}

  register(...units: UnitScopes[]): this {
    for (const scopes of units) {
      const id = unitId(scopes);
      if (this.units.some((unit) => unitId(unit) === id)) continue;
      this.units.push(scopes);
      this.catching.set(id, { cursor: -1 });
    }
    return this;
  }

  unregister(scopes: UnitScopes): this {
    const id = unitId(scopes);
    this.units = this.units.filter((unit) => unitId(unit) !== id);
    this.catching.delete(id);
    return this;
  }

  /** True when no unit catches up. */
  get idle(): boolean {
    return this.catching.size === 0;
  }

  frames(
    options?: Partial<
      Pick<
        PullHeaderFrame,
        'limitCommits' | 'limitSnapshotRows' | 'maxSnapshotPages' | 'accept'
      >
    > & { readonly travel?: boolean },
  ): RequestFrame[] {
    const digest = registrationDigest(this.units);
    const travel =
      options?.travel ??
      (this.#stored === undefined || !sameBytes(this.#stored, digest));
    return [
      pullHeader({
        limitCommits: options?.limitCommits ?? 0,
        limitSnapshotRows: options?.limitSnapshotRows ?? 0,
        maxSnapshotPages: options?.maxSnapshotPages ?? 0,
        accept: options?.accept ?? 0b0011,
        cursor: this.cursor,
        registrationDigest: digest,
        echoDigest: this.echo,
      }),
      ...(travel ? this.units.map(unitFrame) : []),
      ...this.units.flatMap((scopes) => {
        const state = this.catching.get(unitId(scopes));
        return state === undefined
          ? []
          : [progressFrame(scopes, state.cursor, state.token)];
      }),
    ];
  }

  apply(message: ResponseMessage): void {
    for (const [id, { start, end }] of sections(message)) {
      if (start.status === 'revoked') {
        this.units = this.units.filter((unit) => unitId(unit) !== id);
        this.catching.delete(id);
      } else if (start.status === 'reset') {
        this.catching.set(id, { cursor: -1 });
      } else if (start.bootstrap) {
        this.catching.set(id, {
          cursor: end.nextCursor,
          ...(end.bootstrapState !== undefined
            ? { token: end.bootstrapState }
            : {}),
        });
      }
    }
    const { start, end } = live(message);
    if (start.status === 'unregistered') {
      this.#stored = undefined;
      return;
    }
    if (start.status === 'reset') {
      for (const scopes of this.units) {
        const id = unitId(scopes);
        if (!this.catching.has(id)) this.catching.set(id, { cursor: -1 });
      }
      this.cursor = -1;
    } else {
      const joined = Math.max(this.cursor, end.throughSeq);
      for (const [id, state] of this.catching) {
        if (state.token !== undefined || state.cursor < 0) continue;
        const cursor = Math.max(state.cursor, end.throughSeq);
        if (cursor >= joined) this.catching.delete(id);
        else state.cursor = cursor;
      }
      this.cursor = this.units.some((unit) => !this.catching.has(unitId(unit)))
        ? joined
        : -1;
    }
    this.echo = end.echoDigest;
    this.#stored = registrationDigest(this.units);
  }

  async pull(
    t: TestContext,
    options?: Parameters<TestReplica['frames']>[0] & {
      readonly push?: readonly PushCommitFrame[];
    },
  ): Promise<ResponseMessage> {
    const message = await sync(
      t,
      [...(options?.push ?? []), ...this.frames(options)],
      { clientId: this.clientId },
    );
    this.apply(message);
    return message;
  }
}

export async function expectSyncError(
  promise: Promise<unknown>,
  code: string,
): Promise<SyncError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    const sync_ = error as SyncError;
    expect(sync_.code).toBe(code);
    return sync_;
  }
  throw new Error(`expected SyncError ${code}, but the call succeeded`);
}

/** Push a single-upsert commit and return its commitSeq. */
export async function seedTask(
  t: TestContext,
  commitId: string,
  id: string,
  projectId: string,
  title = 'task',
): Promise<number> {
  const message = await sync(t, [
    pushCommit(commitId, [upsert('tasks', id, taskRow(id, projectId, title))]),
  ]);
  const result = pushResults(message)[0];
  if (result?.status !== 'applied' || result.commitSeq === undefined) {
    throw new Error(`seed push not applied: ${JSON.stringify(result)}`);
  }
  return result.commitSeq;
}
