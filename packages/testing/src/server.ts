/**
 * The in-memory test server: one `SqliteServerStorage` (`:memory:`), a
 * `MemorySegmentStore`, and a `RealtimeHub`, all sharing the test's virtual
 * clock. It is the SHIPPED `@syncular-v2/server` core — the kit adds no
 * server logic, it only wires the pieces an app would wire in production
 * (minus the HTTP adapter). Clients reach it through the loopback seam in
 * `client.ts`, calling `handleSyncRequest` / `handleSegmentDownload`
 * directly.
 */
import {
  createRealtimeHub,
  MemorySegmentStore,
  type RealtimeHub,
  type ResolveScopes,
  type ServerSchema,
  SqliteServerStorage,
  type SyncRequestContext,
} from '@syncular-v2/server';
import {
  type ClientSchema,
  compileClientSchema,
} from '@syncular-v2/web-client';
import type { VirtualClock } from './clock';

/** Default partition every actor lives in (apps override via options). */
export const DEFAULT_PARTITION = 'test';
/** Default actor a client is bound to when none is given. */
export const DEFAULT_ACTOR = 'test-actor';

/**
 * `resolveScopes` that grants every value (`'*'`) for every scope variable
 * the schema declares — the "no authorization, just make it converge"
 * default an app test wants. Override with your own resolver to exercise
 * scope-scoping / revocation.
 */
export function allowAllScopes(schema: ClientSchema): ResolveScopes {
  const compiled = compileClientSchema(schema);
  const variables = new Set<string>();
  for (const table of compiled.tables.values()) {
    for (const variable of table.scopeColumnByVariable.keys()) {
      variables.add(variable);
    }
  }
  const allowed: Record<string, string[]> = {};
  for (const variable of variables) allowed[variable] = ['*'];
  return () => allowed;
}

export interface TestServerOptions {
  readonly schema: ClientSchema;
  readonly clock: VirtualClock;
  readonly partition: string;
  /** Defaults to {@link allowAllScopes}. */
  readonly resolveScopes?: ResolveScopes;
}

/**
 * The server half of a test sync. `ctxFor(actorId)` builds the per-request
 * context the loopback transport feeds `handleSyncRequest`; `hub` is the
 * realtime fanout every client's socket attaches to.
 */
export interface TestServer {
  readonly storage: SqliteServerStorage;
  readonly segments: MemorySegmentStore;
  readonly hub: RealtimeHub;
  readonly partition: string;
  ctxFor(actorId: string): SyncRequestContext;
  close(): void;
}

export function createTestServer(options: TestServerOptions): TestServer {
  const { schema, clock, partition } = options;
  const serverSchema = schema as ServerSchema;
  const storage = new SqliteServerStorage();
  const segments = new MemorySegmentStore();
  const resolveScopes = options.resolveScopes ?? allowAllScopes(schema);
  const clockFn = () => clock.now();
  const hub = createRealtimeHub({
    schema: serverSchema,
    storage,
    resolveScopes,
    clock: clockFn,
    segments,
  });
  return {
    storage,
    segments,
    hub,
    partition,
    ctxFor: (actorId) => ({
      partition,
      actorId,
      schema: serverSchema,
      storage,
      segments,
      resolveScopes,
      clock: clockFn,
      realtime: hub,
    }),
    close: () => {
      storage.db.close();
    },
  };
}
