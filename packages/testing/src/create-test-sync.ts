/**
 * `createTestSync` — the one call an app test makes. It stands up an
 * in-memory Syncular backend and hands back a factory for N real clients,
 * all sharing one virtual clock, all talking to the server through an
 * in-process loopback (no HTTP unless you ask). Everything is the SHIPPED
 * core; the kit is wiring, not a mock.
 *
 *     const sync = await createTestSync({ schema });
 *     const a = await sync.client('a');
 *     const b = await sync.client('b');
 *     a.api.subscribe({ id: 's', table: 'notes', scopes: { list_id: ['x'] } });
 *     b.api.subscribe({ id: 's', table: 'notes', scopes: { list_id: ['x'] } });
 *     a.api.mutate([{ table: 'notes', op: 'upsert', values: … }]);
 *     await sync.syncAll();           // both converge
 *     await sync.dispose();
 */

import type { ClientSchema, SyncClientConfig } from '@syncular/client';
import type {
  CommitValidator,
  ResolveScopes,
  ValidatorRegistry,
} from '@syncular/server';
import { buildTestClient, type TestClient } from './client';
import { createVirtualClock, type VirtualClock } from './clock';
import {
  createTestServer,
  DEFAULT_ACTOR,
  DEFAULT_PARTITION,
  type TestServer,
} from './server';

export interface CreateTestSyncOptions {
  /**
   * The generated schema (`syncular.generated.ts`'s `schema`, or any
   * `ClientSchema`). The same object feeds the server and every client — a
   * single-version, matched-schema world, which is what an app test wants.
   */
  readonly schema: ClientSchema;
  /** Partition every client lives in (§1.1); defaults to `"test"`. */
  readonly partition?: string;
  /** Default actor a client authenticates as; defaults to `"test-actor"`. */
  readonly actorId?: string;
  /**
   * Host authorization (§3.2 step 3). Omit for "grant everything" — the
   * default resolver returns `'*'` for every scope variable the schema
   * declares. Provide your own to test scope-scoping / revocation; it runs
   * in the server exactly as it would in production.
   */
  readonly resolveScopes?: ResolveScopes;
  /** Optional §6.7 write validators, executed by the real test server. */
  readonly validators?: ValidatorRegistry;
  /** Optional §6.8 whole-commit validator, executed by the real test server. */
  readonly commitValidator?: CommitValidator;
  /** Epoch ms the shared virtual clock starts at (default 1_750_000_000_000). */
  readonly startMs?: number;
}

export interface TestClientOverrides {
  /** Actor id for this client (defaults to the sync-wide actor). */
  readonly actorId?: string;
  /** Extra `SyncClient` config (e.g. `onConflict`, `limits`). */
  readonly clientConfig?: Partial<
    Omit<
      SyncClientConfig,
      | 'database'
      | 'schema'
      | 'clientId'
      | 'now'
      | 'transport'
      | 'segments'
      | 'realtime'
    >
  >;
}

export interface TestSync {
  /** The shared virtual clock — server + every client read it. */
  readonly clock: VirtualClock;
  /** The in-memory server (storage / segments / realtime hub). */
  readonly server: TestServer;
  /** Every client created so far, in creation order. */
  readonly clients: readonly TestClient[];
  /**
   * Create and start one client. `id` is its stable client id (§1.5);
   * omit for an auto-generated one. Returns once `start()` has run, so the
   * client is ready to `subscribe` / `mutate` immediately.
   */
  client(id?: string, overrides?: TestClientOverrides): Promise<TestClient>;
  /** `syncUntilIdle` on every online client — the "let them converge" step. */
  syncAll(): Promise<void>;
  /** Close every client and the server. Idempotent. */
  dispose(): Promise<void>;
}

export async function createTestSync(
  options: CreateTestSyncOptions,
): Promise<TestSync> {
  const partition = options.partition ?? DEFAULT_PARTITION;
  const defaultActor = options.actorId ?? DEFAULT_ACTOR;
  const clock = createVirtualClock(options.startMs);
  const server = createTestServer({
    schema: options.schema,
    clock,
    partition,
    ...(options.resolveScopes !== undefined
      ? { resolveScopes: options.resolveScopes }
      : {}),
    ...(options.validators !== undefined
      ? { validators: options.validators }
      : {}),
    ...(options.commitValidator !== undefined
      ? { commitValidator: options.commitValidator }
      : {}),
  });

  const clients: TestClient[] = [];
  let autoId = 0;
  let disposed = false;

  const sync: TestSync = {
    clock,
    server,
    clients,
    client: async (id, overrides) => {
      const clientId = id ?? `client-${++autoId}`;
      const { client, start } = buildTestClient({
        server,
        schema: options.schema,
        clock,
        id: clientId,
        actorId: overrides?.actorId ?? defaultActor,
        ...(overrides?.clientConfig !== undefined
          ? { clientConfig: overrides.clientConfig }
          : {}),
      });
      await start();
      clients.push(client);
      return client;
    },
    syncAll: async () => {
      // Sequential, not parallel: the reference server serializes anyway, and
      // sequential rounds make cross-client convergence order deterministic.
      // Repeat until no online client still has pending commits — one pass of
      // A's push may be another's pull.
      for (let pass = 0; pass < 20; pass++) {
        let progressed = false;
        for (const client of clients) {
          if (client.offline) continue;
          const before = client.api.pendingCommits().length;
          await client.sync();
          if (before > 0) progressed = true;
        }
        if (!progressed) return;
      }
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const client of clients) {
        try {
          await client.close();
        } catch {
          // best-effort teardown; keep closing the rest
        }
      }
      server.close();
    },
  };

  return sync;
}
