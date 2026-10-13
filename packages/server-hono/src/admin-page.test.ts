/**
 * DOM-level tests for the static console page: the page string runs in a
 * scoped happy-dom Window (no global registration), `fetch` and
 * `EventSource` are scoped test doubles on that window, and every assertion
 * follows a chained-microtask flush instead of a timer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { ADMIN_CONSOLE_HTML } from './admin-page';

interface Answer {
  readonly status?: number;
  readonly body: unknown;
}
type Route = Answer | ((url: URL) => Answer);

const NOW = Date.now();
const HEAD = 120;
const LONG_ID = 'c-old-tablet-0f3c9a7e-2b11-4c55-9a8d-61f0e2b7c4d1';

function clientRow(
  clientId: string,
  actorId: string,
  lag: number,
  connected: boolean,
  schemaVersion: number,
) {
  return {
    clientId,
    actorId,
    wireVersion: 3,
    schemaVersion,
    cursor: HEAD - lag,
    lag,
    updatedAtMs: NOW - (connected ? 4_000 : 25_200_000),
    subscriptions: [
      { id: 's1', table: 'cards', scopes: { board_id: ['web', 'mobile'] } },
    ],
    active: true,
    connected,
    ...(connected ? { connectedSinceMs: NOW - 60_000 } : {}),
  };
}

const CLIENTS = [
  clientRow('c-ada', 'ada', 0, true, 3),
  clientRow('c-ben', 'ben', 37, false, 3),
  clientRow(LONG_ID, 'ben', 1500, false, 2),
];

function requestEvents(
  requestId: string,
  atMs: number,
  pushed: number,
  pulled: number,
) {
  return [
    {
      type: 'pull.served',
      requestId,
      atMs,
      partition: 'demo',
      actorId: 'ada',
      clientId: 'c-ada',
      acceptedThrough: HEAD,
      storageMaxCommitSeq: HEAD,
      subscriptions: [
        {
          id: 's1',
          table: 'cards',
          status: 'active',
          mode: 'incremental',
          requestedScopes: {},
          effectiveScopes: {},
          fromCursor: HEAD - 1,
          nextCursor: HEAD,
          commits: pulled,
          changes: pulled,
          segments: [],
        },
      ],
    },
    {
      type: 'request.handled',
      kind: 'sync',
      requestId,
      atMs: atMs + 1,
      partition: 'demo',
      actorId: 'ada',
      clientId: 'c-ada',
      durationMs: 12,
      bytesIn: 220,
      bytesOut: 1400,
      outcome: 'ok',
      pushCommits: pushed,
      pulled: true,
      subscriptions: 1,
    },
  ];
}

const CONFLICT = {
  type: 'push.conflicted',
  requestId: 'req-c',
  atMs: NOW - 20_000,
  partition: 'demo',
  actorId: 'ben',
  clientId: 'c-ben',
  clientCommitId: 'cc-7',
  operations: 1,
  opIndex: 0,
  table: 'cards',
  rowId: 'r1',
  replay: false,
};

// Newest first, as the ring answers.
const RING_EVENTS = [
  ...requestEvents('req-idle-1', NOW - 3_000, 0, 0).reverse(),
  ...requestEvents('req-idle-2', NOW - 6_000, 0, 0).reverse(),
  ...requestEvents('req-work', NOW - 9_000, 1, 2).reverse(),
  CONFLICT,
  {
    type: 'realtime.opened',
    atMs: NOW - 30_000,
    partition: 'demo',
    actorId: 'ada',
    clientId: 'c-ada',
    sessionId: 'rt-1',
    registrations: 1,
    cursor: HEAD,
    latestSeq: HEAD,
  },
];

const BUCKETS = 30;
const zeros = () => new Array<number>(BUCKETS).fill(0);
const COUNTS = zeros();
const ERRORS = zeros();
const P95 = new Array<number | null>(BUCKETS).fill(null);
const PUSHES = Array.from({ length: BUCKETS }, () => ({
  applied: 0,
  conflicted: 0,
  rejected: 0,
}));
COUNTS[29] = 2;
P95[29] = 12;
COUNTS[25] = 1;
ERRORS[25] = 1;
P95[25] = 80;
PUSHES[27] = { applied: 6, conflicted: 1, rejected: 0 };

function metrics(coverage: { complete: boolean; fromMs: number }) {
  return {
    metrics: {
      partition: 'demo',
      windowMs: 300_000,
      atMs: NOW,
      coverage,
      requests: {
        count: 4,
        perMinute: 0.8,
        errorCount: 1,
        errorRate: 0.25,
        p50Ms: 21,
        p95Ms: 80,
      },
      pushes: { applied: 6, rejected: 0, conflicted: 1 },
      buckets: {
        widthMs: 10_000,
        counts: COUNTS,
        errors: ERRORS,
        p95Ms: P95,
        pushes: PUSHES,
      },
    },
  };
}

const COLUMNS = [
  { name: 'id', type: 'string', nullable: false, primaryKey: true },
  { name: 'title', type: 'string', nullable: false, primaryKey: false },
  { name: 'cover', type: 'bytes', nullable: true, primaryKey: false },
];
const INFO = {
  hasEventStream: true,
  writes: false,
  realtime: true,
  schemaVersion: 3,
  tables: [{ name: 'cards', columns: COLUMNS }],
};

const HORIZON = {
  partition: 'demo',
  maxCommitSeq: HEAD,
  horizonSeq: 20,
  retainedCommits: 100,
  activeCursorFloor: 83,
  recommendedHorizonSeq: 60,
  recommendation: 'prune-recommended',
};

const ROW = {
  table: 'cards',
  rowId: 'r1',
  exists: true,
  serverVersion: 4,
  scopes: { board_id: 'web' },
  values: { id: 'r1', title: 'Hello', cover: 'AAECAwQF' },
  history: [
    {
      commitSeq: HEAD,
      op: 'upsert',
      rowVersion: 4,
      actorId: 'ada',
      clientId: 'c-ada',
      createdAtMs: NOW - 9_000,
    },
  ],
};

const COMMIT = {
  commitSeq: HEAD,
  clientId: 'c-ada',
  clientCommitId: 'cc-9',
  actorId: 'ada',
  createdAtMs: NOW - 9_000,
  changeCount: 7,
  tables: ['cards'],
};

const TRACE = {
  verdict: 'scope-mismatch',
  table: 'cards',
  rowId: 'r1',
  clientId: 'c-ben',
  row: ROW,
  lastChange: ROW.history[0],
  horizonSeq: 20,
  client: CLIENTS[1],
  allowed: { board_id: ['web', 'mobile'] },
  subscriptions: [
    {
      id: 's1',
      scopes: { board_id: ['mobile'] },
      requestedMatch: false,
      mismatches: [
        { variable: 'board_id', rowValue: 'web', requested: ['mobile'] },
      ],
      effectiveMatch: false,
    },
  ],
  rejections: [CONFLICT],
};

const ROUTES: Record<string, Route> = {
  '/info': { body: INFO },
  '/metrics': { body: metrics({ complete: true, fromMs: NOW - 300_000 }) },
  '/events': (url) => ({
    body: {
      events: url.searchParams.get('requestId')
        ? RING_EVENTS.filter(
            (e) =>
              'requestId' in e &&
              e.requestId === url.searchParams.get('requestId'),
          )
        : RING_EVENTS,
    },
  }),
  '/errors': {
    body: {
      errors: {
        partition: 'demo',
        windowMs: 300_000,
        atMs: NOW,
        coverage: { complete: true, fromMs: NOW - 300_000 },
        byCode: [
          {
            source: 'push',
            code: 'sync.version_conflict',
            count: 3,
            clients: 1,
            actors: 1,
            lastAtMs: NOW - 20_000,
            sampleClientIds: ['c-ben'],
            sampleRows: [{ table: 'cards', rowId: 'r1' }],
          },
        ],
        byClient: [
          {
            clientId: 'c-ben',
            actorId: 'ben',
            count: 3,
            lastCode: 'sync.version_conflict',
            lastAtMs: NOW - 20_000,
          },
        ],
      },
    },
  },
  '/horizon': { body: { horizon: HORIZON } },
  '/clients': { body: { clients: CLIENTS, total: 3 } },
  '/clients/*': (url) => ({
    body: {
      detail: {
        clientId: decodeURIComponent(url.pathname.split('/')[3] ?? ''),
        exists: true,
        client: CLIENTS[1],
        lease: {
          leaseId: 'lease-1',
          actorId: 'ben',
          allowedScopes: {},
          issuedAtMs: NOW - 1_000,
          expiresAtMs: NOW + 600_000,
          revoked: false,
        },
        events: [CONFLICT],
      },
    },
  }),
  '/actors': {
    body: {
      actors: [
        {
          actorId: 'ada',
          clients: [CLIENTS[0]],
          connected: 1,
          lastSeenMs: NOW - 4_000,
          maxLag: 0,
          recentFailures: 0,
        },
        {
          actorId: 'ben',
          clients: [CLIENTS[1], CLIENTS[2]],
          connected: 0,
          lastSeenMs: NOW - 25_200_000,
          maxLag: 1500,
          recentFailures: 3,
        },
      ],
    },
  },
  '/partitions': {
    body: {
      total: 2,
      partitions: [
        {
          partition: 'demo',
          maxCommitSeq: HEAD,
          horizonSeq: 20,
          retainedCommits: 100,
          knownClients: 3,
          activeClients: 2,
          recommendation: 'prune-recommended',
        },
        {
          partition: 'staging',
          maxCommitSeq: 4,
          horizonSeq: 0,
          retainedCommits: 4,
          knownClients: 1,
          activeClients: 0,
          recommendation: 'up-to-date',
        },
      ],
    },
  },
  '/tables': {
    body: { tables: [{ name: 'cards', columns: COLUMNS, rowCount: 51 }] },
  },
  '/rows/*': (url) => {
    const parts = url.pathname.split('/').slice(3).map(decodeURIComponent);
    if (parts[0] === 'nope') {
      return {
        status: 400,
        body: {
          code: 'sync.unknown_table',
          message: 'table is not in the server schema',
        },
      };
    }
    if (parts.length === 1) {
      const after = url.searchParams.get('afterRowId');
      return {
        body: {
          page: {
            table: 'cards',
            rows: [
              {
                rowId: after === null ? 'r1' : 'r9',
                serverVersion: 4,
                scopes: {
                  board_id:
                    url.searchParams.get('scope') === 'board_id:mobile'
                      ? 'mobile'
                      : 'web',
                },
                values: ROW.values,
              },
            ],
            ...(after === null ? { nextAfterRowId: 'r1' } : {}),
          },
        },
      };
    }
    if (parts[2] === 'delivery') {
      return {
        body: {
          delivery: {
            table: 'cards',
            rowId: 'r1',
            row: ROW,
            lastChange: ROW.history[0],
            horizonSeq: 20,
            clients: [
              { client: CLIENTS[1], verdict: 'scope-mismatch' },
              { client: CLIENTS[2], verdict: 'pending-pull' },
              { client: CLIENTS[0], verdict: 'delivered' },
            ],
          },
        },
      };
    }
    return { body: { row: ROW } };
  },
  '/trace': { body: { trace: TRACE } },
  '/scope-activity': {
    body: {
      activity: [
        {
          commitSeq: HEAD,
          table: 'cards',
          createdAtMs: NOW - 9_000,
          actorId: 'ada',
          changeCount: 2,
        },
      ],
    },
  },
  '/commits': (url) => ({
    body: {
      commits:
        url.searchParams.get('table') === 'nope'
          ? []
          : [
              {
                ...COMMIT,
                sample: [{ table: 'cards', rowId: 'r1', op: 'upsert' }],
              },
              {
                ...COMMIT,
                commitSeq: HEAD - 1,
                clientId: 'c-ben',
                clientCommitId: 'cc-8',
                changeCount: 1,
                sample: [{ table: 'cards', rowId: 'r2', op: 'delete' }],
              },
            ],
    },
  }),
  '/commits/*': {
    body: {
      commit: {
        ...COMMIT,
        changes: [
          {
            table: 'cards',
            rowId: 'r1',
            op: 'upsert',
            rowVersion: 4,
            scopes: { board_id: 'web' },
            values: { id: 'r1', title: 'Hello' },
          },
        ],
      },
    },
  },
  '/writes/*': {
    body: {
      write: {
        clientCommitId: 'cc-7',
        outcomes: [
          {
            clientId: 'c-ben',
            status: 'rejected',
            recordedAtMs: NOW - 20_000,
            results: [
              {
                opIndex: 0,
                status: 'conflict',
                code: 'sync.version_conflict',
                message: 'row changed since the base version',
                serverVersion: 4,
                serverRow: 'AAE=',
                conflictColumns: 'Ag==',
              },
            ],
          },
        ],
        events: [CONFLICT],
      },
    },
  },
  '/search': (url) => ({
    body: {
      search:
        url.searchParams.get('q') === 'r1'
          ? {
              query: 'r1',
              clients: [],
              actors: [],
              rows: [{ table: 'cards', rowId: 'r1' }],
              writes: [],
            }
          : {
              query: 'ben',
              clients: [CLIENTS[1], CLIENTS[2]],
              actors: ['ben'],
              rows: [],
              writes: [],
            },
    },
  }),
  '/stats': {
    body: {
      stats: {
        segments: {
          count: 3,
          bytes: 48_000,
          rowsSegments: 2,
          sqliteSegments: 1,
          approximate: true,
        },
      },
    },
  },
  '/reactions': {
    body: {
      reactions: [
        {
          idempotencyKey: 'card:1',
          type: 'email.send',
          version: 1,
          payload: { cardId: '1' },
          sourceClientId: 'c-ada',
          sourceClientCommitId: 'cc-9',
          sourceCommitSeq: HEAD,
          createdAtMs: NOW - 60_000,
          maxAttempts: 5,
          status: 'dead-letter',
          attempts: 5,
          availableAtMs: NOW - 1_000,
          lastFailure: { code: 'mail.bounced', atMs: NOW - 2_000 },
        },
      ],
    },
  },
};

/** The page's view of `EventSource`, driven by the test. */
class FakeEventSource {
  static readonly opened: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }
  close(): void {
    this.closed = true;
  }
  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const windows: Window[] = [];
afterEach(async () => {
  FakeEventSource.opened.length = 0;
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

/** Chained microtasks: enough turns for fetch → json → render chains. */
async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** Route key: the path below the mount, prefixed with the method for writes. */
function routeOf(routes: Record<string, Route>, method: string, url: URL) {
  const path = url.pathname.replace(/^\/admin/, '');
  const key = method === 'GET' ? path : `${method} ${path}`;
  const wildcard =
    method === 'GET' ? `/${path.split('/')[1]}/*` : `${method} /*`;
  return routes[key] ?? routes[wildcard];
}

interface PostedMessage {
  kind: string;
  id: number;
  path: string;
  method: string;
}

function openConsole(
  options: {
    readonly routes?: Record<string, Route>;
    readonly hash?: string;
    readonly search?: string;
    readonly onPost?: (message: PostedMessage) => void;
  } = {},
) {
  const routes = { ...ROUTES, ...options.routes };
  const window = new Window({
    url: `http://admin.test/admin${options.search ?? ''}${options.hash ?? ''}`,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  windows.push(window);
  const requests: string[] = [];
  const answer = (path: string, method: string): Answer => {
    const url = new URL(path, 'http://admin.test');
    requests.push(
      (method === 'GET' ? '' : `${method} `) + url.pathname + url.search,
    );
    const route = routeOf(routes, method, url);
    if (route === undefined) {
      return {
        status: 404,
        body: { code: 'test.no_fixture', message: url.pathname },
      };
    }
    return typeof route === 'function' ? route(url) : route;
  };
  Object.defineProperty(window, 'fetch', {
    value: (path: string, init: { method: string }) => {
      const { status = 200, body } = answer(path, init.method);
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      });
    },
  });
  Object.defineProperty(window, 'EventSource', { value: FakeEventSource });
  if (options.onPost) {
    Object.defineProperty(window, 'postMessage', { value: options.onPost });
  }
  window.document.write(ADMIN_CONSOLE_HTML);
  const document = window.document;
  const $ = (selector: string) => {
    const found = document.querySelector(selector);
    if (found === null) throw new Error(`missing ${selector}`);
    return found;
  };
  const text = (selector: string) => $(selector).textContent ?? '';
  const click = (selector: string) => {
    $(selector).dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    );
  };
  const key = (k: string) => {
    document.body.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: k, bubbles: true }),
    );
  };
  const input = (selector: string) => {
    const control = $(selector);
    if (
      !(control instanceof window.HTMLInputElement) &&
      !(control instanceof window.HTMLSelectElement)
    ) {
      throw new Error(`${selector} is not a form control`);
    }
    return control;
  };
  const type = (selector: string, value: string, event = 'change') => {
    const control = input(selector);
    control.value = value;
    control.dispatchEvent(new window.Event(event, { bubbles: true }));
  };
  const submit = (selector: string) => {
    $(selector).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
  };
  const open = (selector: string) => {
    const dialog = $(selector);
    if (!(dialog instanceof window.HTMLDialogElement))
      throw new Error(`${selector} is not a dialog`);
    return dialog.open;
  };
  const visible = (view: string) => !$(`#view-${view}`).hasAttribute('hidden');
  const rows = (host: string) =>
    [...document.querySelectorAll(`${host} tbody tr`)].map(
      (row) => row.textContent ?? '',
    );
  return {
    window,
    document,
    requests,
    $,
    text,
    click,
    key,
    input,
    type,
    submit,
    open,
    visible,
    rows,
  };
}

describe('overview', () => {
  test('renders the key figures, chart, gauge, lag, failures and fleet panels', async () => {
    const c = openConsole();
    await flush();
    expect(c.requests[0]).toBe('/admin/info');
    expect(c.text('#ov-part')).toBe('demo');
    const kpis = c.text('#kpis');
    expect(kpis).toContain('25%');
    expect(kpis).toContain('80ms');
    expect(kpis).toContain('1 conflicted');
    // Connected comes from the realtime hub; nothing says "active".
    expect(kpis).toContain('1/ 3 connected');
    expect(kpis).toContain('1 below server schema v3');
    expect(kpis).not.toContain('active');
    expect(kpis).toContain('120head');
    const titles = [...c.document.querySelectorAll('#ov-volume g title')];
    expect(titles.length).toBe(30);
    expect(titles[25]?.textContent).toContain('1 failed, p95 80 ms');
    expect(titles[27]?.textContent).toContain('6 pushes applied, 1 conflicted');
    expect(c.text('#ov-horizon')).toContain(
      'from 20 to 60 and drop 40 commits',
    );
    expect(c.text('#ov-horizon')).not.toContain('Prune now');
    expect(c.text('#ov-lag')).toContain('1000 +');
    expect(c.text('#ov-lag')).toContain('connected');
    expect(c.rows('#ov-lagtop')[0]).toContain('c-old-tablet');
    const failing = c.rows('#ov-errors')[0] ?? '';
    expect(failing).toContain('sync.version_conflict');
    expect(failing).toContain('push');
    expect(c.$('#ov-errors a[href="#/row/cards/r1"]').textContent).toBe(
      'cards / r1',
    );
    expect(c.rows('#ov-fleet').length).toBe(2);
    expect(c.text('#side-mode')).toBe(
      'Read-only: the host passed no authorizeWrite.',
    );
    expect(c.text('#updated')).toStartWith('Updated');
  });

  test('failures lead to the event tail and to the client page', async () => {
    const c = openConsole();
    await flush();
    c.click('#ov-errors tr[data-i="0"]');
    await flush();
    expect(c.window.location.hash).toBe('#/events');
    expect(c.input('#ev-q').value).toBe('sync.version_conflict');
    c.key('1');
    await flush();
    c.click('[data-act="err-tab"][data-tab="client"]');
    expect(
      c
        .$('[data-act="err-tab"][data-tab="client"]')
        .getAttribute('aria-pressed'),
    ).toBe('true');
    c.click('#ov-errors tr[data-i="0"]');
    await flush();
    expect(c.window.location.hash).toBe('#/client/c-ben');
    expect(c.visible('client')).toBe(true);
    expect(c.$('#nav-people').getAttribute('aria-current')).toBe('page');
  });

  test('a partial ring window is labeled on every figure', async () => {
    const c = openConsole({
      routes: {
        '/metrics': {
          body: metrics({ complete: false, fromMs: NOW - 60_000 }),
        },
      },
    });
    await flush();
    expect(c.text('#ov-volume')).toContain('covers only the last 1 min');
    expect(c.document.querySelectorAll('#ov-volume rect.nocov').length).toBe(1);
    expect(c.text('#kpis')).toContain('(partial window)');
  });

  test('says so when no event ring or realtime hub is wired', async () => {
    const c = openConsole({
      routes: {
        '/info': { body: { ...INFO, hasEventStream: false, realtime: false } },
      },
    });
    await flush();
    expect(c.text('#ov-volume')).toContain('No event ring wired');
    expect(c.text('#ov-errors')).toContain('No event ring wired');
    expect(c.text('#live')).toBe('No event ring');
    expect(c.text('#kpis')).toContain('seen in the last hour');
    expect(c.requests).not.toContain('/admin/metrics');
    expect(FakeEventSource.opened.length).toBe(0);
  });

  test('an unauthorized console shows the stable code in every panel and an alert', async () => {
    const c = openConsole({
      routes: {
        '/info': {
          status: 401,
          body: {
            code: 'sync.auth_required',
            message: 'authentication required',
            recommendedAction: 'reauthenticate',
          },
        },
      },
    });
    await flush();
    expect(c.$('#alert').hasAttribute('hidden')).toBe(false);
    expect(c.text('#alert')).toContain('sync.auth_required');
    expect(c.text('#ov-volume')).toContain('HTTP 401');
    expect(c.text('#live')).toBe('Events failed');
    expect(c.requests).toEqual(['/admin/info']);
  });

  test('a fleet view the guard refuses shows its code in the fleet panel only', async () => {
    const c = openConsole({
      routes: {
        '/partitions': {
          status: 401,
          body: {
            code: 'sync.auth_required',
            message: 'authentication required',
          },
        },
      },
    });
    await flush();
    expect(c.text('#ov-fleet')).toContain('sync.auth_required');
    expect(c.text('#ov-horizon')).toContain('Prune recommended');
  });
});

describe('people and clients', () => {
  test('lists actors with their devices and the schema rollout', async () => {
    const c = openConsole({ hash: '#/people' });
    await flush();
    expect(c.requests).toContain('/admin/actors');
    expect(c.text('#people-rt')).toBe('');
    const rows = c.rows('#people-table');
    expect(rows.length).toBe(2);
    expect(rows[1]).toContain('ben');
    expect(rows[1]).toContain('none');
    expect(c.document.querySelectorAll('#people-table a.dev.on').length).toBe(
      1,
    );
    expect(
      c.$(`#people-table a[href="#/client/${LONG_ID}"]`).textContent,
    ).toContain('· v2');
    expect(c.text('#rollout-meta')).toBe('server schema v3');
    expect(c.text('#people-rollout')).toContain('1 behind');
    expect(c.document.querySelectorAll('#people-rollout .c-err').length).toBe(
      1,
    );
    c.type('#people-q', 'tablet', 'input');
    expect(c.rows('#people-table').length).toBe(1);
    expect(c.text('#people-count')).toBe('1 of 2 actors · 3 devices');
  });

  test('without a realtime hub the console shows last-seen times', async () => {
    const c = openConsole({
      hash: '#/people',
      routes: { '/info': { body: { ...INFO, realtime: false } } },
    });
    await flush();
    expect(c.text('#people-rt')).toContain('No realtime hub');
    expect(c.text('#people-table')).toContain('Last seen');
    expect(c.text('#people-table')).not.toContain('Connected');
  });

  test('the client page shows presence, lease, subscriptions, events, and traces a row', async () => {
    const c = openConsole({ hash: '#/client/c-ben' });
    await flush();
    expect(c.requests).toContain('/admin/clients/c-ben?eventLimit=50');
    expect(c.text('#h-client')).toBe('c-ben');
    expect(c.text('#client-line')).toContain('seen 7 h ago');
    expect(c.text('#client-body')).toContain('no open socket');
    expect(c.text('#client-body')).toContain('lease-1');
    expect(c.document.querySelector('[data-act="revoke"]')).toBeNull();
    expect(
      c.$('#client-subs a[href="#/table/cards/board_id%3Amobile"]').textContent,
    ).toBe('board_id: mobile');
    expect(c.rows('#client-events')[0]).toContain('push.conflicted');
    c.input('#client-trace [name=r]').value = 'r1';
    c.submit('#client-trace');
    await flush();
    expect(c.requests).toContain(
      '/admin/trace?table=cards&rowId=r1&clientId=c-ben',
    );
    expect(c.open('#modal')).toBe(true);
    expect(c.text('#m-sum .vbox')).toContain('Scope mismatch');
  });
});

describe('data browser and row page', () => {
  test('tables open a scoped row browser with paging', async () => {
    const c = openConsole({ hash: '#/data' });
    await flush();
    expect(c.rows('#data-tables')[0]).toContain('51');
    c.click('#data-tables tr[data-i="0"]');
    await flush();
    expect(c.window.location.hash).toBe('#/table/cards');
    expect(c.requests).toContain('/admin/rows/cards?limit=50');
    expect(c.rows('#table-rows')[0]).toContain('bytes · 6 B');
    // Scope chips come from the client subscriptions and the rows.
    expect(c.text('#table-scopes')).toContain('board_id: mobile');
    c.click('[data-act="rows-next"]');
    await flush();
    expect(c.requests).toContain('/admin/rows/cards?limit=50&afterRowId=r1');
    expect(c.rows('#table-rows')[0]).toContain('r9');
    c.click('[data-act="rows-prev"]');
    await flush();
    expect(c.rows('#table-rows')[0]).toContain('r1');
    c.click('#table-scopes a[href="#/table/cards/board_id%3Amobile"]');
    await flush();
    expect(c.requests).toContain(
      '/admin/rows/cards?limit=50&scope=board_id%3Amobile',
    );
    expect(c.requests).toContain(
      '/admin/scope-activity?variable=board_id&value=mobile',
    );
    expect(c.$('#table-activity-panel').hasAttribute('hidden')).toBe(false);
    expect(c.$('#table-scopes .tag.on').textContent).toBe('board_id: mobile');
    c.click('#table-rows tr[data-i="0"]');
    await flush();
    expect(c.window.location.hash).toBe('#/row/cards/r1');
  });

  test('the row page shows typed values, history, and who has the row', async () => {
    const c = openConsole({ hash: '#/row/cards/r1' });
    await flush();
    expect(c.$('#nav-data').getAttribute('aria-current')).toBe('page');
    expect(c.text('#row-line')).toContain('board_id: web');
    const values = c.rows('#row-values');
    expect(values[0]).toContain('key');
    expect(values[2]).toContain('base64 AAECAwQF');
    expect(c.rows('#row-history')[0]).toContain('upsert');
    const matrix = c.rows('#row-delivery');
    expect(matrix.length).toBe(3);
    expect(matrix[0]).toContain('Scope mismatch');
    expect(matrix[2]).toContain('Delivered');
    expect(c.text('#delivery-meta')).toContain(
      '1 scope-mismatch · 1 pending-pull · 1 delivered',
    );
    c.click('#row-delivery tr[data-i="0"]');
    await flush();
    expect(c.requests).toContain(
      '/admin/trace?table=cards&rowId=r1&clientId=c-ben',
    );
    expect(c.rows('#m-subs')[0]).toContain(
      'board_id: row web, requested mobile',
    );
    expect(c.text('#m-sum')).toContain('board_id: web, mobile');
    expect(c.rows('#m-events')[0]).toContain('push.conflicted');
    c.click('#m-sum [data-seq="120"]');
    await flush();
    expect(c.text('#m-kicker')).toBe('Commit 120');
    c.click('#m-changes tr[data-i="0"]');
    await flush();
    expect(c.open('#modal')).toBe(false);
    expect(c.window.location.hash).toBe('#/row/cards/r1');
  });

  test('an unknown table answers with its stable code', async () => {
    const c = openConsole({ hash: '#/table/nope' });
    await flush();
    expect(c.text('#table-rows')).toContain('sync.unknown_table');
    expect(c.text('#table-rows')).toContain('HTTP 400');
  });
});

describe('commits, writes, search', () => {
  test('commits show their content, page back, and open changes', async () => {
    const c = openConsole({ hash: '#/commits' });
    await flush();
    expect(c.requests).toContain('/admin/commits?limit=50&sample=5');
    const first = c.rows('#commits-list')[0] ?? '';
    expect(first).toContain('upsert cards / r1');
    expect(first).toContain('+6 more');
    expect(c.$('#commits-list a[href="#/row/cards/r2"]').textContent).toBe(
      'delete cards / r2',
    );
    c.type('#commits-table', 'nope');
    await flush();
    expect(c.text('#commits-list')).toContain(
      'No commit on this page touched table nope',
    );
    c.type('#commits-table', '');
    await flush();
    c.click('#commits-list tr[data-i="0"]');
    await flush();
    expect(c.requests).toContain('/admin/commits/120');
    expect(c.text('#m-title')).toBe('cc-9');
    expect(c.rows('#m-changes')[0]).toContain('"title":"Hello"');
  });

  test('a client commit id opens what happened to the write', async () => {
    const c = openConsole({ hash: '#/commits' });
    await flush();
    c.input('#write-id').value = 'cc-7';
    c.submit('#write-form');
    await flush();
    expect(c.requests).toContain('/admin/writes/cc-7');
    expect(c.text('#m-sum')).toContain('rejected');
    const result = c.rows('#m-res-0')[0] ?? '';
    expect(result).toContain('conflict');
    expect(result).toContain('sync.version_conflict');
    expect(c.rows('#m-events')[0]).toContain('push.conflicted');
  });

  test('search groups results, and a single hit opens it', async () => {
    const c = openConsole();
    await flush();
    c.input('#q').value = 'ben';
    c.submit('#search-form');
    await flush();
    expect(c.window.location.hash).toBe('#/search/ben');
    expect(c.rows('#s-clients').length).toBe(2);
    expect(c.$('#search-body a[href="#/people/ben"]').textContent).toBe('ben');
    c.input('#q').value = 'r1';
    c.submit('#search-form');
    await flush();
    expect(c.window.location.hash).toBe('#/row/cards/r1');
    expect(c.visible('row')).toBe(true);
  });
});

describe('event stream', () => {
  test('groups events per request, hides idle rounds, and opens a request', async () => {
    const c = openConsole({ hash: '#/events' });
    await flush();
    const source = FakeEventSource.opened.at(-1);
    if (source === undefined) throw new Error('no stream opened');
    expect(source.url).toBe('/admin/events/stream?limit=200');
    source.onopen?.();
    expect(c.text('#live')).toBe('Live');
    for (const event of [...RING_EVENTS].reverse()) source.emit(event);
    // Two idle rounds hidden: the working request, the conflict, the socket.
    expect(c.rows('#ev-table').length).toBe(3);
    expect(c.text('#ev-idle-label')).toBe('Show idle rounds (2 hidden)');
    expect(c.text('#ev-count')).toBe('3 of 5 rows · 8 events');
    const conflictRow =
      c.rows('#ev-table').find((r) => r.includes('conflicted')) ?? '';
    expect(conflictRow).toContain('cards / r1');
    expect(c.$('#ev-table a[href="#/row/cards/r1"]').textContent).toBe(
      'cards / r1',
    );
    const idle = c.input('#ev-idle');
    if (!(idle instanceof c.window.HTMLInputElement)) throw new Error();
    idle.checked = true;
    idle.dispatchEvent(new c.window.Event('change', { bubbles: true }));
    expect(c.rows('#ev-table').length).toBe(5);

    c.type('#ev-level', 'warn');
    expect(c.rows('#ev-table').length).toBe(1);
    c.type('#ev-level', '');

    c.click('#ev-table tr[data-i="2"]');
    await flush();
    expect(c.requests).toContain('/admin/events?requestId=req-work&limit=200');
    expect(c.text('#m-kicker')).toBe('Sync request');
    expect(c.text('#m-sum')).toContain('1 pushed · 2 commits pulled');
    expect(c.rows('#m-events').length).toBe(2);
    c.click('#m-close');

    c.key(' ');
    expect(c.text('#live')).toBe('Paused');
    source.emit(CONFLICT);
    expect(c.text('#ev-pause')).toBe('Resume (1)');
    c.click('#ev-pause');
    source.onerror?.();
    expect(source.closed).toBe(true);
    expect(c.text('#ev-banner')).toContain('Stream closed');
    c.click('#ev-banner [data-act="reconnect"]');
    expect(FakeEventSource.opened.at(-1)).not.toBe(source);
  });

  test('the parent transport polls and says so', async () => {
    const posted: PostedMessage[] = [];
    const c = openConsole({
      search: '?transport=parent',
      hash: '#/events',
      onPost: (message) => {
        posted.push(message);
      },
    });
    const respond = () => {
      for (const message of posted.splice(0)) {
        const url = new URL(message.path, 'http://admin.test');
        const route = routeOf(ROUTES, message.method, url);
        const answer =
          route === undefined
            ? { body: {} }
            : typeof route === 'function'
              ? route(url)
              : route;
        c.window.dispatchEvent(
          new c.window.MessageEvent('message', {
            data: {
              kind: 'syncular-admin-response',
              id: message.id,
              ok: true,
              status: 200,
              body: answer.body,
            },
            origin: 'http://admin.test',
            // The page's own global, which is what `window.parent` is in a
            // top-level frame.
            source: c.window.eval('window'),
          }),
        );
      }
    };
    await flush();
    expect(posted).toEqual([
      { kind: 'syncular-admin-request', id: 1, path: '/info', method: 'GET' },
    ]);
    respond();
    await flush();
    respond();
    await flush();
    expect(FakeEventSource.opened.length).toBe(0);
    expect(c.text('#live')).toBe('Polling');
    expect(c.text('#ev-banner')).toContain('parent-frame transport');
    expect(c.rows('#ev-table').length).toBe(3);
  });
});

describe('writes', () => {
  const writable = { '/info': { body: { ...INFO, writes: true } } };

  test('retrying a dead letter confirms, posts, and shows the answer', async () => {
    const c = openConsole({
      hash: '#/reactions',
      routes: {
        ...writable,
        'POST /*': {
          body: { reaction: { idempotencyKey: 'card:1', status: 'pending' } },
        },
      },
    });
    await flush();
    expect(c.text('#side-mode')).toBe('Writes enabled: retry, prune, revoke.');
    expect(c.rows('#rx-table')[0]).toContain('mail.bounced');
    c.click('#rx-table tr[data-i="0"]');
    c.click('#m-sum [data-act="retry"]');
    expect(c.open('#confirm')).toBe(true);
    expect(c.text('#c-body')).toContain('POST /reactions/card%3A1/retry');
    c.click('#c-ok');
    await flush();
    expect(c.requests).toContain('POST /admin/reactions/card%3A1/retry');
    expect(c.text('#c-body')).toContain('"status": "pending"');
  });

  test('a refused write shows its stable code', async () => {
    const c = openConsole({
      routes: {
        ...writable,
        'POST /prune': {
          status: 403,
          body: {
            code: 'sync.forbidden',
            message: 'writes are not authorized',
          },
        },
      },
    });
    await flush();
    c.click('#ov-horizon [data-act="prune"]');
    c.click('#c-ok');
    await flush();
    expect(c.text('#c-body')).toContain('sync.forbidden');
    expect(c.text('#c-body')).toContain('HTTP 403');
  });

  test('the client page offers lease revocation when writes are on', async () => {
    const c = openConsole({ hash: '#/client/c-ben', routes: writable });
    await flush();
    c.click('[data-act="revoke"]');
    expect(c.text('#c-body')).toContain('POST /clients/c-ben/revoke-lease');
  });
});

describe('storage and navigation', () => {
  test('storage labels approximate counters and missing stores', async () => {
    const c = openConsole({ hash: '#/storage' });
    await flush();
    expect(c.text('#seg-meta')).toBe('approximate');
    expect(c.text('#st-blob')).toContain('No blob stats');
  });

  test('keyboard shortcuts switch views, focus find, and open the shortcut list', async () => {
    const c = openConsole();
    await flush();
    c.key('3');
    await flush();
    expect(c.window.location.hash).toBe('#/data');
    expect(c.visible('data')).toBe(true);
    expect(c.visible('overview')).toBe(false);
    c.key('/');
    expect(c.document.activeElement?.id).toBe('q');
    c.input('#q').blur();
    c.key('a');
    expect(c.input('#auto').value).toBe('2000');
    c.key('a');
    c.key('a');
    c.key('a');
    expect(c.input('#auto').value).toBe('0');
    c.key('?');
    expect(c.open('#help')).toBe(true);
  });

  test('switching partitions reloads every read with the new partition', async () => {
    const c = openConsole();
    await flush();
    c.click('#ov-fleet tbody tr[data-i="1"]');
    await flush();
    expect(c.requests).toContain('/admin/horizon?partition=staging');
    expect(c.requests).toContain(
      '/admin/clients?partition=staging&sort=lag&limit=500',
    );
    expect(c.requests.filter((r) => r === '/admin/info').length).toBe(1);
    expect(FakeEventSource.opened.at(-1)?.url).toBe(
      '/admin/events/stream?partition=staging&limit=200',
    );
  });
});
