/**
 * SyncProvider StrictMode regression tests
 *
 * React StrictMode (dev) mounts + unmounts + re-mounts components to surface
 * unsafe side effects. These tests ensure our SyncProvider lifecycle remains
 * correct under that behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { SyncClientDb } from '@syncular/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { Kysely } from 'kysely';
import React from 'react';
import { createSyncularReact } from '../index';
import {
  createMockDb,
  createMockHandlerRegistry,
  createMockSync,
  createMockTransport,
} from './test-utils';

const { SyncProvider, useSyncConnection, useSyncStatus } =
  createSyncularReact<SyncClientDb>();

function StatusText() {
  const { enabled, isOnline } = useSyncStatus();
  const text = !enabled ? 'disabled' : isOnline ? 'online' : 'offline';
  return <div data-testid="status">{text}</div>;
}

function ConnectionControls() {
  const { isConnected, disconnect, reconnect } = useSyncConnection();
  const { isOnline } = useSyncStatus();

  return (
    <div>
      <div data-testid="connected">{String(isConnected)}</div>
      <div data-testid="online">{String(isOnline)}</div>
      <button type="button" onClick={disconnect}>
        disconnect
      </button>
      <button type="button" onClick={reconnect}>
        reconnect
      </button>
    </div>
  );
}

describe('SyncProvider (StrictMode)', () => {
  let db: Kysely<SyncClientDb>;

  beforeEach(async () => {
    db = await createMockDb();
  });

  afterEach(async () => {
    cleanup();
    await db.destroy();
  });

  function renderWithProvider(node: React.ReactNode) {
    const transport = createMockTransport();
    const handlers = createMockHandlerRegistry();
    const sync = createMockSync({ handlers });

    return render(
      <React.StrictMode>
        <SyncProvider
          db={db}
          transport={transport}
          sync={sync}
          identity={{ actorId: 'test-actor' }}
          clientId="test-client"
          pollIntervalMs={999999}
        >
          {node}
        </SyncProvider>
      </React.StrictMode>
    );
  }

  it('autoStart brings provider online under StrictMode', async () => {
    renderWithProvider(<StatusText />);

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('online');
    });
  });

  it('disconnect + reconnect works under StrictMode (polling mode)', async () => {
    renderWithProvider(<ConnectionControls />);

    await waitFor(() => {
      expect(screen.getByTestId('online').textContent).toBe('true');
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'disconnect' }));
    });

    expect(screen.getByTestId('online').textContent).toBe('false');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'reconnect' }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('online').textContent).toBe('true');
    });
  });
});
