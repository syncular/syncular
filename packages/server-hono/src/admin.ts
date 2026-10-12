/**
 * Admin / console HTTP surface: a mountable Hono sub-app over a
 * `SyncularAdmin`. JSON endpoints mirror the admin surface; a single static
 * HTML page (zero framework, no build step) at `GET /` renders them.
 *
 * The auth seam is REQUIRED. There is NO default-open admin: the factory
 * refuses to mount without a host-provided `authorize` guard (it throws at
 * construction). Every request runs the guard first; a falsy result is a
 * 401. Admin is a privileged surface (it reads every partition's clients,
 * rows, commits, scope activity, and reactions) and authorization is
 * entirely the host's and mandatory. The operator actions (`POST` routes)
 * additionally require `authorizeWrite`; without it they answer 403.
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
   * The partition the request targets (`?partition=`, else the default).
   * Empty for `GET /partitions`, which spans every partition.
   */
  readonly partition: string;
  readonly request: Request;
}

export interface SyncularAdminRoutesOptions {
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
   * reports `writes: false`.
   */
  readonly authorizeWrite?: (
    ctx: AdminAuthContext,
  ) => boolean | Promise<boolean>;
  /**
   * Serve every partition-scoped request elsewhere once the guards pass.
   * The page and `GET /partitions` stay local. The Workers adapter forwards
   * to the partition's Durable Object, whose event ring sees that
   * partition's sync rounds.
   */
  readonly forward?: (
    request: Request,
    target: { readonly partition: string; readonly writes: boolean },
  ) => Promise<Response>;
  /**
   * Default partition for endpoints when the request omits `?partition=`.
   * When unset, `partition` is required on every data endpoint.
   */
  readonly defaultPartition?: string;
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
 * Build the mountable admin sub-app. Mount it under any prefix, e.g.
 * `app.route('/admin', createSyncularAdminRoutes(admin, { authorize }))`.
 * Throws if `authorize` is missing — admin never mounts default-open.
 */
export function createSyncularAdminRoutes(
  admin: SyncularAdmin,
  options: SyncularAdminRoutesOptions,
): Hono {
  if (typeof options.authorize !== 'function') {
    throw new Error(
      'createSyncularAdminRoutes: an `authorize` guard is required — admin never mounts default-open',
    );
  }
  const app = new Hono();
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

  /** Resolve the request's partition (query, else default) — required. */
  function partitionOf(c: QueryContext): string {
    const partition = c.req.query('partition') ?? options.defaultPartition;
    if (partition === undefined || partition.length === 0) {
      throw new SyncError('sync.invalid_request', 'partition is required');
    }
    return partition;
  }

  // Guard every route (page + data) up front; actions also need the write
  // guard.
  app.use('*', async (c, next) => {
    // The fleet view spans every partition, so its guard sees none: a guard
    // that grants single partitions never grants the whole fleet.
    const context = {
      partition: c.req.path.endsWith('/partitions')
        ? ''
        : (c.req.query('partition') ?? options.defaultPartition ?? ''),
      request: c.req.raw,
    };
    if (!(await options.authorize(context))) {
      throw new SyncError('sync.auth_required');
    }
    if (c.req.method === 'POST' && !(await options.authorizeWrite?.(context))) {
      throw new SyncError('sync.forbidden', 'admin writes are not authorized');
    }
    await next();
  });

  // The single static console page (zero framework, no build step).
  app.get('/', (c) =>
    c.html(ADMIN_CONSOLE_HTML, 200, { 'Cache-Control': 'no-store' }),
  );

  // Cross-partition fleet view: the ONE endpoint that is not partition-
  // scoped (the guard runs with `partition` empty).
  app.get('/partitions', async (c) => {
    const limit = intParam(c, 'limit');
    const offset = intParam(c, 'offset');
    return Response.json(
      await admin.partitionsOverview({
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      }),
    );
  });

  const forward = options.forward;
  if (forward !== undefined) {
    app.all('*', (c) =>
      forward(c.req.raw, {
        partition: partitionOf(c),
        writes: options.authorizeWrite !== undefined,
      }),
    );
    return app;
  }

  app.get('/info', () =>
    Response.json({
      hasEventStream: admin.hasEventStream,
      writes: options.authorizeWrite !== undefined,
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
      await admin.listClients(partitionOf(c), {
        ...(limit !== undefined ? { limit } : {}),
        ...(sort !== undefined ? { sort } : {}),
      }),
    );
  });

  app.get('/clients/:clientId', async (c) => {
    const eventLimit = intParam(c, 'eventLimit');
    const detail = await admin.clientDetail(
      partitionOf(c),
      c.req.param('clientId'),
      eventLimit !== undefined ? { eventLimit } : {},
    );
    return Response.json({ detail });
  });

  app.get('/metrics', (c) => {
    const windowMs = intParam(c, 'windowMs');
    const metrics = admin.metrics(
      partitionOf(c),
      windowMs !== undefined ? { windowMs } : {},
    );
    return Response.json({ metrics });
  });

  app.get('/errors', (c) => {
    const windowMs = intParam(c, 'windowMs');
    const errors = admin.errors(
      partitionOf(c),
      windowMs !== undefined ? { windowMs } : {},
    );
    return Response.json({ errors });
  });

  app.get('/commits', async (c) => {
    const table = c.req.query('table');
    const afterSeq = intParam(c, 'afterSeq');
    const beforeSeq = intParam(c, 'beforeSeq');
    const limit = intParam(c, 'limit');
    const commits = await admin.listCommits(partitionOf(c), {
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(table !== undefined ? { table } : {}),
    });
    return Response.json({ commits });
  });

  app.get('/commits/:commitSeq{[0-9]+}', async (c) => {
    const commit = await admin.commitDetail(
      partitionOf(c),
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
    const reactions = await admin.listReactions(partitionOf(c), {
      ...(status !== undefined ? { statuses: [status as ReactionStatus] } : {}),
      ...(type !== undefined ? { types: [type] } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return Response.json({ reactions });
  });

  app.get('/rows/:table/:rowId', async (c) => {
    const historyLimit = intParam(c, 'historyLimit');
    const row = await admin.inspectRow(
      partitionOf(c),
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
    const trace = await admin.traceRow(partitionOf(c), {
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
      partitionOf(c),
      { variable, value },
      limit !== undefined ? { limit } : {},
    );
    return Response.json({ activity });
  });

  app.get('/horizon', async (c) =>
    Response.json({ horizon: await admin.horizonStatus(partitionOf(c)) }),
  );

  app.get('/stats', async (c) =>
    Response.json({ stats: await admin.stats(partitionOf(c)) }),
  );

  /** The ring filters shared by the polled tail and the SSE stream. */
  function eventFilterOf(
    c: QueryContext,
  ): Omit<RingEventQuery, 'limit' | 'sinceMs'> {
    const type = c.req.query('type') as RingEventQuery['type'];
    const clientId = c.req.query('clientId');
    const actorId = c.req.query('actorId');
    return {
      partition: partitionOf(c),
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

  // -- operator actions (authorizeWrite) ------------------------------------

  app.post('/reactions/:idempotencyKey/retry', async (c) => {
    const reaction = await admin.retryReaction(
      partitionOf(c),
      c.req.param('idempotencyKey'),
    );
    return Response.json({ reaction });
  });

  app.post('/prune', async (c) =>
    Response.json({ prune: await admin.prune(partitionOf(c)) }),
  );

  app.post('/clients/:clientId/revoke-lease', async (c) => {
    const lease = await admin.revokeLease(
      partitionOf(c),
      c.req.param('clientId'),
    );
    return Response.json({ lease });
  });

  return app;
}
