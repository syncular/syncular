import { describe, expect, test } from 'bun:test';
import { decodeRow } from '@syncular/core';
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
import { SyncRemoteClient } from '../src/index';
import { CLIENT_SCHEMA, makeServer, PARTITION, TASK_COLUMNS } from './helpers';

describe('SyncRemoteClient', () => {
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

  test('watches a registered query and receives replacement snapshots', async () => {
    const server = makeServer();
    const descriptor = {
      id: 'sha256:test/watchTasks',
      hasParams: true,
      sql: 'SELECT id, title FROM tasks WHERE project_id = ? ORDER BY id',
      tables: ['tasks'],
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
});
