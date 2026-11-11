/**
 * The optional client-side introspection registry: a configured
 * `SyncClient` / `SyncClientHandle` on a development page registers itself on
 * `globalThis.__SYNCULAR__`, so a first integration debugs from the console
 * instead of hand-exposing the client:
 *
 *     __SYNCULAR__.clients            // the live entries
 *     await __SYNCULAR__.snapshot()   // one plain object per client:
 *                                     // outbox depth, units,
 *                                     // conflicts, syncNeeded, upgrading,
 *                                     // last invalidation
 *     __SYNCULAR__.clients[0].ref     // the client itself — full API
 *
 * The host explicitly supplies `registerDevtools` in its client config. The
 * registry also requires a development or test environment signal and a
 * `window`. A browser without a development signal leaves it disabled.
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
  readonly units: () => Promise<readonly unknown[]>;
  readonly conflicts: () => Promise<number>;
  readonly rejections: () => Promise<number>;
  readonly syncNeeded: () => Promise<boolean>;
  readonly upgrading: () => Promise<boolean>;
  readonly onInvalidate: (listener: InvalidationListener) => () => void;
}

/** Explicit development registry supplied to a client or worker handle. */
export type DevtoolsRegistrar = (
  registration: DevtoolsRegistration,
) => () => void;

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

/**
 * @internal True when the build carries a development or test signal and no
 * production one. The registry and `@syncular/client/dev` read it.
 */
export function developmentBuild(): boolean {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'production')
    return false;
  return (
    (typeof import.meta.env !== 'undefined' &&
      (import.meta.env.DEV as boolean | string | undefined) === true) ||
    (typeof process !== 'undefined' &&
      (process.env.NODE_ENV === 'development' ||
        process.env.NODE_ENV === 'test'))
  );
}

/** The page global to install on, or undefined when gated off. */
function registryHost(): Record<string, unknown> | undefined {
  const g = globalThis as Record<string, unknown> & { window?: unknown };
  return g.window !== undefined && developmentBuild() ? g : undefined;
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
          units: await entry
            .units()
            .then((units) => units.length)
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
