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

function clientRow(
  clientId: string,
  lag: number,
  active: boolean,
  wireVersion: number,
) {
  return {
    clientId,
    actorId: clientId === 'c-ada' ? 'ada' : 'ben',
    cursor: HEAD - lag,
    lag,
    updatedAtMs: NOW - (active ? 4_000 : 3_600_000),
    subscriptions: [
      { id: 's1', table: 'cards', scopes: { board_id: ['web', 'mobile'] } },
    ],
    active,
    wireVersion,
  };
}

const CLIENTS = [
  clientRow('c-ada', 0, true, 3),
  clientRow('c-ben', 37, true, 3),
  clientRow(
    'c-old-tablet-0f3c9a7e-2b11-4c55-9a8d-61f0e2b7c4d1',
    1500,
    false,
    2,
  ),
];

function requestEvent(atMs: number, durationMs: number, outcome = 'ok') {
  return {
    type: 'request.handled',
    kind: 'sync',
    atMs,
    partition: 'demo',
    actorId: 'ada',
    durationMs,
    bytesIn: 220,
    bytesOut: 1400,
    outcome,
    ...(outcome === 'ok' ? {} : { errorCode: 'sync.invalid_request' }),
    pushCommits: 1,
    pulled: true,
    subscriptions: 1,
  };
}

const CONFLICT = {
  type: 'push.conflicted',
  atMs: NOW - 20_000,
  partition: 'demo',
  actorId: 'ben',
  clientId: 'c-ben',
  clientCommitId: 'cc-7',
  operations: 1,
  opIndex: 0,
  replay: false,
};

const RING_EVENTS = [
  requestEvent(NOW - 5_000, 12),
  CONFLICT,
  requestEvent(NOW - 40_000, 80, 'rejected'),
  requestEvent(NOW - 200_000, 30),
];

const BUCKETS = 30;
const COUNTS = new Array<number>(BUCKETS).fill(0);
const ERRORS = new Array<number>(BUCKETS).fill(0);
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
COUNTS[10] = 1;
P95[10] = 30;
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

const INFO = {
  hasEventStream: true,
  writes: false,
  tables: [
    {
      name: 'cards',
      columns: [
        { name: 'id', type: 'string', nullable: false, primaryKey: true },
        { name: 'title', type: 'string', nullable: false, primaryKey: false },
        { name: 'cover', type: 'bytes', nullable: true, primaryKey: false },
      ],
    },
  ],
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

const COMMIT_DETAIL = {
  commit: {
    commitSeq: HEAD,
    clientId: 'c-ada',
    clientCommitId: 'cc-9',
    actorId: 'ada',
    createdAtMs: NOW - 9_000,
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
};

const ROUTES: Record<string, Route> = {
  '/info': { body: INFO },
  '/metrics': { body: metrics({ complete: true, fromMs: NOW - 300_000 }) },
  '/events': { body: { events: RING_EVENTS } },
  '/errors': {
    body: {
      errors: {
        partition: 'demo',
        windowMs: 300_000,
        atMs: NOW,
        coverage: { complete: true, fromMs: NOW - 300_000 },
        byCode: [
          {
            source: 'request',
            code: 'sync.invalid_request',
            count: 3,
            clients: 1,
            actors: 1,
            lastAtMs: NOW - 40_000,
            sampleClientIds: ['c-ben'],
          },
        ],
        byClient: [
          {
            clientId: 'c-ben',
            actorId: 'ben',
            count: 3,
            lastCode: 'sync.invalid_request',
            lastAtMs: NOW - 40_000,
          },
        ],
      },
    },
  },
  '/horizon': { body: { horizon: HORIZON } },
  '/clients': { body: { clients: CLIENTS, total: 3 } },
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
  '/commits': (url) => ({
    body: {
      commits:
        url.searchParams.get('table') === 'nope'
          ? []
          : [
              {
                commitSeq: HEAD,
                clientId: 'c-ada',
                clientCommitId: 'cc-9',
                actorId: 'ada',
                createdAtMs: NOW - 9_000,
                changeCount: 2,
                tables: ['cards', 'card_labels'],
              },
              {
                commitSeq: HEAD - 1,
                clientId: 'c-ben',
                clientCommitId: 'cc-8',
                actorId: 'ben',
                createdAtMs: NOW - 30_000,
                changeCount: 86,
                tables: ['boards'],
              },
            ],
    },
  }),
  '/commits/*': { body: COMMIT_DETAIL },
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
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

/** Route key: the path below the mount, prefixed with the method for writes. */
function routeOf(routes: Record<string, Route>, method: string, url: URL) {
  const path = url.pathname.replace(/^\/admin/, '');
  const key = method === 'GET' ? path : `${method} ${path}`;
  const wildcard =
    method === 'GET' ? `/${path.split('/')[1]}/*` : `${method} /*`;
  return routes[key] ?? routes[wildcard];
}

function openConsole(
  options: {
    readonly routes?: Record<string, Route>;
    readonly hash?: string;
    readonly search?: string;
    readonly onPost?: (message: {
      kind: string;
      id: number;
      path: string;
      method: string;
    }) => void;
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
  const type = (selector: string, value: string, event = 'change') => {
    const input = $(selector);
    if (
      !(input instanceof window.HTMLInputElement) &&
      !(input instanceof window.HTMLSelectElement)
    ) {
      throw new Error(`${selector} is not a form control`);
    }
    input.value = value;
    input.dispatchEvent(new window.Event(event, { bubbles: true }));
  };
  const submit = (selector: string) => {
    $(selector).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    );
  };
  const value = (selector: string) => {
    const control = $(selector);
    if (!(control instanceof window.HTMLSelectElement)) {
      throw new Error(`${selector} is not a select`);
    }
    return control.value;
  };
  const open = (selector: string) => {
    const dialog = $(selector);
    if (!(dialog instanceof window.HTMLDialogElement)) {
      throw new Error(`${selector} is not a dialog`);
    }
    return dialog.open;
  };
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
    type,
    submit,
    value,
    open,
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
    expect(kpis).toContain('Requests');
    expect(kpis).toContain('25%');
    expect(kpis).toContain('80ms');
    expect(kpis).toContain('1 conflicted');
    expect(kpis).toContain('2/ 3 active');
    expect(kpis).toContain('120head');
    // 30 buckets, one tooltip each, with per-bucket p95 and push outcomes.
    const titles = [...c.document.querySelectorAll('#ov-volume g title')];
    expect(titles.length).toBe(30);
    expect(titles[25]?.textContent).toContain('1 failed, p95 80 ms');
    expect(titles[27]?.textContent).toContain('6 pushes applied, 1 conflicted');
    expect(c.document.querySelectorAll('#ov-volume rect.bar.r').length).toBe(1);
    expect(c.text('#ov-volume')).not.toContain('Partial window');
    expect(c.text('#ov-horizon')).toContain('Prune recommended');
    expect(c.text('#ov-horizon')).toContain(
      'from 20 to 60 and drop 40 commits',
    );
    expect(c.text('#ov-horizon')).toContain('cursor floor 83');
    expect(c.text('#ov-horizon')).not.toContain('Prune now');
    expect(c.text('#ov-lag')).toContain('1000 +');
    expect(c.rows('#ov-lagtop')[0]).toContain('c-old-tablet');
    expect(c.rows('#ov-errors')[0]).toContain('sync.invalid_request');
    expect(c.rows('#ov-errors')[0]).toContain('request');
    expect(c.rows('#ov-fleet').length).toBe(2);
    expect(c.$('#ov-fleet tbody tr.cur').textContent).toContain('demo');
    expect(c.text('#updated')).toStartWith('Updated');
  });

  test('failures group by code or client and lead to the client and the event tail', async () => {
    const c = openConsole({
      routes: {
        '/clients/*': {
          body: {
            detail: {
              clientId: 'c-ben',
              exists: true,
              client: CLIENTS[1],
              events: [],
            },
          },
        },
      },
    });
    await flush();
    c.click('#ov-errors tr[data-i="0"]');
    await flush();
    expect(c.window.location.hash).toBe('#/events');
    const search = c.$('#ev-q');
    if (!(search instanceof c.window.HTMLInputElement)) throw new Error();
    expect(search.value).toBe('sync.invalid_request');
    c.key('1');
    await flush();
    c.click('[data-act="err-tab"][data-tab="client"]');
    expect(c.rows('#ov-errors')[0]).toContain('c-ben');
    expect(
      c
        .$('[data-act="err-tab"][data-tab="client"]')
        .getAttribute('aria-pressed'),
    ).toBe('true');
    c.click('#ov-errors tr[data-i="0"]');
    await flush();
    expect(c.open('#modal')).toBe(true);
    expect(c.text('#m-title')).toBe('c-ben');
  });

  test('a partial ring window is labeled on every figure', async () => {
    const fromMs = NOW - 60_000;
    const c = openConsole({
      routes: { '/metrics': { body: metrics({ complete: false, fromMs }) } },
    });
    await flush();
    expect(c.text('#ov-volume')).toContain('Partial window');
    expect(c.text('#ov-volume')).toContain('covers only the last 1 min');
    expect(c.document.querySelectorAll('#ov-volume rect.nocov').length).toBe(1);
    expect(c.text('#kpis')).toContain('(partial window)');
    expect(c.$('#kpis .kpi').className).toContain('warn');
  });

  test('says so when no event ring is wired', async () => {
    const c = openConsole({
      routes: { '/info': { body: { ...INFO, hasEventStream: false } } },
    });
    await flush();
    expect(c.text('#ov-volume')).toContain('No event ring wired');
    expect(c.text('#ov-errors')).toContain('No event ring wired');
    expect(c.text('#live')).toBe('No event ring');
    expect(c.text('#kpis')).toContain('no event ring wired');
    expect(c.requests).not.toContain('/admin/metrics');
    expect(FakeEventSource.opened.length).toBe(0);
  });

  test('an unauthorized console shows the stable code in every panel and an alert', async () => {
    const denied: Answer = {
      status: 401,
      body: {
        code: 'sync.auth_required',
        message: 'authentication required',
        recommendedAction: 'reauthenticate',
      },
    };
    const c = openConsole({ routes: { '/info': denied } });
    await flush();
    expect(c.$('#alert').hasAttribute('hidden')).toBe(false);
    expect(c.text('#alert')).toContain('sync.auth_required');
    expect(c.text('#ov-volume')).toContain('sync.auth_required');
    expect(c.text('#ov-volume')).toContain('HTTP 401');
    expect(c.text('#ov-fleet')).toContain('sync.auth_required');
    expect(c.$('#updated').className).toBe('err');
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
    expect(c.text('#ov-fleet')).toContain('HTTP 401');
    expect(c.text('#ov-horizon')).toContain('Prune recommended');
  });
});

describe('clients', () => {
  test('sorts, filters, and opens the drill-down with a JSON view', async () => {
    const c = openConsole({
      hash: '#/clients',
      routes: {
        '/clients/*': {
          body: {
            detail: {
              clientId: 'c-ben',
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
        },
      },
    });
    await flush();
    expect(c.requests).toContain('/admin/clients?sort=lag&limit=500');
    expect(c.$('#view-clients').hasAttribute('hidden')).toBe(false);
    expect(c.$('#nav-clients').getAttribute('aria-current')).toBe('page');
    expect(c.rows('#clients-table').length).toBe(3);
    expect(c.text('#n-clients')).toBe('3');
    expect(c.text('#clients-wire')).toContain('v2 · 1');
    expect(c.text('#clients-wire')).toContain('v3 · 2');

    // Lag sorts descending first, then ascending.
    c.click('#clients-table th:nth-child(6) button');
    expect(
      c.$('#clients-table th:nth-child(6)').getAttribute('aria-sort'),
    ).toBe('descending');
    expect(c.rows('#clients-table')[0]).toContain('c-old-tablet');
    c.click('#clients-table th:nth-child(6) button');
    expect(
      c.$('#clients-table th:nth-child(6)').getAttribute('aria-sort'),
    ).toBe('ascending');
    expect(c.rows('#clients-table')[0]).toContain('c-ada');

    // Ids keep their full value in the title and a copy button.
    const longId = c.$('#clients-table [data-copy^="c-old-tablet"]');
    expect(longId.getAttribute('data-copy')).toBe(CLIENTS[2]?.clientId ?? '');

    c.type('#clients-q', 'c-ben', 'input');
    expect(c.rows('#clients-table').length).toBe(1);
    expect(c.text('#clients-count')).toBe('1 of 3 clients');
    c.type('#clients-q', 'zzz', 'input');
    expect(c.text('#clients-table')).toContain('No match');
    c.type('#clients-q', '', 'input');
    const active = c.$('#clients-active');
    if (!(active instanceof c.window.HTMLInputElement)) throw new Error();
    active.checked = true;
    active.dispatchEvent(new c.window.Event('change', { bubbles: true }));
    expect(c.rows('#clients-table').length).toBe(2);

    c.click('#clients-table tr[data-i="1"]');
    await flush();
    expect(c.requests).toContain('/admin/clients/c-ben?eventLimit=50');
    expect(c.open('#modal')).toBe(true);
    expect(c.text('#m-title')).toBe('c-ben');
    expect(c.text('#m-sum')).toContain('lease-1');
    expect(c.text('#m-sum')).toContain('37 commits');
    expect(c.text('#m-sum')).toContain('v3');
    // Read-only admin: no revoke button.
    expect(c.document.querySelector('#m-sum [data-act="revoke"]')).toBeNull();
    expect(c.rows('#m-subs')[0]).toContain('board_id: web, mobile');
    expect(c.rows('#m-events')[0]).toContain('push.conflicted');
    c.click('#m-tab-json');
    expect(c.$('#m-json').hasAttribute('hidden')).toBe(false);
    expect(c.text('#m-json')).toContain('"leaseId": "lease-1"');

    // The drill-down prefills the trace form with the client.
    c.click('#m-sum [data-act="trace-client"]');
    await flush();
    expect(c.open('#modal')).toBe(false);
    expect(c.window.location.hash).toBe('#/trace');
    const field = c.$('#trace-client');
    if (!(field instanceof c.window.HTMLInputElement)) throw new Error();
    expect(field.value).toBe('c-ben');
  });

  test('a truncated client list says how many are known', async () => {
    const c = openConsole({
      hash: '#/clients',
      routes: { '/clients': { body: { clients: CLIENTS, total: 1200 } } },
    });
    await flush();
    expect(c.text('#clients-count')).toContain('1,200 known');
    expect(c.text('#n-clients')).toBe('1,200');
  });

  test('an empty partition renders the empty state', async () => {
    const c = openConsole({
      hash: '#/clients',
      routes: { '/clients': { body: { clients: [], total: 0 } } },
    });
    await flush();
    expect(c.text('#clients-table')).toContain('No clients');
    expect(c.text('#clients-count')).toBe('0 clients');
  });
});

describe('commits, rows, trace, scopes', () => {
  test('commits filter on the server and open the change list', async () => {
    const c = openConsole({ hash: '#/commits' });
    await flush();
    expect(c.rows('#commits-list').length).toBe(2);
    expect(c.document.querySelectorAll('#commits-list .tag').length).toBe(3);
    expect(c.$('#tables-list').innerHTML).toContain('value="cards"');
    c.type('#commits-table', 'nope');
    await flush();
    expect(c.requests).toContain('/admin/commits?table=nope&limit=50');
    expect(c.text('#commits-list')).toContain(
      'No commit in the newest 50 touched table nope',
    );
    c.type('#commits-table', '');
    await flush();
    c.click('#commits-list tr[data-i="0"]');
    await flush();
    expect(c.requests).toContain('/admin/commits/120');
    expect(c.requests).toContain('/admin/events?clientId=c-ada&limit=200');
    expect(c.text('#m-kicker')).toBe('Commit 120');
    expect(c.text('#m-title')).toBe('cc-9');
    expect(c.rows('#m-changes')[0]).toContain('upsert');
    expect(c.rows('#m-changes')[0]).toContain('board_id: web');
    // A change opens the row in the inspector.
    c.click('#m-changes tr[data-i="0"]');
    await flush();
    expect(c.window.location.hash).toBe('#/rows');
    expect(c.requests).toContain('/admin/rows/cards/r1');
  });

  test('the row inspector shows the stable error code, values, and history', async () => {
    const c = openConsole({
      hash: '#/rows',
      routes: {
        '/rows/*': (url) =>
          url.pathname.endsWith('/nope/r1')
            ? {
                status: 400,
                body: {
                  code: 'sync.unknown_table',
                  message: 'table is not in the server schema',
                  details: { table: 'nope' },
                },
              }
            : {
                body: {
                  row: {
                    table: 'cards',
                    rowId: 'r1',
                    exists: true,
                    serverVersion: 4,
                    scopes: { board_id: 'web' },
                    values: {
                      id: 'r1',
                      title: 'Hello',
                      cover: 'AAECAwQF',
                    },
                    history: [
                      {
                        commitSeq: HEAD,
                        op: 'upsert',
                        actorId: 'ada',
                        clientId: 'c-ada',
                        createdAtMs: NOW - 9_000,
                      },
                    ],
                  },
                },
              },
      },
    });
    await flush();
    c.type('#rows-table', 'nope');
    c.type('#rows-id', 'r1');
    c.submit('#rows-form');
    await flush();
    expect(c.text('#rows-result')).toContain('sync.unknown_table');
    expect(c.text('#rows-result')).toContain('HTTP 400');
    c.type('#rows-table', 'cards');
    c.submit('#rows-form');
    await flush();
    expect(c.text('#rows-result')).toContain('exists');
    expect(c.text('#rows-result')).toContain('board_id: web');
    const values = c.rows('#row-values');
    expect(values[0]).toContain('key');
    expect(values[1]).toContain('Hello');
    expect(values[2]).toContain('bytes · 6 B');
    expect(values[2]).toContain('base64 AAECAwQF');
    expect(c.rows('#row-history')[0]).toContain('upsert');
    expect(c.document.querySelectorAll('#rows-recent .tag').length).toBe(1);
    c.click('#rows-result [data-act="trace-row"]');
    await flush();
    expect(c.window.location.hash).toBe('#/trace');
    const table = c.$('#trace-table');
    if (!(table instanceof c.window.HTMLInputElement)) throw new Error();
    expect(table.value).toBe('cards');
  });

  test('the trace names the verdict and the scope mismatch', async () => {
    const c = openConsole({
      hash: '#/trace',
      routes: {
        '/trace': {
          body: {
            trace: {
              verdict: 'scope-mismatch',
              table: 'cards',
              rowId: 'r1',
              clientId: 'c-ben',
              row: {
                table: 'cards',
                rowId: 'r1',
                exists: true,
                serverVersion: 4,
                scopes: { board_id: 'web' },
                history: [],
              },
              lastChange: {
                commitSeq: HEAD,
                op: 'upsert',
                rowVersion: 4,
                actorId: 'ada',
                clientId: 'c-ada',
                createdAtMs: NOW - 9_000,
              },
              horizonSeq: 20,
              client: CLIENTS[1],
              allowed: { board_id: ['web', 'mobile'] },
              subscriptions: [
                {
                  id: 's1',
                  scopes: { board_id: ['mobile'] },
                  requestedMatch: false,
                  mismatches: [
                    {
                      variable: 'board_id',
                      rowValue: 'web',
                      requested: ['mobile'],
                    },
                  ],
                  effectiveMatch: false,
                },
              ],
              rejections: [CONFLICT],
            },
          },
        },
      },
    });
    await flush();
    c.type('#trace-table', 'cards');
    c.type('#trace-row', 'r1');
    c.type('#trace-client', 'c-ben');
    c.submit('#trace-form');
    await flush();
    expect(c.requests).toContain(
      '/admin/trace?table=cards&rowId=r1&clientId=c-ben',
    );
    expect(c.$('#trace-result .vbox').className).toContain('err');
    expect(c.text('#trace-result .vbox')).toContain('Scope mismatch');
    expect(c.rows('#trace-subs')[0]).toContain(
      'board_id: row web, requested mobile',
    );
    expect(c.text('#trace-result')).toContain('board_id: web, mobile');
    expect(c.rows('#trace-rej')[0]).toContain('push.conflicted');
    c.click('#trace-result [data-seq="120"]');
    await flush();
    expect(c.text('#m-kicker')).toBe('Commit 120');
  });

  test('scopes suggest subscribed scope keys and query on click', async () => {
    const c = openConsole({
      hash: '#/scopes',
      routes: {
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
      },
    });
    await flush();
    expect(c.document.querySelectorAll('#scopes-suggest .tag').length).toBe(2);
    c.click('#scopes-suggest .tag[data-sval="mobile"]');
    await flush();
    expect(c.requests).toContain(
      '/admin/scope-activity?variable=board_id&value=mobile',
    );
    expect(c.rows('#scopes-table').length).toBe(1);
    expect(c.text('#scopes-count')).toBe('1 commits');
  });
});

describe('event stream', () => {
  test('streams over SSE, filters by level and family, pauses, and reports a closed stream', async () => {
    const c = openConsole({ hash: '#/events' });
    await flush();
    const source = FakeEventSource.opened.at(-1);
    if (source === undefined) throw new Error('no stream opened');
    expect(source.url).toBe('/admin/events/stream?limit=200');
    source.onopen?.();
    expect(c.text('#live')).toBe('Live');
    expect(c.$('#live').className).toContain('ok');
    for (const event of [...RING_EVENTS].reverse()) source.emit(event);
    expect(c.rows('#ev-table').length).toBe(4);
    expect(c.text('#n-events')).toBe('4');

    c.type('#ev-level', 'err');
    expect(c.rows('#ev-table').length).toBe(1);
    expect(c.text('#ev-count')).toBe('1 of 4 events');
    c.type('#ev-level', '');
    c.type('#ev-q', 'c-ben', 'input');
    expect(c.rows('#ev-table').length).toBe(1);
    c.type('#ev-q', '', 'input');

    // A family filters the buffered tail; an exact type reconnects with `type`.
    c.type('#ev-kind', 'push');
    const family = FakeEventSource.opened.at(-1);
    family?.onopen?.();
    for (const event of [...RING_EVENTS].reverse()) family?.emit(event);
    expect(c.rows('#ev-table').length).toBe(1);
    c.type('#ev-kind', 'request.handled');
    expect(FakeEventSource.opened.at(-1)?.url).toBe(
      '/admin/events/stream?limit=200&type=request.handled',
    );
    c.type('#ev-kind', '');
    const all = FakeEventSource.opened.at(-1);
    if (all === undefined) throw new Error();
    all.onopen?.();
    all.emit(RING_EVENTS[0]);

    c.key(' ');
    expect(c.text('#live')).toBe('Paused');
    all.emit(CONFLICT);
    all.emit(CONFLICT);
    expect(c.rows('#ev-table').length).toBe(1);
    expect(c.text('#ev-pause')).toBe('Resume (2)');
    c.click('#ev-pause');
    expect(c.rows('#ev-table').length).toBe(3);

    c.click('#ev-table tr[data-i="0"]');
    expect(c.text('#m-title')).toBe('push.conflicted');
    expect(c.text('#m-kicker')).toBe('warn event');
    c.click('#m-close');

    all.onerror?.();
    expect(all.closed).toBe(true);
    expect(c.text('#live')).toBe('Stream closed');
    expect(c.text('#ev-banner')).toContain('Stream closed');
    c.click('#ev-banner [data-act="reconnect"]');
    expect(FakeEventSource.opened.at(-1)).not.toBe(all);
  });

  test('the parent transport polls and says so', async () => {
    const posted: {
      kind: string;
      id: number;
      path: string;
      method: string;
    }[] = [];
    const c = openConsole({
      search: '?transport=parent',
      hash: '#/events',
      onPost: (message) => {
        posted.push(message);
      },
    });
    const respond = () => {
      for (const message of posted.splice(0)) {
        const route = ROUTES[message.path.split('?')[0] ?? ''];
        const body =
          route === undefined || typeof route === 'function'
            ? { code: 'test.no_fixture' }
            : route.body;
        c.window.dispatchEvent(
          new c.window.MessageEvent('message', {
            data: {
              kind: 'syncular-admin-response',
              id: message.id,
              ok: route !== undefined,
              status: 200,
              body,
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
    expect(posted.map((message) => message.path)).toContain(
      '/events?limit=200',
    );
    respond();
    await flush();
    expect(FakeEventSource.opened.length).toBe(0);
    expect(c.text('#live')).toBe('Polling');
    expect(c.text('#ev-banner')).toContain('parent-frame transport');
    expect(c.rows('#ev-table').length).toBe(4);
  });
});

describe('writes', () => {
  const writable = { '/info': { body: { ...INFO, writes: true } } };

  test('a read-only admin shows no write controls', async () => {
    const c = openConsole({ hash: '#/reactions' });
    await flush();
    c.click('#rx-table tr[data-i="0"]');
    expect(c.document.querySelector('[data-act="retry"]')).toBeNull();
  });

  test('retrying a dead letter confirms, posts, and shows the answer', async () => {
    const c = openConsole({
      hash: '#/reactions',
      routes: {
        ...writable,
        'POST /*': (url) => ({
          body: {
            reaction: {
              idempotencyKey: decodeURIComponent(
                url.pathname.split('/')[3] ?? '',
              ),
              status: 'pending',
            },
          },
        }),
      },
    });
    await flush();
    expect(c.rows('#rx-table')[0]).toContain('mail.bounced');
    expect(c.text('#n-reactions')).toBe('1 dead');
    c.click('#rx-table tr[data-i="0"]');
    c.click('#m-sum [data-act="retry"]');
    expect(c.open('#confirm')).toBe(true);
    expect(c.text('#c-body')).toContain('POST /reactions/card%3A1/retry');
    expect(c.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    c.click('#c-ok');
    await flush();
    expect(c.requests).toContain('POST /admin/reactions/card%3A1/retry');
    expect(c.text('#c-body')).toContain('"status": "pending"');
    expect(c.text('#c-cancel')).toBe('Close');
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
    expect(c.text('#c-text')).toBe('Prune the commit log');
    c.click('#c-ok');
    await flush();
    expect(c.requests).toContain('POST /admin/prune');
    expect(c.text('#c-body')).toContain('sync.forbidden');
    expect(c.text('#c-body')).toContain('HTTP 403');
  });
});

describe('storage and navigation', () => {
  test('storage labels approximate counters and missing stores', async () => {
    const c = openConsole({ hash: '#/storage' });
    await flush();
    expect(c.text('#seg-meta')).toBe('approximate');
    expect(c.text('#st-seg')).toContain('SQLite images');
    expect(c.text('#st-blob')).toContain('No blob stats');
    expect(c.text('#st-horizon')).toContain('Prune recommended');
  });

  test('keyboard shortcuts switch views and open the shortcut list', async () => {
    const c = openConsole();
    await flush();
    c.key('3');
    await flush();
    expect(c.window.location.hash).toBe('#/commits');
    expect(c.$('#view-commits').hasAttribute('hidden')).toBe(false);
    expect(c.$('#view-overview').hasAttribute('hidden')).toBe(true);
    c.key('5');
    expect(c.window.location.hash).toBe('#/trace');
    c.key('a');
    expect(c.value('#auto')).toBe('2000');
    c.key('a');
    c.key('a');
    c.key('a');
    expect(c.value('#auto')).toBe('0');
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
