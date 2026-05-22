import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface WorkerCommand {
  type: string;
  fields?: readonly string[];
  dispatch?: string;
  abortable?: boolean;
  diagnostic?: boolean;
  diagnosticSource?: string;
  operationalState?: boolean;
}

const workerCommands: readonly WorkerCommand[] = [
  {
    type: 'open',
    fields: [
      'config: SyncularClientConfig;',
      'runtime?: SyncularWorkerRuntimeArtifact;',
    ],
    dispatch: 'context.openClient(request)',
    diagnostic: true,
    diagnosticSource: 'storage',
  },
  {
    type: 'setAuthHeaders',
    fields: ['headers: SyncularAuthHeaders;'],
    dispatch: 'context.requireClient().setAuthHeaders(request.headers)',
    diagnostic: true,
    diagnosticSource: 'auth',
  },
  {
    type: 'setFieldEncryption',
    fields: ['config: SyncularFieldEncryptionConfig | null;'],
    dispatch: 'context.requireClient().setFieldEncryption(request.config)',
    diagnostic: true,
    diagnosticSource: 'client',
  },
  {
    type: 'setEncryptedCrdt',
    fields: ['config: SyncularEncryptedCrdtConfig | null;'],
    dispatch: 'context.requireClient().setEncryptedCrdt(request.config)',
    diagnostic: true,
    diagnosticSource: 'client',
  },
  {
    type: 'setBlobEncryption',
    fields: ['config: SyncularBlobEncryptionConfig | null;'],
    dispatch: 'context.requireClient().setBlobEncryption(request.config)',
    diagnostic: true,
    diagnosticSource: 'client',
  },
  {
    type: 'setSubscriptions',
    fields: ['subscriptions: SyncularSubscriptionSpec[];'],
    dispatch: 'context.requireClient().setSubscriptions(request.subscriptions)',
    diagnosticSource: 'sync',
  },
  {
    type: 'forceSubscriptionsBootstrap',
    fields: ['subscriptionIds?: string[];'],
    dispatch:
      'context.requireClient().forceSubscriptionsBootstrap(request.subscriptionIds ?? [])',
    diagnostic: true,
    diagnosticSource: 'sync',
  },
  {
    type: 'upsertAuthLease',
    fields: ['lease: SyncularAuthLeaseRecord;'],
    dispatch: 'context.requireClient().upsertAuthLease(request.lease)',
    operationalState: true,
  },
  {
    type: 'authLease',
    fields: ['leaseId: string;'],
    dispatch: 'context.requireClient().authLease(request.leaseId)',
  },
  {
    type: 'activeAuthLeases',
    fields: ['actorId?: string | null;', 'nowMs: number;'],
    dispatch:
      'context.requireClient().activeAuthLeases(request.actorId, request.nowMs)',
  },
  {
    type: 'startRealtime',
    fields: ['options: SyncularWorkerRealtimeOptions;'],
    dispatch: 'context.startRealtime(request.options)',
    diagnostic: true,
    diagnosticSource: 'realtime',
  },
  {
    type: 'stopRealtime',
    dispatch: 'context.stopRealtime()',
    diagnostic: true,
    diagnosticSource: 'realtime',
  },
  {
    type: 'sendPresence',
    fields: [
      "action: 'join' | 'leave' | 'update';",
      'scopeKey: string;',
      'metadata?: Record<string, unknown>;',
    ],
    dispatch:
      'context.sendPresence(request.action, request.scopeKey, request.metadata)',
  },
  {
    type: 'executeSql',
    fields: ['sql: string;', 'params: unknown[];'],
    dispatch: 'context.requireClient().executeSql(request.sql, request.params)',
  },
  {
    type: 'executeUnsafeSql',
    fields: ['sql: string;', 'params: unknown[];'],
    dispatch:
      'context.requireClient().executeUnsafeSql(request.sql, request.params)',
  },
  {
    type: 'subscribeQuery',
    fields: [
      'sql: string;',
      'params: unknown[];',
      'tables: string[];',
      'hints?: SyncularLiveQueryDependencyHint[];',
    ],
    dispatch:
      'context.requireClient().subscribeQuery(request.sql, request.params, request.tables, request.hints ?? [])',
  },
  {
    type: 'unsubscribeQuery',
    fields: ['queryId: string;'],
    dispatch:
      'context.requireClient().unsubscribeQuery(request.queryId) ?? true',
  },
  {
    type: 'drainLiveQueryEvents',
    dispatch: 'context.requireClient().drainLiveQueryEvents()',
  },
  {
    type: 'liveQueryDiagnostics',
    dispatch: 'context.requireClient().liveQueryDiagnostics()',
  },
  {
    type: 'applyMutation',
    fields: ['operation: SyncOperation;', 'localRow?: unknown | null;'],
    dispatch:
      'context.requireClient().applyMutation(request.operation, request.localRow)',
    operationalState: true,
  },
  {
    type: 'applyLeasedMutation',
    fields: ['operation: SyncOperation;', 'localRow?: unknown | null;'],
    dispatch:
      'context.requireClient().applyLeasedMutation(request.operation, request.localRow)',
    operationalState: true,
  },
  {
    type: 'applyMutationsBatch',
    fields: [
      'operations: Array<{ operation: SyncOperation; localRow?: unknown | null; }>; ',
    ],
    dispatch: 'context.requireClient().applyMutationsBatch(request.operations)',
    operationalState: true,
  },
  {
    type: 'applyMutationsCommit',
    fields: [
      'operations: Array<{ operation: SyncOperation; localRow?: unknown | null; }>; ',
    ],
    dispatch:
      'context.requireClient().applyMutationsCommit(request.operations)',
    operationalState: true,
  },
  {
    type: 'applyLeasedMutationsCommit',
    fields: [
      'operations: Array<{ operation: SyncOperation; localRow?: unknown | null; }>; ',
    ],
    dispatch:
      'context.requireClient().applyLeasedMutationsCommit(request.operations)',
    operationalState: true,
  },
  {
    type: 'syncPull',
    fields: ['syncAttempt?: SyncularSyncAttempt;'],
    dispatch:
      'context.requireClient().syncPull({ syncAttempt: request.syncAttempt })',
    abortable: true,
    diagnostic: true,
    diagnosticSource: 'sync',
    operationalState: true,
  },
  {
    type: 'syncPush',
    fields: ['syncAttempt?: SyncularSyncAttempt;'],
    dispatch:
      'context.requireClient().syncPush({ syncAttempt: request.syncAttempt })',
    abortable: true,
    diagnostic: true,
    diagnosticSource: 'sync',
    operationalState: true,
  },
  {
    type: 'syncOnce',
    fields: ['syncAttempt?: SyncularSyncAttempt;'],
    dispatch:
      'context.requireClient().syncOnce({ syncAttempt: request.syncAttempt })',
    abortable: true,
    diagnostic: true,
    diagnosticSource: 'sync',
    operationalState: true,
  },
  {
    type: 'transportStats',
    dispatch: 'context.requireClient().transportStats()',
  },
  {
    type: 'resetTransportStats',
    dispatch: 'context.requireClient().resetTransportStats() ?? true',
  },
  {
    type: 'conflictSummaries',
    dispatch: 'context.requireClient().conflictSummaries()',
  },
  {
    type: 'retryConflictKeepLocal',
    fields: ['conflictId: string;'],
    dispatch:
      'context.requireClient().retryConflictKeepLocal(request.conflictId)',
    operationalState: true,
  },
  {
    type: 'resolveConflict',
    fields: ['conflictId: string;', 'resolution: SyncularConflictResolution;'],
    dispatch:
      'context.requireClient().resolveConflict(request.conflictId, request.resolution)',
    operationalState: true,
  },
  {
    type: 'listTable',
    fields: ['table: string;'],
    dispatch: 'context.requireClient().listTable(request.table)',
  },
  {
    type: 'storeBlob',
    fields: ['data: Uint8Array;', 'options?: SyncularBlobStoreOptions;'],
    dispatch:
      'context.requireClient().storeBlob(request.data, request.options)',
    abortable: true,
    diagnostic: true,
    diagnosticSource: 'blob',
  },
  {
    type: 'retrieveBlob',
    fields: ['ref: BlobRef;'],
    dispatch: 'context.requireClient().retrieveBlob(request.ref)',
    abortable: true,
    diagnostic: true,
    diagnosticSource: 'blob',
  },
  {
    type: 'isBlobLocal',
    fields: ['hash: string;'],
    dispatch: 'context.requireClient().isBlobLocal(request.hash)',
    diagnosticSource: 'blob',
  },
  {
    type: 'processBlobUploadQueue',
    dispatch: 'context.requireClient().processBlobUploadQueue()',
    abortable: true,
    diagnostic: true,
    diagnosticSource: 'blob',
  },
  {
    type: 'blobUploadQueueStats',
    dispatch: 'context.requireClient().blobUploadQueueStats()',
    diagnosticSource: 'blob',
  },
  {
    type: 'blobCacheStats',
    dispatch: 'context.requireClient().blobCacheStats()',
    diagnosticSource: 'blob',
  },
  {
    type: 'pruneBlobCache',
    fields: ['maxBytes?: number;'],
    dispatch: 'context.requireClient().pruneBlobCache(request.maxBytes)',
    diagnostic: true,
    diagnosticSource: 'blob',
  },
  {
    type: 'clearBlobCache',
    dispatch: 'context.requireClient().clearBlobCache() ?? true',
    diagnostic: true,
    diagnosticSource: 'blob',
  },
  {
    type: 'compactStorage',
    fields: ['options?: SyncularStorageCompactionOptions;'],
    dispatch: 'context.requireClient().compactStorage(request.options)',
    diagnostic: true,
    diagnosticSource: 'storage',
    operationalState: true,
  },
  {
    type: 'generatedSchemaState',
    dispatch: 'context.requireClient().generatedSchemaState()',
    diagnosticSource: 'storage',
  },
  {
    type: 'localHealthCheck',
    dispatch: 'context.requireClient().localHealthCheck()',
    diagnosticSource: 'storage',
  },
  {
    type: 'exportLocalSupportBundle',
    dispatch: 'context.requireClient().exportLocalSupportBundle()',
    diagnostic: true,
    diagnosticSource: 'storage',
  },
  {
    type: 'importLocalSupportBundle',
    fields: ['bundleJson: string;'],
    dispatch:
      'context.requireClient().importLocalSupportBundle(request.bundleJson)',
    diagnostic: true,
    diagnosticSource: 'storage',
  },
  {
    type: 'repairLocalHealth',
    fields: ['request: SyncularLocalHealthRepairRequest;'],
    dispatch: 'context.requireClient().repairLocalHealth(request.request)',
    diagnostic: true,
    diagnosticSource: 'storage',
    operationalState: true,
  },
  {
    type: 'resetLocalSyncState',
    fields: ['request?: SyncularLocalSyncResetRequest;'],
    dispatch: 'context.requireClient().resetLocalSyncState(request.request)',
    diagnostic: true,
    diagnosticSource: 'storage',
    operationalState: true,
  },
  {
    type: 'buildYjsTextUpdate',
    fields: ['args: SyncularBuildYjsTextUpdateArgs;'],
    dispatch: 'context.requireClient().buildYjsTextUpdate(request.args)',
  },
  {
    type: 'applyYjsTextUpdates',
    fields: ['args: SyncularApplyYjsTextUpdatesArgs;'],
    dispatch: 'context.requireClient().applyYjsTextUpdates(request.args)',
  },
  {
    type: 'applyYjsEnvelopeToPayload',
    fields: ['args: SyncularApplyYjsEnvelopeToPayloadArgs;'],
    dispatch: 'context.requireClient().applyYjsEnvelopeToPayload(request.args)',
  },
  {
    type: 'openCrdtField',
    fields: ['request: SyncularCrdtFieldRequest;'],
    dispatch: 'context.requireClient().openCrdtField(request.request)',
  },
  {
    type: 'applyCrdtFieldText',
    fields: ['request: SyncularCrdtFieldTextRequest;'],
    dispatch: 'context.requireClient().applyCrdtFieldText(request.request)',
  },
  {
    type: 'applyCrdtFieldYjsUpdate',
    fields: ['request: SyncularCrdtFieldYjsUpdateRequest;'],
    dispatch:
      'context.requireClient().applyCrdtFieldYjsUpdate(request.request)',
  },
  {
    type: 'materializeCrdtField',
    fields: ['request: SyncularCrdtFieldRequest;'],
    dispatch: 'context.requireClient().materializeCrdtField(request.request)',
  },
  {
    type: 'crdtDocumentSnapshot',
    fields: ['request: SyncularCrdtFieldRequest;'],
    dispatch: 'context.requireClient().crdtDocumentSnapshot(request.request)',
  },
  {
    type: 'crdtUpdateLog',
    fields: ['request: SyncularCrdtFieldRequest & { limit?: number };'],
    dispatch: 'context.requireClient().crdtUpdateLog(request.request)',
  },
  {
    type: 'snapshotCrdtFieldStateVector',
    fields: ['request: SyncularCrdtFieldRequest;'],
    dispatch:
      'context.requireClient().snapshotCrdtFieldStateVector(request.request)',
  },
  {
    type: 'compactCrdtField',
    fields: ['request: SyncularCrdtFieldCompactionRequest;'],
    dispatch: 'context.requireClient().compactCrdtField(request.request)',
  },
  {
    type: 'encryptionHelper',
    fields: ['method: SyncularEncryptionHelperMethod;', 'args?: unknown;'],
    dispatch:
      'context.requireClient().encryptionHelper(request.method, request.args)',
    diagnosticSource: 'client',
  },
  {
    type: 'runtimeInfo',
    dispatch: 'context.runtimeInfo()',
  },
  {
    type: 'close',
    dispatch: 'context.closeClient()',
    diagnostic: true,
    diagnosticSource: 'storage',
  },
  {
    type: 'cancel',
    fields: ['requestId: number;'],
  },
];

function requestVariant(command: WorkerCommand): string {
  const fields = command.fields ?? [];
  return [
    '  | {',
    '      id: number;',
    '      protocolVersion: typeof SYNCULAR_WORKER_PROTOCOL_VERSION;',
    `      type: ${JSON.stringify(command.type)};`,
    ...fields.map((field) => `      ${field}`),
    '    }',
  ].join('\n');
}

function stringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function record(values: Record<string, string>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(
      ([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`
    )
    .join('\n')}\n}`;
}

function generate(): string {
  const dispatchable = workerCommands.filter((command) => command.dispatch);
  const abortable = workerCommands
    .filter((command) => command.abortable)
    .map((command) => command.type);
  const diagnosed = workerCommands
    .filter((command) => command.diagnostic)
    .map((command) => command.type);
  const operational = workerCommands
    .filter((command) => command.operationalState)
    .map((command) => command.type);
  const diagnosticSources = Object.fromEntries(
    workerCommands
      .filter((command) => command.diagnosticSource)
      .map((command) => [command.type, command.diagnosticSource!])
  );

  return `// @generated by packages/client/scripts/generate-bridge.ts
import type { BlobRef, SyncOperation } from '@syncular/core';
import type {
  SyncularApplyYjsEnvelopeToPayloadArgs,
  SyncularApplyYjsTextUpdatesArgs,
  SyncularBuildYjsTextUpdateArgs,
  SyncularAuthHeaders,
  SyncularAuthLeaseRecord,
  SyncularBlobEncryptionConfig,
  SyncularBlobStoreOptions,
  SyncularClientConfig,
  SyncularConflictResolution,
  SyncularCrdtFieldCompactionRequest,
  SyncularCrdtFieldRequest,
  SyncularCrdtFieldTextRequest,
  SyncularCrdtFieldYjsUpdateRequest,
  SyncularEncryptedCrdtConfig,
  SyncularEncryptionHelperMethod,
  SyncularFieldEncryptionConfig,
  SyncularLiveQueryDependencyHint,
  SyncularLocalHealthRepairRequest,
  SyncularLocalSyncResetRequest,
  SyncularStorageCompactionOptions,
  SyncularSubscriptionSpec,
  SyncularSyncAttempt,
} from './types';
import type { SYNCULAR_WORKER_PROTOCOL_VERSION } from './worker-protocol';

export interface SyncularWorkerRuntimeArtifact {
  name?: string;
  wasmGlueUrl?: string;
  wasmUrl?: string;
  features?: string[];
}

export type SyncularWorkerRealtimeOptions = {
  wsUrl?: string;
  params?: Record<string, string>;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectBackoffFactor?: number;
  heartbeatTimeoutMs?: number;
};

export type SyncularGeneratedWorkerRequest =
${workerCommands.map(requestVariant).join('\n')};

export type SyncularGeneratedWorkerRequestInput =
  SyncularGeneratedWorkerRequest extends infer Request
    ? Request extends SyncularGeneratedWorkerRequest
      ? Omit<Request, 'id' | 'protocolVersion'>
      : never
    : never;

export type SyncularGeneratedWorkerRequestType =
  SyncularGeneratedWorkerRequest['type'];

const ABORTABLE_WORKER_REQUEST_TYPES = new Set<string>(${stringArray(abortable)});
const DIAGNOSED_SUCCESS_WORKER_REQUEST_TYPES = new Set<string>(${stringArray(diagnosed)});
const OPERATIONAL_STATE_WORKER_REQUEST_TYPES = new Set<string>(${stringArray(operational)});
const WORKER_REQUEST_DIAGNOSTIC_SOURCES: Record<string, 'auth' | 'blob' | 'client' | 'realtime' | 'storage' | 'sync' | 'worker'> = ${record(diagnosticSources)};

export function isGeneratedSyncularAbortableWorkerRequestType(
  type: SyncularGeneratedWorkerRequestType
): boolean {
  return ABORTABLE_WORKER_REQUEST_TYPES.has(type);
}

export function isGeneratedSyncularDiagnosedSuccessWorkerRequestType(
  type: SyncularGeneratedWorkerRequestType
): boolean {
  return DIAGNOSED_SUCCESS_WORKER_REQUEST_TYPES.has(type);
}

export function isGeneratedSyncularOperationalStateWorkerRequestType(
  type: SyncularGeneratedWorkerRequestType
): boolean {
  return OPERATIONAL_STATE_WORKER_REQUEST_TYPES.has(type);
}

export function generatedSyncularWorkerRequestDiagnosticSource(
  type: SyncularGeneratedWorkerRequestType
): 'auth' | 'blob' | 'client' | 'realtime' | 'storage' | 'sync' | 'worker' {
  return WORKER_REQUEST_DIAGNOSTIC_SOURCES[type] ?? 'worker';
}

export interface SyncularGeneratedWorkerDispatchContext {
  requireClient(): any;
  openClient(request: Extract<SyncularGeneratedWorkerRequest, { type: 'open' }>): Promise<unknown>;
  startRealtime(options: SyncularWorkerRealtimeOptions): unknown;
  stopRealtime(): unknown;
  sendPresence(
    action: 'join' | 'leave' | 'update',
    scopeKey: string,
    metadata?: Record<string, unknown>
  ): unknown;
  runtimeInfo(): Promise<unknown>;
  closeClient(): unknown;
}

export async function dispatchGeneratedSyncularWorkerRequest(
  context: SyncularGeneratedWorkerDispatchContext,
  request: SyncularGeneratedWorkerRequest
): Promise<unknown> {
  switch (request.type) {
${dispatchable
  .map(
    (command) => `    case ${JSON.stringify(command.type)}:
      return ${command.dispatch};`
  )
  .join('\n')}
    case 'cancel':
      throw new Error('Generated Syncular bridge dispatch does not handle cancel requests.');
  }
}
`;
}

await writeFile(
  join(import.meta.dir, '..', 'src', 'generated-bridge.ts'),
  generate()
);
