import { describe, expect, it } from 'bun:test';
import {
  createWebSocketConnectionOwnerKey,
  type WebSocketConnection,
  WebSocketConnectionManager,
  type WebSocketSyncMetadata,
} from '../ws';

function createConn(args: {
  actorId: string;
  clientId: string;
  onSync: (
    cursor: number,
    changes?: unknown[],
    metadata?: WebSocketSyncMetadata
  ) => void;
  onSyncPack?: (bytes: Uint8Array) => void;
  syncPackEncoding?: WebSocketConnection['syncPackEncoding'];
}): WebSocketConnection {
  let open = true;

  return {
    get isOpen() {
      return open;
    },
    actorId: args.actorId,
    clientId: args.clientId,
    ownerKey: createWebSocketConnectionOwnerKey({
      partitionId: 'default',
      actorId: args.actorId,
      clientId: args.clientId,
    }),
    transportPath: 'direct',
    syncPackEncoding: args.syncPackEncoding ?? null,
    sendHello() {},
    sendSync(cursor, changes, metadata) {
      if (!open) return;
      args.onSync(cursor, changes, metadata);
    },
    sendSyncPack(bytes) {
      if (!open) return;
      args.onSyncPack?.(bytes);
    },
    sendHeartbeat() {},
    sendPresence() {},
    sendError() {
      open = false;
    },
    close() {
      open = false;
    },
  };
}

describe('WebSocketConnectionManager (scopes)', () => {
  it('notifies connections based on scope overlap', () => {
    const mgr = new WebSocketConnectionManager({ heartbeatIntervalMs: 0 });
    const seen: Array<{ clientId: string; cursor: number }> = [];

    const c1 = createConn({
      actorId: 'u1',
      clientId: 'c1',
      onSync: (cursor) => seen.push({ clientId: 'c1', cursor }),
    });
    const c2 = createConn({
      actorId: 'u2',
      clientId: 'c2',
      onSync: (cursor) => seen.push({ clientId: 'c2', cursor }),
    });

    mgr.register(c1, ['user:u1']);
    mgr.register(c2, ['user:u2']);

    mgr.notifyScopeKeys(['user:u1'], 10);
    expect(seen).toEqual([{ clientId: 'c1', cursor: 10 }]);
  });

  it('updates scopes for a connected client', () => {
    const mgr = new WebSocketConnectionManager({ heartbeatIntervalMs: 0 });
    const seen: number[] = [];

    const c1 = createConn({
      actorId: 'u1',
      clientId: 'c1',
      onSync: (cursor) => seen.push(cursor),
    });

    mgr.register(c1, ['project:p1']);
    mgr.notifyScopeKeys(['project:p1'], 1);

    mgr.updateConnectionScopeKeys(c1.ownerKey, ['project:p2']);
    mgr.notifyScopeKeys(['project:p1'], 2);
    mgr.notifyScopeKeys(['project:p2'], 3);

    expect(seen).toEqual([1, 3]);
  });

  it('dedupes notifications across multiple matching scopes', () => {
    const mgr = new WebSocketConnectionManager({ heartbeatIntervalMs: 0 });
    const seen: number[] = [];

    const c1 = createConn({
      actorId: 'u1',
      clientId: 'c1',
      onSync: (cursor) => seen.push(cursor),
    });

    mgr.register(c1, ['a', 'b']);
    mgr.notifyScopeKeys(['a', 'b'], 5);

    expect(seen).toEqual([5]);
  });

  it('supports excluding a client id', () => {
    const mgr = new WebSocketConnectionManager({ heartbeatIntervalMs: 0 });
    const seen: string[] = [];

    const c1 = createConn({
      actorId: 'u1',
      clientId: 'c1',
      onSync: () => seen.push('c1'),
    });
    const c2 = createConn({
      actorId: 'u1',
      clientId: 'c2',
      onSync: () => seen.push('c2'),
    });

    mgr.register(c1, ['s']);
    mgr.register(c2, ['s']);

    mgr.notifyScopeKeys(['s'], 123, { excludeClientIds: ['c1'] });
    expect(seen).toEqual(['c2']);
  });

  it('sends binary sync packs only to connections that negotiated them', () => {
    const mgr = new WebSocketConnectionManager({ heartbeatIntervalMs: 0 });
    const seen: Array<{ clientId: string; kind: 'json' | 'binary' }> = [];
    const syncPack = new Uint8Array([0x53, 0x53, 0x50, 0x31]);

    const binary = createConn({
      actorId: 'u1',
      clientId: 'binary',
      syncPackEncoding: 'binary-sync-pack-v1',
      onSync: () => seen.push({ clientId: 'binary', kind: 'json' }),
      onSyncPack: () => seen.push({ clientId: 'binary', kind: 'binary' }),
    });
    const json = createConn({
      actorId: 'u1',
      clientId: 'json',
      onSync: () => seen.push({ clientId: 'json', kind: 'json' }),
      onSyncPack: () => seen.push({ clientId: 'json', kind: 'binary' }),
    });

    mgr.register(binary, ['s']);
    mgr.register(json, ['s']);
    mgr.notifyScopeKeys(['s'], 123, {
      changes: [{ table: 'tasks', row_id: 'task-1' }],
      syncPack,
    });

    expect(seen).toEqual([
      { clientId: 'binary', kind: 'binary' },
      { clientId: 'json', kind: 'json' },
    ]);
  });

  it('replays recent binary sync packs after reconnect when the cursor is inside the window', () => {
    const mgr = new WebSocketConnectionManager({
      heartbeatIntervalMs: 0,
      replayWindowSize: 4,
    });
    const liveSeen: number[] = [];
    const live = createConn({
      actorId: 'u1',
      clientId: 'live',
      syncPackEncoding: 'binary-sync-pack-v1',
      onSync: () => {},
      onSyncPack: (bytes) => liveSeen.push(bytes[0] ?? 0),
    });

    mgr.register(live, ['s']);
    mgr.notifyScopeKeys(['s'], 10, { syncPack: new Uint8Array([10]) });
    mgr.notifyScopeKeys(['s'], 11, { syncPack: new Uint8Array([11]) });

    const replaySeen: number[] = [];
    const replayed = createConn({
      actorId: 'u1',
      clientId: 'replayed',
      syncPackEncoding: 'binary-sync-pack-v1',
      onSync: () => {},
      onSyncPack: (bytes) => replaySeen.push(bytes[0] ?? 0),
    });

    expect(mgr.replayScopeKeys(replayed, ['s'], 9, 11)).toBe(true);
    expect(liveSeen).toEqual([10, 11]);
    expect(replaySeen).toEqual([10, 11]);
  });

  it('refuses websocket replay when the requested cursor fell out of the window', () => {
    const mgr = new WebSocketConnectionManager({
      heartbeatIntervalMs: 0,
      replayWindowSize: 1,
    });
    const conn = createConn({
      actorId: 'u1',
      clientId: 'c1',
      syncPackEncoding: 'binary-sync-pack-v1',
      onSync: () => {},
      onSyncPack: () => {},
    });

    mgr.notifyScopeKeys(['s'], 10, { syncPack: new Uint8Array([10]) });
    mgr.notifyScopeKeys(['s'], 11, { syncPack: new Uint8Array([11]) });

    expect(mgr.replayScopeKeys(conn, ['s'], 9, 11)).toBe(false);
  });

  it('supports per-connection inline deltas for mixed scopes', () => {
    const mgr = new WebSocketConnectionManager({ heartbeatIntervalMs: 0 });
    const seen: Array<{
      clientId: string;
      kind: 'json' | 'binary';
      value: unknown;
    }> = [];

    const binary1 = createConn({
      actorId: 'u1',
      clientId: 'binary-1',
      syncPackEncoding: 'binary-sync-pack-v1',
      onSync: (_cursor, changes) =>
        seen.push({ clientId: 'binary-1', kind: 'json', value: changes }),
      onSyncPack: (bytes) =>
        seen.push({
          clientId: 'binary-1',
          kind: 'binary',
          value: Array.from(bytes),
        }),
    });
    const binary2 = createConn({
      actorId: 'u2',
      clientId: 'binary-2',
      syncPackEncoding: 'binary-sync-pack-v1',
      onSync: (_cursor, changes) =>
        seen.push({ clientId: 'binary-2', kind: 'json', value: changes }),
      onSyncPack: (bytes) =>
        seen.push({
          clientId: 'binary-2',
          kind: 'binary',
          value: Array.from(bytes),
        }),
    });
    const json = createConn({
      actorId: 'u2',
      clientId: 'json',
      onSync: (_cursor, changes) =>
        seen.push({ clientId: 'json', kind: 'json', value: changes }),
      onSyncPack: (bytes) =>
        seen.push({ clientId: 'json', kind: 'binary', value: bytes }),
    });

    mgr.register(binary1, ['s1']);
    mgr.register(binary2, ['s2']);
    mgr.register(json, ['s2']);
    mgr.notifyScopeKeys(['s1', 's2'], 123, {
      changesForConnection: (connection) => [
        { row_id: `row-${connection.clientId}` },
      ],
      syncPackForConnection: (connection) =>
        connection.clientId === 'binary-1'
          ? new Uint8Array([1])
          : connection.clientId === 'binary-2'
            ? new Uint8Array([2])
            : undefined,
    });

    expect(seen).toEqual([
      { clientId: 'binary-1', kind: 'binary', value: [1] },
      { clientId: 'binary-2', kind: 'binary', value: [2] },
      {
        clientId: 'json',
        kind: 'json',
        value: [{ row_id: 'row-json' }],
      },
    ]);
  });

  it('marks cursor-only recovery when websocket payloads are too large', () => {
    const mgr = new WebSocketConnectionManager({ heartbeatIntervalMs: 0 });
    const seen: Array<{
      cursor: number;
      changes?: unknown[];
      metadata?: WebSocketSyncMetadata;
    }> = [];
    const json = createConn({
      actorId: 'u1',
      clientId: 'json',
      onSync: (cursor, changes, metadata) =>
        seen.push({ cursor, changes, metadata }),
    });

    mgr.register(json, ['s']);
    mgr.notifyScopeKeys(['s'], 123, {
      changes: [
        {
          table: 'tasks',
          row_id: 'large',
          row_json: { title: 'x'.repeat(80 * 1024) },
        },
      ],
    });

    expect(seen).toEqual([
      {
        cursor: 123,
        changes: undefined,
        metadata: { reason: 'payload-too-large', requiresPull: true },
      },
    ]);
  });

  it('sends resync-required frames while a connection is over its in-flight limit', () => {
    const mgr = new WebSocketConnectionManager({
      heartbeatIntervalMs: 0,
      maxInFlightSyncsPerConnection: 2,
    });
    const seen: Array<{
      cursor: number;
      changes?: unknown[];
      metadata?: WebSocketSyncMetadata;
    }> = [];
    const conn = createConn({
      actorId: 'u1',
      clientId: 'slow',
      onSync: (cursor, changes, metadata) =>
        seen.push({ cursor, changes, metadata }),
    });

    mgr.register(conn, ['s']);
    mgr.notifyScopeKeys(['s'], 1);
    mgr.notifyScopeKeys(['s'], 2);
    mgr.notifyScopeKeys(['s'], 3);
    mgr.notifyScopeKeys(['s'], 4);

    expect(seen).toEqual([
      {
        cursor: 1,
        changes: undefined,
        metadata: { reason: 'server-wakeup', requiresPull: true },
      },
      {
        cursor: 2,
        changes: undefined,
        metadata: { reason: 'server-wakeup', requiresPull: true },
      },
      {
        cursor: 3,
        changes: undefined,
        metadata: {
          reason: 'resync-required',
          requiresPull: true,
          droppedCount: 1,
        },
      },
      {
        cursor: 4,
        changes: undefined,
        metadata: {
          reason: 'resync-required',
          requiresPull: true,
          droppedCount: 2,
        },
      },
    ]);

    mgr.recordAck(conn, 4);
    mgr.notifyScopeKeys(['s'], 5);

    expect(seen.at(-1)).toEqual({
      cursor: 5,
      changes: undefined,
      metadata: { reason: 'server-wakeup', requiresPull: true },
    });
  });

  it('keeps partial cursor ACKs from forcing unnecessary resync', () => {
    const mgr = new WebSocketConnectionManager({
      heartbeatIntervalMs: 0,
      maxInFlightSyncsPerConnection: 2,
    });
    const seen: Array<{
      cursor: number;
      changes?: unknown[];
      metadata?: WebSocketSyncMetadata;
    }> = [];
    const conn = createConn({
      actorId: 'u1',
      clientId: 'catching-up',
      onSync: (cursor, changes, metadata) =>
        seen.push({ cursor, changes, metadata }),
    });

    mgr.register(conn, ['s']);
    mgr.notifyScopeKeys(['s'], 1);
    mgr.notifyScopeKeys(['s'], 2);
    mgr.recordAck(conn, 1);
    mgr.notifyScopeKeys(['s'], 3);
    mgr.notifyScopeKeys(['s'], 4);

    expect(seen).toEqual([
      {
        cursor: 1,
        changes: undefined,
        metadata: { reason: 'server-wakeup', requiresPull: true },
      },
      {
        cursor: 2,
        changes: undefined,
        metadata: { reason: 'server-wakeup', requiresPull: true },
      },
      {
        cursor: 3,
        changes: undefined,
        metadata: { reason: 'server-wakeup', requiresPull: true },
      },
      {
        cursor: 4,
        changes: undefined,
        metadata: {
          reason: 'resync-required',
          requiresPull: true,
          droppedCount: 1,
        },
      },
    ]);
  });

  it('stops notifying after unregister', () => {
    const mgr = new WebSocketConnectionManager({ heartbeatIntervalMs: 0 });
    const seen: number[] = [];

    const c1 = createConn({
      actorId: 'u1',
      clientId: 'c1',
      onSync: (cursor) => seen.push(cursor),
    });

    const unregister = mgr.register(c1, ['s']);
    mgr.notifyScopeKeys(['s'], 1);

    unregister();
    mgr.notifyScopeKeys(['s'], 2);

    expect(seen).toEqual([1]);
  });

  it('allows presence join only for authorized scope keys', () => {
    const mgr = new WebSocketConnectionManager({ heartbeatIntervalMs: 0 });
    const c1 = createConn({
      actorId: 'u1',
      clientId: 'c1',
      onSync: () => {},
    });

    mgr.register(c1, ['user:u1']);

    const denied = mgr.joinPresence(c1.ownerKey, 'user:u2', {
      status: 'denied',
    });
    expect(denied).toBe(false);
    expect(mgr.getPresence('user:u2')).toEqual([]);

    const allowed = mgr.joinPresence(c1.ownerKey, 'user:u1', {
      status: 'ok',
    });
    expect(allowed).toBe(true);
    expect(mgr.getPresence('user:u1')).toHaveLength(1);
  });

  it('allows presence update only for authorized scope keys', () => {
    const mgr = new WebSocketConnectionManager({ heartbeatIntervalMs: 0 });
    const c1 = createConn({
      actorId: 'u1',
      clientId: 'c1',
      onSync: () => {},
    });

    mgr.register(c1, ['user:u1']);
    expect(
      mgr.joinPresence(c1.ownerKey, 'user:u1', { status: 'initial' })
    ).toBe(true);

    const denied = mgr.updatePresenceMetadata(c1.ownerKey, 'user:u2', {
      status: 'denied',
    });
    expect(denied).toBe(false);

    const allowed = mgr.updatePresenceMetadata(c1.ownerKey, 'user:u1', {
      status: 'updated',
    });
    expect(allowed).toBe(true);
    expect(mgr.getPresence('user:u1')[0]?.metadata).toEqual({
      status: 'updated',
    });
  });
});
