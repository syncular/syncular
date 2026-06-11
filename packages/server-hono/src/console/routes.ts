/**
 * @syncular/server-hono - Console API routes
 *
 * Provides monitoring and operations endpoints for the @syncular dashboard.
 *
 * Endpoints:
 * - GET  /stats           - Sync statistics
 * - GET  /commits         - Paginated commit list
 * - GET  /commits/:seq    - Single commit with changes
 * - GET  /clients         - Client cursor list
 * - GET  /handlers        - Registered handlers
 * - POST /prune           - Trigger pruning
 * - POST /prune/preview   - Preview pruning (dry run)
 * - POST /compact         - Trigger compaction
 * - DELETE /clients/:id   - Evict client
 */

import type { SqlFamily, SyncCoreDb, SyncServerAuth } from '@syncular/server';
import type { Context, Hono } from 'hono';
import { parseBearerToken } from './live-auth';
import { registerApiKeyRoutes } from './routes/api-keys';
import { registerClientRoutes } from './routes/clients';
import { registerCommitRoutes } from './routes/commits';
import { createConsoleRoutesContext } from './routes/context';
import { registerEventRoutes } from './routes/events';
import { registerMaintenanceRoutes } from './routes/maintenance';
import { registerStatsRoutes } from './routes/stats';
import { registerStorageRoutes } from './routes/storage';
import type { LiveEvent } from './schemas';
import type {
  ConsoleAuthResult,
  ConsoleEventEmitter,
  ConsoleEventListener,
  CreateConsoleRoutesOptions,
} from './types';

/**
 * Create a simple console event emitter for broadcasting live events.
 */
export function createConsoleEventEmitter(options?: {
  maxHistory?: number;
}): ConsoleEventEmitter {
  const listeners = new Set<ConsoleEventListener>();
  const history: LiveEvent[] = [];
  const maxHistory = Math.max(1, options?.maxHistory ?? 500);

  return {
    addListener(listener: ConsoleEventListener) {
      listeners.add(listener);
    },
    removeListener(listener: ConsoleEventListener) {
      listeners.delete(listener);
    },
    emit(event: LiveEvent) {
      history.push(event);
      if (history.length > maxHistory) {
        history.splice(0, history.length - maxHistory);
      }
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Ignore errors in listeners
        }
      }
    },
    replay(replayOptions) {
      const sinceMs = replayOptions?.since
        ? Date.parse(replayOptions.since)
        : Number.NaN;
      const hasSince = Number.isFinite(sinceMs);
      const normalizedPartitionId = replayOptions?.partitionId?.trim();
      const hasPartitionFilter = Boolean(normalizedPartitionId);

      const filteredByTime = hasSince
        ? history.filter((event) => {
            const eventMs = Date.parse(event.timestamp);
            return Number.isFinite(eventMs) && eventMs > sinceMs;
          })
        : history;

      const filtered = hasPartitionFilter
        ? filteredByTime.filter((event) => {
            const eventPartitionId = event.data.partitionId;
            return (
              typeof eventPartitionId === 'string' &&
              eventPartitionId === normalizedPartitionId
            );
          })
        : filteredByTime;

      const normalizedLimit =
        replayOptions?.limit && replayOptions.limit > 0
          ? Math.floor(replayOptions.limit)
          : 100;
      const limited = filtered.slice(-normalizedLimit);
      return [...limited];
    },
  };
}

export function createConsoleRoutes<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
  F extends SqlFamily = SqlFamily,
>(
  options: CreateConsoleRoutesOptions<DB, Auth, F>
): Hono<{ Variables: { consoleAuth: ConsoleAuthResult } }> {
  // The context factory operates on the base instantiation; the public
  // generic signature is preserved for callers (same as before the split,
  // where the factory body widened `options.db` via a cast internally).
  const ctx = createConsoleRoutesContext(
    options as unknown as CreateConsoleRoutesOptions
  );

  registerStatsRoutes(ctx);
  registerCommitRoutes(ctx);
  registerClientRoutes(ctx);
  registerMaintenanceRoutes(ctx);
  registerEventRoutes(ctx);
  registerApiKeyRoutes(ctx);
  registerStorageRoutes(ctx);

  return ctx.routes;
}

/**
 * Creates a simple token-based authenticator for local development.
 * The token can be set via SYNC_CONSOLE_TOKEN env var or passed directly.
 */
export function createTokenAuthenticator(
  token?: string
): (c: Context) => Promise<ConsoleAuthResult | null> {
  const expectedToken = (token ?? process.env.SYNC_CONSOLE_TOKEN)?.trim() ?? '';

  return async (c: Context) => {
    if (!expectedToken) return null;

    const bearerToken = parseBearerToken(c.req.header('Authorization'));
    if (bearerToken === expectedToken) {
      return { consoleUserId: 'token' };
    }

    return null;
  };
}
