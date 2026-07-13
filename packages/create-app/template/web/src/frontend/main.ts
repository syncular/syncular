/**
 * A single-pane browser todo app: one client core syncing through the server.
 *
 * The WHOLE core runs in a Web Worker on a persistent opfs-sahpool database,
 * driven through the `SyncClientHandle` RPC — the page only sends
 * query/mutate/subscribe messages and re-renders. This is the real browser
 * shape; grow your app from here.
 *
 * One core per origin: the first tab wins the leader lock and spawns the
 * worker; every further tab becomes a follower proxying the same API to the
 * leader over a BroadcastChannel (and promotes in place when the leader
 * closes). Open two tabs — or two browser windows for two separate actors —
 * to watch them converge over the realtime socket.
 */
import {
  ClientSyncError,
  createSyncClientHandle,
  type SqlRow,
} from '@syncular/client';
import { schema, todoListSubscription } from '../syncular.generated';

const LIST_ID = 'welcome';
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';

interface Todo {
  id: string;
  list_id: string;
  title: string;
  done: number | boolean;
  position: number;
  updated_at_ms: number;
}

const statusEl = document.getElementById('status') as HTMLElement;
const listEl = document.getElementById('todos') as HTMLUListElement;
const outboxEl = document.getElementById('outbox') as HTMLElement;
const form = document.getElementById('add-form') as HTMLFormElement;
const input = document.getElementById('add-input') as HTMLInputElement;
const offlineBtn = document.getElementById('offline-btn') as HTMLButtonElement;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

async function main(): Promise<void> {
  const handle = await createSyncClientHandle({
    worker: () => new Worker('/worker.js', { type: 'module' }),
    schema,
    database: { mode: 'persistent', name: 'app' },
    endpoints: {
      syncUrl: '/sync',
      segmentsUrl: '/segments',
      realtimeUrl: `${WS_PROTO}://${location.host}/realtime?clientId={clientId}`,
    },
    autoSync: true,
    lockName: 'app-core',
    onSynced: () => void refresh(),
  });

  await handle.subscribe({
    id: 'todos',
    table: 'todos',
    scopes: todoListSubscription.scopes({ listId: LIST_ID }),
  });

  // Connect-then-sync (§8.7 reference boot order): the first sync round rides
  // the socket and registers this connection's subscriptions at round end.
  try {
    await handle.connectRealtime();
  } catch {
    // HTTP sync still works without the socket.
  }
  await handle.syncUntilIdle();
  setStatus('in sync');
  await refresh();

  let offline = false;
  offlineBtn.addEventListener('click', async () => {
    offline = !offline;
    await handle.setOffline(offline);
    offlineBtn.textContent = offline ? 'Go online' : 'Go offline';
    if (offline) {
      setStatus('offline — edits queue in the outbox');
    } else {
      setStatus('back online — draining outbox…');
      try {
        await handle.connectRealtime();
      } catch {
        // socket optional
      }
      await handle.syncUntilIdle();
      setStatus('in sync');
    }
    await refresh();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (title === '') return;
    input.value = '';
    const rows = (await handle.query(
      'SELECT position FROM todos ORDER BY position DESC LIMIT 1',
    )) as SqlRow[];
    const top = rows[0]?.position;
    const position = (typeof top === 'number' ? top : 0) + 1;
    await handle.mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: {
          id: crypto.randomUUID(),
          list_id: LIST_ID,
          title,
          done: false,
          position,
          updated_at_ms: Date.now(),
        },
      },
    ]);
    if (!offline) await handle.syncUntilIdle();
    await refresh();
  });

  async function refresh(): Promise<void> {
    const rows = (await handle.query(
      'SELECT * FROM todos ORDER BY position ASC, id ASC',
    )) as unknown as Todo[];
    const pending = (await handle.pendingCommits()).length;
    outboxEl.textContent = `outbox ${pending}`;
    listEl.replaceChildren(...rows.map((row) => renderRow(row)));

    async function toggle(row: Todo): Promise<void> {
      await handle.mutate([
        {
          table: 'todos',
          op: 'upsert',
          values: {
            id: row.id,
            list_id: row.list_id,
            title: row.title,
            done: !row.done,
            position: row.position,
            updated_at_ms: Date.now(),
          },
        },
      ]);
      if (!offline) await handle.syncUntilIdle();
      await refresh();
    }
    async function remove(id: string): Promise<void> {
      await handle.mutate([{ table: 'todos', op: 'delete', rowId: id }]);
      if (!offline) await handle.syncUntilIdle();
      await refresh();
    }

    function renderRow(row: Todo): HTMLLIElement {
      const li = document.createElement('li');
      if (row.done) li.classList.add('done');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(row.done);
      checkbox.addEventListener('change', () => void toggle(row));
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = row.title;
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'delete';
      del.addEventListener('click', () => void remove(row.id));
      li.append(checkbox, title, del);
      return li;
    }
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof ClientSyncError
      ? `${error.code}: ${error.message}`
      : String(error);
  setStatus(`failed to start — ${message}`);
});
