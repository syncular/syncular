/**
 * Test harness: hand-written schema IR plus byte-level request/response
 * helpers. The loopback doctrine: the server is driven EXCLUSIVELY through
 * bytes built and decoded with the reference codec — no HTTP, no sockets.
 */
import { expect } from 'bun:test';
import {
  decodeMessage,
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type PullHeaderFrame,
  type PushCommitFrame,
  type PushOperation,
  type PushResultFrame,
  type RequestFrame,
  type ResponseFrame,
  type ResponseMessage,
  type RowColumn,
  type ScopeMap,
  type SubEndFrame,
  type SubStartFrame,
  type SubscriptionFrame,
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
 * Deterministically pause two deliveries after both optimistic idempotency
 * lookups have started. Their locked rechecks then decide the one true apply.
 */
export function overlapAfterTwoOptimisticMisses(
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
      if (property === 'getPushResult') {
        return async (...args: [string, string, string]) => {
          arrivals += 1;
          if (arrivals <= 2) {
            if (arrivals === 2) release();
            await gate;
          }
          return target.getPushResult(...args);
        };
      }
      if (property === 'begin' && onOperationRead !== undefined) {
        return async (partition: string): Promise<StorageTransaction> => {
          const tx = await target.begin(partition);
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
  return encodeRow(TASK_COLUMNS, [id, projectId, title, done, priority, meta]);
}

export function docRow(
  id: string,
  orgId: string,
  projectId: string,
  body = 'body',
): Uint8Array {
  return encodeRow(DOC_COLUMNS, [id, orgId, projectId, body]);
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
): PushCommitFrame {
  return { type: 'PUSH_COMMIT', clientCommitId, operations };
}

export function pullHeader(
  overrides?: Partial<Omit<PullHeaderFrame, 'type'>>,
): PullHeaderFrame {
  return {
    type: 'PULL_HEADER',
    limitCommits: 0,
    limitSnapshotRows: 0,
    maxSnapshotPages: 0,
    accept: 0b0011,
    ...overrides,
  };
}

export function subFrame(
  id: string,
  table: string,
  scopes: ScopeMap,
  cursor: number,
  extra?: { bootstrapState?: string; params?: string },
): SubscriptionFrame {
  return {
    type: 'SUBSCRIPTION',
    id,
    table,
    scopes,
    cursor,
    ...(extra?.bootstrapState !== undefined
      ? { bootstrapState: extra.bootstrapState }
      : {}),
    ...(extra?.params !== undefined ? { params: extra.params } : {}),
  };
}

export function requestBytes(
  frames: RequestFrame[],
  clientId = 'client-1',
  schemaVersion = 1,
): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [{ type: 'REQ_HEADER', clientId, schemaVersion }, ...frames],
  });
}

/** Drive the server through bytes and decode the response. */
export async function sync(
  t: TestContext,
  frames: RequestFrame[],
  options?: { clientId?: string; schemaVersion?: number },
): Promise<ResponseMessage> {
  const bytes = requestBytes(
    frames,
    options?.clientId ?? 'client-1',
    options?.schemaVersion ?? 1,
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

export function section(message: ResponseMessage, id: string): SubSection {
  const s = sections(message).get(id);
  if (s === undefined) throw new Error(`no subscription section ${id}`);
  return s;
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
