/**
 * One device of the sync lab: a Release board app over its own client
 * core. Everything it renders is read back from the device's SQLite with
 * `core.query`, and every edit is a `mutate` that lands in its outbox:
 * - the kanban board (drag a card with the mouse, or open it and pick a
 *   column with the keyboard or on touch);
 * - the card sheet (title, assignee, estimate, comments, and the open
 *   conflict with keep-mine / keep-server);
 * - the Local SQL lens, a read-only console over this device's database;
 * - the outbox panel and the scope chips in the device header.
 */
import {
  ClientSyncError,
  type ConflictRecord,
  type MutationInput,
  type OutboxCommit,
  type SqlRow,
  SYNC_VERSION_COLUMN,
} from '@syncular/client';
import { BOARD_COLUMNS, releaseBoardSeed } from '../seed';
import { schema } from '../syncular.generated';
import { type DeviceCore, makeCore } from './cores';
import { type DeviceId, outboxLines, planMove, type WriteIntent } from './lab';

export const COLUMN_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  doing: 'Doing',
  review: 'Review',
  done: 'Done',
};
const ESTIMATES = [1, 2, 3, 5, 8, 13];
/** Every synced table, in the manifest's bootstrap order. */
const TABLES = schema.tables.map((table) => table.name);

export const SQL_EXAMPLES: readonly { label: string; sql: string }[] = [
  {
    label: 'Rows per board',
    sql: `SELECT board_id,
       COUNT(*) AS cards,
       SUM(estimate) AS points
FROM cards
GROUP BY board_id`,
  },
  {
    label: 'Cards per column',
    sql: `SELECT board_id, column_id,
       COUNT(*) AS cards,
       SUM(estimate) AS points
FROM cards
GROUP BY board_id, column_id
ORDER BY board_id,
  CASE column_id WHEN 'backlog' THEN 1 WHEN 'doing' THEN 2
    WHEN 'review' THEN 3 ELSE 4 END`,
  },
  {
    label: 'Points per assignee',
    sql: `SELECT m.name AS assignee,
       COUNT(c.id) AS cards,
       SUM(c.estimate) AS points
FROM cards c
JOIN members m ON m.id = c.assignee_id
GROUP BY m.user_id
ORDER BY points DESC`,
  },
  {
    label: 'Label usage',
    sql: `SELECT l.name AS label, COUNT(*) AS cards
FROM card_labels cl
JOIN labels l ON l.id = cl.label_id
GROUP BY l.name
ORDER BY cards DESC, label`,
  },
  {
    label: 'Running points',
    sql: `SELECT column_id, title, estimate,
       SUM(estimate) OVER (
         PARTITION BY board_id, column_id ORDER BY position
       ) AS running_points
FROM cards
WHERE column_id IN ('doing', 'review')
ORDER BY board_id, column_id, position`,
  },
  {
    label: 'Latest comments',
    sql: `SELECT c.title AS card, m.name AS author, k.body
FROM comments k
JOIN cards c ON c.id = k.card_id
JOIN members m ON m.id = k.author_id
ORDER BY k.created_at_ms DESC
LIMIT 5`,
  },
];

export interface CardView {
  readonly id: string;
  readonly boardId: string;
  readonly columnId: string;
  readonly position: number;
  readonly title: string;
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly assigneeColor: string | null;
  readonly estimate: number;
  readonly syncVersion: number;
  readonly commentCount: number;
  readonly labels: readonly { readonly name: string; readonly color: string }[];
}

interface MemberView {
  readonly id: string;
  readonly boardId: string;
  readonly name: string;
  readonly color: string;
  readonly role: string;
}

interface CommentView {
  readonly author: string;
  readonly color: string;
  readonly body: string;
}

/** The lab hooks a device reports to. */
export interface DeviceHost {
  recordIntent(clientCommitId: string, intent: WriteIntent): void;
  intentOf(clientCommitId: string): WriteIntent | undefined;
  deviceChanged(): void;
}

export interface DeviceSpec {
  readonly id: DeviceId;
  readonly label: string;
  readonly actor: string;
  readonly person: string;
  readonly role: string;
  readonly color: string;
  /** Boards this device subscribes to on first start. */
  readonly boards: readonly string[];
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function part<T extends Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (node === null) throw new Error(`lab markup is missing ${selector}`);
  return node;
}

export function errorText(error: unknown): string {
  return error instanceof ClientSyncError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

function text(value: SqlRow[string] | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function toCard(row: SqlRow): CardView {
  return {
    id: text(row.id),
    boardId: text(row.boardId),
    columnId: text(row.columnId),
    position: Number(row.position),
    title: text(row.title),
    assigneeId: row.assigneeId === null ? null : text(row.assigneeId),
    assigneeName: row.assigneeName === null ? null : text(row.assigneeName),
    assigneeColor: row.assigneeColor === null ? null : text(row.assigneeColor),
    estimate: Number(row.estimate),
    syncVersion: Number(row.syncVersion),
    commentCount: Number(row.commentCount),
    labels: text(row.labels)
      .split(',')
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const [name = '', color = ''] = entry.split('|');
        return { name, color };
      }),
  };
}

const CARDS_SQL = `SELECT c.id, c.board_id AS boardId, c.column_id AS columnId,
       c.position, c.title, c.assignee_id AS assigneeId, c.estimate,
       c."${SYNC_VERSION_COLUMN}" AS syncVersion,
       m.name AS assigneeName, m.color AS assigneeColor,
       (SELECT COUNT(*) FROM comments k WHERE k.card_id = c.id) AS commentCount,
       (SELECT group_concat(l.name || '|' || l.color, ',')
          FROM card_labels cl JOIN labels l ON l.id = cl.label_id
         WHERE cl.card_id = c.id) AS labels
FROM cards c LEFT JOIN members m ON m.id = c.assignee_id
ORDER BY c.position, c.id`;

export class Device {
  readonly id: DeviceId;
  readonly label: string;
  readonly spec: DeviceSpec;
  readonly root: HTMLElement;
  core!: DeviceCore;
  online = true;
  ready = false;
  cards: CardView[] = [];
  members: MemberView[] = [];
  pending: readonly OutboxCommit[] = [];
  conflicts: readonly ConflictRecord[] = [];
  /** Boards with an active `cards:{board}` subscription on this device. */
  subscribed = new Set<string>();
  revoked = new Set<string>();
  board: string;
  view: 'board' | 'sql' = 'board';
  /** Monotonic count of successful Local SQL runs. */
  sqlRuns = 0;
  readonly #host: DeviceHost;
  #status = 'Starting the client core';
  #syncRun: Promise<void> | undefined;
  #syncAgain = false;
  #refreshQueued = false;
  #openCard: string | undefined;
  #sheetReturn: HTMLElement | undefined;
  /** Cards this device wrote since the last render (no remote highlight). */
  readonly #touched = new Set<string>();
  readonly #cardNodes = new Map<string, { sig: string; node: HTMLLIElement }>();
  #rendered = false;

  constructor(spec: DeviceSpec, root: HTMLElement, host: DeviceHost) {
    this.id = spec.id;
    this.label = spec.label;
    this.spec = spec;
    this.root = root;
    this.#host = host;
    this.board = spec.boards[0] ?? 'mobile';
    const app = part<HTMLTemplateElement>(document, '#device-app');
    part(root, '.screen').append(app.content.cloneNode(true));
    root.style.setProperty('--dev', spec.color);
    part(root, '.avatar').textContent = spec.person.slice(0, 1);
    part(root, '.dev-person').textContent = spec.person;
    part<HTMLElement>(root, '.dev-person').title =
      `${spec.person}, ${spec.role}`;
    this.#buildStatic();
  }

  async init(): Promise<void> {
    try {
      this.core = await makeCore(this.id, this.spec.actor);
    } catch (error) {
      this.#status = `Client core failed to start: ${errorText(error)}`;
      this.root.dataset.state = 'error';
      part(this.root, '.state-error').textContent = this.#status;
      throw error;
    }
    const core = part<HTMLElement>(this.root, '.dev-core');
    core.textContent = this.core.backendLabel;
    core.title = this.core.backendLabel;
    this.core.onRoleChange?.(() => this.render());
    this.core.onChange(() => this.refreshSoon());
    const existing = await this.core.subscriptions();
    const boards =
      existing.length > 0
        ? [
            ...new Set(
              existing.map((record) =>
                text(record.scopes.board_id?.[0] ?? null),
              ),
            ),
          ]
        : this.spec.boards;
    for (const board of boards) await this.subscribeBoard(board);
    // Connect-then-sync (§8.7 reference boot order): the first sync round
    // rides the socket and registers this connection's subscriptions.
    await this.core.connectRealtime();
    this.ready = true;
    this.root.dataset.state = 'ready';
    await this.syncNow();
    this.core.startRealtimeSupervisor();
  }

  /**
   * Subscribe every table of a board. A subscription the server revoked
   * stays revoked (SPEC §3.3), so a re-grant replaces it with a fresh one
   * that bootstraps from cursor -1.
   */
  async subscribeBoard(board: string): Promise<void> {
    const records = await this.core.subscriptions();
    for (const table of TABLES) {
      const id = `${table}:${board}`;
      const record = records.find((candidate) => candidate.id === id);
      if (record !== undefined && record.status !== 'active') {
        await this.core.unsubscribe(id);
      }
      await this.core.subscribe({
        id,
        table,
        scopes: { board_id: [board] },
      });
    }
  }

  /** Run sync rounds until idle. A call during a run waits for it and
   * schedules one more pass, so writes made meanwhile are pushed too. */
  syncNow(): Promise<void> {
    if (!this.online || !this.ready) return Promise.resolve();
    if (this.#syncRun !== undefined) {
      this.#syncAgain = true;
      return this.#syncRun;
    }
    this.#syncRun = (async () => {
      do {
        this.#syncAgain = false;
        this.#status = 'Syncing';
        this.render();
        try {
          await this.core.syncUntilIdle();
          this.#status = 'Synced';
        } catch (error) {
          this.#status = `Sync failed: ${errorText(error)}`;
        }
        await this.refresh();
      } while (this.#syncAgain && this.online);
    })().finally(() => {
      this.#syncRun = undefined;
    });
    return this.#syncRun;
  }

  async setOnline(online: boolean): Promise<void> {
    if (!this.ready || this.online === online) return;
    this.online = online;
    await this.core.setOffline(!online);
    this.#status = online ? 'Back online, draining the outbox' : 'Offline';
    await this.refresh();
    if (online) await this.syncNow();
  }

  card(id: string): CardView | undefined {
    return this.cards.find((card) => card.id === id);
  }

  async write(
    mutations: readonly MutationInput[],
    intent: WriteIntent,
    touched: readonly string[],
  ): Promise<string> {
    const clientCommitId = await this.core.mutate(mutations);
    this.#host.recordIntent(clientCommitId, intent);
    for (const id of touched) this.#touched.add(id);
    await this.refresh();
    if (this.online) void this.syncNow();
    return clientCommitId;
  }

  async addCard(title: string): Promise<void> {
    const id = `c-${crypto.randomUUID().slice(0, 8)}`;
    const backlog = this.cards.filter(
      (card) => card.boardId === this.board && card.columnId === 'backlog',
    );
    const now = Date.now();
    await this.write(
      [
        {
          table: 'cards',
          op: 'upsert',
          values: {
            id,
            boardId: this.board,
            columnId: 'backlog',
            position:
              backlog.reduce((max, card) => Math.max(max, card.position), 0) +
              1000,
            title,
            assigneeId: `m-${this.board}-${this.spec.actor}`,
            estimate: 2,
            createdAtMs: now,
            updatedAtMs: now,
          },
        },
      ],
      { kind: 'add', title, boardId: this.board },
      [id],
    );
  }

  /**
   * Move a card through {@link planMove}: sparse patches of `column_id` and
   * `position`, each carrying the row's local version as baseVersion, so a
   * concurrent move of the same card surfaces as a conflict (§6.2).
   */
  async moveCard(
    cardId: string,
    toColumn: string,
    toIndex: number,
  ): Promise<void> {
    const card = this.card(cardId);
    if (card === undefined) return;
    const plan = planMove(
      this.cards.filter((candidate) => candidate.boardId === card.boardId),
      cardId,
      toColumn,
      toIndex,
    );
    if (plan.length === 0) return;
    await this.write(
      plan.map((place) => {
        const version = this.card(place.id)?.syncVersion ?? 0;
        return {
          table: 'cards',
          op: 'patch',
          values: {
            id: place.id,
            columnId: place.columnId,
            position: place.position,
          },
          ...(version >= 1 ? { baseVersion: version } : {}),
        };
      }),
      { kind: 'move', title: card.title, boardId: card.boardId },
      plan.map((place) => place.id),
    );
  }

  async editCard(
    card: CardView,
    patch: { title?: string; assigneeId?: string | null; estimate?: number },
  ): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await this.write(
      [
        {
          table: 'cards',
          op: 'patch',
          values: { id: card.id, ...patch },
          ...(card.syncVersion >= 1 ? { baseVersion: card.syncVersion } : {}),
        },
      ],
      { kind: 'edit', title: patch.title ?? card.title, boardId: card.boardId },
      [card.id],
    );
  }

  /** Keep server (§6.5): drop the losing operation, restore the server row. */
  async keepServer(conflict: ConflictRecord): Promise<void> {
    await this.core.resolveCommitOutcome({
      clientCommitId: conflict.clientCommitId,
      resolution: 'resolved_keep_server',
    });
    await this.refresh();
  }

  /** Keep local (§6.5): re-push the same sparse operation with
   * baseVersion = serverVersion, then record the conflict as superseded. */
  async keepMine(conflict: ConflictRecord): Promise<void> {
    const replacement = await this.core.mutate([
      {
        table: conflict.table,
        op: 'patch',
        values: conflict.operation?.values ?? { id: conflict.rowId },
        baseVersion: conflict.serverVersion,
      },
    ]);
    this.#host.recordIntent(replacement, {
      kind: 'keep-mine',
      title: text(conflict.serverRow.title ?? conflict.rowId),
      boardId: text(conflict.serverRow.board_id ?? ''),
    });
    await this.core.resolveCommitOutcome({
      clientCommitId: conflict.clientCommitId,
      resolution: 'superseded',
      replacementClientCommitId: replacement,
    });
    this.#touched.add(conflict.rowId);
    await this.refresh();
    if (this.online) void this.syncNow();
  }

  openSql(sql?: string): void {
    this.view = 'sql';
    if (sql !== undefined)
      part<HTMLTextAreaElement>(this.root, '.sql-input').value = sql;
    this.render();
    if (sql !== undefined) void this.runSql();
  }

  async runSql(): Promise<void> {
    const sql = part<HTMLTextAreaElement>(this.root, '.sql-input').value;
    const out = part<HTMLElement>(this.root, '.sql-result');
    const started = performance.now();
    try {
      const rows = await this.core.query(sql);
      const elapsed = performance.now() - started;
      this.sqlRuns += 1;
      const columns = rows[0] === undefined ? [] : Object.keys(rows[0]);
      const table = el('table', 'sql-table');
      const head = el('tr');
      for (const column of columns) head.append(el('th', undefined, column));
      table.append(el('thead'), el('tbody'));
      part(table, 'thead').append(head);
      for (const row of rows.slice(0, 100)) {
        const tr = el('tr');
        for (const column of columns)
          tr.append(el('td', undefined, text(row[column] ?? null)));
        part(table, 'tbody').append(tr);
      }
      out.replaceChildren(
        el(
          'p',
          'sql-meta',
          `${rows.length} row${rows.length === 1 ? '' : 's'} · ${elapsed.toFixed(1)} ms on the ${this.label.toLowerCase()}'s SQLite`,
        ),
        ...(rows.length > 0 ? [table] : []),
      );
      out.scrollIntoView({ block: 'nearest' });
      this.#host.deviceChanged();
    } catch (error) {
      out.replaceChildren(el('p', 'sql-error', errorText(error)));
    }
  }

  // -- rendering --------------------------------------------------------------

  refreshSoon(): void {
    if (this.#refreshQueued || !this.ready) return;
    this.#refreshQueued = true;
    queueMicrotask(() => {
      this.#refreshQueued = false;
      void this.refresh();
    });
  }

  /** Read the device's state back from its SQLite and outbox, then render. */
  async refresh(): Promise<void> {
    if (!this.ready) return;
    const [cards, members, pending, conflicts, subscriptions] =
      await Promise.all([
        this.core.query(CARDS_SQL),
        this.core.query(
          'SELECT id, board_id AS boardId, name, color, role FROM members ORDER BY name',
        ),
        this.core.pendingCommits(),
        this.core.conflicts(),
        this.core.subscriptions(),
      ]);
    this.cards = cards.map(toCard);
    this.members = members.map((row) => ({
      id: text(row.id),
      boardId: text(row.boardId),
      name: text(row.name),
      color: text(row.color),
      role: text(row.role),
    }));
    this.pending = pending;
    this.conflicts = conflicts;
    const status = (board: string) =>
      subscriptions.find((record) => record.id === `cards:${board}`)?.status;
    this.subscribed = new Set(
      releaseBoardSeed.boards
        .map((board) => board.id)
        .filter((board) => status(board) === 'active'),
    );
    this.revoked = new Set(
      releaseBoardSeed.boards
        .map((board) => board.id)
        .filter((board) => status(board) === 'revoked'),
    );
    this.render();
    this.#host.deviceChanged();
  }

  #buildStatic(): void {
    const root = this.root;
    part<HTMLButtonElement>(root, '.net').addEventListener('click', () => {
      void this.setOnline(!this.online);
    });
    const form = part<HTMLFormElement>(root, 'form.add');
    const input = part<HTMLInputElement>(form, 'input');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!this.ready || value.length === 0) return;
      input.value = '';
      void this.addCard(value);
    });

    const tabs = part<HTMLElement>(root, '.boards');
    for (const board of releaseBoardSeed.boards) {
      const tab = el('button');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.dataset.board = board.id;
      tab.style.setProperty('--c', board.color);
      tab.append(el('span', 'tab-name', board.name), el('span', 'n'));
      tabs.append(tab);
    }
    tabs.addEventListener('click', (event) => {
      const tab = (event.target as Element).closest<HTMLButtonElement>(
        '[data-board]',
      );
      if (tab?.dataset.board === undefined) return;
      this.board = tab.dataset.board;
      this.render();
    });
    tabs.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const ids = releaseBoardSeed.boards.map((board) => board.id);
      const next = ids[(ids.indexOf(this.board) + 1) % ids.length];
      if (next === undefined) return;
      this.board = next;
      this.render();
      part<HTMLButtonElement>(tabs, `[data-board="${next}"]`).focus();
    });

    for (const button of root.querySelectorAll<HTMLButtonElement>(
      '[data-view]',
    )) {
      button.addEventListener('click', () => {
        this.view = button.dataset.view === 'sql' ? 'sql' : 'board';
        this.render();
      });
    }
    part<HTMLButtonElement>(root, '.check-sql').addEventListener(
      'click',
      () => {
        this.openSql(SQL_EXAMPLES[0]?.sql);
      },
    );

    const kanban = part<HTMLElement>(root, '.kanban');
    for (const column of BOARD_COLUMNS) {
      const section = el('section', 'kcol');
      section.dataset.column = column;
      const head = el('header', 'kcol-head');
      head.append(
        el('h4', undefined, COLUMN_LABEL[column]),
        el('span', 'kcol-count'),
      );
      const list = el('ol', 'kcards');
      list.setAttribute('aria-label', COLUMN_LABEL[column] ?? column);
      section.append(head, list);
      kanban.append(section);
    }

    const examples = part<HTMLElement>(root, '.sql-examples');
    for (const example of SQL_EXAMPLES) {
      const chip = el('button', 'chip', example.label);
      chip.type = 'button';
      chip.addEventListener('click', () => this.openSql(example.sql));
      examples.append(chip);
    }
    const sqlInput = part<HTMLTextAreaElement>(root, '.sql-input');
    sqlInput.value = SQL_EXAMPLES[0]?.sql ?? '';
    part<HTMLFormElement>(root, '.sql-form').addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        void this.runSql();
      },
    );
    sqlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.runSql();
      }
    });

    const sheet = part<HTMLElement>(root, '.sheet');
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet) this.#closeSheet();
    });
    // Escape closes the sheet from anywhere in the device: resolving a
    // conflict re-renders its buttons, so focus may leave the panel.
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.#openCard !== undefined) {
        this.#closeSheet();
      }
    });
  }

  render(): void {
    const root = this.root;
    root.dataset.online = String(this.online);
    const net = part<HTMLButtonElement>(root, '.net');
    net.setAttribute('aria-checked', String(this.online));
    part(net, '.net-text').textContent = this.online ? 'Online' : 'Offline';
    const count = this.pending.length;
    for (const node of root.querySelectorAll('.ob-count'))
      node.textContent = String(count);
    root.dataset.queued = String(count > 0);
    if (this.ready && this.core.role !== undefined) {
      part(root, '.dev-core').textContent =
        `${this.core.backendLabel} · ${this.core.role()}`;
    }
    const conflictCount = this.conflicts.length;
    part(root, '.app-status').textContent = !this.online
      ? count > 0
        ? `Offline · ${count} queued`
        : 'Offline'
      : conflictCount > 0
        ? `${conflictCount} conflict${conflictCount === 1 ? '' : 's'}`
        : this.#status;
    root.dataset.syncing = String(this.#syncRun !== undefined);

    const chips = part<HTMLElement>(root, '.scope-chips');
    chips.replaceChildren(
      ...releaseBoardSeed.boards
        .filter(
          (board) =>
            this.subscribed.has(board.id) || this.revoked.has(board.id),
        )
        .map((board) => {
          const chip = el(
            'span',
            this.subscribed.has(board.id) ? 'scope-chip' : 'scope-chip revoked',
            `board:${board.id}`,
          );
          chip.title = this.subscribed.has(board.id)
            ? `This device syncs board:${board.id}`
            : `The server revoked board:${board.id}; its rows were purged`;
          return chip;
        }),
    );

    for (const board of releaseBoardSeed.boards) {
      const tab = part<HTMLButtonElement>(root, `[data-board="${board.id}"]`);
      const selected = board.id === this.board;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      part(tab, '.n').textContent = this.subscribed.has(board.id)
        ? String(this.cards.filter((card) => card.boardId === board.id).length)
        : 'no access';
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      '[data-view]',
    )) {
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.view === this.view),
      );
    }
    root.dataset.view = this.view;
    const access = this.subscribed.has(this.board);
    root.dataset.access = String(access);
    const boardName =
      releaseBoardSeed.boards.find((board) => board.id === this.board)?.name ??
      this.board;
    part(root, '.no-access-scope').textContent = `board:${this.board}`;
    part(root, '.no-access-person').textContent = this.spec.person;
    part(root, '.no-access-board').textContent = boardName;
    const input = part<HTMLInputElement>(root, 'form.add input');
    input.placeholder = `New card in ${boardName} backlog`;
    input.disabled = !this.ready || !access;
    part<HTMLButtonElement>(root, 'form.add button').disabled =
      !this.ready || !access;
    for (const node of root.querySelectorAll('.url-board'))
      node.textContent = this.board;

    this.#renderKanban();
    this.#renderConflictBar();
    this.#renderOutbox();
    this.#renderSheet();
  }

  #renderKanban(): void {
    const pendingRows = new Set(
      this.pending.flatMap((commit) =>
        commit.operations.map((operation) => operation.rowId),
      ),
    );
    const conflicted = new Set(
      this.conflicts.map((conflict) => conflict.rowId),
    );
    const seen = new Set<string>();
    for (const column of BOARD_COLUMNS) {
      const section = part<HTMLElement>(
        this.root,
        `.kcol[data-column="${column}"]`,
      );
      const list = part<HTMLOListElement>(section, '.kcards');
      const cards = this.cards.filter(
        (card) => card.boardId === this.board && card.columnId === column,
      );
      part(section, '.kcol-count').textContent =
        `${cards.length} · ${cards.reduce((sum, card) => sum + card.estimate, 0)} pts`;
      const next = cards.map((card) => {
        seen.add(card.id);
        const queued = pendingRows.has(card.id);
        const conflict = conflicted.has(card.id);
        const sig = JSON.stringify([card, queued, conflict]);
        const previous = this.#cardNodes.get(card.id);
        if (previous !== undefined && previous.sig === sig)
          return previous.node;
        const remote = this.#rendered && !this.#touched.has(card.id);
        const node = this.#buildCard(card, queued, conflict, remote);
        this.#cardNodes.set(card.id, { sig, node });
        return node;
      });
      next.forEach((node, index) => {
        const current = list.children[index];
        if (current !== node) list.insertBefore(node, current ?? null);
      });
      while (list.children.length > next.length)
        list.lastElementChild?.remove();
    }
    for (const id of [...this.#cardNodes.keys()]) {
      if (!seen.has(id)) this.#cardNodes.delete(id);
    }
    this.#touched.clear();
    if (this.ready) this.#rendered = true;
  }

  #buildCard(
    card: CardView,
    queued: boolean,
    conflict: boolean,
    remote: boolean,
  ): HTMLLIElement {
    const li = el('li', 'kcard');
    li.dataset.id = card.id;
    li.tabIndex = 0;
    li.classList.toggle('queued', queued);
    li.classList.toggle('conflicted', conflict);
    if (remote) li.classList.add('fresh');
    li.setAttribute(
      'aria-label',
      `${card.title}. ${card.assigneeName ?? 'Unassigned'}, ${card.estimate} points${conflict ? ', in conflict' : queued ? ', queued' : ''}. Press Enter to open.`,
    );
    if (card.labels.length > 0) {
      const labels = el('div', 'kc-labels');
      for (const label of card.labels) {
        const chip = el('span', 'kc-label', label.name);
        chip.style.setProperty('--c', label.color);
        labels.append(chip);
      }
      li.append(labels);
    }
    li.append(el('p', 'kc-title', card.title));
    const foot = el('div', 'kc-foot');
    foot.append(el('span', 'kc-est', `${card.estimate} pts`));
    foot.append(
      conflict
        ? el('span', 'kc-state kc-conflict', 'conflict')
        : queued
          ? el('span', 'kc-state kc-queued', 'queued')
          : el(
              'span',
              'kc-state',
              card.syncVersion >= 1 ? `v${card.syncVersion}` : 'local',
            ),
    );
    if (card.commentCount > 0) {
      const comments = el('span', 'kc-comments');
      comments.innerHTML =
        '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 2h9v6h-5l-2.5 2V8h-1.5z" fill="none" stroke="currentColor"/></svg>';
      comments.append(String(card.commentCount));
      comments.title = `${card.commentCount} comment${card.commentCount === 1 ? '' : 's'}`;
      foot.append(comments);
    }
    const avatar = el(
      'span',
      'kc-avatar',
      card.assigneeName?.slice(0, 1) ?? '·',
    );
    avatar.title = card.assigneeName ?? 'Unassigned';
    if (card.assigneeColor !== null)
      avatar.style.setProperty('--c', card.assigneeColor);
    foot.append(avatar);
    li.append(foot);

    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.#openSheet(card.id, li);
      }
    });
    li.addEventListener('pointerdown', (event) =>
      this.#startDrag(event, card.id, li),
    );
    return li;
  }

  /**
   * Mouse and pen drag: a ghost follows the pointer, a marker shows the
   * drop slot, and the drop runs {@link moveCard}. A press without movement
   * opens the card; touch opens the card, whose column buttons move it.
   */
  #startDrag(event: PointerEvent, cardId: string, node: HTMLLIElement): void {
    if (event.button !== 0) return;
    if (event.pointerType === 'touch') {
      node.addEventListener('pointerup', () => this.#openSheet(cardId, node), {
        once: true,
      });
      return;
    }
    // Keep the press from starting a text selection; focus stays on the card.
    event.preventDefault();
    node.focus();
    const startX = event.clientX;
    const startY = event.clientY;
    let ghost: HTMLElement | undefined;
    let target: { column: string; index: number } | undefined;
    const marker = el('li', 'drop-marker');
    marker.setAttribute('aria-hidden', 'true');
    node.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      if (ghost === undefined) {
        if (
          Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5
        )
          return;
        const rect = node.getBoundingClientRect();
        ghost = node.cloneNode(true) as HTMLElement;
        ghost.classList.add('ghost');
        ghost.style.width = `${rect.width}px`;
        document.body.append(ghost);
        node.classList.add('dragging');
      }
      ghost.style.transform = `translate(${moveEvent.clientX - 20}px, ${moveEvent.clientY - 16}px) rotate(2deg)`;
      const under = document
        .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest<HTMLElement>('.kcol');
      if (under === null || under === undefined || !this.root.contains(under)) {
        marker.remove();
        target = undefined;
        return;
      }
      const list = part<HTMLOListElement>(under, '.kcards');
      const others = [
        ...list.querySelectorAll<HTMLLIElement>('.kcard:not(.dragging)'),
      ];
      const index = others.findIndex((other) => {
        const rect = other.getBoundingClientRect();
        return moveEvent.clientY < rect.top + rect.height / 2;
      });
      const slot = index === -1 ? others.length : index;
      target = { column: under.dataset.column ?? 'backlog', index: slot };
      list.insertBefore(marker, others[slot] ?? null);
    };
    const end = () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', end);
      marker.remove();
      node.classList.remove('dragging');
      if (ghost === undefined) {
        this.#openSheet(cardId, node);
        return;
      }
      ghost.remove();
      if (target !== undefined)
        void this.moveCard(cardId, target.column, target.index);
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  }

  #openSheet(cardId: string, from: HTMLElement): void {
    this.#openCard = cardId;
    this.#sheetReturn = from;
    this.#renderSheet(true);
  }

  #closeSheet(): void {
    this.#openCard = undefined;
    this.#renderSheet();
    if (this.#sheetReturn?.isConnected === true) this.#sheetReturn.focus();
  }

  /** The card sheet: rebuilt when opened, refreshed in place afterwards. */
  #renderSheet(opening = false): void {
    const sheet = part<HTMLElement>(this.root, '.sheet');
    const card =
      this.#openCard === undefined ? undefined : this.card(this.#openCard);
    if (card === undefined) {
      sheet.hidden = true;
      this.#openCard = undefined;
      return;
    }
    const conflict = this.conflicts.find((record) => record.rowId === card.id);
    if (!opening && !sheet.hidden) {
      // Keep the open form (the visitor may be typing); refresh what the
      // engine owns: version, column buttons, and the conflict section.
      part(sheet, '.sheet-version').textContent = this.#versionText(card);
      for (const button of sheet.querySelectorAll<HTMLButtonElement>(
        '[data-move]',
      )) {
        button.setAttribute(
          'aria-pressed',
          String(button.dataset.move === card.columnId),
        );
      }
      const box = part<HTMLElement>(sheet, '.sheet-conflict');
      const hadFocus = box.contains(document.activeElement);
      box.replaceChildren(...this.#conflictBody(conflict));
      if (hadFocus) {
        part<HTMLButtonElement>(sheet, '.sheet-head .icon-btn').focus();
      }
      return;
    }
    sheet.hidden = false;
    const panel = el('div', 'sheet-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', `${this.id}-sheet-title`);

    const head = el('header', 'sheet-head');
    const heading = el('h4', undefined, 'Card');
    heading.id = `${this.id}-sheet-title`;
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close card');
    close.addEventListener('click', () => this.#closeSheet());
    head.append(
      heading,
      el('span', 'sheet-version', this.#versionText(card)),
      close,
    );

    const form = el('form', 'sheet-form');
    const titleLabel = el('label', 'field');
    const titleInput = el('input');
    titleInput.value = card.title;
    titleInput.maxLength = 90;
    titleLabel.append(el('span', undefined, 'Title'), titleInput);

    const moves = el('div', 'field');
    moves.append(el('span', undefined, 'Column'));
    const moveRow = el('div', 'seg');
    moveRow.setAttribute('role', 'group');
    moveRow.setAttribute('aria-label', 'Move to column');
    for (const column of BOARD_COLUMNS) {
      const button = el('button', undefined, COLUMN_LABEL[column]);
      button.type = 'button';
      button.dataset.move = column;
      button.setAttribute('aria-pressed', String(column === card.columnId));
      button.addEventListener('click', () => {
        const current = this.card(card.id);
        if (current === undefined || current.columnId === column) return;
        void this.moveCard(card.id, column, Number.MAX_SAFE_INTEGER);
      });
      moveRow.append(button);
    }
    moves.append(moveRow);

    const assigneeLabel = el('label', 'field');
    const assignee = el('select');
    const none = el('option', undefined, 'Unassigned');
    none.value = '';
    assignee.append(none);
    for (const member of this.members.filter(
      (candidate) => candidate.boardId === card.boardId,
    )) {
      const option = el('option', undefined, `${member.name} · ${member.role}`);
      option.value = member.id;
      option.selected = member.id === card.assigneeId;
      assignee.append(option);
    }
    assigneeLabel.append(el('span', undefined, 'Assignee'), assignee);

    const estimateLabel = el('label', 'field');
    const estimate = el('select');
    for (const points of ESTIMATES) {
      const option = el('option', undefined, `${points} pts`);
      option.value = String(points);
      option.selected = points === card.estimate;
      estimate.append(option);
    }
    estimateLabel.append(el('span', undefined, 'Estimate'), estimate);

    const pair = el('div', 'field-pair');
    pair.append(assigneeLabel, estimateLabel);
    const save = el('button', 'btn btn-amber', 'Save');
    save.type = 'submit';
    form.append(titleLabel, moves, pair, save);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const current = this.card(card.id) ?? card;
      const title = titleInput.value.trim();
      const assigneeId = assignee.value === '' ? null : assignee.value;
      const points = Number(estimate.value);
      void this.editCard(current, {
        ...(title.length > 0 && title !== current.title ? { title } : {}),
        ...(assigneeId !== current.assigneeId ? { assigneeId } : {}),
        ...(points !== current.estimate ? { estimate: points } : {}),
      }).then(() => this.#closeSheet());
    });

    const conflictBox = el('div', 'sheet-conflict');
    conflictBox.append(...this.#conflictBody(conflict));
    const comments = el('div', 'sheet-comments');
    panel.append(head, conflictBox, form, comments);
    sheet.replaceChildren(panel);
    void this.#loadComments(card.id, comments);
    titleInput.focus();
  }

  #versionText(card: CardView): string {
    return card.syncVersion >= 1
      ? `${card.id} · v${card.syncVersion}`
      : `${card.id} · local`;
  }

  #conflictBody(conflict: ConflictRecord | undefined): HTMLElement[] {
    if (conflict === undefined) return [];
    const head = el('p', 'conflict-head');
    head.append(el('strong', undefined, 'Conflict'), ` ${conflict.code}`);
    const rows = el('dl', 'conflict-rows');
    const mine = conflict.operation?.values ?? {};
    const show = (column: string, value: unknown) =>
      column === 'column_id'
        ? (COLUMN_LABEL[String(value)] ?? String(value))
        : String(value ?? '');
    for (const column of conflict.conflictColumns) {
      rows.append(
        el('dt', undefined, `Your write · ${column}`),
        el('dd', 'mine', show(column, mine[column])),
        el(
          'dt',
          undefined,
          `Server row v${conflict.serverVersion} · ${column}`,
        ),
        el('dd', 'theirs', show(column, conflict.serverRow[column])),
      );
    }
    const actions = el('div', 'conflict-actions');
    const keepServer = el('button', 'btn', 'Keep server');
    keepServer.type = 'button';
    keepServer.addEventListener('click', () => {
      void this.keepServer(conflict);
    });
    const keepMine = el('button', 'btn btn-ghost', 'Keep mine');
    keepMine.type = 'button';
    keepMine.addEventListener('click', () => {
      void this.keepMine(conflict);
    });
    actions.append(keepServer, keepMine);
    const box = el('section', 'conflict');
    box.append(head, rows, actions);
    return [box];
  }

  async #loadComments(cardId: string, host: HTMLElement): Promise<void> {
    const rows = await this.core.query(
      `SELECT m.name AS author, m.color, k.body
       FROM comments k JOIN members m ON m.id = k.author_id
       WHERE k.card_id = ? ORDER BY k.created_at_ms`,
      [cardId],
    );
    const comments: CommentView[] = rows.map((row) => ({
      author: text(row.author),
      color: text(row.color),
      body: text(row.body),
    }));
    host.replaceChildren(
      el('h5', undefined, `Comments · ${comments.length}`),
      ...comments.map((comment) => {
        const item = el('p', 'comment');
        const who = el('strong', undefined, comment.author);
        who.style.setProperty('--c', comment.color);
        item.append(who, ` ${comment.body}`);
        return item;
      }),
    );
  }

  #renderConflictBar(): void {
    const bar = part<HTMLElement>(this.root, '.conflict-bar');
    bar.replaceChildren(
      ...this.conflicts.map((conflict) => {
        const card = this.card(conflict.rowId);
        const button = el('button', 'conflict-pill');
        button.type = 'button';
        button.append(
          el('strong', undefined, 'Conflict'),
          ` on “${card?.title ?? conflict.rowId}”. Open to resolve.`,
        );
        button.addEventListener('click', () => {
          if (card !== undefined && card.boardId !== this.board) {
            this.board = card.boardId;
            this.render();
          }
          this.#openSheet(conflict.rowId, button);
        });
        return button;
      }),
    );
  }

  #renderOutbox(): void {
    const lines = outboxLines(this.pending, (id) => this.#host.intentOf(id));
    part(this.root, '.ob-state').textContent =
      lines.length === 0
        ? 'empty · in sync'
        : this.online
          ? 'pushing'
          : 'held until online';
    part<HTMLOListElement>(this.root, '.ob-list').replaceChildren(
      ...lines.map((line) => {
        const item = el('li');
        item.append(
          el('span', 'ob-kind', line.kind),
          el('span', 'ob-title', line.title),
        );
        if (line.boardId !== undefined)
          item.append(el('span', 'ob-scope', `board:${line.boardId}`));
        return item;
      }),
    );
  }
}
