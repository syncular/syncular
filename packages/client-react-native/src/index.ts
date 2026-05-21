import {
  type CreateSyncularBridgeClientOptions,
  createSyncularBridgeClient,
  type SyncularBridge,
  type SyncularBridgeMutationBatch,
  type SyncularBridgeQueryRequest,
  type SyncularBridgeQueryResult,
  type SyncularBridgeStatus,
  type SyncularClientLike,
  type SyncularV2AuthLeaseRecord,
  type SyncularV2ClientEventMap,
  type SyncularV2ClientEventSink,
  type SyncularV2ClientEventType,
  type SyncularV2ConflictResolution,
  type SyncularV2ConflictSummary,
  type SyncularV2PresenceEntry,
  type SyncularV2PresenceSink,
  type SyncularV2SubscriptionSpec,
  type SyncularV2SyncResult,
} from '@syncular/client';
import type { SyncAuthLeaseIssueRequest } from '@syncular/core';
import { createSyncularReact } from '@syncular/react';

export type SyncularNativeEventSubscription = (() => void) | { remove(): void };

export interface SyncularNativeModule {
  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    request: SyncularBridgeQueryRequest
  ): Promise<SyncularBridgeQueryResult<Row>> | SyncularBridgeQueryResult<Row>;
  applyMutationsCommit(
    batch: SyncularBridgeMutationBatch
  ): Promise<string> | string;
  applyLeasedMutationsCommit?(
    batch: SyncularBridgeMutationBatch
  ): Promise<string> | string;
  sync?(): Promise<SyncularV2SyncResult>;
  resumeFromBackground?(): Promise<SyncularV2SyncResult>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  setSubscriptions?(
    subscriptions: readonly SyncularV2SubscriptionSpec[]
  ): Promise<void>;
  getStatus?(): SyncularBridgeStatus;
  issueAuthLease?(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularV2AuthLeaseRecord>;
  upsertAuthLease?(lease: SyncularV2AuthLeaseRecord): Promise<void>;
  authLease?(leaseId: string): Promise<SyncularV2AuthLeaseRecord | null>;
  activeAuthLeases?(
    actorId?: string | null,
    nowMs?: number
  ): Promise<SyncularV2AuthLeaseRecord[]>;
  addListener?<T extends SyncularV2ClientEventType>(
    event: T,
    listener: SyncularV2ClientEventSink<T>
  ): SyncularNativeEventSubscription;
  getPresence?<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularV2PresenceEntry<TMetadata>[];
  joinPresence?(scopeKey: string, metadata?: Record<string, unknown>): void;
  leavePresence?(scopeKey: string): void;
  updatePresenceMetadata?(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void;
  conflictSummaries?(): Promise<SyncularV2ConflictSummary[]>;
  retryConflictKeepLocal?(id: string): Promise<string>;
  resolveConflict?(
    id: string,
    resolution: SyncularV2ConflictResolution
  ): Promise<void>;
}

export interface CreateSyncularNativeClientOptions
  extends Omit<CreateSyncularBridgeClientOptions, 'bridge'> {
  module: SyncularNativeModule;
}

export async function createSyncularNativeClient<DB>(
  options: CreateSyncularNativeClientOptions
): Promise<SyncularClientLike<DB>> {
  return createSyncularBridgeClient<DB>({
    ...options,
    bridge: createSyncularNativeBridge(options.module),
  });
}

export function createSyncularNativeReact<DB>() {
  return createSyncularReact<DB>();
}

export function createSyncularNativeBridge(
  module: SyncularNativeModule
): SyncularBridge {
  return {
    executeSql: <Row extends Record<string, unknown>>(
      request: SyncularBridgeQueryRequest
    ) => module.executeSql<Row>(request),
    applyMutationsCommit: (batch) => module.applyMutationsCommit(batch),
    applyLeasedMutationsCommit: module.applyLeasedMutationsCommit?.bind(module),
    sync: module.sync?.bind(module),
    resumeFromBackground: module.resumeFromBackground?.bind(module),
    start: module.start?.bind(module),
    stop: module.stop?.bind(module),
    setSubscriptions: module.setSubscriptions?.bind(module),
    getStatus: module.getStatus?.bind(module),
    issueAuthLease: module.issueAuthLease?.bind(module),
    upsertAuthLease: module.upsertAuthLease?.bind(module),
    authLease: module.authLease?.bind(module),
    activeAuthLeases: module.activeAuthLeases?.bind(module),
    on: (event, listener) => removeable(module.addListener?.(event, listener)),
    presence: {
      get: (scopeKey) => module.getPresence?.(scopeKey) ?? [],
      join: (scopeKey, metadata) => module.joinPresence?.(scopeKey, metadata),
      leave: (scopeKey) => module.leavePresence?.(scopeKey),
      updateMetadata: (scopeKey, metadata) =>
        module.updatePresenceMetadata?.(scopeKey, metadata),
      onChange: <TMetadata = Record<string, unknown>>(
        listener: SyncularV2PresenceSink<TMetadata>
      ) =>
        removeable(
          module.addListener?.('presenceChanged', (event) =>
            listener(
              event as SyncularV2ClientEventMap['presenceChanged'] as Parameters<
                SyncularV2PresenceSink<TMetadata>
              >[0]
            )
          )
        ),
    },
    conflicts: {
      list: () => module.conflictSummaries?.() ?? Promise.resolve([]),
      retryKeepLocal: (id) =>
        module.retryConflictKeepLocal?.(id) ??
        Promise.reject(
          new Error('Syncular native module cannot retry conflicts.')
        ),
      resolve: (id, resolution) =>
        module.resolveConflict?.(id, resolution) ??
        Promise.reject(
          new Error('Syncular native module cannot resolve conflicts.')
        ),
    },
  };
}

function removeable(subscription: SyncularNativeEventSubscription | undefined) {
  if (!subscription) return noop;
  return typeof subscription === 'function'
    ? subscription
    : () => subscription.remove();
}

function noop(): void {}
