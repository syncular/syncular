import { describe, expect, it } from 'bun:test';
import type { Kysely } from 'kysely';
import type { SyncularClientError } from './errors';
import {
  type SyncularLocalVisibilityClient,
  type SyncularLocalVisibilityEvidence,
  waitForSyncularLocalVisibility,
} from './local-visibility';
import type {
  SyncularClientEventMap,
  SyncularClientEventSink,
  SyncularClientEventType,
} from './types';

describe('waitForSyncularLocalVisibility', () => {
  it('resolves immediately when the local query is already visible', async () => {
    const client = new FakeLocalVisibilityClient<TestDb>();

    await expect(
      waitForSyncularLocalVisibility(
        client,
        () => [{ id: 'task-1', title: 'Ready' }],
        { tables: ['tasks'] }
      )
    ).resolves.toEqual([{ id: 'task-1', title: 'Ready' }]);

    expect(client.listenerCount('rowsChanged')).toBe(0);
  });

  it('waits until a matching rowsChanged event makes the query visible', async () => {
    const client = new FakeLocalVisibilityClient<TestDb>();
    const evidence: SyncularLocalVisibilityEvidence[] = [];
    let visibleRows: Array<{ id: string; title: string }> = [];

    const result = waitForSyncularLocalVisibility(client, () => visibleRows, {
      tables: ['tasks'],
      timeoutMs: false,
      onEvidence: (event) => evidence.push(event),
    });

    visibleRows = [{ id: 'task-1', title: 'Synced' }];
    client.emitRowsChanged(['tasks']);

    await expect(result).resolves.toEqual([{ id: 'task-1', title: 'Synced' }]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      state: 'visible',
      message: 'Syncular local visibility was observed.',
      details: {
        trigger: 'rowsChanged',
        tables: ['tasks'],
        changedTables: ['tasks'],
        source: 'remotePull',
      },
    });
    expect(typeof evidence[0]?.at).toBe('number');
    expect(client.listenerCount('rowsChanged')).toBe(0);
  });

  it('ignores rowsChanged events for unrelated tables', async () => {
    const client = new FakeLocalVisibilityClient<TestDb>();
    let visible = false;
    let evaluations = 0;

    const result = waitForSyncularLocalVisibility(
      client,
      () => {
        evaluations += 1;
        return visible;
      },
      { tables: ['tasks'], timeoutMs: false }
    );

    await Promise.resolve();
    evaluations = 0;
    visible = true;
    client.emitRowsChanged(['projects']);
    await Promise.resolve();

    expect(evaluations).toBe(0);

    client.emitRowsChanged(['tasks']);
    await expect(result).resolves.toBe(true);
  });

  it('supports Kysely executable query objects', async () => {
    const client = new FakeLocalVisibilityClient<TestDb>();

    await expect(
      waitForSyncularLocalVisibility(client, () => ({
        execute: async () => [{ id: 'task-1', title: 'Executable' }],
      }))
    ).resolves.toEqual([{ id: 'task-1', title: 'Executable' }]);
  });

  it('rejects with a typed timeout when visibility does not arrive', async () => {
    const client = new FakeLocalVisibilityClient<TestDb>();
    const evidence: SyncularLocalVisibilityEvidence[] = [];

    await expect(
      waitForSyncularLocalVisibility(client, () => [], {
        tables: ['tasks'],
        timeoutMs: 1,
        onEvidence: (event) => evidence.push(event),
      })
    ).rejects.toMatchObject({
      code: 'sync.local_visibility_timeout',
      details: { timeoutMs: 1, tables: ['tasks'] },
    } satisfies Partial<SyncularClientError>);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      state: 'timed-out',
      details: {
        trigger: 'timeout',
        tables: ['tasks'],
        timeoutMs: 1,
      },
    });
  });

  it('reports failed local query evidence', async () => {
    const client = new FakeLocalVisibilityClient<TestDb>();
    const evidence: SyncularLocalVisibilityEvidence[] = [];
    const error = new Error('broken local query');

    await expect(
      waitForSyncularLocalVisibility(
        client,
        () => {
          throw error;
        },
        {
          timeoutMs: false,
          onEvidence: (event) => evidence.push(event),
        }
      )
    ).rejects.toBe(error);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      state: 'failed',
      message: 'Syncular local visibility query failed.',
      details: {
        trigger: 'queryError',
        attemptedTrigger: 'initial',
        errorName: 'Error',
      },
    });
  });

  it('unsubscribes when aborted', async () => {
    const client = new FakeLocalVisibilityClient<TestDb>();
    const abortController = new AbortController();
    const result = waitForSyncularLocalVisibility(client, () => [], {
      signal: abortController.signal,
      timeoutMs: false,
    });

    expect(client.listenerCount('rowsChanged')).toBe(1);
    abortController.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.listenerCount('rowsChanged')).toBe(0);
  });
});

class FakeLocalVisibilityClient<DB>
  implements SyncularLocalVisibilityClient<DB>
{
  readonly db = {} as Kysely<DB>;
  readonly #listeners = new Map<
    SyncularClientEventType,
    Set<SyncularClientEventSink<SyncularClientEventType>>
  >();

  on<T extends SyncularClientEventType>(
    event: T,
    listener: SyncularClientEventSink<T>
  ): () => void {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener as SyncularClientEventSink<SyncularClientEventType>);
    return () => {
      listeners?.delete(
        listener as SyncularClientEventSink<SyncularClientEventType>
      );
    };
  }

  emitRowsChanged(changedTables: string[]): void {
    this.emit('rowsChanged', {
      source: 'remotePull',
      changedTables,
      changedRows: [],
    });
  }

  listenerCount(event: SyncularClientEventType): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  private emit<T extends SyncularClientEventType>(
    event: T,
    payload: SyncularClientEventMap[T]
  ): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as SyncularClientEventSink<T>)(payload);
    }
  }
}

interface TestDb {
  tasks: {
    id: string;
    title: string;
  };
}
