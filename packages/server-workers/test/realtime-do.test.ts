/**
 * `SyncularRealtimeDO` over the DO double (the d1-double doctrine for the
 * Durable Object runtime). Every test drives the REAL `RealtimeSession`/
 * `RealtimeHub` logic through the real DO class — the DO is a deployment
 * adapter, so this is the conformance bar for the Workers realtime binding
 * (§8): connect → hello → round over the socket (§8.7 bytes via the reference
 * codec) → delta on commit → ack; hibernation rehydration; HTTP-forwarded
 * push fan-out; presence through the DO.
 *
 * No `workerd`, no HTTP server: request/response bytes are built and decoded
 * with the reference codec (`@syncular/core`), the sockets are in-memory
 * doubles, and the storage is the D1 double.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  decodeMessage,
  encodeMessage,
  encodeRow,
  MessageStreamScanner,
  PROTOCOL_WIRE_VERSION,
  type PushCommitFrame,
  type PushResultFrame,
  REALTIME_TAG_DELTA,
  REALTIME_TAG_ROUND,
  type RequestFrame,
  type RowColumn,
  type SubStartFrame,
} from '@syncular/core';
import {
  type BlobStore,
  blobIdFor,
  CommitValidationRejection,
  type CommitValidator,
  type CrdtMergerRegistry,
  compileSchema,
  MemoryBlobStore,
  MemorySegmentStore,
  type ServerSchema,
  SSP2_CONTENT_TYPE,
  type SyncServerConfig,
} from '@syncular/server';
import { D1DatabaseDouble } from '../../server/test/d1-double';
import {
  createWorkersFetchHandler,
  D1ServerStorage,
  durableObjectRealtimeNotifier,
  REALTIME_DO_UPGRADE_PATH,
  type RealtimeDOConfig,
  setWebSocketPair,
  writeIdentityHeaders,
} from '../src/index';
import {
  FakeDurableObjectNamespace,
  type FakeRealtimeDO,
  type FakeWebSocket,
  FakeWebSocketPair,
  type SocketFrame,
} from './do-double';

const PARTITION = 'part-1';
const ACTOR_ID = 'actor-1';

const TASK_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'list_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'doc', type: 'crdt', nullable: true, crdtType: 'set-union' },
  { name: 'attachment', type: 'blob_ref', nullable: true },
];

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: TASK_COLUMNS,
      primaryKey: 'id',
      scopes: ['list:{list_id}'],
    },
  ],
};

function taskRow(
  id: string,
  listId: string,
  title: string,
  doc: Uint8Array | null = null,
  attachment: string | null = null,
): Uint8Array {
  return encodeRow(TASK_COLUMNS, [id, listId, title, doc, attachment]);
}

function blobRef(blobId: string, byteLength: number): string {
  return JSON.stringify({ blobId, byteLength });
}

/** Capture every `WebSocketPair` the host constructs so the test can drive the
 * client end and inspect the server end. */
const createdPairs: FakeWebSocketPair[] = [];
class TrackedPair extends FakeWebSocketPair {
  constructor() {
    super();
    createdPairs.push(this);
  }
}

function realtimeConfig(
  commitValidator?: CommitValidator,
  capabilities: {
    readonly blobs?: BlobStore;
    readonly crdtMergers?: CrdtMergerRegistry;
  } = {},
): RealtimeDOConfig {
  return {
    syncConfig: (storage) => ({
      schema: SCHEMA,
      storage,
      resolveScopes: () => ({ list_id: ['*'] }),
      segments: new MemorySegmentStore(),
      ...(capabilities.blobs !== undefined
        ? { blobs: capabilities.blobs }
        : {}),
      ...(capabilities.crdtMergers !== undefined
        ? { crdtMergers: capabilities.crdtMergers }
        : {}),
      ...(commitValidator !== undefined ? { commitValidator } : {}),
    }),
  };
}

/** Build a shared D1 double + a migrated storage over it. */
async function makeDb(): Promise<D1DatabaseDouble> {
  const db = new D1DatabaseDouble();
  const storage = new D1ServerStorage(db);
  await storage.migrate();
  return db;
}

/** The HTTP handler over the SAME D1, with the DO notifier wired in. */
function makeHttpHandler(
  db: D1DatabaseDouble,
  namespace: FakeDurableObjectNamespace,
): (request: Request) => Promise<Response> {
  const config: SyncServerConfig = {
    schema: SCHEMA,
    storage: new D1ServerStorage(db),
    segments: new MemorySegmentStore(),
    resolveScopes: () => ({ list_id: ['*'] }),
    realtime: durableObjectRealtimeNotifier(namespace),
  };
  const handler = createWorkersFetchHandler<unknown>({
    config: () => ({
      config,
      authenticate: async () => ({ actorId: ACTOR_ID, partition: PARTITION }),
    }),
    realtime: () => ({
      namespace,
      authenticate: async () => ({
        actorId: ACTOR_ID,
        partition: PARTITION,
        clientId: 'http-client',
      }),
    }),
  });
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  return (request) => handler(request, {}, ctx);
}

function syncRequestBytes(
  frames: RequestFrame[],
  clientId: string,
): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [{ type: 'REQ_HEADER', clientId, schemaVersion: 1 }, ...frames],
  });
}

function httpSyncRequest(frames: RequestFrame[], clientId: string): Request {
  return new Request('https://worker.example/sync', {
    method: 'POST',
    headers: { 'content-type': SSP2_CONTENT_TYPE },
    body: syncRequestBytes(frames, clientId).slice().buffer as ArrayBuffer,
  });
}

async function decodeHttpSync(responseInput: Response | Promise<Response>) {
  const response = await responseInput;
  expect(response.status).toBe(200);
  const message = decodeMessage(new Uint8Array(await response.arrayBuffer()));
  if (message.msgKind !== 'response') throw new Error('expected response');
  return message;
}

/** Directly upgrade a socket on one DO, returning the client/server sockets. */
async function connect(
  ns: FakeDurableObjectNamespace,
  clientId: string,
): Promise<{
  do_: FakeRealtimeDO;
  client: FakeWebSocket;
  server: FakeWebSocket;
}> {
  createdPairs.length = 0;
  const do_ = ns.get(ns.idFromName(PARTITION));
  const req = new Request(new URL(REALTIME_DO_UPGRADE_PATH, 'https://do'), {
    method: 'GET',
    headers: { upgrade: 'websocket' },
  });
  writeIdentityHeaders(req.headers, {
    partition: PARTITION,
    actorId: ACTOR_ID,
    clientId,
  });
  const response = await do_.fetch(req);
  expect(response.status).toBe(101);
  const pair = createdPairs.at(-1);
  if (pair === undefined) throw new Error('no WebSocketPair was constructed');
  return { do_, client: pair[0], server: pair[1] };
}

/** Frames the client received = the server socket's sends. */
function clientFrames(server: FakeWebSocket): SocketFrame[] {
  return server.sent;
}

function textFrames(frames: SocketFrame[]): Array<Record<string, unknown>> {
  return frames
    .filter((f): f is string => typeof f === 'string')
    .map((f) => JSON.parse(f) as Record<string, unknown>);
}

/** Reassemble a §8.7 round response from the 0x01-tagged binary chunks. */
function decodeRoundResponse(frames: SocketFrame[]) {
  const scanner = new MessageStreamScanner();
  for (const frame of frames) {
    if (typeof frame === 'string') continue;
    if (frame[0] !== REALTIME_TAG_ROUND) continue;
    const done = scanner.push(frame.subarray(1));
    if (done !== undefined) return decodeMessage(done.message.slice());
  }
  throw new Error('no complete round response in the socket frames');
}

/**
 * Yield to the event loop until fire-and-forget control/fanout work settles.
 * Completed sync rounds themselves are awaited by the DO partition FIFO.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Send a §8.7 sync round over the socket (as one 0x01-tagged binary frame). */
async function sendRound(
  do_: FakeRealtimeDO,
  server: FakeWebSocket,
  frames: RequestFrame[],
  clientId: string,
): Promise<void> {
  const bytes = syncRequestBytes(frames, clientId);
  const tagged = new Uint8Array(bytes.length + 1);
  tagged[0] = REALTIME_TAG_ROUND;
  tagged.set(bytes, 1);
  await do_.deliver(server, tagged.buffer.slice(0) as ArrayBuffer);
  await settle();
}

beforeEach(() => {
  setWebSocketPair(TrackedPair);
  createdPairs.length = 0;
});
afterEach(() => {
  setWebSocketPair(undefined);
});

describe('SyncularRealtimeDO (DO double + D1 double, reference codec)', () => {
  test('upgrade → hello (§8.1)', async () => {
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(db, realtimeConfig());
    const { server } = await connect(ns, 'client-1');
    const texts = textFrames(clientFrames(server));
    const hello = texts.find((m) => m.event === 'hello');
    expect(hello).toBeDefined();
    expect((hello?.data as { clientId?: string }).clientId).toBe('client-1');
  });

  test('a sync round over the socket round-trips through the DO (§8.7)', async () => {
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(db, realtimeConfig());
    const { do_, server } = await connect(ns, 'client-1');
    // A push round over the socket lands a commit through the SAME handler.
    await sendRound(
      do_,
      server,
      [
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'c1',
          operations: [
            {
              table: 'tasks',
              rowId: 't1',
              op: 'upsert',
              payload: taskRow('t1', 'L', 'first'),
            },
          ],
        },
      ],
      'client-1',
    );
    const response = decodeRoundResponse(server.sent);
    if (response.msgKind !== 'response') throw new Error('expected response');
    const result = response.frames.find(
      (f): f is PushResultFrame => f.type === 'PUSH_RESULT',
    );
    expect(result?.status).toBe('applied');
    expect(result?.commitSeq).toBe(1);
  });

  test('whole-commit validation runs under the DO partition serializer (§6.8)', async () => {
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(
      db,
      realtimeConfig(({ operations }) => {
        const trigger = operations.find(
          (operation) => operation.row?.title === 'needs-audit',
        );
        if (
          trigger !== undefined &&
          !operations.some(
            (operation) => operation.rowId === `${trigger.rowId}-audit`,
          )
        ) {
          throw new CommitValidationRejection(
            trigger.opIndex,
            'app.audit_required',
          );
        }
      }),
    );
    const { do_, server } = await connect(ns, 'validated-client');
    await sendRound(
      do_,
      server,
      [
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'aggregate-c1',
          operations: [
            {
              table: 'tasks',
              rowId: 't1',
              op: 'upsert',
              payload: taskRow('t1', 'L', 'needs-audit'),
            },
          ],
        },
      ],
      'validated-client',
    );

    const response = decodeRoundResponse(server.sent);
    if (response.msgKind !== 'response') throw new Error('expected response');
    const result = response.frames.find(
      (frame): frame is PushResultFrame => frame.type === 'PUSH_RESULT',
    );
    expect(result).toMatchObject({
      status: 'rejected',
      results: [
        {
          opIndex: 0,
          status: 'error',
          code: 'app.audit_required',
          retryable: false,
        },
      ],
    });
  });

  test('a commit fans out as a delta to a subscribed socket (§8.2)', async () => {
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(db, realtimeConfig());
    // Reader connects and registers a subscription via a pull round (§8.7 end
    // → §8.1 registration reload).
    const { do_, server: reader } = await connect(ns, 'reader');
    await sendRound(
      do_,
      reader,
      [
        {
          type: 'PULL_HEADER',
          limitCommits: 100,
          limitSnapshotRows: 100,
          maxSnapshotPages: 4,
          accept: 0b0011,
        },
        {
          type: 'SUBSCRIPTION',
          id: 's1',
          table: 'tasks',
          scopes: { list_id: ['L'] },
          cursor: -1,
        },
      ],
      'reader',
    );
    // Ack the reader's cursor up to the latest applied seq (§8.2) so the
    // wake-pending suppression lifts and subsequent commits arrive as deltas.
    await do_.deliver(reader, JSON.stringify({ type: 'ack', cursor: 0 }));
    await settle();
    reader.sent.length = 0;
    // A writer pushes a commit over its own socket on the SAME DO.
    const { server: writer } = await connect(ns, 'writer');
    await sendRound(
      do_,
      writer,
      [
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'w1',
          operations: [
            {
              table: 'tasks',
              rowId: 't2',
              op: 'upsert',
              payload: taskRow('t2', 'L', 'live'),
            },
          ],
        },
      ],
      'writer',
    );
    // The reader receives a 0x00-tagged delta carrying the new row.
    const delta = reader.sent.find(
      (f): f is Uint8Array =>
        f instanceof Uint8Array && f[0] === REALTIME_TAG_DELTA,
    );
    expect(delta).toBeDefined();
    const decoded = decodeMessage((delta as Uint8Array).subarray(1));
    if (decoded.msgKind !== 'response') throw new Error('expected response');
    const sub = decoded.frames.find(
      (f): f is SubStartFrame => f.type === 'SUB_START' && f.id === 's1',
    );
    expect(sub).toBeDefined();
  });

  test('hibernation: rehydrate the session from attachment + D1, no re-hello', async () => {
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(db, realtimeConfig());
    const { do_, server } = await connect(ns, 'client-1');
    // Drain the initial hello; then hibernate (drop the in-memory session map).
    server.sent.length = 0;
    do_.simulateHibernation();
    // Deliver a round after the wake: the host must rehydrate the session from
    // the socket attachment + the D1 client record — and NOT re-send hello.
    await sendRound(
      do_,
      server,
      [
        {
          type: 'PUSH_COMMIT',
          clientCommitId: 'after-wake',
          operations: [
            {
              table: 'tasks',
              rowId: 't3',
              op: 'upsert',
              payload: taskRow('t3', 'L', 'rehydrated'),
            },
          ],
        },
      ],
      'client-1',
    );
    // No hello frame after the wake (rehydration is transparent, §8.1).
    const helloAfter = textFrames(server.sent).find((m) => m.event === 'hello');
    expect(helloAfter).toBeUndefined();
    // The round still applied — proof the rehydrated session drove the handler.
    const response = decodeRoundResponse(server.sent);
    if (response.msgKind !== 'response') throw new Error('expected response');
    const result = response.frames.find(
      (f): f is PushResultFrame => f.type === 'PUSH_RESULT',
    );
    expect(result?.status).toBe('applied');
  });

  test('HTTP push wakes the DO (§8.3 fan-out, the LISTEN/NOTIFY analogue)', async () => {
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(db, realtimeConfig());
    // A reader connects to the DO and subscribes.
    const { do_, server: reader } = await connect(ns, 'reader');
    await sendRound(
      do_,
      reader,
      [
        {
          type: 'PULL_HEADER',
          limitCommits: 100,
          limitSnapshotRows: 100,
          maxSnapshotPages: 4,
          accept: 0b0011,
        },
        {
          type: 'SUBSCRIPTION',
          id: 's1',
          table: 'tasks',
          scopes: { list_id: ['L'] },
          cursor: -1,
        },
      ],
      'reader',
    );
    reader.sent.length = 0;
    // The outer HTTP handler authenticates, then forwards the sync body into
    // this partition DO and its in-process hub.
    const http = makeHttpHandler(db, ns);
    const pushResp = await http(
      httpSyncRequest(
        [
          {
            type: 'PUSH_COMMIT',
            clientCommitId: 'http-1',
            operations: [
              {
                table: 'tasks',
                rowId: 't4',
                op: 'upsert',
                payload: taskRow('t4', 'L', 'via-http'),
              },
            ],
          },
        ],
        'http-writer',
      ),
    );
    expect(pushResp.status).toBe(200);
    // The reader got a `sync` wake (a re-pull signal, not a byte re-broadcast).
    const wake = textFrames(reader.sent).find((m) => m.event === 'sync');
    expect(wake).toBeDefined();
    expect((wake?.data as { reason?: string }).reason).toBe('catchup-required');
  });

  test('overlapping HTTP duplicates are serialized by the partition DO', async () => {
    let validatorCalls = 0;
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(
      db,
      realtimeConfig(() => {
        validatorCalls += 1;
      }),
    );
    const http = makeHttpHandler(db, ns);
    const commit: PushCommitFrame = {
      type: 'PUSH_COMMIT',
      clientCommitId: 'overlap-http',
      operations: [
        {
          table: 'tasks',
          rowId: 'overlap-http-row',
          op: 'upsert',
          payload: taskRow('overlap-http-row', 'L', 'once'),
        },
      ],
    };

    const [left, right] = await Promise.all([
      decodeHttpSync(http(httpSyncRequest([commit], 'overlap-client'))),
      decodeHttpSync(http(httpSyncRequest([commit], 'overlap-client'))),
    ]);
    const resultOf = (message: typeof left) =>
      message.frames.find(
        (frame): frame is PushResultFrame => frame.type === 'PUSH_RESULT',
      );
    expect([resultOf(left)?.status, resultOf(right)?.status].sort()).toEqual([
      'applied',
      'cached',
    ]);
    expect(validatorCalls).toBe(1);
    const inspect = new D1ServerStorage(db, { pushApplySerialized: true });
    expect(await inspect.getMaxCommitSeq(PARTITION)).toBe(1);
  });

  test('overlapping socket duplicates retain the DO FIFO through round commit', async () => {
    let validatorCalls = 0;
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(
      db,
      realtimeConfig(() => {
        validatorCalls += 1;
      }),
    );
    const first = await connect(ns, 'socket-overlap-client');
    const second = await connect(ns, 'socket-overlap-client');
    first.server.sent.length = 0;
    second.server.sent.length = 0;
    const commit: PushCommitFrame = {
      type: 'PUSH_COMMIT',
      clientCommitId: 'overlap-socket',
      operations: [
        {
          table: 'tasks',
          rowId: 'overlap-socket-row',
          op: 'upsert',
          payload: taskRow('overlap-socket-row', 'L', 'once'),
        },
      ],
    };

    await Promise.all([
      sendRound(first.do_, first.server, [commit], 'socket-overlap-client'),
      sendRound(second.do_, second.server, [commit], 'socket-overlap-client'),
    ]);
    const resultOf = (server: FakeWebSocket) => {
      const message = decodeRoundResponse(server.sent);
      if (message.msgKind !== 'response') throw new Error('expected response');
      return message.frames.find(
        (frame): frame is PushResultFrame => frame.type === 'PUSH_RESULT',
      );
    };
    expect(
      [resultOf(first.server)?.status, resultOf(second.server)?.status].sort(),
    ).toEqual(['applied', 'cached']);
    expect(validatorCalls).toBe(1);
    const inspect = new D1ServerStorage(db, { pushApplySerialized: true });
    expect(await inspect.getMaxCommitSeq(PARTITION)).toBe(1);
  });

  test('different partition DOs remain concurrent', async () => {
    let releasePartitionA!: () => void;
    const partitionAGate = new Promise<void>((resolve) => {
      releasePartitionA = resolve;
    });
    let enteredPartitionA!: () => void;
    const partitionAEntered = new Promise<void>((resolve) => {
      enteredPartitionA = resolve;
    });
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(
      db,
      realtimeConfig(async ({ partition }) => {
        if (partition === 'partition-a') {
          enteredPartitionA();
          await partitionAGate;
        }
      }),
    );
    const directStorage = new D1ServerStorage(db);
    const handler = createWorkersFetchHandler<unknown>({
      config: () => ({
        config: {
          schema: SCHEMA,
          storage: directStorage,
          segments: new MemorySegmentStore(),
          resolveScopes: () => ({ list_id: ['*'] }),
        },
        authenticate: async (request) => ({
          actorId: ACTOR_ID,
          partition: request.headers.get('x-test-partition') ?? '',
        }),
      }),
      coordinator: () => ({ namespace: ns }),
    });
    const request = (partition: string, rowId: string) => {
      const value = httpSyncRequest(
        [
          {
            type: 'PUSH_COMMIT',
            clientCommitId: `commit-${partition}`,
            operations: [
              {
                table: 'tasks',
                rowId,
                op: 'upsert',
                payload: taskRow(rowId, 'L', partition),
              },
            ],
          },
        ],
        `client-${partition}`,
      );
      value.headers.set('x-test-partition', partition);
      return handler(value, {}, { waitUntil: () => {} });
    };

    const partitionA = request('partition-a', 'row-a');
    await partitionAEntered;
    const partitionB = request('partition-b', 'row-b');
    const bFinishedFirst = await Promise.race([
      partitionB.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(bFinishedFirst).toBe(true);
    releasePartitionA();
    expect((await partitionA).status).toBe(200);
    expect((await partitionB).status).toBe(200);
  });

  test('HTTP-forwarded and socket rounds preserve CRDT/blob sync semantics', async () => {
    const attachmentBytes = new Uint8Array([9, 8, 7]);
    const attachmentId = await blobIdFor(attachmentBytes);
    const run = async (transport: 'http' | 'socket') => {
      let mergeCalls = 0;
      let validatorCalls = 0;
      const blobs = new MemoryBlobStore();
      await blobs.put(
        PARTITION,
        attachmentId,
        attachmentBytes,
        1_750_000_000_000,
      );
      const db = await makeDb();
      const ns = new FakeDurableObjectNamespace(
        db,
        realtimeConfig(
          () => {
            validatorCalls += 1;
          },
          {
            blobs,
            crdtMergers: {
              'set-union': (stored, incoming) => {
                mergeCalls += 1;
                const values = new Set<number>(stored ?? []);
                for (const value of incoming) values.add(value);
                return new Uint8Array([...values].sort((a, b) => a - b));
              },
            },
          },
        ),
      );
      const commit: PushCommitFrame = {
        type: 'PUSH_COMMIT',
        clientCommitId: 'transport-parity',
        operations: [
          {
            table: 'tasks',
            rowId: 'transport-row',
            op: 'upsert',
            payload: taskRow(
              'transport-row',
              'L',
              'same semantics',
              new Uint8Array([3, 1]),
              blobRef(attachmentId, attachmentBytes.length),
            ),
          },
        ],
      };
      let result: PushResultFrame | undefined;
      if (transport === 'http') {
        const message = await decodeHttpSync(
          makeHttpHandler(
            db,
            ns,
          )(httpSyncRequest([commit], 'transport-client')),
        );
        result = message.frames.find(
          (frame): frame is PushResultFrame => frame.type === 'PUSH_RESULT',
        );
      } else {
        const { do_, server } = await connect(ns, 'transport-client');
        await sendRound(do_, server, [commit], 'transport-client');
        const message = decodeRoundResponse(server.sent);
        if (message.msgKind !== 'response') {
          throw new Error('expected response');
        }
        result = message.frames.find(
          (frame): frame is PushResultFrame => frame.type === 'PUSH_RESULT',
        );
      }
      const inspect = new D1ServerStorage(db, { pushApplySerialized: true });
      await inspect.ensureSchema(compileSchema(SCHEMA));
      const row = await inspect.getRow(PARTITION, 'tasks', 'transport-row');
      return {
        result,
        mergeCalls,
        validatorCalls,
        payload: row?.payload,
        serverVersion: row?.serverVersion,
      };
    };

    const http = await run('http');
    const socket = await run('socket');
    expect(http.result).toEqual(socket.result);
    expect(http.result?.status).toBe('applied');
    expect(http.mergeCalls).toBe(1);
    expect(socket.mergeCalls).toBe(1);
    expect(http.validatorCalls).toBe(1);
    expect(socket.validatorCalls).toBe(1);
    expect(http.payload).toEqual(socket.payload);
    expect(http.serverVersion).toBe(1);
    expect(socket.serverVersion).toBe(1);
  });

  test('presence fans out between two sockets on the DO (§8.6)', async () => {
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(db, realtimeConfig());
    // Both sockets register the same subscription so they are scope-mates.
    const register: RequestFrame[] = [
      {
        type: 'PULL_HEADER',
        limitCommits: 0,
        limitSnapshotRows: 0,
        maxSnapshotPages: 0,
        accept: 0b0011,
      },
      {
        type: 'SUBSCRIPTION',
        id: 's1',
        table: 'tasks',
        scopes: { list_id: ['L'] },
        cursor: -1,
      },
    ];
    const { do_, server: a } = await connect(ns, 'peer-a');
    await sendRound(do_, a, register, 'peer-a');
    const { server: b } = await connect(ns, 'peer-b');
    await sendRound(do_, b, register, 'peer-b');
    a.sent.length = 0;
    b.sent.length = 0;
    // peer-b publishes presence on the list:L scope key.
    await do_.deliver(
      b,
      JSON.stringify({
        event: 'presence',
        data: { scopeKey: 'list:L', doc: { cursor: 42 } },
      }),
    );
    // peer-a receives the presence fanout.
    const fanout = textFrames(a.sent).find((m) => m.event === 'presence');
    expect(fanout).toBeDefined();
    expect((fanout?.data as { clientId?: string }).clientId).toBe('peer-b');
  });
});

describe('Workers fetch handler realtime route', () => {
  test('GET /realtime forwards the upgrade to the partition DO', async () => {
    setWebSocketPair(TrackedPair);
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(db, realtimeConfig());
    const handler = createWorkersFetchHandler<unknown>({
      config: () => ({
        config: {
          schema: SCHEMA,
          storage: new D1ServerStorage(db),
          segments: new MemorySegmentStore(),
          resolveScopes: () => ({ list_id: ['*'] }),
        },
        authenticate: async () => ({ actorId: ACTOR_ID, partition: PARTITION }),
      }),
      realtime: () => ({
        namespace: ns,
        authenticate: () => ({
          partition: PARTITION,
          actorId: ACTOR_ID,
          clientId: 'via-route',
        }),
      }),
    });
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
    const response = await handler(
      new Request('https://worker.example/realtime', {
        headers: { upgrade: 'websocket' },
      }),
      {},
      ctx,
    );
    expect(response.status).toBe(101);
    // The DO ran a real upgrade → hello for `via-route`.
    const do_ = ns.get(ns.idFromName(PARTITION));
    expect(do_.host.sessionCount).toBe(1);
  });

  test('GET /realtime without an upgrade header is a 426', async () => {
    const db = await makeDb();
    const ns = new FakeDurableObjectNamespace(db, realtimeConfig());
    const handler = createWorkersFetchHandler<unknown>({
      config: () => ({
        config: {
          schema: SCHEMA,
          storage: new D1ServerStorage(db),
          segments: new MemorySegmentStore(),
          resolveScopes: () => ({ list_id: ['*'] }),
        },
        authenticate: async () => ({ actorId: ACTOR_ID, partition: PARTITION }),
      }),
      realtime: () => ({
        namespace: ns,
        authenticate: () => ({
          partition: PARTITION,
          actorId: ACTOR_ID,
          clientId: 'x',
        }),
      }),
    });
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
    const response = await handler(
      new Request('https://worker.example/realtime'),
      {},
      ctx,
    );
    expect(response.status).toBe(426);
  });
});
