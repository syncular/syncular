/**
 * Simplified client factory
 *
 * Breaking changes from legacy Client:
 * - handlers: plain array (no registry class)
 * - url: string instead of transport (transport auto-created)
 * - subscriptions: derived from handler.subscribe (no separate param)
 * - clientId: auto-generated (no longer required)
 */

import type {
  ColumnCodecDialect,
  ColumnCodecSource,
  ScopeDefinition,
  ScopeValues,
  SyncTransport,
} from '@syncular/core';
import { extractScopeVars } from '@syncular/core';
import { createHttpTransport } from '@syncular/transport-http';
import type { Kysely } from 'kysely';
import { Client } from './client';
import { createClientHandlerCollection } from './handlers/collection';
import { createClientHandler } from './handlers/create-handler';
import type { ClientTableHandler } from './handlers/types';
import type { SyncClientDb } from './schema';
import { randomUUID } from './utils/id';

function deriveDefaultSubscriptionScopes<DB>(args: {
  handler: Pick<ClientTableHandler<DB>, 'table' | 'scopePatterns'>;
  actorId: string;
}): ScopeValues {
  const patterns = args.handler.scopePatterns ?? [];
  const vars = new Set<string>();
  for (const pattern of patterns) {
    for (const v of extractScopeVars(pattern)) {
      vars.add(v);
    }
  }

  const allVars = Array.from(vars);
  if (allVars.length !== 1) {
    throw new Error(
      `Handler "${args.handler.table}" has subscribe=true but no explicit subscription scopes. ` +
        'Set subscribe: { scopes: { ... } } on the handler. ' +
        `(Cannot infer defaults from scopePatterns: ${
          patterns.length > 0 ? patterns.join(', ') : '(none)'
        })`
    );
  }

  const varName = allVars[0]!;
  return { [varName]: args.actorId };
}

/**
 * Auto-generate a simple handler for a table.
 * Uses 'id' as primary key and provided scopes.
 */
function createAutoHandler<
  DB extends SyncClientDb,
  TableName extends keyof DB & string,
>(
  table: string,
  scopes: string[],
  options: {
    columnCodecs?: ColumnCodecSource;
    codecDialect?: ColumnCodecDialect;
  }
): ClientTableHandler<DB, TableName> {
  return createClientHandler<DB, TableName>({
    table: table as TableName,
    scopes: scopes as ScopeDefinition[],
    columnCodecs: options.columnCodecs,
    codecDialect: options.codecDialect,
  });
}

function normalizeTransportBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed.endsWith('/sync')) {
    return trimmed;
  }

  const baseUrl = trimmed.slice(0, -'/sync'.length);
  return baseUrl.length > 0 ? baseUrl : '/';
}

interface CreateClientOptions<DB extends SyncClientDb> {
  /** Kysely database instance */
  db: Kysely<DB>;

  /**
   * Sync URL (e.g., '/api/sync') or base API URL (e.g., '/api').
   * Defaults to '/api/sync' if not provided.
   * Ignored if transport is provided.
   */
  url?: string;

  /**
   * Table handlers for applying snapshots and changes.
   * Handlers with `subscribe: true` (or an object) are synced.
   * Handlers with `subscribe: false` are local-only.
   * Either handlers or tables must be provided.
   */
  handlers?: Array<ClientTableHandler<DB>>;

  /**
   * Table names to auto-generate handlers for.
   * Uses default scopes and primary key 'id'.
   * Either handlers or tables must be provided.
   *
   * @example
   * ```typescript
   * tables: ['tasks', 'notes', 'projects']
   * ```
   */
  tables?: string[];

  /**
   * Default scopes for auto-generated table handlers.
   * Required when using tables option.
   * Ignored when handlers are provided.
   */
  scopes?: string[];

  /** Current actor/user identifier */
  actorId: string;

  /** Optional: Custom client ID (auto-generated UUID if not provided) */
  clientId?: string;

  /** Optional: Custom transport (overrides url) */
  transport?: SyncTransport;

  /** Optional: Function to get auth headers */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;

  /** Optional: Sync configuration */
  sync?: {
    /** Enable realtime/WebSocket mode (default: true) */
    realtime?: boolean;
    /** Polling interval in ms (default: 10000) */
    pollIntervalMs?: number;
  };

  /** Optional: Local blob storage adapter */
  blobStorage?: import('./client').ClientBlobStorage;

  /** Optional: Sync plugins */
  plugins?: import('./plugins').SyncClientPlugin[];

  /** Optional: State ID for multi-tenant scenarios */
  stateId?: string;

  /** Optional: Column codec resolver */
  columnCodecs?: ColumnCodecSource;

  /** Optional: Codec dialect override (default: 'sqlite') */
  codecDialect?: ColumnCodecDialect;

  /** Optional: Auto-start sync (default: true) */
  autoStart?: boolean;
}

interface CreateClientResult<DB extends SyncClientDb> {
  /** The client instance */
  client: Client<DB>;
  /** Stop sync */
  stop: () => void;
  /** Destroy client and cleanup */
  destroy: () => void;
}

/**
 * Create a simplified sync client.
 *
 * Auto-generates clientId, creates transport from URL (default: '/api/sync'),
 * builds subscriptions from handlers.
 *
 * @example
 * ```typescript
 * // Auto-generate handlers for simple tables (default URL: '/api/sync')
 * const { client } = await createClient({
 *   db,
 *   actorId: 'user-123',
 *   tables: ['tasks', 'notes'],
 *   scopes: ['user:{user_id}'],
 * });
 *
 * // With custom handlers for advanced cases
 * const { client } = await createClient({
 *   db,
 *   actorId: 'user-123',
 *   handlers: [
 *     tasksHandler,      // subscribe: true by default
 *     notesHandler,      // subscribe: true by default
 *     draftsHandler,     // subscribe: false (local-only)
 *   ],
 * });
 *
 * // Listen for events
 * client.on('sync:error', (err) => console.error(err));
 * client.on('data:change', (scopes) => console.log('Data changed:', scopes));
 * ```
 */
export async function createClient<DB extends SyncClientDb>(
  options: CreateClientOptions<DB>
): Promise<CreateClientResult<DB>> {
  const {
    db,
    url = '/api/sync',
    handlers: providedHandlers,
    tables,
    scopes,
    actorId,
    clientId = randomUUID(),
    transport: customTransport,
    getHeaders,
    sync = {},
    blobStorage,
    plugins,
    stateId,
    columnCodecs,
    codecDialect,
    autoStart = true,
  } = options;

  // Validate options
  if (!providedHandlers && !tables) {
    throw new Error('Either handlers or tables must be provided');
  }
  if (tables && !scopes) {
    throw new Error('scopes is required when using tables option');
  }

  // Auto-generate handlers from tables if needed
  const handlers =
    providedHandlers ??
    tables!.map((table) =>
      createAutoHandler<DB, keyof DB & string>(table, scopes!, {
        columnCodecs,
        codecDialect,
      })
    );

  const tableHandlers = createClientHandlerCollection(handlers);

  // Create transport from URL if not provided
  let transport = customTransport;
  if (!transport && url) {
    transport = createHttpTransport({
      baseUrl: normalizeTransportBaseUrl(url),
      getHeaders,
    });
  }

  if (!transport) {
    throw new Error('Either url or transport must be provided');
  }

  // Build subscriptions from handlers
  const subscriptions = handlers
    .map((handler) => {
      const sub = handler.subscribe;
      // Skip handlers that are explicitly disabled
      if (sub === false) return null;

      if (sub === true || sub === undefined) {
        // Default: subscribe to the handler's single scope var using actorId.
        // This avoids sending `{}` which would be treated as revoked by the server.
        const scopes = deriveDefaultSubscriptionScopes({
          handler,
          actorId,
        });
        return {
          id: handler.table,
          table: handler.table,
          scopes,
          params: {},
        };
      }
      // Custom subscription config
      const scopes: ScopeValues = {};
      for (const [scopeKey, scopeValue] of Object.entries(sub.scopes ?? {})) {
        if (scopeValue === undefined) continue;
        scopes[scopeKey] = scopeValue;
      }
      if (Object.keys(scopes).length === 0) {
        throw new Error(
          `Handler "${handler.table}" subscription scopes cannot be empty. ` +
            'Set subscribe: false or provide subscribe.scopes.'
        );
      }
      return {
        id: handler.table,
        table: handler.table,
        scopes,
        params: sub.params ?? {},
      };
    })
    .filter((sub): sub is NonNullable<typeof sub> => sub !== null);

  // Create client
  const client = new Client({
    db,
    transport,
    tableHandlers,
    clientId,
    actorId,
    subscriptions,
    blobStorage,
    plugins,
    stateId,
    columnCodecs,
    codecDialect,
    realtimeEnabled: sync.realtime ?? true,
    pollIntervalMs: sync.pollIntervalMs,
  });

  // Auto-start
  if (autoStart) {
    await client.start();
  }

  return {
    client,
    stop: () => client.stop(),
    destroy: () => client.destroy(),
  };
}
