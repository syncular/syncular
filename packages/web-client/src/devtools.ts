/**
 * The client-side introspection registry (RFC 0002 §3.2): every live
 * `SyncClient` / `SyncClientHandle` on a page registers itself on
 * `globalThis.__SYNCULAR__`, so a first integration debugs from the console
 * instead of hand-exposing the client:
 *
 *     __SYNCULAR__.clients            // the live entries
 *     await __SYNCULAR__.snapshot()   // one plain object per client:
 *                                     // outbox depth, subscriptions,
 *                                     // conflicts, syncNeeded, upgrading,
 *                                     // last invalidation
 *     __SYNCULAR__.clients[0].ref     // the client itself — full API
 *
 * Gated to development: the registry installs only where a `window` exists
 * (worker cores register through their page-side handle) and NODE_ENV is
 * anything except `'production'` (bundlers statically replace it, so
 * production builds skip installation; environments without `process` are
 * treated as dev). Cost when gated off: one function call per client.
 */
import type { InvalidationEvent, InvalidationListener } from './invalidation';

/** What a registrant supplies — plain lambdas over its own surface. */
export interface DevtoolsRegistration {
  /** `'direct'` (a `SyncClient`) or the handle's role. */
  readonly kind: 'client' | 'handle';
  /** The client/handle itself, for full-API console access. */
  readonly ref: unknown;
  readonly clientId: () => string;
  readonly role: () => string;
  readonly outbox: () => Promise<number>;
  readonly subscriptions: () => Promise<readonly unknown[]>;
  readonly conflicts: () => Promise<number>;
  readonly rejections: () => Promise<number>;
  readonly syncNeeded: () => Promise<boolean>;
  readonly upgrading: () => Promise<boolean>;
  readonly onInvalidate: (listener: InvalidationListener) => () => void;
}

/** One live entry on the registry (a registration plus tracked state). */
export interface DevtoolsEntry extends DevtoolsRegistration {
  /** The most recent invalidation event, timestamped (epoch ms). */
  lastInvalidation?: {
    readonly atMs: number;
    readonly tables: readonly string[];
    readonly scopeKeys: readonly string[];
  };
}

interface DevtoolsRegistry {
  readonly clients: DevtoolsEntry[];
  snapshot(): Promise<Record<string, unknown>[]>;
}

const KEY = '__SYNCULAR__';

/** The page global to install on, or undefined when gated off. */
function registryHost(): Record<string, unknown> | undefined {
  const g = globalThis as Record<string, unknown> & {
    window?: unknown;
    process?: { env?: { NODE_ENV?: string } };
  };
  if (g.window === undefined) return undefined;
  if (g.process?.env?.NODE_ENV === 'production') return undefined;
  return g;
}

function registryOn(host: Record<string, unknown>): DevtoolsRegistry {
  const existing = host[KEY];
  if (existing !== undefined) return existing as DevtoolsRegistry;
  const registry: DevtoolsRegistry = {
    clients: [],
    snapshot: async () =>
      Promise.all(
        registry.clients.map(async (entry) => ({
          kind: entry.kind,
          clientId: entry.clientId(),
          role: entry.role(),
          outbox: await entry.outbox().catch(() => 'unavailable'),
          subscriptions: await entry
            .subscriptions()
            .then((subs) => subs.length)
            .catch(() => 'unavailable'),
          conflicts: await entry.conflicts().catch(() => 'unavailable'),
          rejections: await entry.rejections().catch(() => 'unavailable'),
          syncNeeded: await entry.syncNeeded().catch(() => 'unavailable'),
          upgrading: await entry.upgrading().catch(() => 'unavailable'),
          lastInvalidation: entry.lastInvalidation,
        })),
      ),
  };
  host[KEY] = registry;
  return registry;
}

/**
 * Register a client on the page registry. Returns the unregister function
 * (a no-op when the registry is gated off) — call it from `close()`.
 */
export function registerDevtools(
  registration: DevtoolsRegistration,
): () => void {
  const host = registryHost();
  if (host === undefined) return () => {};
  const registry = registryOn(host);
  const entry: DevtoolsEntry = { ...registration };
  const unlisten = registration.onInvalidate((event: InvalidationEvent) => {
    entry.lastInvalidation = {
      atMs: Date.now(),
      tables: [...event.tables],
      scopeKeys: [...event.scopeKeys],
    };
  });
  registry.clients.push(entry);
  return () => {
    unlisten();
    const index = registry.clients.indexOf(entry);
    if (index !== -1) registry.clients.splice(index, 1);
  };
}
