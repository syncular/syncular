/** Real native parity rung: actual tauri-plugin SyncularCore output flows
 * through the TypeScript Tauri bridge and renderer-independent reactive store.
 * Set SYNCULAR_TAURI_NATIVE_TEST=1 to build the non-published harness first;
 * the Tauri binding gate does so in CI. */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ReactiveClientStore,
  SECURITY_PREFLIGHT_REQUIRED_CODE,
} from '@syncular/client';
import { makeClient, makeServer } from '../../web-client/test/helpers';
import { decodeMessage, encodeMessage } from '../../core/src/index';
import { handleSyncRequest, handleSegmentDownload } from '@syncular/server';
import { createTauriSyncClient, type TauriApi } from '../src/index';

const ROOT = join(import.meta.dir, '..', '..', '..');
const DEFAULT_BIN = join(
  ROOT,
  'bindings',
  'tauri',
  'target',
  'debug',
  'syncular-tauri-bridge-harness',
);
const requested = process.env.SYNCULAR_TAURI_NATIVE_TEST === '1';

if (requested && !existsSync(DEFAULT_BIN)) {
  const built = Bun.spawnSync({
    cmd: ['cargo', 'build', '-p', 'syncular-tauri-bridge-harness'],
    cwd: join(ROOT, 'bindings', 'tauri'),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (built.exitCode !== 0)
    throw new Error('native bridge harness build failed');
}

const binary = process.env.SYNCULAR_TAURI_BRIDGE_BIN ?? DEFAULT_BIN;
const available = existsSync(binary);

interface HarnessResponse {
  readonly id: number;
  readonly reply: unknown;
  readonly events: readonly unknown[];
}

function nativeTauri(baseUrl?: string): {
  readonly api: TauriApi;
  readonly calls: Array<{
    readonly cmd: string;
    readonly args: Record<string, unknown>;
  }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
} {
  const process = Bun.spawn(baseUrl ? [binary, baseUrl] : [binary], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const listeners = new Set<(event: { payload: unknown }) => void>();
  const pending = new Map<
    number,
    { resolve(value: HarnessResponse): void; reject(error: Error): void }
  >();
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  let nextId = 1;

  void (async () => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        const message = JSON.parse(line) as HarnessResponse;
        pending.get(message.id)?.resolve(message);
        pending.delete(message.id);
      }
    }
    for (const waiter of pending.values()) {
      waiter.reject(new Error('native bridge harness exited'));
    }
    pending.clear();
  })();

  const request = (
    payload: Record<string, unknown>,
  ): Promise<HarnessResponse> => {
    const id = nextId++;
    const result = new Promise<HarnessResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    process.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    process.stdin.flush();
    return result;
  };

  const api: TauriApi = {
    async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      const actual = args ?? {};
      calls.push({ cmd, args: actual });
      const response = await request(
        cmd.endsWith('syncular_query_snapshot')
          ? {
              kind: 'snapshot',
              sql: actual.sql,
              params: actual.params,
              coverage: actual.coverage,
            }
          : cmd.endsWith('syncular_query')
            ? { kind: 'query', sql: actual.sql, params: actual.params }
            : { kind: 'command', command: actual.command },
      );
      for (const payload of response.events) {
        for (const listener of listeners) listener({ payload });
      }
      return response.reply as T;
    },
    async listen<T>(
      _event: string,
      handler: (event: { payload: T }) => void,
    ): Promise<() => void> {
      const erased = handler as (event: { payload: unknown }) => void;
      listeners.add(erased);
      return () => listeners.delete(erased);
    },
  };
  return {
    api,
    calls,
    async exec(sql: string) {
      const response = await request({ kind: 'exec', sql });
      const reply = response.reply as {
        readonly error?: { readonly code?: string };
      };
      if (reply.error !== undefined) {
        throw new Error(reply.error.code ?? 'harness exec failed');
      }
    },
    async close() {
      process.stdin.end();
      await process.exited;
    },
  };
}

const schema = {
  version: 1,
  tables: [
    {
      name: 'todos',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'list:{list_id}', column: 'list_id' }],
    },
  ],
} as const;

async function waitFor<T>(
  entry: { getSnapshot(): T; subscribe(listener: () => void): () => void },
  predicate: (value: T) => boolean,
): Promise<T> {
  const current = entry.getSnapshot();
  if (predicate(current)) return current;
  return new Promise((resolve) => {
    const release = entry.subscribe(() => {
      const next = entry.getSnapshot();
      if (!predicate(next)) return;
      release();
      resolve(next);
    });
  });
}

if (!available) {
  describe('native Tauri bridge', () => {
    test.skip('build with SYNCULAR_TAURI_NATIVE_TEST=1', () => {});
  });
} else {
  describe('native Tauri bridge', () => {
    test('native ACK-only edits survive reopen and pull their own commit next round', async () => {
      const source = makeServer(schema);
      source.allowed['actor-1'] = { list_id: ['one'] };
      let defer = 0;
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          const context = source.ctxFor('actor-1');
          if (path === '/sync') {
            const bytes = await handleSyncRequest(
              new Uint8Array(await request.arrayBuffer()),
              context,
            );
            if (defer-- > 0) {
              const message = decodeMessage(bytes);
              if (message.msgKind !== 'response')
                throw new Error('expected response');
              return new Response(
                encodeMessage({
                  ...message,
                  frames: message.frames.filter((frame) =>
                    [
                      'RESP_HEADER',
                      'LEASE',
                      'PUSH_RESULT',
                      'PUSH_RESULT_DETAILS',
                    ].includes(frame.type),
                  ),
                }).slice().buffer,
              );
            }
            return new Response(bytes.slice().buffer);
          }
          if (path.startsWith('/segments/'))
            return new Response(
              (
                await handleSegmentDownload(context, {
                  segmentId: decodeURIComponent(
                    path.slice('/segments/'.length),
                  ),
                  scopesHeader:
                    request.headers.get('X-Syncular-Scopes') ?? '{}',
                })
              ).bytes.slice().buffer,
            );
          return new Response('unknown route', { status: 404 });
        },
      });
      const host = nativeTauri(`http://127.0.0.1:${server.port}`);
      try {
        let client = await createTauriSyncClient({
          schema,
          clientId: 'native-own-ack',
          tauri: host.api,
        });
        await client.subscribe({
          id: 'todos',
          table: 'todos',
          scopes: { list_id: ['one'] },
        });
        await client.mutate([
          {
            op: 'upsert',
            table: 'todos',
            values: { id: 'own', list_id: 'one', title: '100/v1' },
          },
        ]);
        await client.syncUntilIdle();
        defer = 4;
        for (const title of ['200/v2', '300/v3']) {
          await client.patch('todos', 'own', { title });
          const result = (await client.sync()) as {
            ok: boolean;
            report: { applied: string[]; commitsApplied: number };
          };
          expect(result.ok).toBe(true);
          const report = result.report;
          expect(report.applied).toHaveLength(1);
          expect(report.commitsApplied).toBe(0);
          expect(
            await client.query('SELECT title FROM todos WHERE id=?', ['own']),
          ).toEqual([{ title }]);
          expect((await client.statusSnapshot()).syncNeeded).toBe(true);
        }
        expect(await client.pendingCommits()).toEqual([]);
        await client.sync();
        await client.close();
        client = await createTauriSyncClient({
          schema,
          clientId: 'native-own-ack',
          tauri: host.api,
        });
        expect(
          await client.query('SELECT title FROM todos WHERE id=?', ['own']),
        ).toEqual([{ title: '300/v3' }]);
        await client.sync();
        expect(
          await client.query('SELECT title FROM todos WHERE id=?', ['own']),
        ).toEqual([{ title: '300/v3' }]);
        const next = (await client.sync()) as {
          ok: boolean;
          report: { commitsApplied: number };
        };
        expect(next.ok).toBe(true);
        expect(next.report.commitsApplied).toBe(2);
        expect(
          await client.query(
            'SELECT title,_sync_version AS version FROM todos WHERE id=?',
            ['own'],
          ),
        ).toEqual([{ title: '300/v3', version: 3 }]);
        await client.close();
      } finally {
        await host.close();
        await server.stop(true);
        source.storage.db.close();
      }
    });

    test('native persisted scope registrations migrate 89→90 and survive compatible 91', async () => {
      const host = nativeTauri();
      const state = (id: string) =>
        host.api.invoke<{ result: { state: { cursor: number } | null } }>(
          'syncular_command',
          { command: { method: 'subscriptionState', params: { id } } },
        );
      const pendingIds = () =>
        host.api.invoke<{ result: { ids: string[] } }>('syncular_command', {
          command: { method: 'pendingCommitIds', params: {} },
        });
      const schemas = [89, 90, 91].map((version) => ({
        ...schema,
        version,
        tables: schema.tables.map((table) => ({
          ...table,
          scopes: [
            {
              pattern:
                version === 89
                  ? 'theatre:{theatre_calendar_id}'
                  : 'theatre:{calendar_theatre_id}',
              column: 'list_id',
            },
          ],
        })),
      }));
      try {
        let client = await createTauriSyncClient({
          schema: schemas[0]!,
          clientId: 'native-scope',
          tauri: host.api,
        });
        await client.subscribe({
          id: 'old',
          table: 'todos',
          scopes: { theatre_calendar_id: ['one'] },
        });
        await client.setWindow(
          { table: 'todos', variable: 'theatre_calendar_id' },
          ['one'],
        );
        const pending = await client.mutate([
          {
            table: 'todos',
            op: 'upsert',
            values: { id: 'pending', list_id: 'one', title: 'offline' },
          },
        ]);
        await client.close();
        client = await createTauriSyncClient({
          schema: schemas[1]!,
          clientId: 'native-scope',
          tauri: host.api,
        });
        expect((await state('old')).result.state).toBeNull();
        expect(
          await client.windowState({
            table: 'todos',
            variable: 'theatre_calendar_id',
          }),
        ).toEqual({ units: [], pending: [] });
        expect((await pendingIds()).result.ids).toEqual([pending]);
        await client.subscribe({
          id: 'current',
          table: 'todos',
          scopes: { calendar_theatre_id: ['one'] },
        });
        await host.exec(
          `UPDATE _syncular_subscriptions SET state_json=json_set(state_json,'$.cursor',123)`,
        );
        await client.close();
        client = await createTauriSyncClient({
          schema: schemas[1]!,
          clientId: 'native-scope',
          tauri: host.api,
        });
        expect((await state('current')).result.state?.cursor).toBe(123);
        await client.close();
        client = await createTauriSyncClient({
          schema: schemas[2]!,
          clientId: 'native-scope',
          tauri: host.api,
        });
        expect((await state('current')).result.state?.cursor).toBe(-1);
        expect((await pendingIds()).result.ids).toEqual([pending]);
        await client.close();
      } finally {
        await host.close();
      }
    });

    test('real Tauri transport retains a distinct-ID UNIQUE insert across reopen and resolution', async () => {
      const uniqueSchema = {
        ...schema,
        tables: schema.tables.map((table) => ({
          ...table,
          indexes: [
            {
              name: 'todos_unique_title',
              columns: ['list_id', 'title'],
              unique: true,
            },
          ],
        })),
      };
      const source = makeServer(uniqueSchema);
      source.allowed['actor-1'] = { list_id: ['one'] };
      let allowed = ['one'];
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const pathname = new URL(request.url).pathname;
          const context = {
            ...source.ctxFor('native-loser'),
            resolveScopes: () => ({ list_id: allowed }),
          };
          if (pathname === '/sync')
            return new Response(
              (
                await handleSyncRequest(
                  new Uint8Array(await request.arrayBuffer()),
                  context,
                )
              ).slice().buffer,
            );
          if (pathname.startsWith('/segments/'))
            return new Response(
              (
                await handleSegmentDownload(context, {
                  segmentId: decodeURIComponent(
                    pathname.slice('/segments/'.length),
                  ),
                  scopesHeader:
                    request.headers.get('X-Syncular-Scopes') ?? '{}',
                })
              ).bytes.slice().buffer,
            );
          return new Response('unknown route', { status: 404 });
        },
      });
      const host = nativeTauri(`http://127.0.0.1:${server.port}`);
      const winner = await makeClient(source, {
        clientId: 'native-winner',
        schema: uniqueSchema,
      });
      try {
        let client = await createTauriSyncClient({
          schema: uniqueSchema,
          clientId: 'native-loser',
          retainFailedCommits: true,
          tauri: host.api,
        });
        await client.subscribe({
          id: 'todos',
          table: 'todos',
          scopes: { list_id: ['one'] },
        });
        await client.syncUntilIdle();
        for (const resolution of [
          'server',
          'mine',
          'edit',
          'revoke',
        ] as const) {
          const title = `native-${resolution}`;
          const winnerId = `winner-${resolution}`;
          const loserId = `loser-${resolution}`;
          winner.client.mutate([
            {
              table: 'todos',
              op: 'upsert',
              values: { id: winnerId, list_id: 'one', title },
            },
          ]);
          const losing = await client.mutate([
            {
              table: 'todos',
              op: 'upsert',
              values: { id: loserId, list_id: 'one', title },
            },
          ]);
          await winner.client.syncUntilIdle();
          await client.syncUntilIdle();
          const expected = {
            retainedRows: [
              {
                rowId: loserId,
                localRow: { id: loserId },
                serverRow: null,
                uniqueConflicts: [
                  {
                    index: 'todos_unique_title',
                    columns: ['list_id', 'title'],
                    rowId: winnerId,
                    serverRow: { id: winnerId, title },
                    serverVersion: 1,
                  },
                ],
              },
            ],
          };
          expect(await client.commitOutcome(losing)).toMatchObject(expected);
          expect(
            await client.query('SELECT id FROM todos WHERE id = ?', [loserId]),
          ).toEqual([]);
          await client.close();
          client = await createTauriSyncClient({
            schema: uniqueSchema,
            clientId: 'native-loser',
            retainFailedCommits: true,
            tauri: host.api,
          });
          expect(await client.commitOutcome(losing)).toMatchObject(expected);
          if (resolution === 'revoke') {
            allowed = [];
            await client.syncUntilIdle();
            expect(await client.query('SELECT id FROM todos')).toEqual([]);
            expect(
              (await client.commitOutcome(losing))?.retainedRows,
            ).toBeUndefined();
            expect(
              (await client.commitOutcome(losing))?.operations,
            ).toBeUndefined();
          } else {
            const replacement =
              resolution === 'mine'
                ? await client.patch(
                    'todos',
                    winnerId,
                    { title: `${title}-mine` },
                    { baseVersion: 1 },
                  )
                : resolution === 'edit'
                  ? await client.mutate([
                      {
                        table: 'todos',
                        op: 'upsert',
                        values: {
                          id: loserId,
                          list_id: 'one',
                          title: `${title}-edited`,
                        },
                      },
                    ])
                  : undefined;
            await client.resolveCommitOutcome({
              clientCommitId: losing,
              resolution: replacement ? 'superseded' : 'resolved_keep_server',
              ...(replacement
                ? { replacementClientCommitId: replacement }
                : {}),
            });
            await client.syncUntilIdle();
            expect(
              (await client.commitOutcome(losing))?.retainedRows,
            ).toBeUndefined();
            expect(
              await client.query('SELECT id FROM todos WHERE id = ?', [
                loserId,
              ]),
            ).toEqual(resolution === 'edit' ? [{ id: loserId }] : []);
          }
        }
        expect(await client.query('PRAGMA integrity_check')).toEqual([
          { integrity_check: 'ok' },
        ]);
        await client.close();
      } finally {
        await winner.client.close();
        winner.db.close();
        await host.close();
        server.stop(true);
        source.storage.db.close();
      }
    }, 30000);
    test('real native command applies a mixed sparse aggregate in one revision', async () => {
      const host = nativeTauri();
      try {
        const client = await createTauriSyncClient({
          schema,
          retainFailedCommits: true,
          tauri: host.api,
        });
        await client.mutate(
          ['t1', 't2'].map((id) => ({
            op: 'upsert' as const,
            table: 'todos',
            values: { id, list_id: 'one', title: 'original' },
          })),
        );
        const batches: unknown[] = [];
        client.onChange((batch) => batches.push(batch));
        await client.mutate([
          { op: 'patch', table: 'todos', values: { id: 't1', title: 'first' } },
          {
            op: 'patch',
            table: 'todos',
            values: { id: 't2', title: 'second' },
          },
          {
            op: 'upsert',
            table: 'todos',
            values: { id: 'event', list_id: 'one', title: 'audit' },
            baseVersion: 0,
          },
        ]);
        expect(
          await client.query('SELECT id, title FROM todos ORDER BY id'),
        ).toEqual([
          { id: 'event', title: 'audit' },
          { id: 't1', title: 'first' },
          { id: 't2', title: 'second' },
        ]);
        expect(batches).toHaveLength(1);
        expect((await client.statusSnapshot()).outbox).toBe(2);
        await expect(
          client.mutate([
            {
              op: 'upsert',
              table: 'todos',
              values: { id: 'unwritten', list_id: 'one', title: 'audit' },
            },
            {
              op: 'patch',
              table: 'todos',
              values: { id: 'missing', title: 'mine' },
            },
          ]),
        ).rejects.toMatchObject({ code: 'sync.row_missing' });
        expect(
          await client.query(
            "SELECT id FROM todos WHERE id IN ('missing', 'unwritten')",
          ),
        ).toEqual([]);
        expect((await client.statusSnapshot()).outbox).toBe(2);
        expect(batches).toHaveLength(1);
        await client.close();
      } finally {
        await host.close();
      }
    });
    test('real Rust events drive the shared query store atomically', async () => {
      const host = nativeTauri();
      try {
        const client = await createTauriSyncClient({ schema, tauri: host.api });
        const batches: unknown[] = [];
        client.onChange((batch) => batches.push(batch));
        // A push-only diagnostics consumer (never pulling a snapshot): the
        // bridge's enableDiagnostics registration must start native pushes.
        const diagnosticsKinds: string[] = [];
        client.onDiagnostics((snapshot) =>
          diagnosticsKinds.push(snapshot.host.kind),
        );
        const store = new ReactiveClientStore(client);
        store.start();
        const query = store.query<{ id: string; title: string }>({
          id: 'native-todos',
          sql: 'SELECT id, title FROM todos WHERE list_id = ? ORDER BY id',
          params: ['one'],
          dependencies: [{ table: 'todos', scopeKeys: ['list:one'] }],
          rowKey: (row) => [row.id],
        });
        const release = query.subscribe(() => {});
        await waitFor(query, (snapshot) => snapshot.phase === 'ready');

        await client.mutate([
          {
            op: 'upsert',
            table: 'todos',
            values: { id: 't1', listId: 'one', title: 'native' },
          },
        ]);
        const snapshot = await waitFor(
          query,
          (value) => value.rows.length === 1,
        );
        expect(snapshot.revision).toBe(1n);
        expect(snapshot.rows).toEqual([{ id: 't1', title: 'native' }]);
        expect(diagnosticsKinds).toContain('tauri');
        expect(batches).toHaveLength(1);
        expect(
          (batches[0] as { tables: readonly { table: string }[] }).tables[0]
            ?.table,
        ).toBe('todos');

        const reads = host.calls.filter((call) =>
          call.cmd.endsWith('syncular_query_snapshot'),
        );
        expect(reads).toHaveLength(2);
        release();
        store.dispose();
        await client.close();
      } finally {
        await host.close();
      }
    });

    test('real native purge rejects a whole doomed commit and preserves the safe outbox', async () => {
      const host = nativeTauri();
      try {
        const client = await createTauriSyncClient({ schema, tauri: host.api });
        const doomed = await client.mutate([
          {
            op: 'upsert',
            table: 'todos',
            values: { id: 'target', listId: 'purged', title: 'purge me' },
          },
          {
            op: 'upsert',
            table: 'todos',
            values: { id: 'sibling', listId: 'held', title: 'rollback me' },
          },
        ]);
        const kept = await client.mutate([
          {
            op: 'upsert',
            table: 'todos',
            values: { id: 'kept', listId: 'held', title: 'keep me' },
          },
        ]);

        expect(
          await client.purgeLocalData({
            purgeId: 'native-purge-001',
            targets: [
              {
                table: 'todos',
                selectors: { list_id: ['purged'] },
              },
            ],
          }),
        ).toEqual({
          alreadyApplied: false,
          purgedRows: 0,
          droppedCommits: 1,
        });
        expect(await client.query('SELECT id FROM todos ORDER BY id')).toEqual([
          { id: 'kept' },
        ]);
        expect(await client.pendingCommits()).toEqual([kept]);
        expect(await client.commitOutcome(doomed)).toMatchObject({
          status: 'rejected',
          results: [
            {
              status: 'error',
              rejection: { code: 'client.local_data_purged' },
            },
            {
              status: 'error',
              rejection: { code: 'client.local_data_purged' },
            },
          ],
        });
        await client.close();
      } finally {
        await host.close();
      }
    });

    test('real native rebootstrap retains optimistic work and rewinds subscriptions', async () => {
      const host = nativeTauri();
      try {
        const client = await createTauriSyncClient({ schema, tauri: host.api });
        await client.subscribe({
          id: 'native-repair-todos',
          table: 'todos',
          scopes: { listId: ['held'] },
        });
        const pending = await client.mutate([
          {
            op: 'upsert',
            table: 'todos',
            values: { id: 'offline', listId: 'held', title: 'keep me' },
          },
        ]);
        expect(
          await client.rebootstrapLocalData({
            rebootstrapId: 'native-repair-001',
          }),
        ).toEqual({
          alreadyApplied: false,
          retainedCommits: 1,
          resetSubscriptions: 1,
        });
        expect(await client.query('SELECT id FROM todos')).toEqual([
          { id: 'offline' },
        ]);
        expect(await client.pendingCommits()).toEqual([pending]);
        await client.close();
        const reopened = await createTauriSyncClient({
          schema,
          tauri: host.api,
        });
        expect(
          await reopened.rebootstrapLocalData({
            rebootstrapId: 'native-repair-001',
          }),
        ).toEqual({
          alreadyApplied: true,
          retainedCommits: 1,
          resetSubscriptions: 1,
        });
        await reopened.close();
      } finally {
        await host.close();
      }
    });

    test('real native rebootstrap fails closed on a malformed durable receipt', async () => {
      const host = nativeTauri();
      try {
        const client = await createTauriSyncClient({ schema, tauri: host.api });
        await host.exec(
          `INSERT INTO _syncular_meta(key, value) VALUES ('localRebootstrap:native-corrupt-receipt', '{"version":2}')`,
        );
        const attempt = client.rebootstrapLocalData({
          rebootstrapId: 'native-corrupt-receipt',
        });
        await expect(attempt).rejects.toMatchObject({
          code: 'sync.local_corrupt',
          message:
            'sync.local_corrupt: persisted local rebootstrap receipt is invalid',
        });
        await expect(client.query('SELECT id FROM todos')).resolves.toEqual([]);
        await client.close();
      } finally {
        await host.close();
      }
    });

    test('real Rust preflight purges before protected reads and activates in place', async () => {
      const host = nativeTauri();
      try {
        const client = await createTauriSyncClient({
          schema,
          securityPreflight: true,
          tauri: host.api,
        });
        expect(await client.securityLifecycle()).toBe('preflight');
        await expect(
          client.query('SELECT id FROM todos'),
        ).rejects.toMatchObject({ code: SECURITY_PREFLIGHT_REQUIRED_CODE });
        expect(
          await client.purgeLocalData({
            purgeId: 'native-preflight-directive',
            targets: [{ table: 'todos', selectors: { list_id: ['revoked'] } }],
          }),
        ).toEqual({
          alreadyApplied: false,
          purgedRows: 0,
          droppedCommits: 0,
        });
        await expect(
          client.rebootstrapLocalData({
            rebootstrapId: 'native-blocked-repair',
          }),
        ).rejects.toMatchObject({ code: SECURITY_PREFLIGHT_REQUIRED_CODE });

        // The escape the gate exists to prevent: re-issuing create WITHOUT
        // the securityPreflight flag must be refused by the real router.
        await expect(
          createTauriSyncClient({ schema, tauri: host.api }),
        ).rejects.toMatchObject({ code: SECURITY_PREFLIGHT_REQUIRED_CODE });
        // A preflighted replacement is permitted and stays gated.
        const replacement = await createTauriSyncClient({
          schema,
          securityPreflight: true,
          tauri: host.api,
        });
        await expect(
          replacement.query('SELECT id FROM todos'),
        ).rejects.toMatchObject({ code: SECURITY_PREFLIGHT_REQUIRED_CODE });

        // Activation carries the fresh header set atomically and releases
        // the gate; a plain create behaves as before afterwards.
        await replacement.activateSecurity({
          headers: { authorization: 'Bearer post-preflight' },
        });
        expect(await replacement.securityLifecycle()).toBe('active');
        expect(await replacement.query('SELECT id FROM todos')).toEqual([]);
        await replacement.close();
        const reopened = await createTauriSyncClient({
          schema,
          tauri: host.api,
        });
        expect(await reopened.securityLifecycle()).toBe('active');
        expect(await reopened.query('SELECT id FROM todos')).toEqual([]);
        await reopened.close();
      } finally {
        await host.close();
      }
    });

    test('warm native querySnapshot round trips meet the local-view budget', async () => {
      const host = nativeTauri();
      try {
        const client = await createTauriSyncClient({ schema, tauri: host.api });
        const samples: number[] = [];
        for (let i = 0; i < 60; i++) {
          const start = performance.now();
          await client.querySnapshot({ sql: 'SELECT id FROM todos' });
          if (i >= 10) samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity;
        expect(p95).toBeLessThanOrEqual(
          process.env.SYNCULAR_PERF_GATE === '1' ? 5 : 25,
        );
        await client.close();
      } finally {
        await host.close();
      }
    });
  });
}
