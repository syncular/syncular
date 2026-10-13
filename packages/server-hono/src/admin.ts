/**
 * Admin / console HTTP surface: a mountable Hono sub-app over a
 * `SyncularAdmin`. JSON endpoints mirror the admin surface; a single static
 * HTML page (zero framework, no build step) at `GET /` renders them.
 * Hosts mount it through `createSyncularHono({ admin })` or
 * `createWorkersFetchHandler({ admin })`; this module is their shared
 * implementation.
 *
 * The auth seam is REQUIRED. There is NO default-open admin: the factory
 * refuses to mount without a host-provided `authorize` guard (it throws at
 * construction). Every request runs the guard first; a falsy result is a
 * 401. Admin is a privileged surface (it reads every partition's clients,
 * rows, commits, scope activity, and reactions) and authorization is
 * entirely the host's and mandatory. The operator actions (`POST` routes)
 * additionally require `authorizeActions`; without it they answer 403.
 */
import {
  errorBody,
  adapterSyncError,
  matchesRingQuery,
  type ReactionStatus,
  type RingEventQuery,
  SyncError,
  type SyncularAdmin,
  type SyncularErrorHandler,
  type SyncularErrorMapper,
  type SyncularServerEvent,
} from '@syncular/server';
import { Hono } from 'hono';
import { ADMIN_CONSOLE_HTML } from './admin-page';

export interface AdminAuthContext {
  /**
   * The partition the request targets: `?partition=`, else the only
   * partition of the deployment. Empty for the page without `?partition=`
   * and for `GET /partitions`, which spans every partition.
   */
  readonly partition: string;
  readonly request: Request;
}

/** The console guards, shared by the Hono and Workers `admin` options. */
export interface SyncularAdminGuards {
  /**
   * REQUIRED host guard. Return `true` (or a truthy value) to allow the
   * request, a falsy value to reject it with 401. Runs before every admin
   * endpoint, including the HTML page. There is no default — omitting it
   * throws, by design (no default-open admin).
   */
  readonly authorize: (ctx: AdminAuthContext) => boolean | Promise<boolean>;
  /**
   * Guard for the operator actions (retry a dead-lettered reaction, prune,
   * revoke a lease), run after `authorize`. A falsy result answers 403
   * `sync.forbidden`. Omitted ⇒ every action answers 403 and `GET /info`
   * reports `actions: false`.
   */
  readonly authorizeActions?: (
    ctx: AdminAuthContext,
  ) => boolean | Promise<boolean>;
}

/** @internal The adapters' route options; hosts use their `admin` option. */
export interface SyncularAdminRoutesOptions extends SyncularAdminGuards {
  /**
   * Serve every partition-scoped request elsewhere once the guards pass.
   * The page and `GET /partitions` stay local. The Workers adapter forwards
   * to the partition's Durable Object, whose event ring sees that
   * partition's sync rounds.
   */
  readonly forward?: (
    request: Request,
    target: { readonly partition: string; readonly actions: boolean },
  ) => Promise<Response>;
  /**
   * Host error reporting: receives every exception that is not a
   * `SyncError`, which answers 500 `sync.internal_error` (§10.2).
   */
  readonly onError?: SyncularErrorHandler;
  /**
   * Optional synchronous mapper (§10.2) for those exceptions; return a catalog
   * `SyncError` to answer with it, or `undefined` for `sync.internal_error`.
   */
  readonly mapError?: SyncularErrorMapper;
}

type QueryContext = { req: { query: (k: string) => string | undefined } };

/** An optional integer query parameter; a malformed value is a 400. */
function intParam(c: QueryContext, name: string): number | undefined {
  const value = c.req.query(name);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) {
    throw new SyncError(
      'sync.invalid_request',
      'query parameter must be an integer',
      JSON.stringify({ parameter: name }),
    );
  }
  return Number.parseInt(value, 10);
}

/**
 * @internal Build the admin sub-app the adapters mount. Throws if
 * `authorize` is missing — admin never mounts default-open.
 */
export function createSyncularAdminRoutes(
  admin: SyncularAdmin,
  options: SyncularAdminRoutesOptions,
): Hono<{ Variables: { partition: string } }> {
  if (typeof options.authorize !== 'function') {
    throw new Error(
      'admin: an `authorize` guard is required — admin never mounts default-open',
    );
  }
  const app = new Hono<{ Variables: { partition: string } }>();
  const jsonError = (error: unknown): Response => {
    const sync = adapterSyncError(
      error,
      (error, context) => options.onError?.(error, context),
      'admin',
      (error, context) => options.mapError?.(error, context),
    );
    return Response.json(errorBody(sync), { status: sync.httpStatus });
  };
  // Every route throws its failures; this answers them as catalog errors.
  app.onError((error) => jsonError(error));

  /** Run the host guards; actions also need `authorizeActions`. */
  async function guard(request: Request, partition: string): Promise<void> {
    const context = { partition, request };
    if (!(await options.authorize(context))) {
      throw new SyncError('sync.auth_required');
    }
    if (
      request.method === 'POST' &&
      !(await options.authorizeActions?.(context))
    ) {
      throw new SyncError('sync.forbidden', 'admin actions are not authorized');
    }
  }

  // The single static console page (zero framework, no build step).
  app.get('/', async (c) => {
    await guard(c.req.raw, c.req.query('partition') ?? '');
    return c.html(ADMIN_CONSOLE_HTML, 200, { 'Cache-Control': 'no-store' });
  });

  // Cross-partition fleet view: the ONE endpoint that is not partition-
  // scoped. Its guard sees no partition, so a guard that grants single
  // partitions never grants the whole fleet.
  app.get('/partitions', async (c) => {
    await guard(c.req.raw, '');
    const limit = intParam(c, 'limit');
    const offset = intParam(c, 'offset');
    return Response.json(
      await admin.partitionsOverview({
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      }),
    );
  });

  // Every other route is partition-scoped: `?partition=`, else the
  // deployment's only partition. The guards run on the resolved partition.
  app.use('*', async (c, next) => {
    let partition = c.req.query('partition') ?? '';
    if (partition === '') {
      const partitions = await admin.listPartitions();
      if (partitions.length !== 1) {
        // The registry size is fleet knowledge: only the fleet guard may
        // learn that the partition is ambiguous.
        await guard(c.req.raw, '');
        throw new SyncError(
          'sync.invalid_request',
          'partition is required',
          JSON.stringify({ parameter: 'partition' }),
        );
      }
      partition = partitions[0]!;
    }
    await guard(c.req.raw, partition);
    c.set('partition', partition);
    await next();
  });

  const forward = options.forward;
  if (forward !== undefined) {
    app.all('*', (c) =>
      forward(c.req.raw, {
        partition: c.get('partition'),
        actions: options.authorizeActions !== undefined,
      }),
    );
    return app;
  }

  app.get('/info', (c) =>
    Response.json({
      partition: c.get('partition'),
      hasEventStream: admin.hasEventStream,
      actions: options.authorizeActions !== undefined,
      realtime: admin.hasRealtime,
      ...(admin.schemaVersion !== undefined
        ? { schemaVersion: admin.schemaVersion }
        : {}),
      tables: admin.tables(),
    }),
  );

  app.get('/clients', async (c) => {
    const sort = c.req.query('sort');
    if (sort !== undefined && sort !== 'seen' && sort !== 'lag') {
      throw new SyncError(
        'sync.invalid_request',
        'sort must be seen or lag',
        JSON.stringify({ sort }),
      );
    }
    const limit = intParam(c, 'limit');
    return Response.json(
      await admin.listClients(c.get('partition'), {
        ...(limit !== undefined ? { limit } : {}),
        ...(sort !== undefined ? { sort } : {}),
      }),
    );
  });

  app.get('/actors', async (c) =>
    Response.json({ actors: await admin.actors(c.get('partition')) }),
  );

  app.get('/search', async (c) =>
    Response.json({
      search: await admin.search(c.get('partition'), c.req.query('q') ?? ''),
    }),
  );

  app.get('/writes/:clientCommitId', async (c) =>
    Response.json({
      write: await admin.findWrite(
        c.get('partition'),
        c.req.param('clientCommitId'),
      ),
    }),
  );

  app.get('/tables', async (c) => {
    const counts = await admin.tableCounts(c.get('partition'));
    return Response.json({
      tables: admin
        .tables()
        .map((table) => ({ ...table, rowCount: counts[table.name] ?? 0 })),
    });
  });

  app.get('/clients/:clientId', async (c) => {
    const eventLimit = intParam(c, 'eventLimit');
    const detail = await admin.clientDetail(
      c.get('partition'),
      c.req.param('clientId'),
      eventLimit !== undefined ? { eventLimit } : {},
    );
    return Response.json({ detail });
  });

  app.get('/metrics', (c) => {
    const windowMs = intParam(c, 'windowMs');
    const metrics = admin.metrics(
      c.get('partition'),
      windowMs !== undefined ? { windowMs } : {},
    );
    return Response.json({ metrics });
  });

  app.get('/errors', (c) => {
    const windowMs = intParam(c, 'windowMs');
    const errors = admin.errors(
      c.get('partition'),
      windowMs !== undefined ? { windowMs } : {},
    );
    return Response.json({ errors });
  });

  app.get('/commits', async (c) => {
    const table = c.req.query('table');
    const afterSeq = intParam(c, 'afterSeq');
    const beforeSeq = intParam(c, 'beforeSeq');
    const limit = intParam(c, 'limit');
    const changeSample = intParam(c, 'sample');
    const commits = await admin.listCommits(c.get('partition'), {
      ...(changeSample !== undefined ? { changeSample } : {}),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(table !== undefined ? { table } : {}),
    });
    return Response.json({ commits });
  });

  app.get('/commits/:commitSeq{[0-9]+}', async (c) => {
    const commit = await admin.commitDetail(
      c.get('partition'),
      Number.parseInt(c.req.param('commitSeq'), 10),
    );
    return Response.json({ commit });
  });

  app.get('/reactions', async (c) => {
    const status = c.req.query('status');
    const type = c.req.query('type');
    const allowed = new Set<string>([
      'pending',
      'leased',
      'completed',
      'dead-letter',
    ]);
    if (status !== undefined && !allowed.has(status)) {
      throw new SyncError('sync.invalid_request', 'invalid reaction status');
    }
    const limit = intParam(c, 'limit');
    const reactions = await admin.listReactions(c.get('partition'), {
      ...(status !== undefined ? { statuses: [status as ReactionStatus] } : {}),
      ...(type !== undefined ? { types: [type] } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return Response.json({ reactions });
  });

  app.get('/rows/:table', async (c) => {
    const scope = c.req.query('scope');
    const separator = scope?.indexOf(':') ?? -1;
    if (scope !== undefined && separator <= 0) {
      throw new SyncError(
        'sync.invalid_request',
        'scope must be variable:value',
        JSON.stringify({ scope }),
      );
    }
    const afterRowId = c.req.query('afterRowId');
    const limit = intParam(c, 'limit');
    const page = await admin.listRows(
      c.get('partition'),
      c.req.param('table'),
      {
        ...(afterRowId !== undefined ? { afterRowId } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(scope !== undefined
          ? {
              scope: {
                variable: scope.slice(0, separator),
                value: scope.slice(separator + 1),
              },
            }
          : {}),
      },
    );
    return Response.json({ page });
  });

  app.get('/rows/:table/:rowId/delivery', async (c) =>
    Response.json({
      delivery: await admin.rowDelivery(
        c.get('partition'),
        c.req.param('table'),
        c.req.param('rowId'),
      ),
    }),
  );

  app.get('/rows/:table/:rowId', async (c) => {
    const historyLimit = intParam(c, 'historyLimit');
    const row = await admin.inspectRow(
      c.get('partition'),
      c.req.param('table'),
      c.req.param('rowId'),
      historyLimit !== undefined ? { historyLimit } : {},
    );
    return Response.json({ row });
  });

  app.get('/trace', async (c) => {
    const table = c.req.query('table');
    const rowId = c.req.query('rowId');
    const clientId = c.req.query('clientId');
    if (table === undefined || rowId === undefined || clientId === undefined) {
      throw new SyncError(
        'sync.invalid_request',
        'table, rowId and clientId are required',
      );
    }
    const trace = await admin.traceRow(c.get('partition'), {
      table,
      rowId,
      clientId,
    });
    return Response.json({ trace });
  });

  app.get('/scope-activity', async (c) => {
    const variable = c.req.query('variable');
    const value = c.req.query('value');
    if (variable === undefined || value === undefined) {
      throw new SyncError(
        'sync.invalid_request',
        'variable and value are required',
      );
    }
    const limit = intParam(c, 'limit');
    const activity = await admin.scopeActivity(
      c.get('partition'),
      { variable, value },
      limit !== undefined ? { limit } : {},
    );
    return Response.json({ activity });
  });

  app.get('/horizon', async (c) =>
    Response.json({ horizon: await admin.horizonStatus(c.get('partition')) }),
  );

  app.get('/stats', async (c) =>
    Response.json({ stats: await admin.stats(c.get('partition')) }),
  );

  /** The ring filters shared by the polled tail and the SSE stream. */
  function eventFilterOf(
    c: QueryContext & { get: (key: 'partition') => string },
  ): Omit<RingEventQuery, 'limit' | 'sinceMs'> {
    const type = c.req.query('type') as RingEventQuery['type'];
    const clientId = c.req.query('clientId');
    const actorId = c.req.query('actorId');
    const requestId = c.req.query('requestId');
    return {
      partition: c.get('partition'),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
      ...(actorId !== undefined ? { actorId } : {}),
    };
  }

  app.get('/events', (c) => {
    const sinceMs = intParam(c, 'sinceMs');
    const events = admin.events({
      ...eventFilterOf(c),
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      limit: intParam(c, 'limit') ?? 200,
    });
    return Response.json({ events });
  });

  // Live event tail over SSE, fed by the ring's subscribe hook. Plain
  // web-streams (no filesystem, no Node API), so it serves identically on
  // Bun, Node, and Workers. A recent backlog is replayed first (oldest →
  // newest), then events stream as they land; a comment ping every 5 s
  // keeps the connection under runtime idle timeouts (Bun.serve drops an
  // idle response after 10 s by default) and intermediaries alive.
  app.get('/events/stream', (c) => {
    if (!admin.hasEventStream) {
      throw new SyncError(
        'sync.invalid_request',
        'no RingBufferEvents wired on this admin — the event stream is off',
      );
    }
    const filter = eventFilterOf(c);
    const backlogLimit = intParam(c, 'limit') ?? 50;
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: SyncularServerEvent): void => {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          } catch {
            stop(); // the consumer went away mid-enqueue
          }
        };
        controller.enqueue(encoder.encode('retry: 2000\n\n'));
        for (const event of admin
          .events({ ...filter, limit: backlogLimit })
          .reverse()) {
          send(event);
        }
        unsubscribe = admin.subscribeEvents((event) => {
          if (matchesRingQuery(event, filter)) send(event);
        });
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            stop();
          }
        }, 5_000);
      },
      cancel() {
        stop();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
      },
    });
  });

  // -- operator actions (authorizeActions) ----------------------------------

  app.post('/reactions/:idempotencyKey/retry', async (c) => {
    const reaction = await admin.retryReaction(
      c.get('partition'),
      c.req.param('idempotencyKey'),
    );
    return Response.json({ reaction });
  });

  app.post('/prune', async (c) =>
    Response.json({ prune: await admin.prune(c.get('partition')) }),
  );

  app.post('/clients/:clientId/revoke-lease', async (c) => {
    const lease = await admin.revokeLease(
      c.get('partition'),
      c.req.param('clientId'),
    );
    return Response.json({ lease });
  });

  return app;
}
