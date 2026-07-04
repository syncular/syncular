/**
 * Admin / console HTTP surface (TODO §2.5) — a mountable Hono sub-app over a
 * `SyncularAdmin`. JSON endpoints mirror the read surface; a single static
 * HTML page (zero framework, no build step) at `GET /` renders them.
 *
 * The auth seam is REQUIRED. There is NO default-open admin: the factory
 * refuses to mount without a host-provided `authorize` guard (it throws at
 * construction). Every request runs the guard first; a falsy result is a
 * 401. Admin is a privileged surface (it reads every partition's clients,
 * commit metadata, and scope activity) and SPEC.md deliberately says nothing
 * about it — authorization is entirely the host's, and mandatory.
 */
import {
  errorBody,
  type RingEventQuery,
  SyncError,
  type SyncularAdmin,
} from '@syncular-v2/server';
import { Hono } from 'hono';
import { ADMIN_CONSOLE_HTML } from './admin-page';

export interface AdminAuthContext {
  /** The partition the request targets (from the query string / route). */
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
   * Default partition for endpoints when the request omits `?partition=`.
   * When unset, `partition` is required on every data endpoint.
   */
  readonly defaultPartition?: string;
}

function jsonError(error: unknown): Response {
  const sync =
    error instanceof SyncError
      ? error
      : new SyncError('sync.invalid_request', String(error));
  return Response.json(errorBody(sync), { status: sync.httpStatus });
}

function intParam(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
      'createSyncularAdminRoutes: an `authorize` guard is required — admin never mounts default-open (TODO §2.5)',
    );
  }
  const app = new Hono();

  /** Resolve the request's partition (query, else default) — required. */
  function partitionOf(c: {
    req: { query: (k: string) => string | undefined };
  }): string {
    const partition = c.req.query('partition') ?? options.defaultPartition;
    if (partition === undefined || partition.length === 0) {
      throw new SyncError('sync.invalid_request', 'partition is required');
    }
    return partition;
  }

  // Guard every route (page + data) up front.
  app.use('*', async (c, next) => {
    let partition: string;
    try {
      partition = c.req.query('partition') ?? options.defaultPartition ?? '';
    } catch {
      partition = '';
    }
    const ok = await options.authorize({ partition, request: c.req.raw });
    if (!ok) return jsonError(new SyncError('sync.auth_required'));
    await next();
  });

  // The single static console page (zero framework, no build step).
  app.get('/', (c) =>
    c.html(ADMIN_CONSOLE_HTML, 200, { 'Cache-Control': 'no-store' }),
  );

  app.get('/clients', async (c) => {
    try {
      const clients = await admin.listClients(partitionOf(c));
      return Response.json({ clients });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get('/commits', async (c) => {
    try {
      const table = c.req.query('table');
      const commits = await admin.listCommits(partitionOf(c), {
        afterSeq: intParam(c.req.query('afterSeq'), 0),
        limit: intParam(c.req.query('limit'), 50),
        ...(table !== undefined ? { table } : {}),
      });
      return Response.json({ commits });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get('/rows/:table/:rowId', async (c) => {
    try {
      const row = await admin.inspectRow(
        partitionOf(c),
        c.req.param('table'),
        c.req.param('rowId'),
      );
      return Response.json({ row });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get('/scope-activity', async (c) => {
    try {
      const variable = c.req.query('variable');
      const value = c.req.query('value');
      if (variable === undefined || value === undefined) {
        throw new SyncError(
          'sync.invalid_request',
          'variable and value are required',
        );
      }
      const activity = await admin.scopeActivity(
        partitionOf(c),
        { variable, value },
        { limit: intParam(c.req.query('limit'), 50) },
      );
      return Response.json({ activity });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get('/horizon', async (c) => {
    try {
      const status = await admin.horizonStatus(partitionOf(c));
      return Response.json({ horizon: status });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get('/stats', async (c) => {
    try {
      const stats = await admin.stats(partitionOf(c));
      return Response.json({ stats });
    } catch (error) {
      return jsonError(error);
    }
  });

  app.get('/events', async (c) => {
    try {
      const type = c.req.query('type') as RingEventQuery['type'];
      const sinceMs = c.req.query('sinceMs');
      const events = admin.events({
        ...(type !== undefined ? { type } : {}),
        ...(sinceMs !== undefined ? { sinceMs: intParam(sinceMs, 0) } : {}),
        limit: intParam(c.req.query('limit'), 200),
      });
      return Response.json({ events, hasEventStream: admin.hasEventStream });
    } catch (error) {
      return jsonError(error);
    }
  });

  return app;
}
