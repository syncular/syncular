/**
 * @syncular/relay - Tests
 */

import Database from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SyncCombinedRequest, SyncCombinedResponse } from '@syncular/core';
import { createServerHandlerCollection } from '@syncular/server';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Dialect, QueryResult } from 'kysely';
import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
} from 'kysely';
import { PullEngine } from '../client-role/pull-engine';
import { SequenceMapper } from '../client-role/sequence-mapper';
import { ensureRelaySchema } from '../migrate';
import { ModeManager, type RelayMode } from '../mode-manager';
import { createRelayWebSocketConnection, RelayRealtime } from '../realtime';
import { RelayServer } from '../relay';
import type { RelayDatabase } from '../schema';
import { relayPushCommit } from '../server-role/push';

// Helper to create in-memory SQLite database
function createTestDb() {
  const sqlite = new Database(':memory:');

  const dialect: Dialect = {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => ({
      init: async () => {},
      acquireConnection: async () => ({
        executeQuery: async <R>(compiledQuery: {
          sql: string;
          parameters: readonly unknown[];
        }): Promise<QueryResult<R>> => {
          const sql = compiledQuery.sql;
          const params = compiledQuery.parameters ?? [];

          const normalizedSql = sql.trimStart().toLowerCase();
          if (
            normalizedSql.startsWith('select') ||
            normalizedSql.startsWith('with') ||
            normalizedSql.startsWith('pragma')
          ) {
            const stmt = sqlite.prepare(sql);
            return { rows: stmt.all(...params) as R[] };
          }

          const stmt = sqlite.prepare(sql);
          const result = stmt.run(...params);
          return {
            rows: [] as R[],
            numAffectedRows: BigInt(result.changes),
            insertId:
              result.lastInsertRowid != null
                ? BigInt(result.lastInsertRowid)
                : undefined,
          };
        },
        streamQuery: <R>(): AsyncIterableIterator<QueryResult<R>> => {
          throw new Error('Not implemented');
        },
      }),
      beginTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      releaseConnection: async () => {},
      destroy: async () => {},
    }),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };

  const db = new Kysely<RelayDatabase>({ dialect });

  return { db, sqlite };
}

describe('ModeManager', () => {
  it('should start in offline mode', () => {
    const manager = new ModeManager();
    expect(manager.getMode()).toBe('offline');
  });

  it('should transition to online on success', async () => {
    const modes: RelayMode[] = [];
    const manager = new ModeManager({
      healthCheckIntervalMs: 100,
      onModeChange: (mode) => modes.push(mode),
    });

    manager.start(async () => true);

    // Wait for health check
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(manager.getMode()).toBe('online');
    expect(modes).toContain('online');

    manager.stop();
  });

  it('should transition to reconnecting on failure', async () => {
    const modes: RelayMode[] = [];
    const manager = new ModeManager({
      healthCheckIntervalMs: 100,
      reconnectBackoffMs: 50,
      onModeChange: (mode) => modes.push(mode),
    });

    // Start online
    manager.start(async () => true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(manager.getMode()).toBe('online');

    // Report failure
    manager.reportFailure();
    expect(manager.getMode()).toBe('reconnecting');
    expect(modes).toContain('reconnecting');

    manager.stop();
  });

  it('should reset backoff on success', () => {
    const manager = new ModeManager({
      reconnectBackoffMs: 1000,
    });

    // Report multiple failures to increase backoff
    manager.reportFailure();
    manager.reportFailure();
    manager.reportFailure();

    // Success should reset
    manager.reportSuccess();
    expect(manager.getMode()).toBe('online');
  });

  it('should transition from offline to reconnecting on initial failure', async () => {
    const manager = new ModeManager({
      healthCheckIntervalMs: 100,
      reconnectBackoffMs: 50,
    });

    manager.start(async () => false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(manager.getMode()).toBe('reconnecting');
    manager.stop();
  });
});

describe('RelayServer health check', () => {
  let db: Kysely<RelayDatabase>;
  let sqlite: Database;

  beforeEach(() => {
    const setup = createTestDb();
    db = setup.db;
    sqlite = setup.sqlite;
  });

  afterEach(async () => {
    await db.destroy();
    sqlite.close();
  });

  it('uses a protocol-valid pull limit during startup health checks', async () => {
    const syncCalls: SyncCombinedRequest[] = [];
    const mainServerTransport = {
      async sync(request: SyncCombinedRequest): Promise<SyncCombinedResponse> {
        syncCalls.push(request);
        return {};
      },
      async fetchSnapshotChunk(): Promise<Uint8Array> {
        return new Uint8Array();
      },
    };

    const relay = new RelayServer({
      db,
      dialect: createSqliteServerDialect(),
      mainServerTransport,
      mainServerClientId: 'relay-main-client',
      mainServerActorId: 'relay-main-actor',
      tables: [],
      scopes: {},
      handlers: createServerHandlerCollection<RelayDatabase>([]),
      healthCheckIntervalMs: 50,
      pullIntervalMs: 10_000,
      forwardRetryIntervalMs: 10_000,
      pruneIntervalMs: 0,
    });

    await relay.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await relay.stop();

    expect(
      syncCalls.some(
        (request) =>
          request.pull?.subscriptions.length === 0 &&
          request.pull.limitCommits === 1
      )
    ).toBe(true);
  });
});

describe('relayPushCommit atomic enqueue', () => {
  let db: Kysely<RelayDatabase>;
  let sqlite: Database;

  beforeEach(async () => {
    const setup = createTestDb();
    db = setup.db;
    sqlite = setup.sqlite;
    await ensureRelaySchema(db, createSqliteServerDialect());
  });

  afterEach(async () => {
    await db.destroy();
    sqlite.close();
  });

  it('rolls back local commit when forwarding enqueue fails', async () => {
    const now = Date.now();
    await sql`
      insert into ${sql.table('relay_forward_outbox')} (
        id,
        local_commit_seq,
        client_id,
        client_commit_id,
        operations_json,
        schema_version,
        status,
        main_commit_seq,
        error,
        last_response_json,
        created_at,
        updated_at,
        attempt_count
      )
      values (
        ${'fixed-outbox-id'},
        ${999},
        ${'seed-client'},
        ${'seed-commit'},
        ${'[]'},
        ${1},
        ${'pending'},
        ${null},
        ${null},
        ${null},
        ${now},
        ${now},
        ${0}
      )
    `.execute(db);

    const handlers = createServerHandlerCollection<RelayDatabase>([
      {
        table: 'tasks',
        scopePatterns: ['user:{user_id}'],
        resolveScopes: async () => ({ user_id: ['u1'] }),
        extractScopes: () => ({ user_id: 'u1' }),
        snapshot: async () => ({ rows: [], nextCursor: null }),
        async applyOperation(_ctx, op, opIndex) {
          return {
            result: {
              opIndex,
              status: 'applied',
            },
            emittedChanges: [
              {
                table: 'tasks',
                row_id: op.row_id,
                op: op.op,
                row_json: op.payload,
                row_version: 1,
                scopes: { user_id: 'u1' },
              },
            ],
          };
        },
      },
    ]);

    const originalRandomUUID = crypto.randomUUID;
    crypto.randomUUID = () => 'fixed-outbox-id';
    try {
      await expect(
        relayPushCommit({
          db,
          dialect: createSqliteServerDialect(),
          handlers,
          auth: { actorId: 'u1' },
          request: {
            clientId: 'relay-client-1',
            clientCommitId: 'relay-commit-1',
            schemaVersion: 1,
            operations: [
              {
                table: 'tasks',
                row_id: 'task-1',
                op: 'upsert',
                payload: { id: 'task-1', title: 'hello' },
                base_version: null,
              },
            ],
          },
        })
      ).rejects.toThrow();
    } finally {
      crypto.randomUUID = originalRandomUUID;
    }

    const commitRows = await sql<{ count: number | bigint }>`
      select count(*) as count
      from ${sql.table('sync_commits')}
      where ${sql.ref('client_id')} = ${'relay-client-1'}
        and ${sql.ref('client_commit_id')} = ${'relay-commit-1'}
    `.execute(db);
    expect(Number(commitRows.rows[0]?.count ?? 0)).toBe(0);
  });
});

describe('PullEngine cursor safety', () => {
  let db: Kysely<RelayDatabase>;
  let sqlite: Database;

  beforeEach(async () => {
    const setup = createTestDb();
    db = setup.db;
    sqlite = setup.sqlite;
    await ensureRelaySchema(db, createSqliteServerDialect());
  });

  afterEach(async () => {
    await db.destroy();
    sqlite.close();
  });

  it('does not advance cursor when a pulled commit is rejected locally', async () => {
    const syncCalls: SyncCombinedRequest[] = [];
    const transport = {
      async sync(request: SyncCombinedRequest): Promise<SyncCombinedResponse> {
        syncCalls.push(request);
        return {
          pull: {
            ok: true,
            subscriptions: [
              {
                id: 'tasks',
                status: 'active',
                scopes: {},
                bootstrap: false,
                nextCursor: 25,
                commits: [
                  {
                    commitSeq: 25,
                    createdAt: new Date(0).toISOString(),
                    actorId: 'main-actor',
                    changes: [
                      {
                        table: 'tasks',
                        row_id: 'task-1',
                        op: 'upsert',
                        row_json: { id: 'task-1', title: 'from-main' },
                        row_version: 1,
                        scopes: {},
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      },
      async fetchSnapshotChunk(): Promise<Uint8Array> {
        return new Uint8Array();
      },
    };

    const handlers = createServerHandlerCollection<RelayDatabase>([
      {
        table: 'tasks',
        scopePatterns: ['user:{user_id}'],
        resolveScopes: async () => ({}),
        extractScopes: () => ({}),
        snapshot: async () => ({ rows: [], nextCursor: null }),
        async applyOperation(_ctx, _op, opIndex) {
          return {
            result: {
              opIndex,
              status: 'conflict',
              message: 'reject locally',
              server_version: 1,
              server_row: {},
            },
            emittedChanges: [],
          };
        },
      },
    ]);

    const pullErrors: Error[] = [];
    const pullEngine = new PullEngine({
      db,
      dialect: createSqliteServerDialect(),
      transport,
      clientId: 'relay-client',
      tables: ['tasks'],
      scopes: {},
      handlers,
      sequenceMapper: new SequenceMapper({ db }),
      realtime: new RelayRealtime({ heartbeatIntervalMs: 0 }),
      onError: (error) => pullErrors.push(error),
    });

    await pullEngine.pullOnce();
    await pullEngine.pullOnce();

    expect(pullErrors.length).toBe(2);
    expect(syncCalls.length).toBe(2);
    expect(syncCalls[0]?.pull?.subscriptions[0]?.cursor).toBe(-1);
    expect(syncCalls[1]?.pull?.subscriptions[0]?.cursor).toBe(-1);

    const rowResult = await sql<{ value_json: string }>`
      select value_json
      from ${sql.table('relay_config')}
      where key = 'main_cursors'
      limit 1
    `.execute(db);
    const row = rowResult.rows[0];

    const cursorState: Record<string, number> = {};
    if (row?.value_json) {
      const parsed = JSON.parse(row.value_json);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'number') {
            cursorState[key] = value;
          }
        }
      }
    }

    expect(cursorState.tasks).toBeUndefined();
  });
});

describe('RelayRealtime', () => {
  it('should start with no connections', () => {
    const realtime = new RelayRealtime();
    expect(realtime.getTotalConnections()).toBe(0);
  });

  it('should register and unregister connections', () => {
    const realtime = new RelayRealtime({ heartbeatIntervalMs: 0 });

    const mockWs = {
      send: () => {},
      close: () => {},
      readyState: 1,
    };

    const conn = createRelayWebSocketConnection(mockWs, {
      actorId: 'actor1',
      clientId: 'client1',
    });

    const unregister = realtime.register(conn, ['scope:test']);
    expect(realtime.getTotalConnections()).toBe(1);
    expect(realtime.getConnectionCount('client1')).toBe(1);

    unregister();
    expect(realtime.getTotalConnections()).toBe(0);
    expect(realtime.getConnectionCount('client1')).toBe(0);
  });

  it('should update client scopes', () => {
    const realtime = new RelayRealtime({ heartbeatIntervalMs: 0 });

    const mockWs = {
      send: () => {},
      close: () => {},
      readyState: 1,
    };

    const conn = createRelayWebSocketConnection(mockWs, {
      actorId: 'actor1',
      clientId: 'client1',
    });

    realtime.register(conn, ['scope:a']);
    realtime.updateClientScopeKeys('client1', ['scope:a', 'scope:b']);

    // Should still have 1 connection
    expect(realtime.getTotalConnections()).toBe(1);

    realtime.closeAll();
  });

  it('should notify connections by scope', () => {
    const realtime = new RelayRealtime({ heartbeatIntervalMs: 0 });

    const messages1: string[] = [];
    const messages2: string[] = [];

    const mockWs1 = {
      send: (msg: string) => messages1.push(msg),
      close: () => {},
      readyState: 1,
    };

    const mockWs2 = {
      send: (msg: string) => messages2.push(msg),
      close: () => {},
      readyState: 1,
    };

    const conn1 = createRelayWebSocketConnection(mockWs1, {
      actorId: 'actor1',
      clientId: 'client1',
    });

    const conn2 = createRelayWebSocketConnection(mockWs2, {
      actorId: 'actor2',
      clientId: 'client2',
    });

    realtime.register(conn1, ['scope:a']);
    realtime.register(conn2, ['scope:b']);

    // Notify scope:a - only client1 should receive
    realtime.notifyScopeKeys(['scope:a'], 42);
    expect(messages1.length).toBe(1);
    expect(messages2.length).toBe(0);

    const parsed = JSON.parse(messages1[0]);
    expect(parsed.event).toBe('sync');
    expect(parsed.data.cursor).toBe(42);

    realtime.closeAll();
  });

  it('should exclude specified client IDs from notifications', () => {
    const realtime = new RelayRealtime({ heartbeatIntervalMs: 0 });

    const messages1: string[] = [];
    const messages2: string[] = [];

    const conn1 = createRelayWebSocketConnection(
      {
        send: (msg: string) => messages1.push(msg),
        close: () => {},
        readyState: 1,
      },
      { actorId: 'actor1', clientId: 'client1' }
    );

    const conn2 = createRelayWebSocketConnection(
      {
        send: (msg: string) => messages2.push(msg),
        close: () => {},
        readyState: 1,
      },
      { actorId: 'actor2', clientId: 'client2' }
    );

    realtime.register(conn1, ['scope:shared']);
    realtime.register(conn2, ['scope:shared']);

    // Notify but exclude client1
    realtime.notifyScopeKeys(['scope:shared'], 100, {
      excludeClientIds: ['client1'],
    });

    expect(messages1.length).toBe(0);
    expect(messages2.length).toBe(1);

    realtime.closeAll();
  });
});

describe('SequenceMapper', () => {
  let db: Kysely<RelayDatabase>;
  let sqlite: Database;
  let mapper: SequenceMapper<RelayDatabase>;

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;

    const dialect = createSqliteServerDialect();
    await ensureRelaySchema(db, dialect);

    mapper = new SequenceMapper({ db });
  });

  afterEach(async () => {
    await db.destroy();
    sqlite.close();
  });

  it('should create pending mappings', async () => {
    await mapper.createPendingMapping(1);

    const mapping = await mapper.getMapping(1);
    expect(mapping).not.toBeNull();
    expect(mapping?.localCommitSeq).toBe(1);
    expect(mapping?.mainCommitSeq).toBeNull();
    expect(mapping?.status).toBe('pending');
  });

  it('should mark mappings as forwarded', async () => {
    await mapper.createPendingMapping(1);
    await mapper.markForwarded(1, 100);

    const mapping = await mapper.getMapping(1);
    expect(mapping?.mainCommitSeq).toBe(100);
    expect(mapping?.status).toBe('forwarded');
  });

  it('should mark mappings as confirmed', async () => {
    await mapper.createPendingMapping(1);
    await mapper.markForwarded(1, 100);
    await mapper.markConfirmed(1);

    const mapping = await mapper.getMapping(1);
    expect(mapping?.status).toBe('confirmed');
  });

  it('should get local commit seq from main commit seq', async () => {
    await mapper.createPendingMapping(5);
    await mapper.markForwarded(5, 500);

    const localSeq = await mapper.getLocalCommitSeq(500);
    expect(localSeq).toBe(5);
  });

  it('should return null for unknown main commit seq', async () => {
    const localSeq = await mapper.getLocalCommitSeq(999);
    expect(localSeq).toBeNull();
  });

  it('should create confirmed mappings for pulled commits', async () => {
    await mapper.createConfirmedMapping(10, 1000);

    const mapping = await mapper.getMapping(10);
    expect(mapping?.localCommitSeq).toBe(10);
    expect(mapping?.mainCommitSeq).toBe(1000);
    expect(mapping?.status).toBe('confirmed');
  });

  it('should get pending mappings', async () => {
    await mapper.createPendingMapping(1);
    await mapper.createPendingMapping(2);
    await mapper.createPendingMapping(3);
    await mapper.markForwarded(2, 200);

    const pending = await mapper.getPendingMappings();
    expect(pending.length).toBe(2);
    expect(pending[0].localCommitSeq).toBe(1);
    expect(pending[1].localCommitSeq).toBe(3);
  });

  it('should get highest main commit seq', async () => {
    await mapper.createConfirmedMapping(1, 100);
    await mapper.createConfirmedMapping(2, 200);
    await mapper.createConfirmedMapping(3, 150);

    const highest = await mapper.getHighestMainCommitSeq();
    expect(highest).toBe(200);
  });

  it('should return 0 for highest main commit seq when empty', async () => {
    const highest = await mapper.getHighestMainCommitSeq();
    expect(highest).toBe(0);
  });
});

describe('createRelayWebSocketConnection', () => {
  it('should create connection with correct properties', () => {
    const mockWs = {
      send: () => {},
      close: () => {},
      readyState: 1,
    };

    const conn = createRelayWebSocketConnection(mockWs, {
      actorId: 'actor1',
      clientId: 'client1',
    });

    expect(conn.actorId).toBe('actor1');
    expect(conn.clientId).toBe('client1');
    expect(conn.isOpen).toBe(true);
  });

  it('should report closed when readyState is not 1', () => {
    const mockWs = {
      send: () => {},
      close: () => {},
      readyState: 3, // CLOSED
    };

    const conn = createRelayWebSocketConnection(mockWs, {
      actorId: 'actor1',
      clientId: 'client1',
    });

    expect(conn.isOpen).toBe(false);
  });

  it('should send sync events', () => {
    const messages: string[] = [];
    const mockWs = {
      send: (msg: string) => messages.push(msg),
      close: () => {},
      readyState: 1,
    };

    const conn = createRelayWebSocketConnection(mockWs, {
      actorId: 'actor1',
      clientId: 'client1',
    });

    conn.sendSync(42);

    expect(messages.length).toBe(1);
    const parsed = JSON.parse(messages[0]);
    expect(parsed.event).toBe('sync');
    expect(parsed.data.cursor).toBe(42);
    expect(typeof parsed.data.timestamp).toBe('number');
  });

  it('should send heartbeat events', () => {
    const messages: string[] = [];
    const mockWs = {
      send: (msg: string) => messages.push(msg),
      close: () => {},
      readyState: 1,
    };

    const conn = createRelayWebSocketConnection(mockWs, {
      actorId: 'actor1',
      clientId: 'client1',
    });

    conn.sendHeartbeat();

    expect(messages.length).toBe(1);
    const parsed = JSON.parse(messages[0]);
    expect(parsed.event).toBe('heartbeat');
    expect(typeof parsed.data.timestamp).toBe('number');
  });

  it('should not send when closed', () => {
    const messages: string[] = [];
    const mockWs = {
      send: (msg: string) => messages.push(msg),
      close: () => {},
      readyState: 1,
    };

    const conn = createRelayWebSocketConnection(mockWs, {
      actorId: 'actor1',
      clientId: 'client1',
    });

    conn.close();
    conn.sendSync(42);

    expect(messages.length).toBe(0);
  });
});
