/**
 * The `__SYNCULAR__` console registry: installs on a dev
 * page, tracks live clients + their last invalidation, and unregisters on
 * close. Other suites in the same bun process may install a DOM (react
 * tests) — so the tests save/restore `window` and assert registry deltas
 * for THIS client rather than global absence.
 */
import { afterEach, expect, test } from 'bun:test';
import { registerDevtools } from '../src/devtools';
import { makeClient, makeServer, taskValues } from './helpers';

type Entry = {
  clientId(): string;
  lastInvalidation?: { tables: readonly string[] };
};
type Registry = {
  clients: Entry[];
  snapshot(): Promise<Record<string, unknown>[]>;
};

const g = globalThis as Record<string, unknown>;
const savedWindow = g.window;

const registry = (): Registry | undefined =>
  g.__SYNCULAR__ as Registry | undefined;
const entryFor = (clientId: string): Entry | undefined =>
  registry()?.clients.find((c) => c.clientId() === clientId);

afterEach(() => {
  if (savedWindow === undefined) delete g.window;
  else g.window = savedWindow;
});

test('gated off without a window: starting a client registers nothing', async () => {
  delete g.window;
  const before = registry()?.clients.length ?? 0;
  const server = makeServer();
  const a = await makeClient(server, {
    clientId: 'no-window',
    devtools: registerDevtools,
  });
  expect(registry()?.clients.length ?? 0).toBe(before);
  await a.client.close();
});

test('registers on an opted-in dev page, snapshots state, unregisters on close', async () => {
  g.window ??= g; // a dev "page" (NODE_ENV under bun test is not production)
  const server = makeServer();
  const a = await makeClient(server, {
    clientId: 'dev-client',
    devtools: registerDevtools,
  });
  expect(entryFor('dev-client')).toBeDefined();

  a.client.subscribe({
    id: 's1',
    table: 'tasks',
    scopes: { project_id: ['p1'] },
  });
  a.client.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
  ]);

  const snapshots = await (registry() as Registry).snapshot();
  const snap = snapshots.find((s) => s.clientId === 'dev-client');
  expect(snap?.role).toBe('direct');
  expect(snap?.outbox).toBe(1);
  expect(snap?.subscriptions).toBe(1);
  // The mutate's apply batch was recorded as the last invalidation.
  expect(entryFor('dev-client')?.lastInvalidation?.tables).toContain('tasks');

  await a.client.close();
  expect(entryFor('dev-client')).toBeUndefined();
});

test('a client without a registrar never exposes itself on a dev page', async () => {
  g.window ??= g;
  const server = makeServer();
  const a = await makeClient(server, { clientId: 'no-devtools-opt-in' });
  expect(entryFor('no-devtools-opt-in')).toBeUndefined();
  await a.client.close();
});
