import { describe, expect, test } from 'bun:test';
import type { SyncClientLike } from '../src/client';
import type { SyncClientResource } from '../src/resource';
import {
  createViteSyncClientResource,
  retainViteSyncClientResource,
} from '../src/vite-hmr';
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
  test('boots synchronously without opening a replacement before async disposal', async () => {
    const hotData: Record<string, unknown> = {};
    const timeline: string[] = [];
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const current = createViteSyncClientResource(hotData, 1, () => {
      timeline.push('open:1');
      const client = new FakeClient();
      (client as FakeClient & { close: () => Promise<void> }).close =
        async () => {
          timeline.push('close:start:1');
          await closeGate;
          timeline.push('close:end:1');
        };
      return client;
    });
    expect(current.resource.getSnapshot().phase).toBe('pending');
    expect((await settled(current.resource)).phase).toBe('ready');

    const replacement = createViteSyncClientResource(hotData, 2, () => {
      timeline.push('open:2');
      return new FakeClient();
    });
    expect(replacement.ownerChanged).toBe(true);
    expect(replacement.resource.getSnapshot().phase).toBe('pending');
    await Promise.resolve();
    await Promise.resolve();
    expect(timeline).toEqual(['open:1', 'close:start:1']);

    releaseClose?.();
    await replacement.handoff;
    expect((await settled(replacement.resource)).phase).toBe('ready');
    expect(timeline).toEqual([
      'open:1',
      'close:start:1',
      'close:end:1',
      'open:2',
    ]);
    await replacement.resource.dispose();
  });

  test('surfaces synchronous-bootstrap disposal failure without opening a replacement', async () => {
    const hotData: Record<string, unknown> = {};
    let replacementCalls = 0;
    const current = createViteSyncClientResource(hotData, 1, () => {
      const client = new FakeClient();
      (client as FakeClient & { close: () => void }).close = () => {
        throw new Error('worker close failed');
      };
      return client;
    });
    expect((await settled(current.resource)).phase).toBe('ready');

    const replacement = createViteSyncClientResource(hotData, 2, () => {
      replacementCalls += 1;
      return new FakeClient();
    });
    await expect(replacement.handoff).rejects.toThrow('worker close failed');
    const snapshot = await settled(replacement.resource);
    expect(snapshot.phase).toBe('error');
    if (snapshot.phase !== 'error') throw new Error('expected startup error');
    expect(snapshot.error.message).toBe('worker close failed');
    expect(replacementCalls).toBe(0);
  });

  test('rejects an invalid runtime identity', async () => {
    await expect(
      retainViteSyncClientResource({}, 1, () => new FakeClient(), 42 as never),
    ).rejects.toThrow('runtimeVersion must be a bounded non-empty string');
  });

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
    expect(ordinary.runtimeChanged).toBe(false);
    expect(ordinary.ownerChanged).toBe(false);
    expect(factoryCalls).toBe(1);

    const bumped = await retainViteSyncClientResource(hotData, 2, factory(2));
    expect(bumped.schemaChanged).toBe(true);
    expect(bumped.runtimeChanged).toBe(false);
    expect(bumped.ownerChanged).toBe(true);
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

  test('replaces a same-schema worker when the Syncular package runtime changes', async () => {
    const hotData: Record<string, unknown> = {};
    const timeline: string[] = [];
    let owners = 0;

    const factory =
      (runtime: string): (() => SyncClientLike) =>
      () => {
        owners += 1;
        timeline.push(`open:${runtime}`);
        const client = new FakeClient();
        (client as FakeClient & { close: () => void }).close = () => {
          owners -= 1;
          timeline.push(`close:${runtime}`);
        };
        return client;
      };

    const oldRuntime = await retainViteSyncClientResource(
      hotData,
      1,
      factory('0.15.29'),
      '0.15.29',
    );
    expect((await settled(oldRuntime.resource)).phase).toBe('ready');

    const upgraded = await retainViteSyncClientResource(
      hotData,
      1,
      factory('0.15.30'),
      '0.15.30',
    );
    expect(upgraded.schemaChanged).toBe(true);
    expect(upgraded.runtimeChanged).toBe(true);
    expect(upgraded.ownerChanged).toBe(true);
    expect((await settled(upgraded.resource)).phase).toBe('ready');
    expect(timeline).toEqual(['open:0.15.29', 'close:0.15.29', 'open:0.15.30']);
    expect(owners).toBe(1);

    await upgraded.resource.dispose();
    expect(owners).toBe(0);
  });
});
