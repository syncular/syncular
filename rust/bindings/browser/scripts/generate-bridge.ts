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
      'config: SyncularV2ClientConfig;',
      'runtime?: SyncularV2WorkerRuntimeArtifact;',
    ],
    dispatch: 'context.openClient(request)',
    diagnostic: true,
    diagnosticSource: 'storage',
  },
  {
    type: 'setAuthHeaders',
    fields: ['headers: SyncularV2AuthHeaders;'],
    dispatch: 'context.requireClient().setAuthHeaders(request.headers)',
    diagnostic: true,
    diagnosticSource: 'auth',
  },
  {
    type: 'setFieldEncryption',
    fields: ['config: SyncularV2FieldEncryptionConfig | null;'],
    dispatch: 'context.requireClient().setFieldEncryption(request.config)',
    diagnostic: true,
    diagnosticSource: 'client',
  },
  {
    type: 'setEncryptedCrdt',
    fields: ['config: SyncularV2EncryptedCrdtConfig | null;'],
    dispatch: 'context.requireClient().setEncryptedCrdt(request.config)',
    diagnostic: true,
    diagnosticSource: 'client',
  },
  {
    type: 'setBlobEncryption',
    fields: ['config: SyncularV2BlobEncryptionConfig | null;'],
    dispatch: 'context.requireClient().setBlobEncryption(request.config)',
    diagnostic: true,
    diagnosticSource: 'client',
  },
  {
    type: 'setSubscriptions',
    fields: ['subscriptions: SyncularV2SubscriptionSpec[];'],
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
    fields: ['lease: SyncularV2AuthLeaseRecord;'],
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
    fields: ['options: SyncularV2WorkerRealtimeOptions;'],
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
      'hints?: SyncularV2LiveQueryDependencyHint[];',
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
    fields: ['syncAttempt?: SyncularV2SyncAttempt;'],
    dispatch:
      'context.requireClient().syncPull({ syncAttempt: request.syncAttempt })',
    abortable: true,
    diagnostic: true,
    diagnosticSource: 'sync',
    operationalState: true,
  },
  {
    type: 'syncPush',
    fields: ['syncAttempt?: SyncularV2SyncAttempt;'],
    dispatch:
      'context.requireClient().syncPush({ syncAttempt: request.syncAttempt })',
    abortable: true,
    diagnostic: true,
    diagnosticSource: 'sync',
    operationalState: true,
  },
  {
    type: 'syncOnce',
    fields: ['syncAttempt?: SyncularV2SyncAttempt;'],
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
    fields: [
      'conflictId: string;',
      'resolution: SyncularV2ConflictResolution;',
    ],
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
    fields: ['data: Uint8Array;', 'options?: SyncularV2BlobStoreOptions;'],
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
    fields: ['options?: SyncularV2StorageCompactionOptions;'],
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
    fields: ['request: SyncularV2LocalHealthRepairRequest;'],
    dispatch: 'context.requireClient().repairLocalHealth(request.request)',
    diagnostic: true,
    diagnosticSource: 'storage',
    operationalState: true,
  },
  {
    type: 'resetLocalSyncState',
    fields: ['request?: SyncularV2LocalSyncResetRequest;'],
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
    fields: ['request: SyncularV2CrdtFieldRequest;'],
    dispatch: 'context.requireClient().openCrdtField(request.request)',
  },
  {
    type: 'applyCrdtFieldText',
    fields: ['request: SyncularV2CrdtFieldTextRequest;'],
    dispatch: 'context.requireClient().applyCrdtFieldText(request.request)',
  },
  {
    type: 'applyCrdtFieldYjsUpdate',
    fields: ['request: SyncularV2CrdtFieldYjsUpdateRequest;'],
    dispatch:
      'context.requireClient().applyCrdtFieldYjsUpdate(request.request)',
  },
  {
    type: 'materializeCrdtField',
    fields: ['request: SyncularV2CrdtFieldRequest;'],
    dispatch: 'context.requireClient().materializeCrdtField(request.request)',
  },
  {
    type: 'crdtDocumentSnapshot',
    fields: ['request: SyncularV2CrdtFieldRequest;'],
    dispatch: 'context.requireClient().crdtDocumentSnapshot(request.request)',
  },
  {
    type: 'crdtUpdateLog',
    fields: ['request: SyncularV2CrdtFieldRequest & { limit?: number };'],
    dispatch: 'context.requireClient().crdtUpdateLog(request.request)',
  },
  {
    type: 'snapshotCrdtFieldStateVector',
    fields: ['request: SyncularV2CrdtFieldRequest;'],
    dispatch:
      'context.requireClient().snapshotCrdtFieldStateVector(request.request)',
  },
  {
    type: 'compactCrdtField',
    fields: ['request: SyncularV2CrdtFieldCompactionRequest;'],
    dispatch: 'context.requireClient().compactCrdtField(request.request)',
  },
  {
    type: 'encryptionHelper',
    fields: ['method: SyncularV2EncryptionHelperMethod;', 'args?: unknown;'],
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
    '      protocolVersion: typeof SYNCULAR_V2_WORKER_PROTOCOL_VERSION;',
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

  return `// @generated by rust/bindings/browser/scripts/generate-bridge.ts
import type { BlobRef, SyncOperation } from '@syncular/core';
import type {
  SyncularApplyYjsEnvelopeToPayloadArgs,
  SyncularApplyYjsTextUpdatesArgs,
  SyncularBuildYjsTextUpdateArgs,
  SyncularV2AuthHeaders,
  SyncularV2AuthLeaseRecord,
  SyncularV2BlobEncryptionConfig,
  SyncularV2BlobStoreOptions,
  SyncularV2ClientConfig,
  SyncularV2ConflictResolution,
  SyncularV2CrdtFieldCompactionRequest,
  SyncularV2CrdtFieldRequest,
  SyncularV2CrdtFieldTextRequest,
  SyncularV2CrdtFieldYjsUpdateRequest,
  SyncularV2EncryptedCrdtConfig,
  SyncularV2EncryptionHelperMethod,
  SyncularV2FieldEncryptionConfig,
  SyncularV2LiveQueryDependencyHint,
  SyncularV2LocalHealthRepairRequest,
  SyncularV2LocalSyncResetRequest,
  SyncularV2StorageCompactionOptions,
  SyncularV2SubscriptionSpec,
  SyncularV2SyncAttempt,
} from './types';
import type { SYNCULAR_V2_WORKER_PROTOCOL_VERSION } from './worker-protocol';

export interface SyncularV2WorkerRuntimeArtifact {
  name?: string;
  wasmGlueUrl?: string;
  wasmUrl?: string;
  features?: string[];
}

export type SyncularV2WorkerRealtimeOptions = {
  wsUrl?: string;
  params?: Record<string, string>;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectBackoffFactor?: number;
  heartbeatTimeoutMs?: number;
};

export type SyncularV2GeneratedWorkerRequest =
${workerCommands.map(requestVariant).join('\n')};

export type SyncularV2GeneratedWorkerRequestInput =
  SyncularV2GeneratedWorkerRequest extends infer Request
    ? Request extends SyncularV2GeneratedWorkerRequest
      ? Omit<Request, 'id' | 'protocolVersion'>
      : never
    : never;

export type SyncularV2GeneratedWorkerRequestType =
  SyncularV2GeneratedWorkerRequest['type'];

const ABORTABLE_WORKER_REQUEST_TYPES = new Set<string>(${stringArray(abortable)});
const DIAGNOSED_SUCCESS_WORKER_REQUEST_TYPES = new Set<string>(${stringArray(diagnosed)});
const OPERATIONAL_STATE_WORKER_REQUEST_TYPES = new Set<string>(${stringArray(operational)});
const WORKER_REQUEST_DIAGNOSTIC_SOURCES: Record<string, 'auth' | 'blob' | 'client' | 'realtime' | 'storage' | 'sync' | 'worker'> = ${record(diagnosticSources)};

export function isGeneratedSyncularV2AbortableWorkerRequestType(
  type: SyncularV2GeneratedWorkerRequestType
): boolean {
  return ABORTABLE_WORKER_REQUEST_TYPES.has(type);
}

export function isGeneratedSyncularV2DiagnosedSuccessWorkerRequestType(
  type: SyncularV2GeneratedWorkerRequestType
): boolean {
  return DIAGNOSED_SUCCESS_WORKER_REQUEST_TYPES.has(type);
}

export function isGeneratedSyncularV2OperationalStateWorkerRequestType(
  type: SyncularV2GeneratedWorkerRequestType
): boolean {
  return OPERATIONAL_STATE_WORKER_REQUEST_TYPES.has(type);
}

export function generatedSyncularV2WorkerRequestDiagnosticSource(
  type: SyncularV2GeneratedWorkerRequestType
): 'auth' | 'blob' | 'client' | 'realtime' | 'storage' | 'sync' | 'worker' {
  return WORKER_REQUEST_DIAGNOSTIC_SOURCES[type] ?? 'worker';
}

export interface SyncularV2GeneratedWorkerDispatchContext {
  requireClient(): any;
  openClient(request: Extract<SyncularV2GeneratedWorkerRequest, { type: 'open' }>): Promise<unknown>;
  startRealtime(options: SyncularV2WorkerRealtimeOptions): unknown;
  stopRealtime(): unknown;
  sendPresence(
    action: 'join' | 'leave' | 'update',
    scopeKey: string,
    metadata?: Record<string, unknown>
  ): unknown;
  runtimeInfo(): Promise<unknown>;
  closeClient(): unknown;
}

export async function dispatchGeneratedSyncularV2WorkerRequest(
  context: SyncularV2GeneratedWorkerDispatchContext,
  request: SyncularV2GeneratedWorkerRequest
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
