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
  type SyncularV2DiagnosticSnapshot,
  type SyncularV2SubscriptionSpec,
  type SyncularV2SyncResult,
} from '@syncular/client';
import type { SyncAuthLeaseIssueRequest } from '@syncular/core';
import { createSyncularReact } from '@syncular/react';

export type SyncularTauriInvoke = <TResult>(
  command: string,
  args?: Record<string, unknown>
) => Promise<TResult>;

export type SyncularTauriListen = <TPayload>(
  event: string,
  handler: (event: { payload: TPayload }) => void
) => Promise<() => void>;

export interface SyncularTauriCommands {
  executeSql: string;
  applyMutationsCommit: string;
  applyLeasedMutationsCommit: string;
  sync: string;
  resumeFromBackground: string;
  start: string;
  stop: string;
  setSubscriptions: string;
  issueAuthLease: string;
  upsertAuthLease: string;
  authLease: string;
  activeAuthLeases: string;
  diagnosticSnapshot: string;
  joinPresence: string;
  leavePresence: string;
  updatePresenceMetadata: string;
  listConflicts: string;
  retryConflictKeepLocal: string;
  resolveConflict: string;
}

export interface CreateSyncularTauriClientOptions
  extends Omit<CreateSyncularBridgeClientOptions, 'bridge'> {
  invoke: SyncularTauriInvoke;
  listen?: SyncularTauriListen;
  commands?: Partial<SyncularTauriCommands>;
  eventPrefix?: string;
}

const DEFAULT_COMMANDS: SyncularTauriCommands = {
  executeSql: 'syncular_execute_sql',
  applyMutationsCommit: 'syncular_apply_mutations_commit',
  applyLeasedMutationsCommit: 'syncular_apply_leased_mutations_commit',
  sync: 'syncular_sync',
  resumeFromBackground: 'syncular_resume_from_background',
  start: 'syncular_start',
  stop: 'syncular_stop',
  setSubscriptions: 'syncular_set_subscriptions',
  issueAuthLease: 'syncular_issue_auth_lease',
  upsertAuthLease: 'syncular_upsert_auth_lease',
  authLease: 'syncular_auth_lease',
  activeAuthLeases: 'syncular_active_auth_leases',
  diagnosticSnapshot: 'syncular_diagnostic_snapshot',
  joinPresence: 'syncular_join_presence',
  leavePresence: 'syncular_leave_presence',
  updatePresenceMetadata: 'syncular_update_presence_metadata',
  listConflicts: 'syncular_conflict_summaries',
  retryConflictKeepLocal: 'syncular_retry_conflict_keep_local',
  resolveConflict: 'syncular_resolve_conflict',
};

export async function createSyncularTauriClient<DB>(
  options: CreateSyncularTauriClientOptions
): Promise<SyncularClientLike<DB>> {
  return createSyncularBridgeClient<DB>({
    ...options,
    bridge: createSyncularTauriBridge(options),
  });
}

export function createSyncularTauriReact<DB>() {
  return createSyncularReact<DB>();
}

export function createSyncularTauriBridge(
  options: CreateSyncularTauriClientOptions
): SyncularBridge {
  const commands = { ...DEFAULT_COMMANDS, ...options.commands };
  const eventPrefix = options.eventPrefix ?? 'syncular';
  const presence = new Map<string, SyncularV2PresenceEntry[]>();
  let status: SyncularBridgeStatus = {};

  const invoke = <TResult>(
    command: string,
    args?: Record<string, unknown>
  ): Promise<TResult> => options.invoke<TResult>(command, args);

  return {
    executeSql: <Row extends Record<string, unknown>>(
      request: SyncularBridgeQueryRequest
    ) =>
      invoke<SyncularBridgeQueryResult<Row>>(commands.executeSql, { request }),
    applyMutationsCommit: (batch: SyncularBridgeMutationBatch) =>
      invoke<string>(commands.applyMutationsCommit, { batch }),
    applyLeasedMutationsCommit: (batch: SyncularBridgeMutationBatch) =>
      invoke<string>(commands.applyLeasedMutationsCommit, { batch }),
    sync: () => invoke<SyncularV2SyncResult>(commands.sync),
    resumeFromBackground: (syncOptions) =>
      invoke<SyncularV2SyncResult>(commands.resumeFromBackground, {
        options: syncOptions,
      }),
    start: () => invoke<void>(commands.start),
    stop: () => invoke<void>(commands.stop),
    setSubscriptions: (subscriptions: readonly SyncularV2SubscriptionSpec[]) =>
      invoke<void>(commands.setSubscriptions, {
        subscriptions: [...subscriptions],
      }),
    getStatus: () => status,
    issueAuthLease: (request: SyncAuthLeaseIssueRequest) =>
      invoke<SyncularV2AuthLeaseRecord>(commands.issueAuthLease, { request }),
    upsertAuthLease: (lease: SyncularV2AuthLeaseRecord) =>
      invoke<void>(commands.upsertAuthLease, { lease }),
    authLease: (leaseId: string) =>
      invoke<SyncularV2AuthLeaseRecord | null>(commands.authLease, {
        leaseId,
      }),
    activeAuthLeases: (actorId?: string | null, nowMs?: number) =>
      invoke<SyncularV2AuthLeaseRecord[]>(commands.activeAuthLeases, {
        actorId,
        nowMs,
      }),
    diagnosticSnapshot: () =>
      invoke<SyncularV2DiagnosticSnapshot>(commands.diagnosticSnapshot),
    on: (event, listener) =>
      listen(options.listen, `${eventPrefix}:${event}`, (payload) => {
        if (event === 'lifecycleChanged') {
          status = {
            ...status,
            lifecycle: payload as SyncularBridgeStatus['lifecycle'],
          };
        }
        listener(payload as never);
      }),
    presence: {
      get: <TMetadata = Record<string, unknown>>(scopeKey: string) =>
        (presence.get(scopeKey) ?? []) as SyncularV2PresenceEntry<TMetadata>[],
      join: (scopeKey, metadata) => {
        void invoke<void>(commands.joinPresence, { scopeKey, metadata });
      },
      leave: (scopeKey) => {
        void invoke<void>(commands.leavePresence, { scopeKey });
      },
      updateMetadata: (scopeKey, metadata) => {
        void invoke<void>(commands.updatePresenceMetadata, {
          scopeKey,
          metadata,
        });
      },
      onChange: <TMetadata = Record<string, unknown>>(
        listener: SyncularV2PresenceSink<TMetadata>
      ) =>
        listen(options.listen, `${eventPrefix}:presenceChanged`, (payload) => {
          const event = payload as SyncularV2ClientEventMap['presenceChanged'];
          presence.set(event.scopeKey, event.presence);
          listener(event as Parameters<SyncularV2PresenceSink<TMetadata>>[0]);
        }),
    },
    conflicts: {
      list: () => invoke<SyncularV2ConflictSummary[]>(commands.listConflicts),
      retryKeepLocal: (id) =>
        invoke<string>(commands.retryConflictKeepLocal, { id }),
      resolve: (id, resolution: SyncularV2ConflictResolution) =>
        invoke<void>(commands.resolveConflict, { id, resolution }),
    },
  };
}

function listen<T extends SyncularV2ClientEventType>(
  listenFn: SyncularTauriListen | undefined,
  event: string,
  listener: SyncularV2ClientEventSink<T>
): () => void {
  if (!listenFn) return noop;
  let unlisten: (() => void) | undefined;
  let closed = false;
  void listenFn(event, ({ payload }) => listener(payload as never)).then(
    (nextUnlisten) => {
      if (closed) {
        nextUnlisten();
      } else {
        unlisten = nextUnlisten;
      }
    }
  );
  return () => {
    closed = true;
    unlisten?.();
  };
}

function noop(): void {}
