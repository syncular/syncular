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
  httpBlobTransport,
  httpSegmentDownloader,
  httpSyncTransport,
  type MutationInput,
  NOT_LEADER_CODE,
  type RealtimeHandlers,
  type RealtimeSocket,
  type SqlRow,
  type SqlValue,
  type SubscribeInput,
  SYNC_VERSION_COLUMN,
  SyncClient,
  type SyncSummary,
  webSocketRealtimeConnector,
} from '@syncular/client';
import { openWasmDatabase } from '@syncular/client/wasm';
import {
  schema,
  type TodosRow,
  todoListSubscription,
} from '../syncular.generated';

/**
 * Build-time flag (Bun.build `define`): the static, backend-free bundle sets
 * it, and the panes then talk to the embedded server worker instead of HTTP.
 * The dev server bundle leaves it unset.
 */
declare const SYNCULAR_DEMO_EMBEDDED: boolean;
const EMBEDDED =
  typeof SYNCULAR_DEMO_EMBEDDED !== 'undefined' && SYNCULAR_DEMO_EMBEDDED;

const LIST_ID = 'demo';
const SUBSCRIPTION_ID = 'todos';
const EPHEMERAL = new URLSearchParams(location.search).has('ephemeral');
/**
 * TODO 3.2: `?multitab` makes each pane a multi-tab core — open the demo in
 * two tabs and the first tab's pane is the leader, the second's is a
 * follower proxying to it (one socket, one DB, N tabs). Off by default so
 * the two panes stay two independent "devices".
 */
const MULTITAB = new URLSearchParams(location.search).has('multitab');
const WS_PROTO = location.protocol === 'https:' ? 'wss' : 'ws';

type LocalTodo = TodosRow & { _sync_version: number };

/**
 * The pane's view of a client core: the handle's async surface. The
 * worker handle implements it directly; the ephemeral main-thread
 * SyncClient is adapted below so both modes drive the same pane code.
 */
interface PaneCore {
  readonly backendLabel: string;
  /** 'leader' | 'follower' in multi-tab mode; undefined otherwise. */
  role?(): 'leader' | 'follower';
  onRoleChange?(cb: (role: 'leader' | 'follower') => void): void;
  subscribe(input: SubscribeInput): Promise<void>;
  mutate(mutations: readonly MutationInput[]): Promise<string>;
  syncUntilIdle(): Promise<SyncSummary>;
  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
  pendingCount(): Promise<number>;
  conflicts(): Promise<readonly ConflictRecord[]>;
  setOffline(offline: boolean): Promise<void>;
  /** §5.9: stage a blob → its canonical ref string; resolve a ref → bytes. */
  uploadBlob(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<string>;
  fetchBlob(blobIdOrRef: string): Promise<Uint8Array>;
  /** Best-effort; connect-then-sync is the reference boot order — the
   * first sync round rides the socket and registers this connection's
   * subscriptions at round end (§8.7). */
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
      blobsUrl: '/blobs',
      realtimeUrl: `${WS_PROTO}://${location.host}/realtime?clientId={clientId}`,
    },
    limits: { limitSnapshotRows: 5000, maxSnapshotPages: 20 },
    // §8.4 host loop: wake-ups coalesce into sync rounds INSIDE the
    // worker; the page only re-renders when told (or on its poll tick).
    autoSync: true,
    lockName: `syncular-demo-${paneName.toLowerCase()}`,
    // TODO 3.2: with ?multitab, a second tab's pane follows this one.
    multiTab: MULTITAB,
    onRoleChange: () => onDataMaybeChanged(),
    onSynced: () => onDataMaybeChanged(),
    onConflict: () => onDataMaybeChanged(),
  });
  if (!MULTITAB && !handle.isLeader) {
    throw new ClientSyncError(
      NOT_LEADER_CODE,
      `another tab owns pane ${paneName}'s core — close it first, ` +
        'or open with ?multitab to follow it',
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
    backendLabel: MULTITAB
      ? 'sqlite-wasm (OPFS, worker, multi-tab)'
      : 'sqlite-wasm (OPFS, worker)',
    role: () => handle.role,
    onRoleChange: (cb) => handle.onRoleChange(cb),
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
    uploadBlob: async (bytes, options) => {
      const ref = await handle.uploadBlob(bytes, options);
      return JSON.stringify(ref);
    },
    fetchBlob: async (blobIdOrRef) =>
      (await handle.fetchBlob(blobIdOrRef)).bytes,
    connectRealtime,
  };
}

// -- embedded mode (static build): the server runs in a web worker -----------

/** The page-side handle on the embedded server worker (one per page). */
interface EmbeddedServer {
  sync(bytes: Uint8Array): Promise<Uint8Array>;
  blobUpload(
    blobId: string,
    bytes: Uint8Array,
    mediaType?: string,
  ): Promise<void>;
  blobDownload(blobId: string): Promise<Uint8Array>;
  /** A realtime "socket": a numbered channel into the worker's hub (§8.7). */
  rtOpen(clientId: string, handlers: RealtimeHandlers): Promise<RealtimeSocket>;
}

let embeddedServer: Promise<EmbeddedServer> | undefined;

function getEmbeddedServer(): Promise<EmbeddedServer> {
  if (embeddedServer !== undefined) return embeddedServer;
  embeddedServer = new Promise<EmbeddedServer>((resolve, reject) => {
    const worker = new Worker('/server-worker.js', { type: 'module' });
    let nextId = 1;
    let nextChannel = 1;
    const pending = new Map<
      number,
      {
        resolve: (msg: { bytes?: Uint8Array }) => void;
        reject: (error: Error) => void;
      }
    >();
    const channels = new Map<number, RealtimeHandlers>();
    const call = (
      body: Record<string, unknown>,
    ): Promise<{ bytes?: Uint8Array }> =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        worker.postMessage({ id, ...body });
      });
    const api: EmbeddedServer = {
      sync: async (bytes) => {
        const out = (await call({ kind: 'sync', bytes })).bytes;
        if (out === undefined) throw new Error('sync rpc returned no bytes');
        return out;
      },
      blobUpload: async (blobId, bytes, mediaType) => {
        await call({ kind: 'blob-upload', blobId, bytes, mediaType });
      },
      blobDownload: async (blobId) => {
        const out = (await call({ kind: 'blob-download', blobId })).bytes;
        if (out === undefined) throw new Error('blob rpc returned no bytes');
        return out;
      },
      rtOpen: async (clientId, handlers) => {
        const channel = nextChannel++;
        channels.set(channel, handlers);
        await call({ kind: 'rt-open', channel, clientId });
        return {
          send: (text) =>
            worker.postMessage({ kind: 'rt-text', channel, text }),
          sendBytes: (bytes) =>
            worker.postMessage({ kind: 'rt-bytes', channel, bytes }),
          close: () => {
            worker.postMessage({ kind: 'rt-close', channel });
            channels.delete(channel);
          },
        };
      },
    };
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as {
        kind: string;
        id?: number;
        ok?: boolean;
        bytes?: Uint8Array;
        text?: string;
        channel?: number;
        error?: { code: string; message: string };
      };
      switch (msg.kind) {
        case 'ready':
          resolve(api);
          break;
        case 'result': {
          if (msg.id === undefined) break;
          const waiter = pending.get(msg.id);
          if (waiter === undefined) break;
          pending.delete(msg.id);
          if (msg.ok === true) waiter.resolve(msg);
          else
            waiter.reject(
              new ClientSyncError(
                msg.error?.code ?? 'sync.transport_failed',
                msg.error?.message ?? 'embedded server call failed',
                false,
              ),
            );
          break;
        }
        case 'rt-text':
          if (msg.channel !== undefined && msg.text !== undefined) {
            channels.get(msg.channel)?.onText(msg.text);
          }
          break;
        case 'rt-bytes':
          if (msg.channel !== undefined && msg.bytes !== undefined) {
            channels.get(msg.channel)?.onBinary(msg.bytes);
          }
          break;
        case 'rt-closed':
          if (msg.channel !== undefined) {
            channels.get(msg.channel)?.onClose?.();
            channels.delete(msg.channel);
          }
          break;
      }
    };
    worker.onerror = (event) => {
      reject(new Error(`embedded server worker failed: ${event.message}`));
    };
  });
  return embeddedServer;
}

/**
 * A pane core for the embedded mode: the same in-memory main-thread
 * `SyncClient` as the ephemeral mode, with every transport routed into the
 * server worker — sync bytes, blobs, and a real realtime channel.
 */
async function makeEmbeddedCore(
  paneName: string,
  onDataMaybeChanged: () => void,
): Promise<PaneCore> {
  const server = await getEmbeddedServer();
  const database = await openWasmDatabase();
  const clientId = crypto.randomUUID();
  let offline = false;
  let syncScheduled = false;
  const offlineError = () =>
    new ClientSyncError(
      'sync.transport_failed',
      `pane ${paneName} is offline`,
      true,
    );
  const client = new SyncClient({
    database,
    schema,
    clientId,
    transport: async (bytes) => {
      if (offline) throw offlineError();
      return server.sync(bytes);
    },
    blobs: {
      upload: async (blobId, bytes, mediaType) => {
        if (offline) throw offlineError();
        await server.blobUpload(blobId, bytes, mediaType);
      },
      download: async (blobId) => {
        if (offline) throw offlineError();
        return { kind: 'bytes', bytes: await server.blobDownload(blobId) };
      },
    },
    realtime: (handlers) => server.rtOpen(clientId, handlers),
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
      // request/response sync still works without the channel
    }
  };
  return {
    backendLabel: 'sqlite-wasm ↔ in-page server worker',
    subscribe: (input) => {
      client.subscribe(input);
      return Promise.resolve();
    },
    mutate: (mutations) => Promise.resolve(client.mutate(mutations)),
    syncUntilIdle: () => client.syncUntilIdle(),
    query: (sql, params) => Promise.resolve(client.query(sql, params)),
    pendingCount: () => Promise.resolve(client.pendingCommits().length),
    conflicts: () => Promise.resolve(client.conflicts),
    uploadBlob: async (bytes, options) => {
      const ref = await client.uploadBlob(bytes, options);
      return client.blobRefString(ref);
    },
    fetchBlob: async (blobIdOrRef) =>
      (await client.fetchBlob(blobIdOrRef)).bytes,
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
    blobs: httpBlobTransport('/blobs'),
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
    uploadBlob: async (bytes, options) => {
      const ref = await client.uploadBlob(bytes, options);
      return client.blobRefString(ref);
    },
    fetchBlob: async (blobIdOrRef) =>
      (await client.fetchBlob(blobIdOrRef)).bytes,
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
  #roleBadge?: HTMLElement;
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
      this.core = EMBEDDED
        ? await makeEmbeddedCore(this.name, () => this.refreshSoon())
        : EPHEMERAL
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
    // TODO 3.2: reflect promotion (follower → leader) in the badge.
    this.core.onRoleChange?.(() => this.render());
    await this.core.subscribe({
      id: SUBSCRIPTION_ID,
      table: 'todos',
      scopes: todoListSubscription.scopes({ listId: LIST_ID }),
    });
    this.#ready = true;
    // Connect-then-sync (§8.7 reference boot order): the first sync
    // round rides the socket and registers this connection's
    // subscriptions at round end — no reconnect, no silent-no-fanout
    // window (the old §8.1 footgun is structurally dead).
    await this.core.connectRealtime();
    await this.syncNow();
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
          listId: LIST_ID,
          title,
          done: false,
          position: position + 1,
          updatedAtMs: Date.now(),
          attachment: null,
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
      listId: row.listId,
      title: row.title,
      done: Boolean(row.done),
      position: row.position,
      updatedAtMs: Date.now(),
      // Preserve the blob_ref across unrelated edits (§5.9): a full-row
      // upsert that omitted it would clear the attachment.
      attachment: row.attachment ?? null,
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

  /**
   * §5.9: attach a file to a todo. Stage the bytes (upload queued, B4),
   * then upsert the row's `attachment` blob_ref — the upload flushes before
   * the referencing push (§6.6), so the reference is always resolvable.
   */
  async attachFile(row: LocalTodo, file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ref = await this.core.uploadBlob(bytes, {
      mediaType: file.type || 'application/octet-stream',
      name: file.name,
    });
    await this.updateTodo(row, { attachment: ref });
    this.setStatus(`attached ${file.name} (${bytes.length} bytes)`);
  }

  /** §5.9.5: resolve the attachment bytes (cache hit or download) + save. */
  async downloadAttachment(row: LocalTodo): Promise<void> {
    if (row.attachment === null || row.attachment === undefined) return;
    const meta = JSON.parse(row.attachment) as {
      mediaType?: string;
      name?: string;
    };
    const bytes = await this.core.fetchBlob(row.attachment);
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], {
      type: meta.mediaType ?? 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = meta.name ?? 'attachment';
    anchor.click();
    URL.revokeObjectURL(url);
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
        `SELECT id, list_id AS listId, title, done, position,
                updated_at_ms AS updatedAtMs, attachment,
                "${SYNC_VERSION_COLUMN}" AS _sync_version
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
    // TODO 3.2: show leader/follower when ?multitab is on (populated after
    // the core starts, in init()).
    if (MULTITAB) {
      this.#roleBadge = el('span', 'badge', 'role …');
      title.append(this.#roleBadge);
    }
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
    if (this.#roleBadge !== undefined) {
      const role = this.core.role?.() ?? 'leader';
      this.#roleBadge.textContent = role;
      this.#roleBadge.className = `badge ${role === 'leader' ? 'online' : 'offline'}`;
    }
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

    // §5.9 attachment cell: attach a file, or download an existing blob.
    const attachCell = document.createElement('td');
    attachCell.className = 'attach';
    if (row.attachment !== null && row.attachment !== undefined) {
      let name = 'file';
      try {
        name = (JSON.parse(row.attachment) as { name?: string }).name ?? 'file';
      } catch {
        // keep the fallback label
      }
      const dl = el('button', undefined, `↓ ${name}`);
      dl.title = 'download attachment';
      dl.addEventListener('click', () => {
        void this.downloadAttachment(row);
      });
      attachCell.append(dl);
    } else {
      const label = document.createElement('label');
      label.className = 'attach-label';
      label.title = 'attach a file';
      label.append('attach');
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file !== undefined) void this.attachFile(row, file);
      });
      label.append(fileInput);
      attachCell.append(label);
    }

    const deleteCell = document.createElement('td');
    const deleteBtn = el('button', undefined, '×');
    deleteBtn.title = 'delete';
    deleteBtn.addEventListener('click', () => {
      void this.deleteTodo(row.id);
    });
    deleteCell.append(deleteBtn);

    tr.append(toggleCell, titleCell, attachCell, deleteCell);
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
        listId: LIST_ID,
        title: 'Conflict target',
        done: false,
        position: 999,
        updatedAtMs: Date.now(),
        attachment: null,
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
    modeEl.innerHTML = EMBEDDED
      ? 'server: <strong>in this page</strong> (web worker) — nothing leaves the browser'
      : EPHEMERAL
        ? 'mode: <strong>ephemeral</strong> (in-memory, main thread — explicit) · <a href="/">persistent</a>'
        : MULTITAB
          ? 'mode: <strong>persistent + multi-tab</strong> (OPFS, worker) — open a second tab to see a follower · <a href="/">single-tab</a>'
          : 'mode: <strong>persistent</strong> (OPFS, worker) · <a href="/?ephemeral">ephemeral</a> · <a href="/?multitab">multi-tab</a>';
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
