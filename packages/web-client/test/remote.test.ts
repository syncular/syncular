import { describe, expect, test } from 'bun:test';
import {
  decodeMessage,
  decodeRow,
  encodeRemoteOperationRealtimeMessage,
  encodeRemoteOperationResponse,
  type RemoteOperationResponse,
} from '@syncular/core';
import {
  composeRealtimeNotifiers,
  handleRemoteOperation,
  handleSyncRequest,
  registerRemoteCommand,
  registerRemoteQuery,
  remoteCommand,
  RemoteOperationRegistry,
  RemoteOperationWatchHub,
} from '@syncular/server';
import {
  SyncRemoteClient,
  type RemoteOperationRealtimeHandlers,
} from '../src/index';
import { CLIENT_SCHEMA, makeServer, PARTITION, TASK_COLUMNS } from './helpers';

describe('SyncRemoteClient', () => {
  test('binds prepared ordinary commits to an explicit log epoch', async () => {
    const client = new SyncRemoteClient({
      schema: CLIENT_SCHEMA,
      clientId: 'epoch-worker',
      logEpoch: 'epoch-2',
    });
    const prepared = await client.prepareCommit({
      requestId: 'epoch-job-1',
      mutations: [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'task-epoch',
            project_id: 'project-1',
            title: 'Epoch bound',
            done: false,
            priority: null,
            meta: null,
          },
        },
      ],
    });

    const message = decodeMessage(prepared.bytes);
    expect(message.wireVersion).toBe(2);
    expect(message.frames[0]).toMatchObject({
      type: 'REQ_HEADER',
      logEpoch: 'epoch-2',
    });
  });

  test('applies an ordinary push-only commit without a local database', async () => {
    const server = makeServer();
    const client = new SyncRemoteClient({
      schema: CLIENT_SCHEMA,
      clientId: 'appointment-worker',
      transport: (bytes) => handleSyncRequest(bytes, server.ctxFor('worker')),
    });

    const outcome = await client.commit({
      requestId: 'job-1',
      mutations: [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'task-1',
            projectId: 'project-1',
            title: 'Confirm appointment',
            done: false,
            priority: 2,
            meta: '{"source":"worker"}',
          },
        },
      ],
    });

    expect(outcome.status).toBe('applied');
    expect(outcome.commitSeq).toBe(1);
    const stored = await server.storage.getRow(PARTITION, 'tasks', 'task-1');
    expect(stored).toBeDefined();
    expect(
      decodeRow(TASK_COLUMNS, stored?.payload ?? new Uint8Array()),
    ).toEqual([
      'task-1',
      'project-1',
      'Confirm appointment',
      false,
      2,
      '{"source":"worker"}',
    ]);
    server.storage.db.close();
  });

  test('reuses prepared bytes after response loss and receives cached', async () => {
    const server = makeServer();
    const client = new SyncRemoteClient({
      schema: CLIENT_SCHEMA,
      clientId: 'webhook-worker',
      transport: (bytes) => handleSyncRequest(bytes, server.ctxFor('worker')),
    });
    const prepared = await client.prepareCommit({
      requestId: 'webhook-7',
      mutations: [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'task-7',
            project_id: 'project-1',
            title: 'Imported once',
            done: false,
            priority: null,
            meta: null,
          },
        },
      ],
    });

    await handleSyncRequest(prepared.bytes, server.ctxFor('worker'));
    const replay = await client.sendCommit(prepared);

    expect(replay.status).toBe('cached');
    expect(replay.commitSeq).toBe(1);
    expect(await server.storage.getMaxCommitSeq(PARTITION)).toBe(1);
    server.storage.db.close();
  });

  test('surfaces conflicts directly and does not retain an outbox', async () => {
    const server = makeServer();
    const client = new SyncRemoteClient({
      schema: CLIENT_SCHEMA,
      clientId: 'conflict-worker',
      transport: (bytes) => handleSyncRequest(bytes, server.ctxFor('worker')),
    });
    await client.commit({
      requestId: 'create',
      mutations: [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'task-1',
            project_id: 'project-1',
            title: 'Current',
            done: false,
            priority: null,
            meta: null,
          },
        },
      ],
    });

    const outcome = await client.commit({
      requestId: 'stale-update',
      mutations: [
        {
          table: 'tasks',
          op: 'upsert',
          baseVersion: 0,
          values: {
            id: 'task-1',
            project_id: 'project-1',
            title: 'Stale',
            done: true,
            priority: null,
            meta: null,
          },
        },
      ],
    });

    expect(outcome.status).toBe('rejected');
    expect(outcome.results[0]?.status).toBe('conflict');
    server.storage.db.close();
  });

  test('runs a registered scoped query without a local database', async () => {
    const server = makeServer();
    const descriptor = {
      id: 'sha256:test/tasksInProject',
      hasParams: true,
      sql: 'SELECT id, title, done, NULL AS attachment FROM tasks WHERE project_id = ? ORDER BY id',
      tables: ['tasks'],
      resultColumns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'done', type: 'boolean', nullable: false },
        { name: 'attachment', type: 'bytes', nullable: true },
      ] as const,
      bind: (params: { projectId: string }) => [params.projectId],
      dependencies: () => [{ table: 'tasks' }],
      coverage: (params: { projectId: string }) => [
        {
          base: { table: 'tasks', variable: 'project_id' },
          units: [params.projectId],
        },
      ],
      mapRow: (row: Readonly<Record<string, unknown>>) => ({
        id: String(row.id),
        title: String(row.title),
        done: row.done === true || row.done === 1,
        attachment:
          row.attachment instanceof Uint8Array
            ? [...row.attachment]
            : undefined,
      }),
    };
    const registry = new RemoteOperationRegistry([
      registerRemoteQuery(descriptor, {
        maxRows: 100,
        auth: { access: 'scoped' },
      }),
    ]);
    const context = { ...server.ctxFor('worker'), storage: server.storage };
    const queryAuthoritative = server.storage.queryAuthoritative.bind(
      server.storage,
    );
    server.storage.queryAuthoritative = async (partition, query) => {
      const result = await queryAuthoritative(partition, query);
      return {
        ...result,
        rows: result.rows.map((row) => ({
          ...row,
          attachment: new Uint8Array([0, 1, 255]).buffer,
        })),
      };
    };
    const writer = new SyncRemoteClient({
      schema: CLIENT_SCHEMA,
      clientId: 'query-writer',
      transport: (bytes) => handleSyncRequest(bytes, context),
    });
    const client = new SyncRemoteClient({
      clientId: 'query-worker',
      operations: (bytes) => handleRemoteOperation(bytes, context, registry),
    });
    await writer.commit({
      requestId: 'query-seed',
      mutations: [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'task-1',
            project_id: 'project-1',
            title: 'Visible',
            done: false,
            priority: null,
            meta: null,
          },
        },
      ],
    });

    const result = await client.query(descriptor, {
      projectId: 'project-1',
    });

    expect(result.maxCommitSeq).toBe(1);
    expect(result.rows).toEqual([
      {
        id: 'task-1',
        title: 'Visible',
        done: false,
        attachment: [0, 1, 255],
      },
    ]);
    server.allowed.worker = { project_id: ['project-1'] };
    await expect(
      client.query(descriptor, { projectId: 'project-2' }),
    ).rejects.toMatchObject({ code: 'operation.forbidden' });
    server.storage.db.close();
  });

  test('rejects scoped query metadata that omits a declared table scope', async () => {
    const server = makeServer();
    const descriptor = {
      id: 'sha256:test/incompleteDocsCoverage',
      hasParams: true,
      sql: 'SELECT id FROM docs WHERE org_id = ? AND project_id = ?',
      tables: ['docs'],
      resultColumns: [{ name: 'id', type: 'string', nullable: false }] as const,
      bind: (params: { orgId: string; projectId: string }) => [
        params.orgId,
        params.projectId,
      ],
      dependencies: () => [{ table: 'docs' }],
      coverage: (params: { orgId: string }) => [
        {
          base: { table: 'docs', variable: 'org_id' },
          units: [params.orgId],
        },
      ],
      mapRow: (row: Readonly<Record<string, unknown>>) => ({
        id: String(row.id),
      }),
    };
    const registry = new RemoteOperationRegistry([
      registerRemoteQuery(descriptor, {
        maxRows: 10,
        auth: { access: 'scoped' },
      }),
    ]);
    const context = { ...server.ctxFor('worker'), storage: server.storage };
    const client = new SyncRemoteClient({
      clientId: 'query-worker',
      operations: (bytes) => handleRemoteOperation(bytes, context, registry),
    });

    await expect(
      client.query(descriptor, {
        orgId: 'org-1',
        projectId: 'project-1',
      }),
    ).rejects.toMatchObject({ code: 'operation.invalid_request' });
    server.storage.db.close();
  });

  test('rejects registered query rows that violate generated result metadata', async () => {
    const server = makeServer();
    const descriptor = {
      id: 'query/invalid-result',
      hasParams: false,
      sql: 'SELECT id, 1.5 AS estimate FROM tasks',
      tables: ['tasks'],
      resultColumns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'estimate', type: 'float', nullable: false },
      ] as const,
      bind: () => [],
      dependencies: () => [{ table: 'tasks' }],
      coverage: () => [],
      mapRow: (row: Readonly<Record<string, unknown>>) => row,
    };
    const registry = new RemoteOperationRegistry([
      registerRemoteQuery(descriptor, {
        maxRows: 10,
        auth: { access: 'privileged', authorize: () => true },
      }),
    ]);
    server.storage.queryAuthoritative = async () => ({
      rows: [{ id: null, estimate: 1.5 }],
      maxCommitSeq: 0,
    });
    const context = { ...server.ctxFor('worker'), storage: server.storage };
    const client = new SyncRemoteClient({
      clientId: 'query-worker',
      operations: (bytes) => handleRemoteOperation(bytes, context, registry),
    });

    await expect(client.query(descriptor)).rejects.toMatchObject({
      code: 'operation.query_failed',
    });
    server.storage.queryAuthoritative = async () => ({
      rows: [{ id: 'task-1', estimate: ' ' }],
      maxCommitSeq: 0,
    });
    await expect(client.query(descriptor)).rejects.toMatchObject({
      code: 'operation.query_failed',
    });
    server.storage.db.close();
  });

  test('returns only columns declared by generated result metadata', async () => {
    const server = makeServer();
    const descriptor = {
      id: 'query/declared-result',
      hasParams: false,
      sql: 'SELECT id FROM tasks',
      tables: ['tasks'],
      resultColumns: [{ name: 'id', type: 'string', nullable: false }] as const,
      bind: () => [],
      dependencies: () => [{ table: 'tasks' }],
      coverage: () => [],
      mapRow: (row: Readonly<Record<string, unknown>>) => row,
    };
    const registry = new RemoteOperationRegistry([
      registerRemoteQuery(descriptor, {
        maxRows: 10,
        auth: { access: 'privileged', authorize: () => true },
      }),
    ]);
    server.storage.queryAuthoritative = async () => ({
      rows: [{ id: 'task-1', internal: 'must-not-leak' }],
      maxCommitSeq: 0,
    });
    const context = { ...server.ctxFor('worker'), storage: server.storage };
    const client = new SyncRemoteClient({
      clientId: 'query-worker',
      operations: (bytes) => handleRemoteOperation(bytes, context, registry),
    });

    expect((await client.query(descriptor)).rows).toEqual([{ id: 'task-1' }]);
    server.storage.db.close();
  });

  test('sanitizes generated row mapper failures', async () => {
    const client = new SyncRemoteClient({
      clientId: 'query-worker',
      operations: async () =>
        encodeRemoteOperationResponse({
          revision: 1,
          kind: 'query',
          operationId: 'query/map-failure',
          rows: [{}],
          maxCommitSeq: 0,
        }),
    });

    await expect(
      client.query({
        id: 'query/map-failure',
        mapRow: () => {
          throw new Error('raw mapper failure');
        },
      }),
    ).rejects.toMatchObject({
      code: 'client.invalid_host_response',
      message: 'remote query row is malformed',
    });
  });

  test('rejects a non-object remote operation response', async () => {
    const client = new SyncRemoteClient({
      clientId: 'query-worker',
      operations: async () => new TextEncoder().encode('{"t":"null"}'),
    });

    await expect(
      client.query({ id: 'query/null', mapRow: (row) => row }),
    ).rejects.toMatchObject({ code: 'client.invalid_host_response' });
  });

  test('rejects a remote operation clientId bound to another actor', async () => {
    const server = makeServer();
    const writer = new SyncRemoteClient({
      schema: CLIENT_SCHEMA,
      clientId: 'bound-service',
      transport: (bytes) => handleSyncRequest(bytes, server.ctxFor('worker')),
    });
    await writer.commit({
      requestId: 'bind-client',
      mutations: [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'task-1',
            project_id: 'project-1',
            title: 'Bound',
            done: false,
            priority: null,
            meta: null,
          },
        },
      ],
    });
    const descriptor = {
      id: 'sha256:test/boundClientQuery',
      hasParams: false,
      sql: 'SELECT id FROM tasks',
      tables: ['tasks'],
      resultColumns: [{ name: 'id', type: 'string', nullable: false }] as const,
      bind: () => [],
      dependencies: () => [{ table: 'tasks' }],
      coverage: () => [],
      mapRow: (row: Readonly<Record<string, unknown>>) => ({
        id: String(row.id),
      }),
    };
    const registry = new RemoteOperationRegistry([
      registerRemoteQuery(descriptor, {
        maxRows: 10,
        auth: { access: 'privileged', authorize: () => true },
      }),
    ]);
    const context = {
      ...server.ctxFor('other-actor'),
      storage: server.storage,
    };
    const client = new SyncRemoteClient({
      clientId: 'bound-service',
      operations: (bytes) => handleRemoteOperation(bytes, context, registry),
    });

    await expect(client.query(descriptor)).rejects.toMatchObject({
      code: 'sync.invalid_client_id',
    });
    server.storage.db.close();
  });

  test('runs an idempotent authoritative command inside the push transaction', async () => {
    const server = makeServer();
    const descriptor = remoteCommand<{ taskId: string }>(
      'commands/complete-task-v1',
    );
    let runs = 0;
    const registry = new RemoteOperationRegistry([
      registerRemoteCommand(descriptor, {
        authorize: ({ actorId }) => actorId === 'worker',
        run: async (context, input) => {
          runs += 1;
          const task = await context.getRow('tasks', input.taskId);
          if (task === undefined) throw new Error('task is unavailable');
          return [
            {
              table: 'tasks',
              op: 'upsert',
              values: { ...task, done: true },
            },
          ];
        },
      }),
    ]);
    const context = { ...server.ctxFor('worker'), storage: server.storage };
    const client = new SyncRemoteClient({
      schema: CLIENT_SCHEMA,
      clientId: 'command-worker',
      transport: (bytes) => handleSyncRequest(bytes, context),
      operations: (bytes) => handleRemoteOperation(bytes, context, registry),
    });
    await client.commit({
      requestId: 'command-seed',
      mutations: [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'task-1',
            project_id: 'project-1',
            title: 'Complete me',
            done: false,
            priority: null,
            meta: null,
          },
        },
      ],
    });

    const first = await client.command(descriptor, 'request-1', {
      taskId: 'task-1',
    });
    const replay = await client.command(descriptor, 'request-1', {
      taskId: 'task-1',
    });

    expect(first.status).toBe('applied');
    expect(first.commitSeq).toBe(2);
    expect(replay.status).toBe('cached');
    expect(runs).toBe(1);
    const stored = await server.storage.getRow(PARTITION, 'tasks', 'task-1');
    expect(
      decodeRow(TASK_COLUMNS, stored?.payload ?? new Uint8Array())[3],
    ).toBe(true);
    server.storage.db.close();
  });

  test('isolates command idempotency when actors reuse a clientId', async () => {
    const server = makeServer();
    const descriptor = remoteCommand('commands/actor-isolation');
    let runs = 0;
    const registry = new RemoteOperationRegistry([
      registerRemoteCommand(descriptor, {
        authorize: () => true,
        run: ({ actorId }) => {
          runs += 1;
          return [
            {
              table: 'tasks',
              op: 'upsert',
              values: {
                id: `task-${actorId}`,
                project_id: 'project-1',
                title: actorId,
                done: false,
                priority: null,
                meta: null,
              },
            },
          ];
        },
      }),
    ]);
    const firstContext = {
      ...server.ctxFor('first-actor'),
      storage: server.storage,
    };
    const secondContext = {
      ...server.ctxFor('second-actor'),
      storage: server.storage,
    };
    const first = new SyncRemoteClient({
      clientId: 'shared-worker-id',
      operations: (bytes) =>
        handleRemoteOperation(bytes, firstContext, registry),
    });
    const second = new SyncRemoteClient({
      clientId: 'shared-worker-id',
      operations: (bytes) =>
        handleRemoteOperation(bytes, secondContext, registry),
    });

    expect((await first.command(descriptor, 'request-1')).status).toBe(
      'applied',
    );
    expect((await second.command(descriptor, 'request-1')).status).toBe(
      'applied',
    );
    expect(runs).toBe(2);
    expect(await server.storage.getMaxCommitSeq(PARTITION)).toBe(2);
    server.storage.db.close();
  });

  test('keeps command and request id tuples collision-free', async () => {
    const server = makeServer();
    const firstDescriptor = remoteCommand<{ taskId: string }>('commands/a:b');
    const secondDescriptor = remoteCommand<{ taskId: string }>('commands/a');
    let runs = 0;
    const register = (descriptor: typeof firstDescriptor, title: string) =>
      registerRemoteCommand(descriptor, {
        authorize: () => true,
        run: async (context, input) => {
          runs += 1;
          const task = await context.getRow('tasks', input.taskId);
          if (task === undefined) throw new Error('task is unavailable');
          return [
            {
              table: 'tasks',
              op: 'upsert' as const,
              values: { ...task, title },
            },
          ];
        },
      });
    const registry = new RemoteOperationRegistry([
      register(firstDescriptor, 'First'),
      register(secondDescriptor, 'Second'),
    ]);
    const context = { ...server.ctxFor('worker'), storage: server.storage };
    const client = new SyncRemoteClient({
      schema: CLIENT_SCHEMA,
      clientId: 'command-worker',
      transport: (bytes) => handleSyncRequest(bytes, context),
      operations: (bytes) => handleRemoteOperation(bytes, context, registry),
    });
    await client.commit({
      requestId: 'seed-collision-test',
      mutations: [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'task-1',
            project_id: 'project-1',
            title: 'Original',
            done: false,
            priority: null,
            meta: null,
          },
        },
      ],
    });

    const first = await client.command(firstDescriptor, 'c', {
      taskId: 'task-1',
    });
    const second = await client.command(secondDescriptor, 'b:c', {
      taskId: 'task-1',
    });

    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    expect(runs).toBe(2);
    expect(await server.storage.getMaxCommitSeq(PARTITION)).toBe(3);
    server.storage.db.close();
  });

  test('reports unexpected command failures as server execution errors', async () => {
    const server = makeServer();
    const descriptor = remoteCommand('commands/fails');
    const registry = new RemoteOperationRegistry([
      registerRemoteCommand(descriptor, {
        authorize: () => true,
        run: () => {
          throw new Error('private diagnostic');
        },
      }),
    ]);
    const context = { ...server.ctxFor('worker'), storage: server.storage };
    const client = new SyncRemoteClient({
      clientId: 'command-worker',
      operations: (bytes) => handleRemoteOperation(bytes, context, registry),
    });

    await expect(client.command(descriptor, 'request-1')).rejects.toMatchObject(
      {
        code: 'operation.execution_failed',
        message: 'registered remote operation failed',
      },
    );
    server.storage.db.close();
  });

  test('watches a registered query and receives replacement snapshots', async () => {
    const server = makeServer();
    const descriptor = {
      id: 'sha256:test/watchTasks',
      hasParams: true,
      sql: 'SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id',
      tables: ['tasks'],
      resultColumns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ] as const,
      bind: (params: { projectId: string }) => [params.projectId],
      dependencies: () => [{ table: 'tasks' }],
      coverage: (params: { projectId: string }) => [
        {
          base: { table: 'tasks', variable: 'project_id' },
          units: [params.projectId],
        },
      ],
      mapRow: (row: Readonly<Record<string, unknown>>) => ({
        id: String(row.id),
        title: String(row.title),
      }),
    };
    const registry = new RemoteOperationRegistry([
      registerRemoteQuery(descriptor, {
        maxRows: 100,
        auth: { access: 'scoped' },
      }),
    ]);
    const watchHub = new RemoteOperationWatchHub(registry);
    const baseContext = { ...server.ctxFor('worker'), storage: server.storage };
    const context = {
      ...baseContext,
      realtime: composeRealtimeNotifiers(
        baseContext.realtime ?? server.hub,
        watchHub,
      ),
    };
    const client = new SyncRemoteClient({
      schema: CLIENT_SCHEMA,
      clientId: 'watch-worker',
      transport: (bytes) => handleSyncRequest(bytes, context),
      operations: (bytes) => handleRemoteOperation(bytes, context, registry),
      operationRealtime: (handlers) => {
        const session = watchHub.connect(context, handlers.onMessage);
        return {
          send: (bytes) => {
            void session.receive(bytes);
          },
          close: () => {
            session.close();
            handlers.onClose?.();
          },
        };
      },
    });
    const snapshots: Array<readonly { id: string; title: string }[]> = [];
    let resolveInitial!: () => void;
    let resolveChanged!: () => void;
    const initial = new Promise<void>((resolve) => {
      resolveInitial = resolve;
    });
    const changed = new Promise<void>((resolve) => {
      resolveChanged = resolve;
    });
    const unwatch = await client.watch(
      descriptor,
      { projectId: 'project-1' },
      {
        onSnapshot: (snapshot) => {
          snapshots.push(snapshot.rows);
          if (snapshots.length === 1) resolveInitial();
          if (snapshots.length === 2) resolveChanged();
        },
      },
    );
    await initial;
    await client.commit({
      requestId: 'watch-change',
      mutations: [
        {
          table: 'tasks',
          op: 'upsert',
          values: {
            id: 'task-1',
            project_id: 'project-1',
            title: 'Now visible',
            done: false,
            priority: null,
            meta: null,
          },
        },
      ],
    });
    await changed;

    expect(snapshots).toEqual([[], [{ id: 'task-1', title: 'Now visible' }]]);
    unwatch();
    client.close();
    server.storage.db.close();
  });

  test('does not publish a snapshot after its watch is removed', async () => {
    const server = makeServer();
    let finish!: (response: RemoteOperationResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const operation = {
      kind: 'query' as const,
      id: 'query/deferred',
      tables: ['tasks'],
      run: () =>
        new Promise<RemoteOperationResponse>((resolve) => {
          markStarted();
          finish = resolve;
        }),
    };
    const hub = new RemoteOperationWatchHub(
      new RemoteOperationRegistry([operation]),
    );
    const sent: Uint8Array[] = [];
    const session = hub.connect(server.ctxFor('worker'), (bytes) => {
      sent.push(bytes);
    });
    const pending = session.receive(
      encodeRemoteOperationRealtimeMessage({
        revision: 1,
        kind: 'watch',
        watchId: 'watch-1',
        clientId: 'worker-client',
        operationId: operation.id,
        params: null,
      }),
    );
    await started;
    await session.receive(
      encodeRemoteOperationRealtimeMessage({
        revision: 1,
        kind: 'unwatch',
        watchId: 'watch-1',
      }),
    );
    finish({
      revision: 1,
      kind: 'query',
      operationId: operation.id,
      rows: [],
      maxCommitSeq: 0,
    });
    await pending;

    expect(sent).toEqual([]);
    session.close();
    server.storage.db.close();
  });

  test('rejects malformed watch messages with a stable operation error', async () => {
    const server = makeServer();
    const hub = new RemoteOperationWatchHub(new RemoteOperationRegistry([]));
    const session = hub.connect(server.ctxFor('worker'), () => undefined);

    await expect(
      session.receive(new TextEncoder().encode('{')),
    ).rejects.toMatchObject({ code: 'operation.invalid_request' });

    session.close();
    server.storage.db.close();
  });

  test('cancels a realtime connection that opens after close', async () => {
    let connect!: (socket: {
      send(bytes: Uint8Array): void;
      close(): void;
    }) => void;
    let closes = 0;
    const descriptor = {
      id: 'query/pending-connect',
      mapRow: (row: Readonly<Record<string, unknown>>) => row,
    };
    const client = new SyncRemoteClient({
      clientId: 'watch-worker',
      operationRealtime: () =>
        new Promise((resolve) => {
          connect = resolve;
        }),
    });
    const pending = client.watch(descriptor, undefined, {
      onSnapshot: () => undefined,
    });
    client.close();
    connect({
      send: () => undefined,
      close: () => {
        closes += 1;
      },
    });

    await expect(pending).rejects.toMatchObject({
      code: 'client.remote_realtime_cancelled',
    });
    expect(closes).toBe(1);
  });

  test('closes realtime and reports a malformed server message', async () => {
    let realtimeHandlers!: RemoteOperationRealtimeHandlers;
    let closes = 0;
    const errors: string[] = [];
    const descriptor = {
      id: 'query/malformed-message',
      mapRow: (row: Readonly<Record<string, unknown>>) => row,
    };
    const client = new SyncRemoteClient({
      clientId: 'watch-worker',
      operationRealtime: (handlers) => {
        realtimeHandlers = handlers;
        return {
          send: () => undefined,
          close: () => {
            closes += 1;
          },
        };
      },
    });
    await client.watch(descriptor, undefined, {
      onSnapshot: () => undefined,
      onError: (error) => errors.push(error.code),
    });

    realtimeHandlers.onMessage(new TextEncoder().encode('{'));

    expect(errors).toEqual(['client.invalid_host_response']);
    expect(closes).toBe(1);
  });

  test('closes realtime when watch registration cannot be sent', async () => {
    let closes = 0;
    const errors: string[] = [];
    const client = new SyncRemoteClient({
      clientId: 'watch-worker',
      operationRealtime: () => ({
        send: () => {
          throw new Error('socket closed');
        },
        close: () => {
          closes += 1;
        },
      }),
    });

    await expect(
      client.watch(
        {
          id: 'query/send-failure',
          mapRow: (row: Readonly<Record<string, unknown>>) => row,
        },
        undefined,
        {
          onSnapshot: () => undefined,
          onError: (error) => errors.push(error.code),
        },
      ),
    ).rejects.toMatchObject({ code: 'client.remote_realtime_closed' });
    expect(errors).toEqual(['client.remote_realtime_closed']);
    expect(closes).toBe(1);
  });
});
