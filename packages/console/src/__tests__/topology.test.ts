import { describe, expect, it } from 'bun:test';
import { adaptConsoleClientsToTopology } from '../lib/topology';
import type { ConsoleClient, SyncStats } from '../lib/types';

function makeClient(overrides: Partial<ConsoleClient> = {}): ConsoleClient {
  return {
    clientId: 'test-client-1',
    actorId: 'actor-1',
    cursor: 10,
    lagCommitCount: 0,
    connectionPath: 'direct',
    connectionMode: 'realtime',
    realtimeConnectionCount: 1,
    isRealtimeConnected: true,
    activityState: 'active',
    lastRequestAt: '2026-02-28T00:00:00Z',
    lastRequestType: 'pull',
    lastRequestOutcome: 'ok',
    effectiveScopes: { scope1: true },
    updatedAt: '2026-02-28T00:00:00Z',
    ...overrides,
  };
}

const defaultStats: SyncStats = {
  commitCount: 100,
  changeCount: 500,
  minCommitSeq: 1,
  maxCommitSeq: 100,
  clientCount: 5,
  activeClientCount: 3,
  minActiveClientCursor: 80,
  maxActiveClientCursor: 100,
};

describe('inferType (via adaptConsoleClientsToTopology)', () => {
  it.each([
    ['ios-client-abc', 'mobile'],
    ['android-device-1', 'mobile'],
    ['desktop-app-v2', 'desktop'],
    ['mac-workstation', 'desktop'],
    ['windows-service', 'desktop'],
    ['linux-daemon-3', 'desktop'],
    ['browser-session', 'browser'],
    ['web-frontend', 'browser'],
    ['server-backend', 'server'],
    ['api-gateway', 'server'],
    ['iot-sensor-42', 'iot'],
    ['sensor-hub', 'iot'],
    ['tablet-user-7', 'tablet'],
  ] as const)('maps "%s" to type "%s"', (clientId, expectedType) => {
    const clients = [makeClient({ clientId })];
    const [node] = adaptConsoleClientsToTopology(clients, defaultStats);
    expect(node.type).toBe(expectedType);
  });

  it('returns "client" for unknown hints', () => {
    const clients = [makeClient({ clientId: 'fridge-sync' })];
    const [node] = adaptConsoleClientsToTopology(clients, defaultStats);
    expect(node.type).toBe('client');
  });
});

describe('inferDialect (via adaptConsoleClientsToTopology)', () => {
  it.each([
    ['pglite-client-1', 'PGlite'],
    ['my-sqlite-app', 'SQLite'],
    ['wa-sqlite-worker', 'SQLite'],
    ['postgres-backend', 'PostgreSQL'],
    ['pg-proxy', 'PostgreSQL'],
    ['generic-client', 'unknown'],
  ] as const)('extracts dialect "%s" → "%s"', (clientId, expectedDialect) => {
    const clients = [makeClient({ clientId })];
    const [node] = adaptConsoleClientsToTopology(clients, defaultStats);
    expect(node.dialect).toBe(expectedDialect);
  });
});

describe('adaptConsoleClientsToTopology', () => {
  it('respects maxNodes option', () => {
    const clients = Array.from({ length: 20 }, (_, i) =>
      makeClient({ clientId: `client-${i}`, actorId: `actor-${i}` })
    );

    const withDefault = adaptConsoleClientsToTopology(clients, defaultStats);
    expect(withDefault).toHaveLength(10);

    const withCustom = adaptConsoleClientsToTopology(clients, defaultStats, {
      maxNodes: 3,
    });
    expect(withCustom).toHaveLength(3);
  });

  it('maps cursor, actor, mode, scopes, and lastSeen fields', () => {
    const clients = [
      makeClient({
        clientId: 'short-id',
        actorId: 'a1',
        cursor: 42,
        connectionMode: 'polling',
        effectiveScopes: { scopeA: true, scopeB: true },
        updatedAt: '2026-01-15T12:00:00Z',
      }),
    ];

    const [node] = adaptConsoleClientsToTopology(clients, defaultStats);
    expect(node.cursor).toBe(42);
    expect(node.actor).toBe('a1');
    expect(node.mode).toBe('polling');
    expect(node.scopes).toEqual(['scopeA', 'scopeB']);
    expect(node.lastSeen).toBe('2026-01-15T12:00:00Z');
  });
});

describe('inferStatus (via adaptConsoleClientsToTopology)', () => {
  it('returns "offline" when activityState is stale', () => {
    const clients = [makeClient({ activityState: 'stale', lagCommitCount: 0 })];
    const [node] = adaptConsoleClientsToTopology(clients, defaultStats);
    expect(node.status).toBe('offline');
  });

  it('returns "syncing" when lagCommitCount > 0 and not stale', () => {
    const clients = [
      makeClient({ activityState: 'active', lagCommitCount: 5 }),
    ];
    const [node] = adaptConsoleClientsToTopology(clients, defaultStats);
    expect(node.status).toBe('syncing');
  });

  it('returns "online" when active and fully caught up', () => {
    const clients = [
      makeClient({ activityState: 'active', lagCommitCount: 0 }),
    ];
    const [node] = adaptConsoleClientsToTopology(clients, defaultStats);
    expect(node.status).toBe('online');
  });
});

describe('createDisplayId (via adaptConsoleClientsToTopology)', () => {
  it('returns the full clientId when it is 16 chars or shorter', () => {
    const clients = [makeClient({ clientId: 'exactly-16-chars' })];
    const [node] = adaptConsoleClientsToTopology(clients, defaultStats);
    expect(node.id).toBe('exactly-16-chars');
  });

  it('truncates long clientIds to 12-char prefix plus index', () => {
    const clients = [
      makeClient({ clientId: 'this-is-a-very-long-client-identifier' }),
    ];
    const [node] = adaptConsoleClientsToTopology(clients, defaultStats);
    expect(node.id).toBe('this-is-a-ve-1');
  });
});
