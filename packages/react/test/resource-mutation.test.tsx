import { afterEach, describe, expect, test } from 'bun:test';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import {
  createSyncClientResource,
  SyncProvider,
  type SyncTableDescriptor,
  useMutation,
  useRawSql,
} from '../src/index';
import { FakeClient } from './fake-client';
import { installHappyDom } from './setup';

installHappyDom();

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function wrapper(client: FakeClient) {
  return ({ children }: { children: ReactNode }) => (
    <SyncProvider client={client}>{children}</SyncProvider>
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('client resources', () => {
  test('StrictMode initializes once and explicit disposal closes exactly once', async () => {
    const ready = deferred<FakeClient>();
    const client = new FakeClient();
    let factoryCalls = 0;
    let closeCalls = 0;
    (client as FakeClient & { close: () => void }).close = () => {
      closeCalls += 1;
    };
    const resource = createSyncClientResource(() => {
      factoryCalls += 1;
      return ready.promise;
    });

    function Child() {
      const query = useRawSql('SELECT * FROM tasks');
      return <span>rows={query.rows.length}</span>;
    }
    const view = render(
      <StrictMode>
        <SyncProvider client={resource} fallback={<span>opening</span>}>
          <Child />
        </SyncProvider>
      </StrictMode>,
    );
    expect(view.getByText('opening')).toBeDefined();
    await act(async () => Promise.resolve());
    expect(factoryCalls).toBe(1);

    await act(async () => ready.resolve(client));
    await waitFor(() => expect(view.getByText('rows=0')).toBeDefined());
    view.unmount();
    expect(closeCalls).toBe(0);
    await resource.dispose();
    await resource.dispose();
    expect(closeCalls).toBe(1);
  });

  test('disposing an in-flight resource closes a late client without publishing ready', async () => {
    const ready = deferred<FakeClient>();
    const client = new FakeClient();
    let closeCalls = 0;
    (client as FakeClient & { close: () => void }).close = () => {
      closeCalls += 1;
    };
    const resource = createSyncClientResource(() => ready.promise);
    const disposing = resource.dispose();
    ready.resolve(client);
    await disposing;
    expect(resource.getSnapshot()).toEqual({ phase: 'pending' });
    expect(closeCalls).toBe(1);
  });

  test('a failed resource can retry without being replaced', async () => {
    const client = new FakeClient();
    const snapshots: string[] = [];
    let factoryCalls = 0;
    const resource = createSyncClientResource(() => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error('storage is busy');
      return client;
    });
    resource.subscribe(() => snapshots.push(resource.getSnapshot().phase));

    await waitFor(() => expect(resource.getSnapshot().phase).toBe('error'));
    const firstRetry = resource.retry();
    const duplicateRetry = resource.retry();
    expect(firstRetry).toBe(duplicateRetry);
    await firstRetry;

    expect(factoryCalls).toBe(2);
    expect(resource.getSnapshot()).toEqual({ phase: 'ready', client });
    expect(snapshots).toEqual(['error', 'pending', 'ready']);
    await resource.dispose();
  });

  test('SyncProvider gives its error surface a retry action', async () => {
    const client = new FakeClient();
    let factoryCalls = 0;
    const resource = createSyncClientResource(() => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error('opening failed');
      return client;
    });

    function Child() {
      const query = useRawSql('SELECT * FROM tasks');
      return <span>rows={query.rows.length}</span>;
    }
    const view = render(
      <SyncProvider
        client={resource}
        fallback={<span>opening</span>}
        renderError={(error, retry) => (
          <button type="button" onClick={() => void retry()}>
            Retry {error.message}
          </button>
        )}
      >
        <Child />
      </SyncProvider>,
    );

    const retryButton = await view.findByText('Retry opening failed');
    act(() => retryButton.click());
    await waitFor(() => expect(view.getByText('rows=0')).toBeDefined());
    expect(factoryCalls).toBe(2);
    await resource.dispose();
  });
});

describe('mutation ergonomics', () => {
  test('overlapping mutations use a pending count and preserve rejected promises', async () => {
    const client = new FakeClient();
    const first = deferred<string>();
    const second = deferred<string>();
    const pending = [first, second];
    client.mutate = () => pending.shift()?.promise ?? Promise.resolve('extra');
    const successes: string[] = [];
    const errors: Error[] = [];
    const { result } = renderHook(
      () =>
        useMutation({
          onSuccess: (id) => successes.push(id),
          onError: (error) => errors.push(error),
        }),
      { wrapper: wrapper(client) },
    );

    let firstResult!: Promise<string>;
    let secondResult!: Promise<string>;
    act(() => {
      firstResult = result.current.mutate([]);
      secondResult = result.current.mutate([]);
    });
    const firstCaught = firstResult.then(
      () => undefined,
      (error: unknown) => error,
    );
    await act(async () => Promise.resolve());
    expect(result.current.pendingCount).toBe(2);

    second.resolve('second');
    await act(async () => {
      expect(await secondResult).toBe('second');
    });
    expect(result.current.pendingCount).toBe(1);
    expect(result.current.isPending).toBe(true);

    const failure = new Error('write failed');
    first.reject(failure);
    await act(async () => {
      expect(await firstCaught).toBe(failure);
    });
    expect(result.current.pendingCount).toBe(0);
    expect(result.current.error).toBe(failure);
    expect(successes).toEqual(['second']);
    expect(errors).toEqual([failure]);
    act(() => result.current.resetError());
    await waitFor(() => expect(result.current.error).toBeUndefined());
  });

  test('typed table helpers emit partial patch and targeted delete operations', async () => {
    interface TaskRow {
      id: string;
      title: string;
      done: boolean;
    }
    const descriptor: SyncTableDescriptor<
      TaskRow,
      TaskRow,
      Pick<TaskRow, 'title' | 'done'>,
      string
    > = {
      name: 'tasks',
      primaryKey: 'id',
      physicalPrimaryKey: 'id',
    };
    const client = new FakeClient();
    const mutations: unknown[] = [];
    const patches: unknown[] = [];
    client.mutate = (input) => {
      mutations.push(input);
      return 'mutated';
    };
    client.patch = (...args) => {
      patches.push(args);
      return 'patched';
    };
    const { result } = renderHook(() => useMutation(descriptor), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.upsert({ id: 't1', title: 'A', done: false });
      await result.current.patch('t1', { done: true }, 3);
      await result.current.remove('t1', 4);
    });
    expect(mutations).toEqual([
      [
        {
          table: 'tasks',
          op: 'upsert',
          values: { id: 't1', title: 'A', done: false },
        },
      ],
      [
        {
          table: 'tasks',
          op: 'delete',
          rowId: 't1',
          baseVersion: 4,
        },
      ],
    ]);
    expect(patches).toEqual([
      ['tasks', 't1', { done: true }, { baseVersion: 3 }],
    ]);
  });
});
