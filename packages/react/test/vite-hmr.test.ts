import { describe, expect, test } from 'bun:test';
import type { SyncClientLike } from '../src/client';
import type { SyncClientResource } from '../src/resource';
import { retainViteSyncClientResource } from '../src/vite-hmr';
import { FakeClient } from './fake-client';

async function settled(resource: SyncClientResource) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snapshot = resource.getSnapshot();
    if (snapshot.phase !== 'pending') return snapshot;
    await Promise.resolve();
  }
  throw new Error('resource did not settle');
}

describe('Vite schema-aware HMR fixture', () => {
  test('reuses ordinary HMR and closes the old owner before a schema bump', async () => {
    const hotData: Record<string, unknown> = {};
    const timeline: string[] = [];
    let owners = 0;
    let peakOwners = 0;
    let factoryCalls = 0;

    const factory =
      (version: number): (() => SyncClientLike) =>
      () => {
        factoryCalls += 1;
        owners += 1;
        peakOwners = Math.max(peakOwners, owners);
        timeline.push(`open:${version}`);
        const client = new FakeClient();
        client.setRows(`schema_v${version}`, [
          version === 1 ? { id: 'row' } : { id: 'row', new_column: 'ready' },
        ]);
        (client as FakeClient & { close: () => void }).close = () => {
          timeline.push(`close:${version}`);
          owners -= 1;
        };
        return client;
      };

    const first = await retainViteSyncClientResource(hotData, 1, factory(1));
    expect((await settled(first.resource)).phase).toBe('ready');

    const ordinary = await retainViteSyncClientResource(hotData, 1, factory(1));
    expect(ordinary.resource).toBe(first.resource);
    expect(ordinary.schemaChanged).toBe(false);
    expect(factoryCalls).toBe(1);

    const bumped = await retainViteSyncClientResource(hotData, 2, factory(2));
    expect(bumped.schemaChanged).toBe(true);
    const snapshot = await settled(bumped.resource);
    expect(snapshot.phase).toBe('ready');
    if (snapshot.phase !== 'ready') throw new Error('expected ready resource');
    expect(
      await snapshot.client.query(
        'SELECT new_column FROM schema_v2 WHERE id = ?',
        ['row'],
      ),
    ).toEqual([{ id: 'row', new_column: 'ready' }]);

    expect(timeline).toEqual(['open:1', 'close:1', 'open:2']);
    expect(peakOwners).toBe(1);
    expect(owners).toBe(1);
    await bumped.resource.dispose();
    expect(owners).toBe(0);
  });

  test('surfaces disposal failure without constructing a second owner', async () => {
    const hotData: Record<string, unknown> = {};
    let replacementCalls = 0;
    const current = await retainViteSyncClientResource(hotData, 1, () => {
      const client = new FakeClient();
      (client as FakeClient & { close: () => void }).close = () => {
        throw new Error('worker close failed');
      };
      return client;
    });
    expect((await settled(current.resource)).phase).toBe('ready');

    const bumped = await retainViteSyncClientResource(hotData, 2, () => {
      replacementCalls += 1;
      return new FakeClient();
    });
    expect(bumped.disposalError?.message).toBe('worker close failed');
    expect((await settled(bumped.resource)).phase).toBe('error');
    expect(replacementCalls).toBe(0);
  });
});
