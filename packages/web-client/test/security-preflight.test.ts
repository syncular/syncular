import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClientSyncError,
  SECURITY_PREFLIGHT_REQUIRED_CODE,
  SyncClient,
  type SyncIntent,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { CLIENT_SCHEMA } from './helpers';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function expectPreflightFailure(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClientSyncError);
    expect((error as ClientSyncError).code).toBe(
      SECURITY_PREFLIGHT_REQUIRED_CODE,
    );
    return;
  }
  throw new Error('expected a security-preflight rejection');
}

test('preflight suppresses startup work until exact purge and activation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'syncular-security-preflight-'));
  roots.push(root);
  const path = join(root, 'client.db');

  const initialDb = new BunClientDatabase(path);
  const initial = new SyncClient({
    database: initialDb,
    schema: CLIENT_SCHEMA,
    transport: async () => new Uint8Array(),
  });
  await initial.start();
  initial.subscribe({
    id: 'persisted-tasks',
    table: 'tasks',
    scopes: { project_id: ['facility-1'] },
  });
  await initial.close();
  initialDb.close();

  const intents: SyncIntent[] = [];
  const db = new BunClientDatabase(path);
  const client = new SyncClient({
    database: db,
    schema: CLIENT_SCHEMA,
    transport: async () => {
      throw new Error('transport must not run during preflight');
    },
    securityPreflight: true,
    onSyncIntent: (intent) => intents.push(intent),
  });
  await client.start();

  expect(client.securityLifecycle).toBe('preflight');
  expect(intents).toEqual([]);
  expect(client.statusSnapshot().currentSchemaVersion).toBe(1);
  expect(client.localRevision).toBeGreaterThanOrEqual(0n);
  expectPreflightFailure(() => client.query('SELECT id FROM tasks'));
  expectPreflightFailure(() => client.subscriptions());
  expectPreflightFailure(() => client.mutate([]));
  expectPreflightFailure(() => client.sync());

  expect(
    client.purgeLocalData({
      purgeId: 'directive-1',
      targets: [
        {
          table: 'tasks',
          selectors: { project_id: ['facility-1'] },
        },
      ],
    }),
  ).toEqual({ alreadyApplied: false, purgedRows: 0, droppedCommits: 0 });

  await client.activateSecurity();
  expect(client.securityLifecycle).toBe('active');
  expect(intents).toEqual([{ kind: 'interactive' }]);
  expect(client.query('SELECT id FROM tasks')).toEqual([]);

  await client.close();
  db.close();
});

test('active clients can enter a synchronous fail-closed barrier and rotate keys', async () => {
  const db = new BunClientDatabase(':memory:');
  const client = new SyncClient({
    database: db,
    schema: CLIENT_SCHEMA,
    transport: async () => new Uint8Array(),
  });
  await client.start();
  expect(client.query('SELECT id FROM tasks')).toEqual([]);

  const barrier = client.beginSecurityPreflight();
  expect(client.securityLifecycle).toBe('preflight');
  expectPreflightFailure(() => client.query('SELECT id FROM tasks'));
  await barrier;

  await client.activateSecurity({
    encryption: { keyProvider: () => new Uint8Array(32).fill(7) },
  });
  expect(client.securityLifecycle).toBe('active');
  expect(client.query('SELECT id FROM tasks')).toEqual([]);
  await expect(client.activateSecurity()).rejects.toMatchObject({
    code: 'sync.invalid_request',
  });

  await client.close();
  db.close();
});

test('preflight waits for an in-flight realtime connect and closes its late socket', async () => {
  let resolveSocket:
    | ((socket: {
        send(text: string): void;
        sendBytes(bytes: Uint8Array): void;
        close(): void;
      }) => void)
    | undefined;
  let socketClosed = false;
  const db = new BunClientDatabase(':memory:');
  const client = new SyncClient({
    database: db,
    schema: CLIENT_SCHEMA,
    transport: async () => new Uint8Array(),
    realtime: () =>
      new Promise((resolve) => {
        resolveSocket = resolve;
      }),
  });
  await client.start();

  const connecting = client.connectRealtime();
  await Promise.resolve();
  const barrier = client.beginSecurityPreflight();
  let barrierSettled = false;
  void barrier.then(() => {
    barrierSettled = true;
  });
  await Promise.resolve();
  expect(barrierSettled).toBe(false);

  resolveSocket?.({
    send: () => {},
    sendBytes: () => {},
    close: () => {
      socketClosed = true;
    },
  });
  await expect(connecting).rejects.toMatchObject({
    code: SECURITY_PREFLIGHT_REQUIRED_CODE,
  });
  await barrier;
  expect(socketClosed).toBe(true);
  expect(barrierSettled).toBe(true);

  await client.close();
  db.close();
});

test('preflight never accepts key material before activation', () => {
  const db = new BunClientDatabase(':memory:');
  expect(
    () =>
      new SyncClient({
        database: db,
        schema: CLIENT_SCHEMA,
        transport: async () => new Uint8Array(),
        securityPreflight: true,
        encryption: { keyProvider: () => new Uint8Array(32) },
      }),
  ).toThrow('securityPreflight and encryption are mutually exclusive');
  db.close();
});
