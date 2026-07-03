/**
 * SSR safety: rendering the hooks on the server (no DOM, effects never run)
 * must not crash. `useSyncQuery`/`useSyncStatus`/`useConflicts` return their
 * initial state during `renderToString`; the query fires only in the mount
 * effect (client-side), so the server render is inert and safe.
 */
import { describe, expect, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import {
  SyncProvider,
  useConflicts,
  useSyncQuery,
  useSyncStatus,
} from '../src/index';
import { FakeClient } from './fake-client';

function App(): ReactNode {
  const { rows, isLoading } = useSyncQuery('SELECT * FROM tasks');
  const status = useSyncStatus();
  const { conflicts } = useConflicts();
  return createElement(
    'div',
    null,
    `rows=${rows.length} loading=${isLoading} outbox=${status.outbox} conflicts=${conflicts.length}`,
  );
}

describe('SSR safety', () => {
  test('renderToString does not crash and shows initial state', () => {
    const client = new FakeClient();
    const html = renderToString(
      createElement(SyncProvider, { client }, createElement(App)),
    );
    // Initial state: empty rows, loading true, empty outbox/conflicts.
    expect(html).toContain('rows=0');
    expect(html).toContain('loading=true');
    expect(html).toContain('outbox=0');
    expect(html).toContain('conflicts=0');
  });
});
