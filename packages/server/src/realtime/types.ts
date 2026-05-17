/**
 * @syncular/server - Realtime broadcaster types
 *
 * Realtime is a best-effort "wake up" mechanism. Correctness always comes from pull + cursors.
 */

export interface SyncRealtimeCommitEvent {
  type: 'commit';
  commitSeq: number;
  /** Stable sequencer/fanout shard key. */
  shardKey?: string;
  /** Logical partition key (tenant / demo / workspace). */
  partitionId?: string;
  /**
   * Optional scopes affected by the commit.
   * Broadcasters may omit this to keep payloads small (listeners can look up in DB).
   */
  scopeKeys?: string[];
  /** Optional instance id to suppress echo on the originating instance. */
  sourceInstanceId?: string;
}

/**
 * Presence event for tracking which clients are connected to which scopes.
 * Used for collaborative features like "who's online" indicators.
 */
export interface SyncRealtimePresenceEvent {
  type: 'presence';
  /** Stable sequencer/fanout shard key. */
  shardKey?: string;
  /** The action that occurred */
  action: 'join' | 'leave' | 'update';
  /** The scope key this presence event relates to */
  scopeKey: string;
  /** Stable owner identity, when the publisher tracks one. */
  ownerKey?: string;
  /** Client/device identifier */
  clientId: string;
  /** Actor/user identifier */
  actorId: string;
  /** Optional metadata (e.g., entity being viewed/edited) */
  metadata?: Record<string, unknown>;
  /** Optional instance id to suppress echo on the originating instance. */
  sourceInstanceId?: string;
}

export type SyncRealtimeEvent =
  | SyncRealtimeCommitEvent
  | SyncRealtimePresenceEvent;

export interface SyncRealtimeBroadcaster {
  /** Publish an event to other app instances. */
  publish(event: SyncRealtimeEvent): Promise<void>;
  /**
   * Subscribe to events from other app instances.
   * Returns an unsubscribe function.
   */
  subscribe(handler: (event: SyncRealtimeEvent) => void): () => void;
  /** Close underlying resources (best-effort). */
  close(): Promise<void>;
}

export interface SyncRealtimeShardKeyInput {
  tenantId?: string | null;
  workspaceId?: string | null;
  partitionId?: string | null;
}

export function createSyncRealtimeShardKey(
  input: SyncRealtimeShardKeyInput = {}
): string {
  const partitionId = normalizeShardPart(input.partitionId, 'default');
  const tenantId = normalizeShardPart(input.tenantId, partitionId);
  const workspaceId = normalizeShardPart(input.workspaceId, partitionId);
  return `sync-realtime-v1:${encodeShardPart(tenantId)}:${encodeShardPart(
    workspaceId
  )}:${encodeShardPart(partitionId)}`;
}

function normalizeShardPart(
  value: string | null | undefined,
  fallback: string
): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function encodeShardPart(value: string): string {
  return encodeURIComponent(value);
}
