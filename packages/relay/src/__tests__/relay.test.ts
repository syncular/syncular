/**
 * @syncular/relay - Tests
 */

import Database from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createSqliteServerDialect } from '@syncular/server-dialect-sqlite';
import type { Dialect, QueryResult } from 'kysely';
import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';
import { SequenceMapper } from '../client-role/sequence-mapper';
import { ensureRelaySchema } from '../migrate';
import { ModeManager, type RelayMode } from '../mode-manager';
import { createRelayWebSocketConnection, RelayRealtime } from '../realtime';
import type { RelayDatabase } from '../schema';

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
