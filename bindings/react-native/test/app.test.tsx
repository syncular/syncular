/**
 * The hooks↔module INTEGRATION proof: render the example's real `App.tsx`
 * (the same file that ships to the device) against an injected NativeModule
 * double, with NO device and NO Metro. This closes the loop the bridge unit
 * test (`bridge.test.ts`) leaves open — that one proves the SyncClientLike
 * marshaling; this one proves `@syncular/react`'s hooks (`useRawSql` /
 * `useMutation` / `useSyncStatus`) drive the native client through the JSX the
 * user actually wrote:
 *
 *   1. the list renders the rows the native `query` returns;
 *   2. typing + Add calls `useMutation.mutate` → the native `command('mutate')`;
 *   3. the resulting `invalidate` event re-runs `useRawSql` and the new row
 *      appears (the optimistic-write round trip, hooks end-to-end).
 *
 * The NativeModule double here is STATEFUL (a tiny todo store) so `query`
 * reflects the mutation — exactly what the real native core does. `react-native`
 * is mocked to DOM tags in `setup-app.ts` (the one thing bun can't resolve
 * off-device); everything else is the shipped code.
 */
// `react-native` is mocked + happy-dom registered by the bunfig test preload
// (`./test/setup-app.ts`), which must run before the static `react-native`
// import in `App.tsx` resolves.
import { afterEach, describe, expect, test } from 'bun:test';
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react';
import * as React from 'react';
import { App } from '../example/src/App';
import {
  createNativeSyncClient,
  type SyncularEvent,
  type SyncularEventEmitter,
  type SyncularNativeModule,
} from '../src/index';

interface TodoRow {
  id: string;
  list_id: string;
  title: string;
  done: boolean;
  position: number;
  updated_at_ms: number;
}

/**
 * A stateful NativeModule double backed by a todo store — `mutate` upserts /
 * deletes and fires an `invalidate`, `query` returns the current rows. This is
 * the native core's observable behavior (optimistic local write → invalidate →
 * re-read), the substrate the hooks are meant to drive.
 */
function makeStatefulNative(): {
  nativeModule: SyncularNativeModule;
  eventEmitter: SyncularEventEmitter;
} {
  const store = new Map<string, TodoRow>();
  const handlers = new Set<(payload: SyncularEvent) => void>();
  const emitInvalidate = () => {
    for (const h of handlers) h({ type: 'invalidate', tables: ['todos'] });
  };

  const nativeModule: SyncularNativeModule = {
    create: async () => JSON.stringify({ result: {} }),
    command: async (commandJson) => {
      const { method, params } = JSON.parse(commandJson) as {
        method: string;
        params: Record<string, unknown>;
      };
      switch (method) {
        case 'mutate': {
          const mutations = params.mutations as Array<{
            op: string;
            values?: TodoRow;
            rowId?: string;
          }>;
          for (const m of mutations) {
            if (m.op === 'upsert' && m.values) store.set(m.values.id, m.values);
            else if (m.op === 'delete' && m.rowId) store.delete(m.rowId);
          }
          // The native core fires the choke-point invalidation after apply.
          queueMicrotask(emitInvalidate);
          return JSON.stringify({ result: { clientCommitId: 'c-1' } });
        }
        case 'pendingCommitIds':
          return JSON.stringify({ result: { ids: [] } });
        case 'upgrading':
          return JSON.stringify({ result: { value: false } });
        case 'syncNeeded':
          return JSON.stringify({ result: { value: false } });
        case 'leaseState':
          return JSON.stringify({ result: { lease: undefined } });
        case 'schemaFloor':
          return JSON.stringify({ result: { floor: undefined } });
        default:
          return JSON.stringify({ result: {} });
      }
    },
    query: async () => {
      const rows = [...store.values()].sort(
        (a, b) => a.position - b.position || a.id.localeCompare(b.id),
      );
      return JSON.stringify({ result: { rows } });
    },
    close: async () => {},
    startEvents: () => {},
    stopEvents: () => {},
  };

  const eventEmitter: SyncularEventEmitter = {
    addListener: (_event, handler) => {
      handlers.add(handler);
      return { remove: () => handlers.delete(handler) };
    },
  };

  return { nativeModule, eventEmitter };
}

afterEach(() => {
  cleanup();
});

describe('App over the native client (integration)', () => {
  test('renders the empty state, then a mutation flows through and appears', async () => {
    const { nativeModule, eventEmitter } = makeStatefulNative();
    const client = await createNativeSyncClient({
      clientId: 'test-device',
      schema: { version: 1, tables: [] },
      nativeModule,
      eventEmitter,
    });

    const screen = render(React.createElement(App, { client }));

    // Empty state resolves (the initial useRawSql read returned no rows).
    await waitFor(() => expect(screen.getByText('no todos yet')).toBeDefined());

    // Type a title and press Add — drives useMutation → command('mutate').
    const input = screen.container.querySelector('input');
    if (input === null) throw new Error('missing input');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'buy milk' } });
    });
    const addButton = [...screen.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Add',
    );
    if (addButton === undefined) throw new Error('missing Add button');
    await act(async () => {
      fireEvent.click(addButton);
    });

    // The invalidate re-ran useRawSql; the optimistic row is on screen.
    await waitFor(() => expect(screen.getByText('buy milk')).toBeDefined());
  });

  test('renders rows the native query returns and toggles one', async () => {
    const { nativeModule, eventEmitter } = makeStatefulNative();
    // Pre-seed via a mutation so the store has a row before first render.
    const client = await createNativeSyncClient({
      clientId: 'test-device',
      schema: { version: 1, tables: [] },
      nativeModule,
      eventEmitter,
    });
    await client.mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: {
          id: 't1',
          list_id: 'groceries',
          title: 'eggs',
          done: false,
          position: 1,
          updated_at_ms: 0,
        },
      },
    ]);

    const screen = render(React.createElement(App, { client }));
    await waitFor(() => expect(screen.getByText('eggs')).toBeDefined());

    // The checkbox (☐) toggles the row done via another mutate → re-render.
    const checkbox = [...screen.container.querySelectorAll('button')].find(
      (b) => b.textContent === '☐',
    );
    if (checkbox === undefined) throw new Error('missing checkbox');
    await act(async () => {
      fireEvent.click(checkbox);
    });
    await waitFor(() =>
      expect(
        [...screen.container.querySelectorAll('button')].some(
          (b) => b.textContent === '☑',
        ),
      ).toBe(true),
    );
  });
});
