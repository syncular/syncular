/**
 * The sync lab: a team lead's laptop and a mobile engineer's phone, EACH
 * with its own client core and SQLite database, editing one Release board
 * through a server whose commit log sits between them. Plain TypeScript and
 * vanilla DOM; the client cores live in `cores.ts`, the board app in
 * `device.ts`, and the state model in `lab.ts`.
 *
 * Everything the lab shows comes from the engine: the commit log and the
 * packets on the wires fold server events (`push.*`, `realtime.delta`,
 * `pull.served`), each device renders its own SQLite rows, outbox,
 * subscriptions, and conflict records, and the tour completes from the
 * same data.
 */
import { ClientSyncError } from '@syncular/client';
import type { SyncularServerEvent } from '@syncular/server';
import { PEOPLE } from '../seed';
import {
  EMBEDDED,
  EPHEMERAL,
  getEmbeddedServer,
  latency,
  MULTITAB,
} from './cores';
import {
  COLUMN_LABEL,
  Device,
  type DeviceHost,
  el,
  errorText,
  part,
  SQL_EXAMPLES,
} from './device';
import {
  advanceTour,
  applyServerEvent,
  currentStep,
  type DeviceId,
  EMPTY_LOG,
  type LogEntry,
  type LogState,
  resetTour,
  TOUR_STEPS,
  type TourState,
  type Transit,
  type WriteIntent,
} from './lab';

const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');

function pause(ms: number): Promise<void> {
  return new Promise((resolve) =>
    window.setTimeout(resolve, REDUCED_MOTION.matches ? 0 : ms),
  );
}

function person(id: string): (typeof PEOPLE)[number] {
  const found = PEOPLE.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`unknown person ${id}`);
  return found;
}

class Lab implements DeviceHost {
  readonly devices: Device[] = [];
  /** True while a script narrates its own steps. */
  scripted = false;
  readonly #intents = new Map<string, WriteIntent>();
  #log: LogState = EMPTY_LOG;
  #tour: TourState = resetTour(EMPTY_LOG);
  #renderedArrivals = 0;
  #renderQueued = false;

  recordIntent(clientCommitId: string, intent: WriteIntent): void {
    this.#intents.set(clientCommitId, intent);
    this.#scheduleRender();
  }

  intentOf(clientCommitId: string): WriteIntent | undefined {
    return this.#intents.get(clientCommitId);
  }

  device(id: DeviceId): Device {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (device === undefined) throw new Error(`unknown device ${id}`);
    return device;
  }

  deviceChanged(): void {
    this.#scheduleRender();
  }

  serverEvent(event: SyncularServerEvent): void {
    const result = applyServerEvent(
      this.#log,
      event,
      (clientId) =>
        this.devices.find(
          (device) => device.ready && device.core.clientId === clientId,
        )?.id,
    );
    if (!this.scripted) this.#narrateEvent(event, result.state);
    this.#log = result.state;
    for (const transit of result.transits) {
      this.#animate(transit);
      this.device(transit.device).refreshSoon();
    }
    this.#scheduleRender();
  }

  resetTour(): void {
    this.#tour = resetTour(this.#log);
    this.#scheduleRender();
  }

  narrate(text: string): void {
    part(document, '#narration').textContent = text;
  }

  #narrateEvent(event: SyncularServerEvent, log: LogState): void {
    if (
      event.type !== 'push.applied' &&
      event.type !== 'push.conflicted' &&
      event.type !== 'push.rejected'
    ) {
      return;
    }
    const entry = log.entries.find(
      (candidate) => candidate.clientCommitId === event.clientCommitId,
    );
    if (
      entry === undefined ||
      (entry.origin !== 'laptop' && entry.origin !== 'phone')
    ) {
      return;
    }
    const from = this.device(entry.origin).label.toLowerCase();
    this.narrate(
      entry.status === 'applied'
        ? `The server appended c${entry.commitSeq} from the ${from} and forwarded it to every device that syncs its board.`
        : entry.status === 'conflict'
          ? `The server refused a stale write from the ${from} and returned its current row.`
          : `The server rejected a write from the ${from}: ${entry.code ?? 'rejected'}.`,
    );
  }

  #scheduleRender(): void {
    if (this.#renderQueued) return;
    this.#renderQueued = true;
    queueMicrotask(() => {
      this.#renderQueued = false;
      this.#render();
    });
  }

  #render(): void {
    const phone = this.device('phone');
    this.#tour = advanceTour(this.#tour, {
      log: this.#log,
      intentOf: (id) => this.intentOf(id),
      phone: {
        online: phone.online,
        pending: phone.pending.length,
        sqlRuns: phone.sqlRuns,
      },
      openConflicts: this.devices.reduce(
        (sum, device) => sum + device.conflicts.length,
        0,
      ),
    });
    this.#renderTour();
    this.#renderLog();
    const granted = phone.subscribed.has('web');
    const grant = part<HTMLButtonElement>(document, '#grant-btn');
    grant.textContent = granted ? 'Revoke Web' : 'Grant Web';
    grant.setAttribute(
      'aria-label',
      granted ? 'Revoke the Web board from Ben' : 'Grant Ben the Web board',
    );
    grant.setAttribute('aria-pressed', String(granted));
  }

  #renderTour(): void {
    const current = currentStep(this.#tour);
    document.body.dataset.tour = current ?? 'done';
    let done = 0;
    for (const step of TOUR_STEPS) {
      const node = part<HTMLElement>(document, `.step[data-step="${step}"]`);
      const state = this.#tour.done[step]
        ? 'done'
        : step === current
          ? 'current'
          : 'open';
      if (state === 'done') done += 1;
      node.dataset.state = state;
      part(node, '.step-state').textContent =
        state === 'done' ? 'Done' : state === 'current' ? 'Next' : 'Open';
    }
    part(document, '#tour-count').textContent = `${done}/${TOUR_STEPS.length}`;
    const hint = part(document, '#tour-hint');
    if (current === undefined) {
      hint.textContent =
        'Tour complete. Every step finished from real engine events; Reset starts it over.';
    } else {
      const step = part(document, `.step[data-step="${current}"]`);
      const label = el(
        'b',
        undefined,
        `STEP ${TOUR_STEPS.indexOf(current) + 1}`,
      );
      hint.replaceChildren(label, part(step, 'p').textContent ?? '');
    }
  }

  #renderLog(): void {
    const entries = this.#log.entries;
    const head = entries.find((entry) => entry.commitSeq !== undefined);
    part(document, '#server-head').textContent =
      head?.commitSeq !== undefined ? `head c${head.commitSeq}` : 'empty log';
    part<HTMLOListElement>(document, '#log').replaceChildren(
      ...entries.map((entry) => this.#renderEntry(entry)),
    );
    this.#renderedArrivals = this.#log.arrivals;
  }

  #renderEntry(entry: LogEntry): HTMLLIElement {
    const intent = this.intentOf(entry.clientCommitId);
    const li = el('li', `entry st-${entry.status}`);
    if (entry.arrival > this.#renderedArrivals) li.classList.add('fresh');
    li.append(
      el(
        'span',
        'seq',
        entry.commitSeq !== undefined ? `c${entry.commitSeq}` : 'no seq',
      ),
      el(
        'span',
        `who who-${entry.origin}`,
        entry.origin === 'laptop' || entry.origin === 'phone'
          ? this.device(entry.origin).label
          : entry.origin,
      ),
      el(
        'span',
        'what',
        intent !== undefined
          ? `${intent.kind} “${intent.title}”`
          : entry.origin === 'seed'
            ? `seed · ${entry.operations} rows`
            : `${entry.operations} op${entry.operations === 1 ? '' : 's'}`,
      ),
      el('span', 'status', entry.status),
      el('span', 'route', this.#route(entry, intent)),
    );
    return li;
  }

  /** Where the commit went: scope, receivers, and held deliveries. */
  #route(entry: LogEntry, intent: WriteIntent | undefined): string {
    const replay = entry.replay ? ' · idempotent replay' : '';
    if (entry.status === 'conflict') {
      return `server row kept · conflict record returned${replay}`;
    }
    if (entry.status === 'rejected') {
      return `${entry.code ?? 'rejected'}${replay}`;
    }
    if (entry.origin === 'seed') {
      return 'board:web, board:mobile · server operator';
    }
    if (intent === undefined) return `${entry.operations} rows${replay}`;
    const routes = this.devices
      .filter((device) => device.id !== entry.origin)
      .map((device) =>
        entry.deliveredTo.includes(device.id)
          ? `→ ${device.label}`
          : !device.subscribed.has(intent.boardId)
            ? `${device.label} has no access`
            : !device.online
              ? `held for ${device.label} (offline)`
              : `→ ${device.label} …`,
      );
    return [`board:${intent.boardId}`, ...routes].join(' · ') + replay;
  }

  #animate(transit: Transit): void {
    const wire = part<HTMLElement>(
      document,
      `.wire[data-device="${transit.device}"]`,
    );
    const packet = el(
      'span',
      `pkt ${transit.direction} tone-${transit.tone}`,
      transit.label,
    );
    packet.setAttribute('aria-hidden', 'true');
    // Packets in flight together stack instead of covering each other.
    packet.style.setProperty('--lane', String(wire.childElementCount % 4));
    packet.addEventListener('animationend', () => packet.remove());
    wire.append(packet);
  }
}

// -- scripted scenarios -----------------------------------------------------------

async function scripted(lab: Lab, run: () => Promise<void>): Promise<void> {
  lab.scripted = true;
  try {
    await run();
  } finally {
    lab.scripted = false;
  }
}

/**
 * The §6.2 base-version race on one Mobile card: both devices go offline
 * and move it to different columns, the phone reconnects first and its
 * move applies, then the laptop replays its move against a stale version.
 * The server answers with a conflict record and its current row.
 */
async function simulateConflict(lab: Lab): Promise<void> {
  const laptop = lab.device('laptop');
  const phone = lab.device('phone');
  laptop.board = 'mobile';
  phone.board = 'mobile';
  laptop.view = 'board';
  phone.view = 'board';
  await phone.setOnline(true);
  await laptop.setOnline(true);
  await Promise.all([laptop.syncNow(), phone.syncNow()]);
  const target = laptop.cards.find(
    (card) =>
      card.boardId === 'mobile' &&
      card.columnId !== 'done' &&
      card.columnId !== 'review' &&
      card.syncVersion >= 1 &&
      (phone.card(card.id)?.syncVersion ?? 0) === card.syncVersion,
  );
  if (target === undefined) {
    lab.narrate(
      'No Mobile card is in the same version on both devices yet. Wait for the log to settle and press again.',
    );
    return;
  }
  lab.narrate(
    `1/4 · Both devices go offline. Each holds “${target.title}” at v${target.syncVersion}.`,
  );
  await Promise.all([laptop.setOnline(false), phone.setOnline(false)]);
  await pause(1000);
  lab.narrate(
    `2/4 · Offline, the laptop moves it to ${COLUMN_LABEL.review} and the phone moves it to ${COLUMN_LABEL.done}. Both writes wait in the outboxes.`,
  );
  await laptop.moveCard(target.id, 'review', 0);
  await phone.moveCard(target.id, 'done', 0);
  await pause(1400);
  lab.narrate(
    '3/4 · The phone reconnects first. Its move applies and the card version advances.',
  );
  await phone.setOnline(true);
  await pause(1400);
  lab.narrate(
    '4/4 · The laptop reconnects and replays its move against the old version.',
  );
  await laptop.setOnline(true);
  lab.narrate(
    'The server returned a conflict with its row. Open the card on the laptop and keep one side.',
  );
}

/**
 * Grant or revoke Ben's membership of the Web board. The laptop (Ada, the
 * lead) writes the `members` row; the server's `resolveScopes` reads
 * memberships, so the next round of the phone either bootstraps the board
 * (after a fresh subscription) or finds its Web subscriptions revoked and
 * purges every Web row (SPEC §3.3).
 */
async function toggleWebAccess(lab: Lab): Promise<void> {
  const laptop = lab.device('laptop');
  const phone = lab.device('phone');
  if (!laptop.online) {
    lab.narrate(
      'Ada changes memberships from the laptop. Bring the laptop online first.',
    );
    return;
  }
  const ben = person('ben');
  const countWeb = async () =>
    Number(
      (
        await phone.core.query(
          "SELECT COUNT(*) AS n FROM cards WHERE board_id = 'web'",
        )
      )[0]?.n ?? 0,
    );
  const before = await countWeb();
  const granting = !phone.subscribed.has('web');
  if (granting) {
    lab.narrate(
      'Ada adds Ben to the Web board: one members row, written on the laptop.',
    );
    await laptop.write(
      [
        {
          table: 'members',
          op: 'upsert',
          values: {
            id: 'm-web-ben',
            boardId: 'web',
            userId: ben.id,
            name: ben.name,
            color: ben.color,
            role: 'engineer',
          },
        },
      ],
      { kind: 'grant', title: ben.name, boardId: 'web' },
      [],
    );
    await laptop.syncNow();
    await phone.subscribeBoard('web');
  } else {
    lab.narrate(
      'Ada removes Ben from the Web board: the laptop deletes his members row.',
    );
    await laptop.write(
      [{ table: 'members', op: 'delete', rowId: 'm-web-ben' }],
      { kind: 'revoke', title: ben.name, boardId: 'web' },
      [],
    );
    await laptop.syncNow();
  }
  if (!phone.online) {
    lab.narrate(
      `The membership change is in the log. The phone is offline and ${granting ? 'bootstraps' : 'purges'} board:web on its next round after reconnecting.`,
    );
    return;
  }
  await phone.syncNow();
  const after = await countWeb();
  phone.board = 'web';
  phone.openSql(SQL_EXAMPLES[0]?.sql);
  lab.narrate(
    granting
      ? `The phone subscribed to board:web and bootstrapped ${after} cards into its SQLite. Its Local SQL lens shows them.`
      : `The server revoked the phone's board:web subscriptions, and the phone purged ${before - after} cards with their labels and comments. Its Local SQL lens shows only board:mobile.`,
  );
}

// -- boot ------------------------------------------------------------------------

function followServerEvents(lab: Lab): void {
  if (EMBEDDED) {
    void getEmbeddedServer().then((server) =>
      server.events((event) => lab.serverEvent(event)),
    );
    return;
  }
  const source = new EventSource('events');
  source.onmessage = (message: MessageEvent<string>) => {
    lab.serverEvent(JSON.parse(message.data) as SyncularServerEvent);
  };
}

function wireConsole(): void {
  const button = part<HTMLButtonElement>(document, '#console-btn');
  if (!EMBEDDED) return;
  button.hidden = false;
  const dialog = part<HTMLDialogElement>(document, '#admin-console-dialog');
  const frame = part<HTMLIFrameElement>(document, '#admin-console-frame');
  window.addEventListener('message', (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== frame.contentWindow
    ) {
      return;
    }
    const message = event.data as {
      readonly kind?: unknown;
      readonly id?: unknown;
      readonly path?: unknown;
    };
    if (
      message.kind !== 'syncular-admin-request' ||
      typeof message.id !== 'number' ||
      typeof message.path !== 'string'
    ) {
      return;
    }
    const requestId = message.id;
    const path = message.path;
    void (async () => {
      try {
        const response = await (await getEmbeddedServer()).admin(path);
        frame.contentWindow?.postMessage(
          {
            kind: 'syncular-admin-response',
            id: requestId,
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            body: response.body,
          },
          location.origin,
        );
      } catch (error) {
        frame.contentWindow?.postMessage(
          {
            kind: 'syncular-admin-response',
            id: requestId,
            ok: false,
            status: 500,
            body: {
              code:
                error instanceof ClientSyncError ? error.code : 'sync.internal',
            },
          },
          location.origin,
        );
      }
    })();
  });
  button.addEventListener('click', () => {
    if (frame.getAttribute('src') === null) {
      frame.src = 'admin.html?transport=parent';
    }
    dialog.showModal();
  });
  part(document, '#console-close').addEventListener('click', () => {
    dialog.close();
  });
}

function wireLatency(): void {
  const field = part<HTMLElement>(document, '#latency-field');
  if (!EMBEDDED) return;
  field.hidden = false;
  const input = part<HTMLInputElement>(field, 'input');
  const output = part<HTMLOutputElement>(field, 'output');
  const stage = part<HTMLElement>(document, '#stage');
  const apply = () => {
    latency.ms = Number(input.value);
    output.value = `${latency.ms} ms`;
    // Packets cross each wire in half the round trip, never faster than
    // the base animation.
    stage.style.setProperty('--hop', `${Math.max(480, latency.ms / 2)}ms`);
  };
  input.addEventListener('input', apply);
  apply();
}

async function main(): Promise<void> {
  part(document, '#mode').textContent = EMBEDDED
    ? 'The server runs in a Web Worker in this page. Nothing leaves the browser, and a reload starts over.'
    : EPHEMERAL
      ? 'Ephemeral mode: in-memory cores on the main thread. A reload starts over.'
      : MULTITAB
        ? 'Multi-tab mode: open a second tab to see a follower proxy to this leader.'
        : 'Persistent mode: each core keeps its SQLite database in OPFS across reloads.';
  part(document, '#server-mode').textContent = EMBEDDED
    ? 'Web Worker in this page'
    : 'Bun · server-hono';

  const menu = part<HTMLButtonElement>(document, '#menu-btn');
  menu.addEventListener('click', () => {
    menu.setAttribute(
      'aria-expanded',
      String(menu.getAttribute('aria-expanded') !== 'true'),
    );
  });

  const lab = new Lab();
  const ada = person('ada');
  const ben = person('ben');
  lab.devices.push(
    new Device(
      {
        id: 'laptop',
        label: 'Laptop',
        actor: ada.id,
        person: ada.name,
        role: 'team lead',
        color: ada.color,
        boards: ['mobile', 'web'],
      },
      part(document, '.device[data-device="laptop"]'),
      lab,
    ),
    new Device(
      {
        id: 'phone',
        label: 'Phone',
        actor: ben.id,
        person: ben.name,
        role: 'mobile engineer',
        color: ben.color,
        boards: ['mobile'],
      },
      part(document, '.device[data-device="phone"]'),
      lab,
    ),
  );
  for (const device of lab.devices) device.render();
  wireConsole();
  wireLatency();

  const actions = [
    [part<HTMLButtonElement>(document, '#conflict-btn'), simulateConflict],
    [part<HTMLButtonElement>(document, '#grant-btn'), toggleWebAccess],
  ] as const;
  for (const [button, run] of actions) {
    button.addEventListener('click', () => {
      for (const [other] of actions) other.disabled = true;
      void scripted(lab, () => run(lab))
        .catch((error: unknown) =>
          lab.narrate(`The scenario failed: ${errorText(error)}`),
        )
        .finally(() => {
          for (const [other] of actions) other.disabled = false;
        });
    });
  }
  part(document, '#tour-reset').addEventListener('click', () =>
    lab.resetTour(),
  );

  await Promise.all(lab.devices.map((device) => device.init()));
  followServerEvents(lab);
  for (const [button] of actions) button.disabled = false;
  lab.narrate(
    'Both devices are synced. Drag a card to another column on either one.',
  );
}

void main().catch((error: unknown) => console.error(error));
