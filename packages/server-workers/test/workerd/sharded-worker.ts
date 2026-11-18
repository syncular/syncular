/**
 * The §8.9 Workers topology on PostgreSQL for
 * `sharded-topology.workerd.test.ts`. The Worker runs every `/sync` round
 * against PostgreSQL itself; sockets live in shard objects named by the
 * `shard` query parameter; the partition's object relays commits between
 * them. PostgreSQL is reached through the `PG` service binding, which the
 * test process answers with a `PgExecutor` (a real server or PGlite). A
 * commit whose id is `held` waits in the commit validator, under the
 * partition lock, until the test answers the `GATE` service binding. The
 * resolver reads each actor's lists from the `GRANTS` service binding, so the
 * test can revoke them. `POST /setup` creates the schema and pins the
 * partition log epoch; `POST /refresh?actor=` refreshes that actor's scopes
 * in every object; `POST /announce?actor=` announces that actor's grown
 * scopes in every object; `POST /fail-next?shard=` makes that shard object answer
 * its next relay with 503.
 */
import {
  compileSchema,
  MemorySegmentStore,
  type PgExecutor,
  type PgQueryable,
  type PgRow,
  PostgresServerStorage,
  prepareReadTransaction,
  type RealtimeHubConfig,
  type ServerSchema,
} from '@syncular/server';
import {
  createWorkersFetchHandler,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
  durableObjectRealtimeNotifier,
  type ExecutionContextLike,
  REALTIME_DO_FANOUT_PATH,
  SyncularRealtimeHost,
  type WebSocketLike,
} from '../../src/index';

const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['list:{list_id}'],
    },
  ],
};
const PARTITION = 'part-1';
const LOG_EPOCH = 'test-log-epoch';
const segments = new MemorySegmentStore();

interface ServiceBinding {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface Env {
  readonly PG: ServiceBinding;
  readonly GATE: ServiceBinding;
  readonly GRANTS: ServiceBinding;
  readonly REALTIME: DurableObjectNamespaceLike;
}

/** A `PgExecutor` over the `PG` service binding; bytes travel as base64. */
function serviceExecutor(pg: ServiceBinding): PgExecutor {
  const call = async (path: string, body: object) => {
    const response = await pg.fetch(`https://pg/${path}`, {
      method: 'POST',
      body: JSON.stringify(
        body,
        function (this: Record<string, unknown>, key: string, value: unknown) {
          const raw: unknown = this[key];
          return raw instanceof Uint8Array
            ? {
                $b: btoa(
                  Array.from(raw, (b) => String.fromCharCode(b)).join(''),
                ),
              }
            : value;
        },
      ),
    });
    const text = await response.text();
    if (response.status !== 200) {
      const { message, code } = JSON.parse(text) as {
        message: string;
        code?: string;
      };
      throw Object.assign(new Error(message), { code });
    }
    return JSON.parse(text, (_key, value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof value.$b === 'string'
        ? Uint8Array.from(atob(value.$b), (c) => c.charCodeAt(0))
        : value,
    );
  };
  const on = (tx?: string): PgQueryable => ({
    query: async <Row = PgRow>(text: string, params?: readonly unknown[]) =>
      (await call('query', { tx, text, params })) as { rows: Row[] },
  });
  return {
    ...on(),
    async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
      const { tx } = (await call('begin', {})) as { tx: string };
      let result: T;
      try {
        result = await fn(on(tx));
      } catch (error) {
        await call('rollback', { tx });
        throw error;
      }
      await call('commit', { tx });
      return result;
    },
  };
}

function syncConfig(
  env: Env,
  storage: PostgresServerStorage,
): RealtimeHubConfig {
  return {
    schema: SCHEMA,
    storage,
    segments,
    // §6.8: the resolver reads its authority in one snapshot without the
    // partition lock, so a pull never waits on a push.
    resolveScopes: async ({ partition, actorId }) => {
      const tx = await storage.begin(partition);
      try {
        await prepareReadTransaction(tx, SCHEMA.version);
        await tx.getRow('tasks', 'grant');
      } finally {
        await tx.rollback();
      }
      const lists = (await (
        await env.GRANTS.fetch(`https://grants/${actorId}`)
      ).json()) as string[];
      return { list_id: lists };
    },
    commitValidator: async ({ clientCommitId }) => {
      if (clientCommitId === 'held') await env.GATE.fetch('https://gate/');
    },
  };
}

const handler = createWorkersFetchHandler<Env>({
  config: (env, ctx) => ({
    config: {
      ...syncConfig(env, new PostgresServerStorage(serviceExecutor(env.PG))),
      realtime: durableObjectRealtimeNotifier(env.REALTIME, {
        waitUntil: (promise) => ctx.waitUntil(promise),
      }),
    },
    authenticate: async () => ({ actorId: 'actor-1', partition: PARTITION }),
  }),
  realtime: (env) => ({
    namespace: env.REALTIME,
    authenticate: (request) => ({
      partition: PARTITION,
      actorId: new URL(request.url).searchParams.get('actor') ?? '',
      clientId: new URL(request.url).searchParams.get('client') ?? '',
    }),
    shard: (_identity, request) =>
      new URL(request.url).searchParams.get('shard') ?? '',
  }),
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/setup') {
      const storage = new PostgresServerStorage(serviceExecutor(env.PG));
      await storage.ensureSchema(compileSchema(SCHEMA));
      await storage.touchPartition(PARTITION, 0, LOG_EPOCH);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/refresh') {
      await durableObjectRealtimeNotifier(env.REALTIME, {
        waitUntil: (promise) => ctx.waitUntil(promise),
      }).refreshScopes(PARTITION, url.searchParams.get('actor') ?? '');
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/announce') {
      await durableObjectRealtimeNotifier(env.REALTIME, {
        waitUntil: (promise) => ctx.waitUntil(promise),
      }).announceScopes(PARTITION, [url.searchParams.get('actor') ?? '']);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/fail-next') {
      const shard = JSON.stringify([PARTITION, url.searchParams.get('shard')]);
      return env.REALTIME.get(env.REALTIME.idFromName(shard)).fetch(
        new Request('https://do/fail-next', { method: 'POST' }),
      );
    }
    return handler(request, env, ctx);
  },
};

/** The partition's object (the relay) and every shard object. */
export class RealtimeDO {
  readonly #host: SyncularRealtimeHost<PostgresServerStorage>;
  #failNext = false;

  constructor(state: DurableObjectStateLike, env: Env) {
    this.#host = new SyncularRealtimeHost(
      state,
      new PostgresServerStorage(serviceExecutor(env.PG)),
      {
        syncConfig: (storage) => syncConfig(env, storage),
        namespace: env.REALTIME,
      },
    );
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/fail-next') {
      this.#failNext = true;
      return new Response(null, { status: 204 });
    }
    if (path === REALTIME_DO_FANOUT_PATH && this.#failNext) {
      this.#failNext = false;
      return new Response(null, { status: 503 });
    }
    return this.#host.fetch(request);
  }

  webSocketMessage(ws: WebSocketLike, message: ArrayBuffer | string) {
    return this.#host.webSocketMessage(ws, message);
  }

  webSocketClose(ws: WebSocketLike) {
    return this.#host.webSocketClose(ws);
  }

  webSocketError(ws: WebSocketLike) {
    return this.#host.webSocketError(ws);
  }

  alarm() {
    return this.#host.alarm();
  }
}
