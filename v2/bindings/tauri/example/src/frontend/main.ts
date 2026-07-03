/**
 * Vanilla frontend for the syncular tauri example. Proves the wiring: it
 * constructs a `TauriSyncClient` over the plugin (the ambient `@tauri-apps/api`
 * inside the webview) and drives it with the SAME `SyncClientLike` surface the
 * React hooks use — subscribe, mutate, live-query via `onInvalidate`.
 *
 * Vanilla rather than React so the example has no bundler/JSX toolchain to
 * stand up: the point of this rung is that the plugin + bridge compile and wire
 * together, not to ship a UI framework demo (the react hooks are proven
 * unchanged by @syncular-v2/tauri's shape-parity test). Swap in
 * @syncular-v2/react + <SyncProvider client={await createTauriSyncClient(...)}>
 * and the hooks work verbatim.
 */
import { createTauriSyncClient } from '@syncular-v2/tauri';

// The generated schema an app ships (typegen emits this from the IR). A tiny
// inline schema keeps the example self-contained.
const schema = {
  version: 1,
  tables: [
    {
      name: 'todo',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'done', type: 'boolean', nullable: false },
      ],
      scopes: [],
    },
  ],
};

const statusEl = document.getElementById('status') as HTMLParagraphElement;
const listEl = document.getElementById('todos') as HTMLUListElement;
const formEl = document.getElementById('add') as HTMLFormElement;
const titleEl = document.getElementById('title') as HTMLInputElement;

async function main(): Promise<void> {
  const client = await createTauriSyncClient({
    clientId: 'example-device',
    schema,
  });
  statusEl.textContent = 'connected — native syncular instance is running';

  await client.subscribe({ id: 'todos', table: 'todo' });

  const render = async (): Promise<void> => {
    const rows = await client.query(
      'SELECT id, title, done FROM todo ORDER BY title',
    );
    listEl.replaceChildren(
      ...rows.map((row) => {
        const li = document.createElement('li');
        li.textContent = `${row.done ? '✓' : '○'} ${String(row.title)}`;
        return li;
      }),
    );
  };

  // A live query: re-run on every apply-batch invalidation (the same seam the
  // react useSyncQuery hook subscribes to).
  client.onInvalidate(() => {
    void render();
  });
  await render();

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = titleEl.value.trim();
    if (title === '') return;
    titleEl.value = '';
    void client.mutate([
      {
        op: 'upsert',
        table: 'todo',
        values: { id: crypto.randomUUID(), title, done: false },
      },
    ]);
  });
}

void main().catch((error) => {
  statusEl.textContent = `failed to start: ${String(error)}`;
});
