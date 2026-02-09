/**
 * @syncular/client - Sync engine types
 *
 * Framework-agnostic types for the sync engine.
 */

import type {
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncSubscriptionRequest,
  SyncTransport,
} from '@syncular/core';
import type { Kysely } from 'kysely';
import type { ClientTableRegistry } from '../handlers/registry';
import type { SyncClientPlugin } from '../plugins/types';
import type { SyncClientDb } from '../schema';

/**
 * Connection state for the sync engine
 */
export type SyncConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

/**
 * Transport mode (detected or configured)
 */
export type SyncTransportMode = 'polling' | 'realtime';

/**
 * Sync engine state
 */
export interface SyncEngineState {
  /** Whether sync is enabled */
  enabled: boolean;
  /** Whether currently syncing */
  isSyncing: boolean;
  /** Current connection state */
  connectionState: SyncConnectionState;
  /** Transport mode */
  transportMode: SyncTransportMode;
  /** Last successful sync timestamp */
  lastSyncAt: number | null;
  /** Last error (cleared on successful sync) */
  error: SyncError | null;
  /** Number of pending outbox commits */
  pendingCount: number;
  /** Number of sync retries (reset on success) */
  retryCount: number;
  /** Whether currently retrying */
  isRetrying: boolean;
}

/**
 * Sync error with context
 */
export interface SyncError {
  /** Error code */
  code: 'NETWORK_ERROR' | 'SYNC_ERROR' | 'CONFLICT' | 'UNKNOWN';
  /** Error message */
  message: string;
  /** Original error if available */
  cause?: Error;
  /** Timestamp when error occurred */
  timestamp: number;
}

/**
 * Sync event types
 */
export type SyncEventType =
  | 'state:change'
  | 'sync:start'
  | 'sync:complete'
  | 'sync:error'
  | 'connection:change'
  | 'outbox:change'
  | 'data:change'
  | 'presence:change';

/**
 * Presence entry for a client connected to a scope
 */
export interface PresenceEntry<TMetadata = Record<string, unknown>> {
  clientId: string;
  actorId: string;
  joinedAt: number;
  metadata?: TMetadata;
}

/**
 * Sync event payloads
 */
export interface SyncEventPayloads {
  'state:change': Record<string, never>;
  'sync:start': { timestamp: number };
  'sync:complete': {
    timestamp: number;
    pushedCommits: number;
    pullRounds: number;
    pullResponse: SyncPullResponse;
  };
  'sync:error': SyncError;
  'connection:change': {
    previous: SyncConnectionState;
    current: SyncConnectionState;
  };
  'outbox:change': {
    pendingCount: number;
    sendingCount: number;
    failedCount: number;
    ackedCount: number;
  };
  'data:change': {
    scopes: string[];
    timestamp: number;
  };
  'presence:change': {
    scopeKey: string;
    presence: PresenceEntry[];
  };
}

/**
 * Sync event listener
 */
export type SyncEventListener<T extends SyncEventType> = (
  payload: SyncEventPayloads[T]
) => void;

/**
 * Sync engine configuration
 */
export interface SyncEngineConfig<DB extends SyncClientDb = SyncClientDb> {
  /** Database instance */
  db: Kysely<DB>;
  /** Sync transport */
  transport: SyncTransport;
  /** Client table handler registry */
  handlers: ClientTableRegistry<DB>;
  /** Actor id for sync scoping (null/undefined disables sync) */
  actorId: string | null | undefined;
  /** Stable device/app installation id */
  clientId: string | null | undefined;
  /** Subscriptions for partial sync */
  subscriptions: Array<Omit<SyncSubscriptionRequest, 'cursor'>>;
  /** Pull limit (commit count per request) */
  limitCommits?: number;
  /** Bootstrap snapshot rows per page */
  limitSnapshotRows?: number;
  /** Bootstrap snapshot pages per pull */
  maxSnapshotPages?: number;
  /** Optional state row id (multi-profile support) */
  stateId?: string;
  /** Poll interval in milliseconds (polling mode) */
  pollIntervalMs?: number;
  /** Max retries before giving up */
  maxRetries?: number;
  /** Migration function to run before first sync */
  migrate?: (db: Kysely<DB>) => Promise<void>;
  /** Called when migration fails. Receives the error. */
  onMigrationError?: (error: Error) => void;
  /**
   * Enable realtime mode (WebSocket wake-ups).
   * Default behavior is auto-enable when transport supports realtime.
   * Set to false to force polling.
   */
  realtimeEnabled?: boolean;
  /** Fallback poll interval when realtime reconnecting */
  realtimeFallbackPollMs?: number;
  /** Error callback */
  onError?: (error: SyncError) => void;
  /** Conflict callback */
  onConflict?: (conflict: ConflictInfo) => void;
  /** Data change callback */
  onDataChange?: (scopes: string[]) => void;
  /** Optional client plugins (e.g. encryption) */
  plugins?: SyncClientPlugin[];
  /** Custom SHA-256 hash function (for platforms without crypto.subtle, e.g. React Native) */
  sha256?: (bytes: Uint8Array) => Promise<string>;
}

/**
 * Conflict information for callback
 */
export interface ConflictInfo {
  id: string;
  outboxCommitId: string;
  clientCommitId: string;
  opIndex: number;
  resultStatus: 'conflict' | 'error';
  message: string;
  code: string | null;
  serverVersion: number | null;
  serverRowJson: string | null;
  createdAt: number;
  /** Table name from the conflicting operation */
  table: string;
  /** Row ID from the conflicting operation */
  rowId: string;
  /** Local payload that was rejected (extracted from outbox) */
  localPayload: Record<string, unknown> | null;
}

/**
 * Realtime transport interface (duck-typed from transport)
 */
export interface RealtimeTransportLike extends SyncTransport {
  connect(
    args: { clientId: string },
    onEvent: (event: {
      event: string;
      data: {
        cursor?: number;
        changes?: unknown[];
        error?: string;
        timestamp: number;
      };
    }) => void,
    onStateChange?: (state: 'disconnected' | 'connecting' | 'connected') => void
  ): () => void;
  getConnectionState(): 'disconnected' | 'connecting' | 'connected';
  reconnect(): void;
  sendPresenceJoin?(scopeKey: string, metadata?: Record<string, unknown>): void;
  sendPresenceLeave?(scopeKey: string): void;
  sendPresenceUpdate?(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void;
  onPresenceEvent?(
    callback: (event: {
      action: 'join' | 'leave' | 'update' | 'snapshot';
      scopeKey: string;
      clientId?: string;
      actorId?: string;
      metadata?: Record<string, unknown>;
      entries?: PresenceEntry[];
    }) => void
  ): () => void;
  /**
   * Push a commit via WebSocket (bypasses HTTP).
   * Returns `null` if WS is not connected or times out (caller should fall back to HTTP).
   */
  pushViaWs?(request: SyncPushRequest): Promise<SyncPushResponse | null>;
}

/**
 * Sync result from a single sync cycle
 */
export interface SyncResult {
  success: boolean;
  pushedCommits: number;
  pullRounds: number;
  pullResponse: SyncPullResponse;
  error?: SyncError;
}

/**
 * Outbox statistics
 */
export interface OutboxStats {
  pending: number;
  sending: number;
  failed: number;
  acked: number;
  total: number;
}
