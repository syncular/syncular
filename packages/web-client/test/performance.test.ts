import { describe, expect, test } from 'bun:test';
import { ReactiveClientStore, SyncClient } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { CLIENT_SCHEMA } from './helpers';

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}

describe('local querySnapshot performance lanes (RFC 0003 §10.3)', () => {
  test('warm p95 and 100/1k/10k scaling stay local-fast', async () => {
    const db = new BunClientDatabase();
    const client = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      clientId: 'performance',
      transport: async () => {
        throw new Error('performance lane is local-only');
      },
    });
    await client.start();
    db.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        db.exec(
          `INSERT INTO tasks
             (id, project_id, title, done, priority, meta, _sync_version)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `t${index}`,
            `p${Math.floor(index / 100)}`,
            `task ${index}`,
            index % 2 === 0,
            index,
            null,
            1,
          ],
        );
      }
    });

    const read = (limit: number) =>
      client.querySnapshot({
        sql: 'SELECT id, title, done FROM tasks ORDER BY id LIMIT ?',
        params: [limit],
      });
    read(100);
    const warm: number[] = [];
    for (let run = 0; run < 80; run += 1) {
      const started = performance.now();
      read(100);
      warm.push(performance.now() - started);
    }
    const p95 = percentile(warm, 0.95);
    const scaling = [100, 1_000, 10_000].map((size) => {
      const samples: number[] = [];
      for (let run = 0; run < 8; run += 1) {
        const started = performance.now();
        expect(read(size).rows).toHaveLength(size);
        samples.push(performance.now() - started);
      }
      return percentile(samples, 0.5);
    });

    if (process.env.SYNCULAR_PERF_GATE === '1') {
      expect(p95).toBeLessThanOrEqual(2);
    } else {
      // Developer/CI machines still catch architectural regressions while the
      // absolute 2 ms gate remains opt-in to the pinned performance runner.
      expect(p95).toBeLessThan(10);
    }
    expect(scaling[2] ?? Number.POSITIVE_INFINITY).toBeLessThan(100);
    expect((scaling[2] ?? 1) / Math.max(scaling[1] ?? 1, 0.1)).toBeLessThan(25);

    await client.close();
    db.close();
  });

  test('warm retained-window switch publishes within the local-view budget', async () => {
    const db = new BunClientDatabase();
    const client = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      clientId: 'retained-switch-performance',
      transport: async () => {
        throw new Error('performance lane is local-only');
      },
    });
    await client.start();
    const units = Array.from({ length: 80 }, (_, index) => `p${index}`);
    db.transaction(() => {
      for (const [index, unit] of units.entries()) {
        db.exec(
          `INSERT INTO tasks
             (id, project_id, title, done, priority, meta, _sync_version)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [`t${index}`, unit, `task ${index}`, false, index, null, 1],
        );
      }
    });

    const store = new ReactiveClientStore(client);
    store.start();
    const base = { table: 'tasks', variable: 'project_id' } as const;
    const retention = store.retainWindow(base, units);
    await retention.ready;
    // This lane is deliberately warm: the bootstrap/network operation is a
    // separate budget. Mark the retained local fixtures complete before
    // timing first observation of each route/query entry.
    db.exec(
      `UPDATE _syncular_subscriptions
          SET cursor = 0, bootstrap_state = NULL, status = 'active'`,
    );

    const samples: number[] = [];
    for (const [index, unit] of units.entries()) {
      const entry = store.query<{ id: string; title: string }>({
        id: `retained-project-${unit}`,
        sql: 'SELECT id, title FROM tasks WHERE project_id = ?',
        params: [unit],
        dependencies: [{ table: 'tasks', scopeKeys: [`project:${unit}`] }],
        coverage: [{ base, units: [unit] }],
        rowKey: (row) => [row.id],
      });
      const started = performance.now();
      await new Promise<void>((resolve, reject) => {
        const release = entry.subscribe(() => {
          const snapshot = entry.getSnapshot();
          if (snapshot.phase === 'error') {
            release();
            reject(snapshot.error);
          } else if (snapshot.phase === 'ready') {
            release();
            resolve();
          }
        });
      });
      if (index >= 10) samples.push(performance.now() - started);
    }

    const p95 = percentile(samples, 0.95);
    expect(p95).toBeLessThanOrEqual(
      process.env.SYNCULAR_PERF_GATE === '1' ? 8 : 25,
    );

    retention.release();
    store.dispose();
    await client.close();
    db.close();
  });
});
