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
import type { ClientHandlerCollection } from '../handlers/collection';
import type { SyncClientPlugin } from '../plugins/types';
import type { SyncClientDb } from '../schema';
import type { SubscriptionState } from '../subscription-state';

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

export type TransportFallbackReason = 'network' | 'auth' | 'server' | 'manual';

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

export interface TransportHealth {
  mode: 'realtime' | 'polling' | 'disconnected';
  connected: boolean;
  lastSuccessfulPollAt: number | null;
  lastRealtimeMessageAt: number | null;
  fallbackReason: TransportFallbackReason | null;
}

export type SubscriptionProgressPhase =
  | 'idle'
  | 'bootstrapping'
  | 'catching_up'
  | 'live'
  | 'error';

export type SyncChannelPhase =
  | 'idle'
  | 'starting'
  | 'bootstrapping'
  | 'catching_up'
  | 'live'
  | 'error';

export interface SubscriptionProgress {
  stateId: string;
  id: string;
  table?: string;
  phase: SubscriptionProgressPhase;
  progressPercent: number;
  rowsProcessed?: number;
  rowsTotal?: number;
  tablesProcessed?: number;
  tablesTotal?: number;
  startedAt?: number;
  completedAt?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface SyncProgress {
  channelPhase: SyncChannelPhase;
  progressPercent: number;
  subscriptions: SubscriptionProgress[];
}

/**
 * Sync error with context
 */
export interface SyncError {
  /** Error code */
  code:
    | 'NETWORK_ERROR'
    | 'AUTH_FAILED'
    | 'SNAPSHOT_CHUNK_NOT_FOUND'
    | 'MIGRATION_FAILED'
    | 'CONFLICT'
    | 'SYNC_ERROR'
    | 'UNKNOWN';
  /** Error message */
  message: string;
  /** Original error if available */
  cause?: Error;
  /** Timestamp when error occurred */
  timestamp: number;
  /** Whether retrying this error is expected to succeed */
  retryable: boolean;
  /** HTTP status code when available */
  httpStatus?: number;
  /** Related subscription id when available */
  subscriptionId?: string;
  /** Related state id when available */
  stateId?: string;
}

/**
 * Sync event types
 */
export type SyncEventType =
  | 'state:change'
  | 'sync:start'
  | 'sync:complete'
  | 'sync:live'
  | 'sync:error'
  | 'bootstrap:start'
  | 'bootstrap:progress'
  | 'bootstrap:complete'
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
  'sync:live': { timestamp: number };
  'sync:error': SyncError;
  'bootstrap:start': {
    timestamp: number;
    stateId: string;
    subscriptionId: string;
  };
  'bootstrap:progress': {
    timestamp: number;
    stateId: string;
    subscriptionId: string;
    progress: SubscriptionProgress;
  };
  'bootstrap:complete': {
    timestamp: number;
    stateId: string;
    subscriptionId: string;
    durationMs: number;
  };
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
  handlers: ClientHandlerCollection<DB>;
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
  /** Optional app migration to run before sync schema migration. */
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

export type SyncResetScope = 'state' | 'subscription' | 'all';

export interface SyncResetOptions {
  scope: SyncResetScope;
  stateId?: string;
  subscriptionIds?: string[];
  clearOutbox?: boolean;
  clearConflicts?: boolean;
  clearSyncedTables?: boolean;
}

export interface SyncResetResult {
  deletedSubscriptionStates: number;
  deletedOutboxCommits: number;
  deletedConflicts: number;
  clearedTables: string[];
}

export interface SyncRepairOptions {
  mode: 'rebootstrap-missing-chunks';
  stateId?: string;
  subscriptionIds?: string[];
  clearOutbox?: boolean;
  clearConflicts?: boolean;
}

export interface SyncAwaitPhaseOptions {
  timeoutMs?: number;
}

export interface SyncAwaitBootstrapOptions {
  timeoutMs?: number;
  stateId?: string;
  subscriptionId?: string;
}

export interface SyncDiagnostics {
  timestamp: number;
  state: SyncEngineState;
  transport: TransportHealth;
  progress: SyncProgress;
  outbox: OutboxStats;
  conflictCount: number;
  subscriptions: SubscriptionState[];
}

export interface SyncInspectorEvent {
  id: number;
  event: SyncEventType;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface SyncInspectorOptions {
  eventLimit?: number;
}

export interface SyncInspectorSnapshot {
  version: 1;
  generatedAt: number;
  diagnostics: Record<string, unknown>;
  recentEvents: SyncInspectorEvent[];
}
