/**
 * B6 demo frontend: two side-by-side panes, EACH with its own independent
 * SyncClient from @syncular-v2/web-client on the sqlite-wasm backend.
 * Plain TypeScript + vanilla DOM — no framework.
 *
 * Per pane: add/toggle/delete todos, an offline toggle that severs the
 * transport (outbox accumulates, drains with idempotent retry on
 * reconnect), a pending-commit counter, and surfaced §6.3 conflicts.
 */
import {
  type ClientDatabase,
  ClientSyncError,
  type ConflictRecord,
  httpSegmentDownloader,
  httpSyncTransport,
  SYNC_VERSION_COLUMN,
  SyncClient,
  webSocketRealtimeConnector,
} from '@syncular-v2/web-client';
import { openWasmDatabase } from '@syncular-v2/web-client/wasm';
import {
  schema,
  type TodosRow,
  todoListSubscription,
} from '../syncular.generated';

const LIST_ID = 'demo';
const SUBSCRIPTION_ID = 'todos';

type LocalTodo = TodosRow & { _sync_version: number };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

class Pane {
  readonly name: string;
  readonly root: HTMLElement;
  readonly clientId = crypto.randomUUID();
  client!: SyncClient;
  offline = false;
  #ready = false;
  backendLabel = 'starting…';
  #status = '';
  #syncTimer: number | undefined;
  #syncing = false;

  // DOM
  #badge!: HTMLElement;
  #statusLine!: HTMLElement;
  #tbody!: HTMLTableSectionElement;
  #pendingEl!: HTMLElement;
  #conflictsEl!: HTMLElement;
  #offlineBtn!: HTMLButtonElement;

  constructor(name: string, root: HTMLElement) {
    this.name = name;
    this.root = root;
  }

  async init(): Promise<void> {
    this.#buildShell();
    let database: ClientDatabase;
    try {
      // OPFS persistence needs a worker context (Atomics.wait): on the
      // main thread sqlite-wasm has no OpfsDb and this falls back to a
      // transient in-memory database — the honest B6 default.
      database = await openWasmDatabase({ filename: `demo-${this.name}.db` });
      const list = database.query('PRAGMA database_list');
      const file = String(list[0]?.file ?? '');
      this.backendLabel =
        file.length > 0 ? 'sqlite-wasm (OPFS)' : 'sqlite-wasm (in-memory)';
    } catch (error) {
      this.setStatus(`database open failed: ${String(error)}`);
      throw error;
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const baseTransport = httpSyncTransport('/sync');
    this.client = new SyncClient({
      database,
      schema,
      clientId: this.clientId,
      transport: async (bytes) => {
        if (this.offline) {
          throw new ClientSyncError(
            'sync.transport_failed',
            `pane ${this.name} is offline`,
            true,
          );
        }
        return baseTransport(bytes);
      },
      segments: httpSegmentDownloader('/segments'),
      realtime: webSocketRealtimeConnector(
        `${proto}://${location.host}/realtime?clientId=${this.clientId}`,
      ),
      limits: { limitSnapshotRows: 5000, maxSnapshotPages: 20 },
      onSyncNeeded: () => this.scheduleSync(),
      onConflict: () => this.render(),
    });

    await this.client.start();
    this.client.subscribe({
      id: SUBSCRIPTION_ID,
      table: 'todos',
      scopes: todoListSubscription.scopes({ listId: LIST_ID }),
    });
    this.#ready = true;
    await this.syncNow();
    await this.#connectRealtime();
    this.setStatus('ready');
    this.render();
    // Realtime deltas apply asynchronously inside the client with no app
    // callback — a light re-render loop keeps the table fresh.
    setInterval(() => this.render(), 400);
  }

  async #connectRealtime(): Promise<void> {
    try {
      await this.client.connectRealtime();
    } catch {
      this.setStatus('realtime connect failed — HTTP sync still works');
    }
  }

  setStatus(text: string): void {
    this.#status = text;
    if (this.#statusLine !== undefined) this.#statusLine.textContent = text;
  }

  scheduleSync(): void {
    if (this.#syncTimer !== undefined) return;
    this.#syncTimer = window.setTimeout(() => {
      this.#syncTimer = undefined;
      void this.syncNow();
    }, 50);
  }

  async syncNow(): Promise<void> {
    if (this.#syncing || this.offline) return;
    this.#syncing = true;
    try {
      await this.client.syncUntilIdle();
      this.setStatus('in sync');
    } catch (error) {
      const message =
        error instanceof ClientSyncError
          ? `${error.code}: ${error.message}`
          : String(error);
      this.setStatus(`sync failed — ${message}`);
    } finally {
      this.#syncing = false;
      this.render();
    }
  }

  setOffline(offline: boolean): void {
    if (!this.#ready || this.offline === offline) return;
    this.offline = offline;
    if (offline) {
      this.client.disconnectRealtime();
      this.setStatus('offline — edits queue in the outbox');
    } else {
      this.setStatus('back online — draining outbox…');
      void this.#connectRealtime();
      this.scheduleSync();
    }
    this.render();
  }

  todos(): LocalTodo[] {
    return this.client.query(
      `SELECT *, "${SYNC_VERSION_COLUMN}" AS _sync_version
       FROM todos ORDER BY position ASC, id ASC`,
    ) as unknown as LocalTodo[];
  }

  todo(id: string): LocalTodo | undefined {
    return (
      this.client.query(
        `SELECT *, "${SYNC_VERSION_COLUMN}" AS _sync_version FROM todos WHERE id = ?`,
        [id],
      ) as unknown as LocalTodo[]
    )[0];
  }

  addTodo(title: string): void {
    const rows = this.todos();
    const position = rows.reduce((max, row) => Math.max(max, row.position), 0);
    this.client.mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: {
          id: crypto.randomUUID(),
          list_id: LIST_ID,
          title,
          done: false,
          position: position + 1,
          updated_at_ms: Date.now(),
        } satisfies TodosRow,
      },
    ]);
    this.afterMutation();
  }

  /** Full-row upsert (§6.1); baseVersion only when the server version is
   * known locally (bootstrap rows carry version 0 = unknown). */
  updateTodo(row: LocalTodo, patch: Partial<TodosRow>): void {
    const values: TodosRow = {
      id: row.id,
      list_id: row.list_id,
      title: row.title,
      done: Boolean(row.done),
      position: row.position,
      updated_at_ms: Date.now(),
      ...patch,
    };
    this.client.mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: { ...values },
        ...(row._sync_version >= 1 ? { baseVersion: row._sync_version } : {}),
      },
    ]);
    this.afterMutation();
  }

  deleteTodo(id: string): void {
    this.client.mutate([{ table: 'todos', op: 'delete', rowId: id }]);
    this.afterMutation();
  }

  afterMutation(): void {
    this.render();
    if (this.offline) {
      this.setStatus('offline — edits queue in the outbox');
    } else {
      this.scheduleSync();
    }
  }

  // -- rendering --------------------------------------------------------------

  #buildShell(): void {
    const title = el('h2');
    title.append(`Pane ${this.name}`);
    this.#badge = el('span', 'badge online', 'online');
    title.append(this.#badge);
    this.#pendingEl = el('span', 'badge', 'outbox 0');
    title.append(this.#pendingEl);
    this.#offlineBtn = el('button', undefined, 'Go offline');
    this.#offlineBtn.addEventListener('click', () =>
      this.setOffline(!this.offline),
    );
    title.append(this.#offlineBtn);
    this.root.append(title);

    this.#statusLine = el('p', 'statusline', 'starting…');
    this.root.append(this.#statusLine);

    const form = el('form', 'add');
    const input = el('input');
    input.placeholder = `Add a todo in pane ${this.name}…`;
    const submit = el('button', undefined, 'Add');
    form.append(input, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (value.length === 0) return;
      input.value = '';
      this.addTodo(value);
    });
    this.root.append(form);

    const table = el('table');
    this.#tbody = document.createElement('tbody');
    table.append(this.#tbody);
    this.root.append(table);

    this.#conflictsEl = el('div', 'conflicts');
    this.root.append(this.#conflictsEl);
  }

  render(): void {
    if (!this.#ready) return;
    this.root.classList.toggle('offline', this.offline);
    this.#badge.textContent = this.offline ? 'offline' : 'online';
    this.#badge.className = `badge ${this.offline ? 'offline' : 'online'}`;
    this.#offlineBtn.textContent = this.offline ? 'Go online' : 'Go offline';
    const pending = this.client.pendingCommits().length;
    this.#pendingEl.textContent = `outbox ${pending} · ${this.backendLabel}`;
    this.#statusLine.textContent = this.#status;

    this.#tbody.replaceChildren(
      ...this.todos().map((row) => this.#renderRow(row)),
    );
    this.#renderConflicts();
  }

  #renderRow(row: LocalTodo): HTMLTableRowElement {
    const tr = document.createElement('tr');
    if (row.done) tr.classList.add('done');

    const toggleCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = Boolean(row.done);
    checkbox.addEventListener('change', () =>
      this.updateTodo(row, { done: !row.done }),
    );
    toggleCell.append(checkbox);

    const titleCell = document.createElement('td');
    titleCell.className = 'title';
    titleCell.append(row.title);
    const version = el(
      'span',
      'ver',
      row._sync_version === -1 ? 'local' : `v${row._sync_version}`,
    );
    titleCell.append(version);

    const deleteCell = document.createElement('td');
    const deleteBtn = el('button', undefined, '×');
    deleteBtn.title = 'delete';
    deleteBtn.addEventListener('click', () => this.deleteTodo(row.id));
    deleteCell.append(deleteBtn);

    tr.append(toggleCell, titleCell, deleteCell);
    return tr;
  }

  #renderConflicts(): void {
    const conflicts = this.client.conflicts;
    const children: HTMLElement[] = [];
    if (conflicts.length > 0) {
      children.push(
        el('strong', undefined, `conflicts surfaced (${conflicts.length})`),
      );
      for (const conflict of conflicts) {
        children.push(this.#renderConflict(conflict));
      }
    }
    this.#conflictsEl.replaceChildren(...children);
  }

  #renderConflict(conflict: ConflictRecord): HTMLElement {
    const item = el('div', 'item');
    const mine =
      conflict.operation?.op === 'upsert'
        ? String(conflict.operation.values?.title ?? '')
        : '(delete)';
    const theirs = String(conflict.serverRow.title ?? '');
    item.append(el('div', undefined, `${conflict.code} on ${conflict.rowId}`));
    const detail = el('div');
    detail.append('yours: ');
    detail.append(el('code', undefined, mine));
    detail.append(` — server (v${conflict.serverVersion}): `);
    detail.append(el('code', undefined, theirs));
    item.append(detail);
    return item;
  }
}

// -- conflict simulation --------------------------------------------------------

/**
 * The classic §6.2 base-version race: pane A goes offline and edits a row;
 * pane B edits the same row online (server version advances). Toggling
 * pane A back online replays its stale-baseVersion commit and the server
 * answers with a conflict record instead of applying it.
 */
async function simulateConflict(
  a: Pane,
  b: Pane,
  status: HTMLElement,
): Promise<void> {
  status.textContent = 'setting up conflict…';
  if (a.offline) a.setOffline(false);
  if (b.offline) b.setOffline(false);

  // A fresh row through pane A so both panes know its server version.
  const id = crypto.randomUUID();
  a.client.mutate([
    {
      table: 'todos',
      op: 'upsert',
      values: {
        id,
        list_id: LIST_ID,
        title: 'Conflict target',
        done: false,
        position: 999,
        updated_at_ms: Date.now(),
      } satisfies TodosRow,
    },
  ]);
  await a.syncNow();
  await b.syncNow();
  const inA = a.todo(id);
  const inB = b.todo(id);
  if (inA === undefined || inB === undefined || inA._sync_version < 1) {
    status.textContent = 'conflict setup failed — panes did not converge';
    return;
  }

  a.setOffline(true);
  a.updateTodo(inA, { title: 'Edited OFFLINE in pane A' });
  b.updateTodo(inB, { title: 'Edited ONLINE in pane B' });
  await b.syncNow();
  status.textContent =
    'pane A holds a conflicting offline edit — toggle pane A online to surface the conflict';
}

// -- boot ------------------------------------------------------------------------

async function main(): Promise<void> {
  const paneA = new Pane('A', document.getElementById('pane-a') as HTMLElement);
  const paneB = new Pane('B', document.getElementById('pane-b') as HTMLElement);
  const conflictBtn = document.getElementById(
    'conflict-btn',
  ) as HTMLButtonElement;
  const globalStatus = document.getElementById('global-status') as HTMLElement;

  await Promise.all([paneA.init(), paneB.init()]);

  conflictBtn.disabled = false;
  conflictBtn.addEventListener('click', () => {
    conflictBtn.disabled = true;
    void simulateConflict(paneA, paneB, globalStatus).finally(() => {
      conflictBtn.disabled = false;
    });
  });
}

void main();
