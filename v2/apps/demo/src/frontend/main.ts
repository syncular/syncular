/**
 * B6 demo frontend: two side-by-side panes, EACH with its own independent
 * client core syncing through one server. Plain TypeScript + vanilla DOM.
 *
 * Default mode (Direction decision 2): each pane's WHOLE core runs in a
 * Web Worker on a persistent opfs-sahpool database (`demo-a` / `demo-b`),
 * driven through the `SyncClientHandle` RPC. Add `?ephemeral` for the
 * explicit in-memory main-thread mode (nothing survives a reload).
 *
 * Per pane: add/toggle/delete todos, an offline toggle that severs the
 * transport (outbox accumulates, drains with idempotent retry on
 * reconnect), a pending-commit counter, and surfaced §6.3 conflicts.
 */
import {
  ClientSyncError,
  type ConflictRecord,
  createSyncClientHandle,
  httpSegmentDownloader,
  httpSyncTransport,
  type MutationInput,
  NOT_LEADER_CODE,
  type SqlRow,
  type SqlValue,
  type SubscribeInput,
  SYNC_VERSION_COLUMN,
  SyncClient,
  type SyncSummary,
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
const EPHEMERAL = new URLSearchParams(location.search).has('ephemeral');
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';

type LocalTodo = TodosRow & { _sync_version: number };

/**
 * The pane's view of a client core: the handle's async surface. The
 * worker handle implements it directly; the ephemeral main-thread
 * SyncClient is adapted below so both modes drive the same pane code.
 */
interface PaneCore {
  readonly backendLabel: string;
  subscribe(input: SubscribeInput): Promise<void>;
  mutate(mutations: readonly MutationInput[]): Promise<string>;
  syncUntilIdle(): Promise<SyncSummary>;
  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
  pendingCount(): Promise<number>;
  conflicts(): Promise<readonly ConflictRecord[]>;
  setOffline(offline: boolean): Promise<void>;
  /** Best-effort; call AFTER the first sync so the hub session attaches
   * to an existing client record (§8.1 fixed registration). */
  connectRealtime(): Promise<void>;
}

// -- worker mode (the default): whole core behind the RPC handle -------------

async function makeWorkerCore(
  paneName: string,
  onDataMaybeChanged: () => void,
): Promise<PaneCore> {
  const handle = await createSyncClientHandle({
    worker: () => new Worker('/worker.js', { type: 'module' }),
    schema,
    database: { mode: 'persistent', name: `demo-${paneName.toLowerCase()}` },
    endpoints: {
      syncUrl: '/sync',
      segmentsUrl: '/segments',
      realtimeUrl: `${WS_PROTO}://${location.host}/realtime?clientId={clientId}`,
    },
    limits: { limitSnapshotRows: 5000, maxSnapshotPages: 20 },
    // §8.4 host loop: wake-ups coalesce into sync rounds INSIDE the
    // worker; the page only re-renders when told (or on its poll tick).
    autoSync: true,
    lockName: `syncular-demo-${paneName.toLowerCase()}`,
    onSynced: () => onDataMaybeChanged(),
    onConflict: () => onDataMaybeChanged(),
  });
  if (!handle.isLeader) {
    throw new ClientSyncError(
      NOT_LEADER_CODE,
      `another tab owns pane ${paneName}'s core — close it first ` +
        '(multi-tab followers are TODO 3.2)',
    );
  }
  const connectRealtime = async () => {
    try {
      await handle.connectRealtime();
    } catch {
      // HTTP sync still works without the socket.
    }
  };
  return {
    backendLabel: 'sqlite-wasm (OPFS, worker)',
    subscribe: (input) => handle.subscribe(input),
    mutate: (mutations) => handle.mutate(mutations),
    syncUntilIdle: () => handle.syncUntilIdle(),
    query: (sql, params) => handle.query(sql, params),
    pendingCount: async () => (await handle.pendingCommits()).length,
    conflicts: () => handle.conflicts(),
    setOffline: async (offline) => {
      await handle.setOffline(offline);
      if (!offline) await connectRealtime();
    },
    connectRealtime,
  };
}

// -- ephemeral mode (?ephemeral): explicit in-memory, main thread ------------

async function makeEphemeralCore(
  paneName: string,
  onDataMaybeChanged: () => void,
): Promise<PaneCore> {
  const database = await openWasmDatabase();
  const clientId = crypto.randomUUID();
  let offline = false;
  let syncScheduled = false;
  const baseTransport = httpSyncTransport('/sync');
  const client = new SyncClient({
    database,
    schema,
    clientId,
    transport: async (bytes) => {
      if (offline) {
        throw new ClientSyncError(
          'sync.transport_failed',
          `pane ${paneName} is offline`,
          true,
        );
      }
      return baseTransport(bytes);
    },
    segments: httpSegmentDownloader('/segments'),
    realtime: webSocketRealtimeConnector(
      `${WS_PROTO}://${location.host}/realtime?clientId=${clientId}`,
    ),
    limits: { limitSnapshotRows: 5000, maxSnapshotPages: 20 },
    onSyncNeeded: () => scheduleSync(),
    onConflict: () => onDataMaybeChanged(),
  });

  function scheduleSync(): void {
    if (syncScheduled || offline) return;
    syncScheduled = true;
    window.setTimeout(() => {
      syncScheduled = false;
      void client
        .syncUntilIdle()
        .catch(() => {})
        .then(() => onDataMaybeChanged());
    }, 50);
  }

  await client.start();
  const connectRealtime = async () => {
    try {
      await client.connectRealtime();
    } catch {
      // HTTP sync still works without the socket.
    }
  };
  return {
    backendLabel: 'sqlite-wasm (in-memory, ephemeral)',
    subscribe: (input) => {
      client.subscribe(input);
      return Promise.resolve();
    },
    mutate: (mutations) => Promise.resolve(client.mutate(mutations)),
    syncUntilIdle: () => client.syncUntilIdle(),
    query: (sql, params) => Promise.resolve(client.query(sql, params)),
    pendingCount: () => Promise.resolve(client.pendingCommits().length),
    conflicts: () => Promise.resolve(client.conflicts),
    connectRealtime,
    setOffline: async (value) => {
      offline = value;
      if (offline) {
        client.disconnectRealtime();
      } else {
        await connectRealtime();
      }
    },
  };
}

// -- pane ---------------------------------------------------------------------

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
  core!: PaneCore;
  offline = false;
  #ready = false;
  #status = '';
  #syncing = false;
  #refreshQueued = false;

  // last-fetched snapshot (RPC results are async; render stays sync)
  #todos: LocalTodo[] = [];
  #pending = 0;
  #conflicts: readonly ConflictRecord[] = [];

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
    try {
      this.core = EPHEMERAL
        ? await makeEphemeralCore(this.name, () => this.refreshSoon())
        : await makeWorkerCore(this.name, () => this.refreshSoon());
    } catch (error) {
      const message =
        error instanceof ClientSyncError
          ? `${error.code}: ${error.message}`
          : String(error);
      this.setStatus(`core start failed — ${message}`);
      throw error;
    }
    await this.core.subscribe({
      id: SUBSCRIPTION_ID,
      table: 'todos',
      scopes: todoListSubscription.scopes({ listId: LIST_ID }),
    });
    this.#ready = true;
    await this.syncNow();
    // AFTER the first sync: the hub attaches the realtime session to the
    // client record that sync just created (§8.1 fixed registration).
    await this.core.connectRealtime();
    this.setStatus('ready');
    await this.refresh();
    // Realtime deltas apply inside the core with no per-row callback — a
    // light refresh loop keeps the table fresh on top of onSynced events.
    setInterval(() => this.refreshSoon(), 500);
  }

  setStatus(text: string): void {
    this.#status = text;
    if (this.#statusLine !== undefined) this.#statusLine.textContent = text;
  }

  async syncNow(): Promise<void> {
    if (this.#syncing || this.offline) return;
    this.#syncing = true;
    try {
      await this.core.syncUntilIdle();
      this.setStatus('in sync');
    } catch (error) {
      const message =
        error instanceof ClientSyncError
          ? `${error.code}: ${error.message}`
          : String(error);
      this.setStatus(`sync failed — ${message}`);
    } finally {
      this.#syncing = false;
      await this.refresh();
    }
  }

  async setOffline(offline: boolean): Promise<void> {
    if (!this.#ready || this.offline === offline) return;
    this.offline = offline;
    await this.core.setOffline(offline);
    if (offline) {
      this.setStatus('offline — edits queue in the outbox');
    } else {
      this.setStatus('back online — draining outbox…');
      void this.syncNow();
    }
    await this.refresh();
  }

  todo(id: string): LocalTodo | undefined {
    return this.#todos.find((row) => row.id === id);
  }

  async addTodo(title: string): Promise<void> {
    const position = this.#todos.reduce(
      (max, row) => Math.max(max, row.position),
      0,
    );
    await this.core.mutate([
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
    await this.afterMutation();
  }

  /** Full-row upsert (§6.1); baseVersion only when the server version is
   * known locally (bootstrap rows carry version 0 = unknown). */
  async updateTodo(row: LocalTodo, patch: Partial<TodosRow>): Promise<void> {
    const values: TodosRow = {
      id: row.id,
      list_id: row.list_id,
      title: row.title,
      done: Boolean(row.done),
      position: row.position,
      updated_at_ms: Date.now(),
      ...patch,
    };
    await this.core.mutate([
      {
        table: 'todos',
        op: 'upsert',
        values: { ...values },
        ...(row._sync_version >= 1 ? { baseVersion: row._sync_version } : {}),
      },
    ]);
    await this.afterMutation();
  }

  async deleteTodo(id: string): Promise<void> {
    await this.core.mutate([{ table: 'todos', op: 'delete', rowId: id }]);
    await this.afterMutation();
  }

  async afterMutation(): Promise<void> {
    await this.refresh();
    if (this.offline) {
      this.setStatus('offline — edits queue in the outbox');
    } else {
      void this.syncNow();
    }
  }

  // -- rendering --------------------------------------------------------------

  refreshSoon(): void {
    if (this.#refreshQueued) return;
    this.#refreshQueued = true;
    window.setTimeout(() => {
      this.#refreshQueued = false;
      void this.refresh();
    }, 30);
  }

  /** Pull a fresh snapshot over the (possibly RPC) boundary, then render. */
  async refresh(): Promise<void> {
    if (!this.#ready) return;
    const [todos, pending, conflicts] = await Promise.all([
      this.core.query(
        `SELECT *, "${SYNC_VERSION_COLUMN}" AS _sync_version
         FROM todos ORDER BY position ASC, id ASC`,
      ),
      this.core.pendingCount(),
      this.core.conflicts(),
    ]);
    this.#todos = todos as unknown as LocalTodo[];
    this.#pending = pending;
    this.#conflicts = conflicts;
    this.render();
  }

  #buildShell(): void {
    const title = el('h2');
    title.append(`Pane ${this.name}`);
    this.#badge = el('span', 'badge online', 'online');
    title.append(this.#badge);
    this.#pendingEl = el('span', 'badge', 'outbox 0');
    title.append(this.#pendingEl);
    this.#offlineBtn = el('button', undefined, 'Go offline');
    this.#offlineBtn.addEventListener('click', () => {
      void this.setOffline(!this.offline);
    });
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
      void this.addTodo(value);
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
    this.#pendingEl.textContent = `outbox ${this.#pending} · ${this.core.backendLabel}`;
    this.#statusLine.textContent = this.#status;

    this.#tbody.replaceChildren(
      ...this.#todos.map((row) => this.#renderRow(row)),
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
    checkbox.addEventListener('change', () => {
      void this.updateTodo(row, { done: !row.done });
    });
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
    deleteBtn.addEventListener('click', () => {
      void this.deleteTodo(row.id);
    });
    deleteCell.append(deleteBtn);

    tr.append(toggleCell, titleCell, deleteCell);
    return tr;
  }

  #renderConflicts(): void {
    const conflicts = this.#conflicts;
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
  if (a.offline) await a.setOffline(false);
  if (b.offline) await b.setOffline(false);

  // A fresh row through pane A so both panes know its server version.
  const id = crypto.randomUUID();
  await a.core.mutate([
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

  await a.setOffline(true);
  await a.updateTodo(inA, { title: 'Edited OFFLINE in pane A' });
  await b.updateTodo(inB, { title: 'Edited ONLINE in pane B' });
  await b.syncNow();
  status.textContent =
    'pane A holds a conflicting offline edit — toggle pane A online to surface the conflict';
}

// -- boot ------------------------------------------------------------------------

async function main(): Promise<void> {
  const modeEl = document.getElementById('mode-hint');
  if (modeEl !== null) {
    modeEl.innerHTML = EPHEMERAL
      ? 'mode: <strong>ephemeral</strong> (in-memory, main thread — explicit) · <a href="/">persistent</a>'
      : 'mode: <strong>persistent</strong> (OPFS, worker) · <a href="/?ephemeral">ephemeral</a>';
  }
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
