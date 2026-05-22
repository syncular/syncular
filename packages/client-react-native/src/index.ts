import {
  type CreateSyncularBridgeClientOptions,
  createSyncularBridgeClient,
  type SyncularAuthLeaseRecord,
  type SyncularBridge,
  type SyncularBridgeMutationBatch,
  type SyncularBridgeQueryRequest,
  type SyncularBridgeQueryResult,
  type SyncularBridgeStatus,
  type SyncularClientEventMap,
  type SyncularClientEventSink,
  type SyncularClientEventType,
  type SyncularClientLike,
  type SyncularConflictResolution,
  type SyncularConflictSummary,
  type SyncularDiagnosticSnapshot,
  type SyncularPresenceEntry,
  type SyncularPresenceSink,
  type SyncularSubscriptionSpec,
  type SyncularSyncResult,
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
  sync?(): Promise<SyncularSyncResult>;
  resumeFromBackground?(): Promise<SyncularSyncResult>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  setSubscriptions?(
    subscriptions: readonly SyncularSubscriptionSpec[]
  ): Promise<void>;
  getStatus?(): SyncularBridgeStatus;
  issueAuthLease?(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularAuthLeaseRecord>;
  upsertAuthLease?(lease: SyncularAuthLeaseRecord): Promise<void>;
  authLease?(leaseId: string): Promise<SyncularAuthLeaseRecord | null>;
  activeAuthLeases?(
    actorId?: string | null,
    nowMs?: number
  ): Promise<SyncularAuthLeaseRecord[]>;
  diagnosticSnapshot?(): Promise<SyncularDiagnosticSnapshot>;
  addListener?<T extends SyncularClientEventType>(
    event: T,
    listener: SyncularClientEventSink<T>
  ): SyncularNativeEventSubscription;
  getPresence?<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularPresenceEntry<TMetadata>[];
  joinPresence?(scopeKey: string, metadata?: Record<string, unknown>): void;
  leavePresence?(scopeKey: string): void;
  updatePresenceMetadata?(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void;
  conflictSummaries?(): Promise<SyncularConflictSummary[]>;
  retryConflictKeepLocal?(id: string): Promise<string>;
  resolveConflict?(
    id: string,
    resolution: SyncularConflictResolution
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
    diagnosticSnapshot: module.diagnosticSnapshot?.bind(module),
    on: (event, listener) => removeable(module.addListener?.(event, listener)),
    presence: {
      get: (scopeKey) => module.getPresence?.(scopeKey) ?? [],
      join: (scopeKey, metadata) => module.joinPresence?.(scopeKey, metadata),
      leave: (scopeKey) => module.leavePresence?.(scopeKey),
      updateMetadata: (scopeKey, metadata) =>
        module.updatePresenceMetadata?.(scopeKey, metadata),
      onChange: <TMetadata = Record<string, unknown>>(
        listener: SyncularPresenceSink<TMetadata>
      ) =>
        removeable(
          module.addListener?.('presenceChanged', (event) =>
            listener(
              event as SyncularClientEventMap['presenceChanged'] as Parameters<
                SyncularPresenceSink<TMetadata>
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
