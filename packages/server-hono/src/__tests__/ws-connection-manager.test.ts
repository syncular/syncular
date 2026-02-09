import { describe, expect, it } from 'bun:test';
import { type WebSocketConnection, WebSocketConnectionManager } from '../ws';

function createConn(args: {
  actorId: string;
  clientId: string;
  onSync: (cursor: number) => void;
}): WebSocketConnection {
  let open = true;

  return {
    get isOpen() {
      return open;
    },
    actorId: args.actorId,
    clientId: args.clientId,
    transportPath: 'direct',
    sendSync(cursor) {
      if (!open) return;
      args.onSync(cursor);
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

    mgr.updateClientScopeKeys('c1', ['project:p2']);
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

    const denied = mgr.joinPresence('c1', 'user:u2', { status: 'denied' });
    expect(denied).toBe(false);
    expect(mgr.getPresence('user:u2')).toEqual([]);

    const allowed = mgr.joinPresence('c1', 'user:u1', { status: 'ok' });
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
    expect(mgr.joinPresence('c1', 'user:u1', { status: 'initial' })).toBe(true);

    const denied = mgr.updatePresenceMetadata('c1', 'user:u2', {
      status: 'denied',
    });
    expect(denied).toBe(false);

    const allowed = mgr.updatePresenceMetadata('c1', 'user:u1', {
      status: 'updated',
    });
    expect(allowed).toBe(true);
    expect(mgr.getPresence('user:u1')[0]?.metadata).toEqual({
      status: 'updated',
    });
  });
});
