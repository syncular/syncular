/** Real native parity rung: actual tauri-plugin SyncularCore output flows
 * through the TypeScript Tauri bridge and renderer-independent reactive store.
 * Set SYNCULAR_TAURI_NATIVE_TEST=1 to build the non-published harness first;
 * the Tauri binding gate does so in CI. */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ReactiveClientStore } from '@syncular/client';
import { normalizeClient } from '@syncular/react';
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

function nativeTauri(): {
  readonly api: TauriApi;
  readonly calls: Array<{
    readonly cmd: string;
    readonly args: Record<string, unknown>;
  }>;
  close(): Promise<void>;
} {
  const process = Bun.spawn([binary], {
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
        cmd.endsWith('syncular_query')
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
    test('real Rust events drive the shared query store atomically', async () => {
      const host = nativeTauri();
      try {
        const client = await createTauriSyncClient({ schema, tauri: host.api });
        const batches: unknown[] = [];
        client.onChange((batch) => batches.push(batch));
        const store = new ReactiveClientStore(normalizeClient(client));
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
        expect(batches).toHaveLength(1);
        expect(
          (batches[0] as { tables: readonly { table: string }[] }).tables[0]
            ?.table,
        ).toBe('todos');

        const reads = host.calls.filter(
          (call) =>
            (call.args.command as { method?: string } | undefined)?.method ===
            'querySnapshot',
        );
        expect(reads).toHaveLength(2);
        release();
        store.dispose();
        await client.close();
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
