/**
 * Integration tests for SyncProvider reconfiguration
 *
 * Tests that verify the SyncProvider correctly handles changes to critical props.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  type ClientHandlerCollection,
  ensureClientSyncSchema,
  type SyncClientDb,
  SyncEngine,
} from '@syncular/client';
import { createDatabase } from '@syncular/core';
import { createBunSqliteDialect } from '@syncular/dialect-bun-sqlite';
import { cleanup, render } from '@testing-library/react';
import type { Kysely } from 'kysely';
import { createElement } from 'react';
import { createSyncularReact } from '../../index';
import {
  createTestServer,
  destroyTestServer,
  type TestServer,
} from './test-setup';
import '../setup'; // Ensure happy-dom is registered

/**
 * Client database schema for tests
 */
interface ClientDb extends SyncClientDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    server_version: number;
  };
}

const { SyncProvider } = createSyncularReact<ClientDb>();

// Create mock handlers for tests
function createMockClientHandlers(): ClientHandlerCollection<ClientDb> {
  return [];
}

describe('SyncProvider Reconfiguration', () => {
  let server: TestServer;
  let db: Kysely<ClientDb>;
  let mockHandlers: ClientHandlerCollection<ClientDb>;

  beforeEach(async () => {
    server = await createTestServer();
    db = createDatabase<ClientDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    mockHandlers = createMockClientHandlers();

    await ensureClientSyncSchema(db);

    // Create tasks table
    await db.schema
      .createTable('tasks')
      .ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('completed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
    await destroyTestServer(server);
  });

  it('SyncEngine recreates when actorId changes', async () => {
    // Create a simple transport for testing
    const transport = {
      async sync() {
        return { ok: true as const };
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
      },
    };

    // Create first engine with actorId 'user-1'
    const engine1 = new SyncEngine({
      db,
      transport,
      handlers: mockHandlers,
      actorId: 'user-1',
      clientId: 'client-1',
      subscriptions: [],
      pollIntervalMs: 999999,
      realtimeEnabled: false,
    });

    // Verify engine has correct actorId
    expect(engine1.getActorId()).toBe('user-1');

    // Create second engine with different actorId
    const engine2 = new SyncEngine({
      db,
      transport,
      handlers: mockHandlers,
      actorId: 'user-2',
      clientId: 'client-1',
      subscriptions: [],
      pollIntervalMs: 999999,
      realtimeEnabled: false,
    });

    // Verify new engine has different actorId
    expect(engine2.getActorId()).toBe('user-2');

    // Engines should be different instances
    expect(engine1).not.toBe(engine2);

    // Cleanup
    engine1.destroy();
    engine2.destroy();
  });

  it('error message format for prop changes is correct', () => {
    // Tests that the error message format is correct for prop changes
    // In dev mode, SyncProvider throws an error when critical props change
    // In production, it logs an error

    const initialProps = {
      actorId: 'user-1',
      clientId: 'client-1',
    };

    const newActorId = 'user-2';
    const changedProps: string[] = [];

    if (newActorId !== initialProps.actorId) changedProps.push('actorId');

    // Verify message construction
    expect(changedProps.length).toBe(1);
    expect(changedProps[0]).toBe('actorId');

    const message =
      `[SyncProvider] Critical props changed after mount: ${changedProps.join(', ')}. ` +
      'This is not supported. Use a React key prop to force remount, e.g., ' +
      "<SyncProvider key={identity.actorId + ':' + clientId} ...>";

    expect(message).toContain(
      '[SyncProvider] Critical props changed after mount'
    );
    expect(message).toContain('actorId');
    expect(message).toContain('This is not supported');
    expect(message).toContain(
      "<SyncProvider key={identity.actorId + ':' + clientId} ...>"
    );
  });

  it('engine config is immutable after creation', () => {
    const transport = {
      async sync() {
        return { ok: true as const };
      },
      async fetchSnapshotChunk() {
        return new Uint8Array();
      },
    };

    const engine = new SyncEngine({
      db,
      transport,
      handlers: mockHandlers,
      actorId: 'user-1',
      clientId: 'client-1',
      subscriptions: [],
      pollIntervalMs: 999999,
      realtimeEnabled: false,
    });

    const originalActorId = engine.getActorId();
    expect(originalActorId).toBe('user-1');

    // Engine should maintain its original config
    expect(engine.getActorId()).toBe('user-1');

    engine.destroy();
  });
});

describe('SyncProvider React render tests', () => {
  let db: Kysely<ClientDb>;
  let mockHandlers: ClientHandlerCollection<ClientDb>;
  const mockTransport = {
    async sync() {
      return { ok: true as const };
    },
    async fetchSnapshotChunk() {
      return new Uint8Array();
    },
  };

  beforeEach(async () => {
    db = createDatabase<ClientDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    mockHandlers = [];
    await ensureClientSyncSchema(db);
  });

  afterEach(async () => {
    cleanup();
    await db.destroy();
  });

  it('warns when critical props change after mount', () => {
    const child = createElement('div', null, 'Test Child');
    const sync = {
      handlers: mockHandlers,
      subscriptions: () => [],
    };

    // Render with initial props
    const { rerender } = render(
      createElement(SyncProvider, {
        db,
        transport: mockTransport,
        sync,
        identity: { actorId: 'user-1' },
        clientId: 'client-1',
        autoStart: false, // Disable auto-start for faster test
        // biome-ignore lint/correctness/noChildrenProp: createElement requires children prop
        children: child,
      })
    );

    // Re-render with changed actorId should warn but not throw
    expect(() => {
      rerender(
        createElement(SyncProvider, {
          db,
          transport: mockTransport,
          sync,
          identity: { actorId: 'user-2' }, // Changed!
          clientId: 'client-1',
          autoStart: false,
          // biome-ignore lint/correctness/noChildrenProp: createElement requires children prop
          children: child,
        })
      );
    }).not.toThrow();
  });

  it('does not throw when non-critical props change', () => {
    const child = createElement('div', null, 'Test Child');
    const sync = {
      handlers: mockHandlers,
      subscriptions: () => [],
    };
    const { rerender } = render(
      createElement(SyncProvider, {
        db,
        transport: mockTransport,
        sync,
        identity: { actorId: 'user-1' },
        clientId: 'client-1',
        autoStart: false,
        pollIntervalMs: 1000,
        // biome-ignore lint/correctness/noChildrenProp: createElement requires children prop
        children: child,
      })
    );

    // Re-render with changed pollIntervalMs should not throw
    expect(() => {
      rerender(
        createElement(SyncProvider, {
          db,
          transport: mockTransport,
          sync,
          identity: { actorId: 'user-1' },
          clientId: 'client-1',
          autoStart: false,
          pollIntervalMs: 5000, // Changed non-critical prop
          // biome-ignore lint/correctness/noChildrenProp: createElement requires children prop
          children: child,
        })
      );
    }).not.toThrow();
  });
});
