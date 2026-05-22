import type {
  BlobRef,
  ColumnCodecSource,
  SyncularErrorCategory as CoreSyncularErrorCategory,
  SyncularErrorCode as CoreSyncularErrorCode,
  SyncularErrorRecommendedAction as CoreSyncularErrorRecommendedAction,
  SyncAuthLeaseIssueRequest,
  SyncAuthLifecycle,
  SyncOperation,
} from '@syncular/core';
import type { CompiledQuery } from 'kysely';

export interface SyncularClientConfig {
  baseUrl: string;
  clientId: string;
  actorId: string;
  projectId?: string | null;
  pull?: SyncularPullOptions;
  push?: SyncularPushOptions;
  fileName?: string;
  storage?: SyncularStorage;
  clearOnInit?: boolean;
  stateId?: string;
  schemaVersion?: number;
  appSchema?: SyncularAppSchema;
}

export interface SyncularPullOptions {
  limitCommits?: number;
  limitSnapshotRows?: number;
  maxSnapshotPages?: number;
  dedupeRows?: boolean | null;
  /** Numeric bootstrap phase considered critical. Defaults to 0. */
  criticalBootstrapPhase?: number;
  /** Numeric bootstrap phase considered interactive. Defaults to 1. */
  interactiveBootstrapPhase?: number;
  /** Defaults to false; snapshot bootstrap rows hydrate local SQLite instead of being returned. */
  includeSnapshotRows?: boolean;
  collectChangedRows?: boolean;
  maxSnapshotChangedRows?: number | null;
  collectServerTimings?: boolean;
}

export interface SyncularPushOptions {
  /**
   * Fixed maximum pending outbox commits to send in one push request.
   * When omitted, Rust uses 20 for normal queues and adapts up to 100 for
   * large due outboxes. Configured values disable that adaptive default and
   * must remain bounded.
   */
  outboxBatchLimit?: number;
  /**
   * Maximum adaptive outbox batch size used when outboxBatchLimit is omitted.
   * Defaults to 100.
   */
  adaptiveOutboxBatchLimit?: number;
  /**
   * Due outbox size that must be exceeded before adaptive batching engages.
   * Defaults to 100.
   */
  adaptiveOutboxBatchThreshold?: number;
}

export interface SyncularTransportStats {
  requestCount: number;
  requestBytes: number;
  responseBytes: number;
  snapshotChunkCount: number;
  snapshotChunkBinaryCount: number;
  snapshotChunkRowCount: number;
  snapshotChunkFetchMs: number;
  snapshotChunkDecompressMs: number;
  snapshotChunkHashMs: number;
  snapshotChunkDecodeMs: number;
  snapshotArtifactCount: number;
  snapshotArtifactBytes: number;
  snapshotArtifactFetchMs: number;
  snapshotArtifactDecompressMs: number;
  snapshotArtifactHashMs: number;
  syncPackDecodeMs: number;
  serverBootstrapSnapshotQueryMs: number;
  serverBootstrapRowFrameEncodeMs: number;
  serverBootstrapSnapshotBinaryEncodeMs: number;
  serverBootstrapChunkCacheLookupMs: number;
  serverBootstrapArtifactCacheLookupMs: number;
  serverBootstrapChunkGzipMs: number;
  serverBootstrapChunkHashMs: number;
  serverBootstrapChunkPersistMs: number;
}

export type SyncularStorage = 'memory' | 'indexedDb' | 'opfsSahPool';

export type SyncularAuthHeaders = Record<string, string>;

export interface SyncularAuthLeaseRecord {
  leaseId: string;
  kid: string;
  actorId: string;
  issuedAtMs: number;
  notBeforeMs: number;
  expiresAtMs: number;
  schemaVersion: number;
  payloadJson: string;
  token: string;
  status: string;
  lastValidationError?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SyncularFieldEncryptionRule {
  scope: string;
  table?: string;
  fields: string[];
  rowIdField?: string;
}

export interface SyncularFieldEncryptionConfig {
  rules: SyncularFieldEncryptionRule[];
  keys: Record<string, string | Uint8Array>;
  encryptionKid?: string;
  decryptionErrorMode?: 'throw' | 'keepCiphertext';
  envelopePrefix?: string;
}

export interface SyncularEncryptedCrdtConfig {
  keys: Record<string, string | Uint8Array>;
  encryptionKid?: string;
  partitionId?: string;
}

export interface SyncularBlobEncryptionConfig {
  keys: Record<string, string | Uint8Array>;
  encryptionKid?: string;
}

export type SyncularEncryptionHelperMethod =
  | 'generateSymmetricKey'
  | 'keyToMnemonic'
  | 'mnemonicToKey'
  | 'generateKeypair'
  | 'wrapKeyForRecipient'
  | 'unwrapKey'
  | 'keyToShareUrl'
  | 'publicKeyToShareUrl'
  | 'parseShareUrl'
  | 'deriveScopedPassphraseKeyPbkdf2'
  | 'derivePassphraseKeyArgon2id';

export type SyncularRealtimeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected';

export type SyncularDiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export type SyncularDiagnosticSource =
  | 'client'
  | 'worker'
  | 'sync'
  | 'auth'
  | 'realtime'
  | 'storage'
  | 'blob';

export interface SyncularDiagnosticEvent {
  at: number;
  level: SyncularDiagnosticLevel;
  source: SyncularDiagnosticSource;
  code: string;
  message: string;
  syncAttemptId?: string;
  traceId?: string;
  spanId?: string;
  clientId?: string;
  subscriptionId?: string;
  table?: string;
  rowId?: string;
  cursor?: number | string | null;
  details?: Record<string, unknown>;
}

export type SyncularDiagnosticSink = (event: SyncularDiagnosticEvent) => void;

export interface SyncularSyncAttempt {
  syncAttemptId: string;
  traceId: string;
  spanId: string;
  traceparent: string;
}

export interface SyncularSyncRequestOptions {
  syncAttempt?: SyncularSyncAttempt;
}

export interface SyncularRealtimeOptions {
  enabled?: boolean;
  wsUrl?: string;
  params?: Record<string, string>;
  getParams?: (args: {
    clientId: string;
  }) => Record<string, string> | Promise<Record<string, string>>;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectBackoffFactor?: number;
  reconnectJitterRatio?: number;
  pullRecoveryJitterMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface SyncularNetworkStatusSource {
  isOnline(): boolean | undefined;
  addEventListener?(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener?(type: 'online' | 'offline', listener: () => void): void;
}

export interface SyncularDatabaseSyncOptions {
  autoSyncAfterMutation?: boolean;
  mutationSyncDebounceMs?: number | false;
  network?: SyncularNetworkStatusSource | false;
  rowsChangedDebounceMs?: number | false;
  autoProcessBlobUploadsAfterStore?: boolean;
  blobUploadDebounceMs?: number | false;
}

export interface SyncularConsoleDiagnosticsOptions {
  enabled?: boolean;
  endpoint?: string;
  baseUrl?: string;
  token?: string;
  getHeaders?: () => SyncularAuthHeaders | Promise<SyncularAuthHeaders>;
  clientId?: string;
  actorId?: string;
  partitionId?: string;
  debounceMs?: number | false;
  maxPayloadBytes?: number;
  network?: SyncularNetworkStatusSource | false;
}

export interface CreateSyncularDatabaseOptions {
  config: SyncularClientConfig;
  worker?: Worker | (() => Worker);
  requestTimeoutMs?: number;
  runtime?: SyncularRuntimeArtifact;
  runtimeArtifacts?: readonly SyncularRuntimeArtifactCandidate[];
  requiredRuntimeFeatures?: readonly string[];
  blobLimits?: SyncularBlobLimits;
  codecs?: ColumnCodecSource;
  appTables?: readonly string[];
  tableConfig?: SyncularTableConfigMap;
  getHeaders?: () => SyncularAuthHeaders | Promise<SyncularAuthHeaders>;
  authLifecycle?: SyncAuthLifecycle;
  diagnostics?: SyncularDiagnosticSink;
  consoleDiagnostics?: boolean | SyncularConsoleDiagnosticsOptions;
  realtime?: boolean | SyncularRealtimeOptions;
  sync?: SyncularDatabaseSyncOptions;
}

export interface SyncularRuntimeArtifact {
  wasmGlueUrl?: string | URL;
  wasmUrl?: string | URL | Request;
}

export interface SyncularRuntimeArtifactCandidate
  extends SyncularRuntimeArtifact {
  name?: string;
  features: readonly string[];
}

export interface SyncularRuntimeArtifactCatalog {
  catalogVersion: 1;
  packageName: string;
  packageVersion: string;
  generatedAt?: string;
  artifacts: readonly SyncularRuntimeArtifactCatalogEntry[];
}

export interface SyncularRuntimeArtifactCatalogEntry {
  name: string;
  variant?: string;
  profile?: string;
  features: readonly string[];
  rustFeatures?: readonly string[];
  wasmGlueUrl: string;
  wasmUrl: string;
  rawBytes?: number;
  gzipBytes?: number;
}

export type SyncularTableConfigMap = Record<string, SyncularTableConfig>;

export interface SyncularTableConfig {
  primaryKeyColumn?: string;
  serverVersionColumn?: string | null;
  softDeleteColumn?: string | null;
  blobColumns?: readonly string[];
  crdtYjsFields?: readonly SyncularCrdtYjsFieldConfig[];
  encryptedFields?: readonly {
    field: string;
    scope?: string;
    rowIdField?: string;
  }[];
}

export interface SyncularAppSchema {
  schemaVersion: number;
  localBaseSchema?: SyncularLocalBaseSchema;
  tables: readonly SyncularAppTableMetadata[];
  migrations?: readonly SyncularEmbeddedMigration[];
}

export interface SyncularLocalBaseSchema {
  tableSetupSql: readonly string[];
}

export interface SyncularEmbeddedMigration {
  version: string;
  schemaVersion: number;
  name: string;
  upSql: string;
}

export interface SyncularAppTableMetadata {
  name: string;
  primaryKeyColumn: string;
  serverVersionColumn: string;
  softDeleteColumn?: string | null;
  subscriptionId: string;
  columns: readonly SyncularColumnMetadata[];
  blobColumns: readonly string[];
  crdtYjsFields: readonly SyncularCrdtYjsFieldMetadata[];
  encryptedFields: readonly SyncularEncryptedFieldMetadata[];
  scopes: readonly SyncularScopeMetadata[];
}

export interface SyncularColumnMetadata {
  name: string;
  typeFamily: string;
  notnullRequired: boolean;
  primaryKey: boolean;
}

export interface SyncularScopeMetadata {
  name: string;
  column: string;
  source: 'actorId' | 'projectId';
  required: boolean;
}

export interface SyncularCrdtYjsFieldMetadata {
  field: string;
  stateColumn: string;
  containerKey: string;
  rowIdField: string;
  kind: SyncularYjsFieldKind;
  syncMode: SyncularYjsSyncMode;
}

export interface SyncularEncryptedFieldMetadata {
  field: string;
  scope: string;
  rowIdField: string;
}

export type SyncularYjsFieldKind = 'text' | 'xml-fragment' | 'prosemirror';
export type SyncularYjsSyncMode = 'server-merge' | 'encrypted-update-log';

export interface SyncularCrdtYjsFieldConfig {
  field: string;
  stateColumn: string;
  containerKey?: string;
  rowIdField?: string;
  kind?: SyncularYjsFieldKind;
  syncMode?: SyncularYjsSyncMode;
}

export interface SyncularYjsUpdateEnvelope {
  updateId: string;
  updateBase64: string;
}

export type SyncularYjsUpdateInput =
  | SyncularYjsUpdateEnvelope
  | readonly SyncularYjsUpdateEnvelope[];

export type SyncularYjsPayloadEnvelope<Field extends string = string> = {
  __yjs?: Partial<Record<Field, SyncularYjsUpdateInput>>;
};

export interface SyncularCrdtFieldRequest {
  table: string;
  rowId: string;
  field: string;
}

export interface SyncularCrdtFieldDescriptor extends SyncularCrdtFieldRequest {
  stateColumn: string;
  containerKey: string;
  rowIdField: string;
  kind: SyncularYjsFieldKind;
  syncMode: SyncularYjsSyncMode;
}

export interface SyncularCrdtFieldTextRequest extends SyncularCrdtFieldRequest {
  nextText: string;
}

export interface SyncularCrdtFieldYjsUpdateRequest
  extends SyncularCrdtFieldRequest {
  update: SyncularYjsUpdateEnvelope;
}

export interface SyncularCrdtFieldCompactionRequest
  extends SyncularCrdtFieldRequest {
  minUncheckpointedUpdates?: number;
}

export interface SyncularCrdtFieldWriteReceipt {
  clientCommitId: string;
  syncMode: SyncularYjsSyncMode;
}

export interface SyncularCrdtFieldMaterialization {
  value: unknown;
  stateBase64?: string | null;
  stateVectorBase64: string;
}

export interface SyncularCrdtDocumentSnapshot extends SyncularCrdtFieldRequest {
  documentKey: string;
  stateColumn: string;
  syncMode: SyncularYjsSyncMode;
  stateBase64?: string | null;
  stateVectorBase64: string;
  pendingUpdates: number;
  flushedUpdates: number;
  ackedUpdates: number;
  logUpdates: number;
  updatedAt: number;
  compactedAt?: number | null;
}

export type SyncularCrdtUpdateOrigin = 'local' | 'remote' | 'compaction';
export type SyncularCrdtUpdateStatus =
  | 'pending'
  | 'flushed'
  | 'acked'
  | 'pruned';

export interface SyncularCrdtUpdateLogEntry {
  id: number;
  documentKey: string;
  updateId: string;
  clientCommitId?: string | null;
  origin: SyncularCrdtUpdateOrigin;
  status: SyncularCrdtUpdateStatus;
  updateBase64: string;
  stateVectorBase64: string;
  createdAt: number;
  flushedAt?: number | null;
  ackedAt?: number | null;
}

export interface SyncularCrdtFieldCompactionStats {
  pendingUpdates: number;
  flushedUpdates: number;
  ackedUpdates: number;
  logUpdates: number;
  stateVectorBase64: string;
  updatedAt: number;
  compactedAt?: number | null;
}

export interface SyncularEncryptedCrdtStreamStats {
  updateCount: number;
  checkpointCount: number;
  checkpointableUpdateCount: number;
  maxServerSeq?: number | null;
  latestCheckpointCoversSeq?: number | null;
}

export interface SyncularCrdtFieldCompactionReceipt {
  checkpointCreated: boolean;
  clientCommitId?: string | null;
  before: SyncularCrdtFieldCompactionStats;
  after: SyncularCrdtFieldCompactionStats;
  encryptedStreamBefore?: SyncularEncryptedCrdtStreamStats | null;
  encryptedStreamAfter?: SyncularEncryptedCrdtStreamStats | null;
}

export interface SyncularBuildYjsTextUpdateArgs {
  previousStateBase64?: string | null;
  nextText: string;
  containerKey?: string;
  updateId?: string;
}

export interface SyncularBuildYjsTextUpdateResult {
  update: SyncularYjsUpdateEnvelope;
  nextStateBase64: string;
  nextText: string;
}

export interface SyncularApplyYjsTextUpdatesArgs {
  previousStateBase64?: string | null;
  updates: readonly SyncularYjsUpdateEnvelope[];
  containerKey?: string;
}

export interface SyncularApplyYjsTextUpdatesResult {
  nextStateBase64: string;
  text: string;
}

export interface SyncularApplyYjsEnvelopeToPayloadArgs {
  table: string;
  rowId?: string | null;
  payload: Record<string, unknown>;
  existingRow?: Record<string, unknown> | null;
  rules: readonly (SyncularCrdtYjsFieldConfig & { table: string })[];
  envelopeKey?: string;
  strict?: boolean;
  stripEnvelope?: boolean;
}

export interface SyncularSubscriptionSpec {
  id: string;
  table: string;
  scopes: Record<string, string | string[]>;
  params?: Record<string, unknown>;
  /**
   * Local-only startup phase. Lower phases bootstrap first; ready or currently
   * bootstrapping higher phases continue to participate in pull requests.
   */
  bootstrapPhase?: number;
}

export interface SyncularChangedRow {
  table: string;
  rowId?: string | null;
  operation: 'insert' | 'update' | 'delete' | 'compact' | string;
  changedFields: string[];
  crdtFields: string[];
  crdtFieldChanges?: SyncularChangedCrdtField[];
  commitId?: string | null;
  commitSeq?: number | null;
  subscriptionId?: string | null;
  serverVersion?: number | null;
}

export interface SyncularChangedCrdtField {
  field: string;
  stateColumn: string;
  containerKey: string;
  rowIdField: string;
  kind: string;
  syncMode: string;
}

export interface SyncularRowsChangedEvent {
  source: 'localWrite' | 'remotePull' | string;
  changedTables: string[];
  changedRows: SyncularChangedRow[];
  changedRowsTruncated?: boolean;
}

export type SyncularRowsChangedSink = (event: SyncularRowsChangedEvent) => void;

export interface SyncularOutboxStats {
  pending: number;
  sending: number;
  failed: number;
  acked: number;
  total: number;
}

export interface SyncularConflictStats {
  unresolved: number;
  resolved: number;
  total: number;
}

export interface SyncularPresenceEntry<TMetadata = Record<string, unknown>> {
  clientId: string;
  actorId: string;
  joinedAt: number;
  metadata?: TMetadata;
}

export interface SyncularPresenceChangeEvent<
  TMetadata = Record<string, unknown>,
> {
  scopeKey: string;
  presence: SyncularPresenceEntry<TMetadata>[];
}

export type SyncularPresenceSink<TMetadata = Record<string, unknown>> = (
  event: SyncularPresenceChangeEvent<TMetadata>
) => void;

export interface SyncularBlobUploadEvent {
  ref: BlobRef;
}

export interface SyncularBlobUploadErrorEvent {
  hash: string;
  error: string;
  ref?: BlobRef;
}

export type SyncularLifecyclePhase =
  | 'closed'
  | 'offline'
  | 'connecting'
  | 'syncing'
  | 'recovering'
  | 'authRequired'
  | 'degraded'
  | 'complete';

export interface SyncularLifecycleState {
  phase: SyncularLifecyclePhase;
  realtime: SyncularRealtimeConnectionState;
  online: boolean;
  requiresAction: boolean;
  pendingRequests: number;
  bootstrap?: Pick<
    SyncularBootstrapStatus,
    | 'complete'
    | 'criticalReady'
    | 'interactiveReady'
    | 'isBootstrapping'
    | 'progressPercent'
  >;
  outbox?: SyncularOutboxStats;
  conflicts?: SyncularConflictStats;
  blobUploads?: SyncularBlobUploadQueueStats;
  lastDiagnostic?: SyncularDiagnosticEvent;
  lastError?: {
    message: string;
    code?: string;
  };
}

export interface SyncularClientEventMap {
  rowsChanged: SyncularRowsChangedEvent;
  lifecycleChanged: SyncularLifecycleState;
  bootstrapChanged: SyncularBootstrapStatus;
  outboxChanged: SyncularOutboxStats;
  conflictsChanged: SyncularConflictStats;
  blobUploadsChanged: SyncularBlobUploadQueueStats;
  blobUploadCompleted: SyncularBlobUploadEvent;
  blobUploadFailed: SyncularBlobUploadErrorEvent;
  presenceChanged: SyncularPresenceChangeEvent;
}

export type SyncularClientEventType = keyof SyncularClientEventMap;

export type SyncularClientEventSink<T extends SyncularClientEventType> = (
  event: SyncularClientEventMap[T]
) => void;

export type SyncularErrorCode = CoreSyncularErrorCode;

export type SyncularErrorCategory = CoreSyncularErrorCategory;

export type SyncularErrorRecommendedAction = CoreSyncularErrorRecommendedAction;

export interface SyncularSyncResult {
  changedTables: string[];
  changedRows: SyncularChangedRow[];
  changedRowsTruncated: boolean;
  subscriptions: SyncularSubscriptionResult[];
  bootstrap: SyncularBootstrapStatus;
  pushedCommits: number;
  timings: SyncularSyncTimings;
}

export interface SyncularSyncTimings {
  totalMs: number;
  pushMs: number;
  pullMs: number;
  pullRequestMs: number;
  syncPackDecodeMs: number;
  pullTransformMs: number;
  integrityVerifyMs: number;
  snapshotFetchMs: number;
  pullApplyMs: number;
  scopeClearMs: number;
  snapshotRowApplyMs: number;
  snapshotArtifactApplyMs: number;
  snapshotArtifactCheckpointMs: number;
  snapshotArtifactCheckpointCount: number;
  snapshotChunkApplyMs: number;
  snapshotChunkMaterializeMs: number;
  snapshotChunkResetMs: number;
  snapshotChunkBindMs: number;
  snapshotChunkStepMs: number;
  commitApplyMs: number;
  subscriptionStateMs: number;
  notifyMs: number;
}

export interface SyncularConflictSummary {
  id: string;
  clientCommitId: string;
  opIndex: number;
  resultStatus: string;
  message: string;
  code: string | null;
  serverVersion: number | null;
  resolvedAt: number | null;
  resolution: string | null;
}

export type SyncularConflictResolution =
  | 'keep-local'
  | 'keep-server'
  | 'dismiss';

export interface SyncularSubscriptionResult {
  id: string;
  table: string;
  status: string;
  scopes: Record<string, string | string[]>;
  nextCursor: number;
  bootstrapPhase: number;
  bootstrapState: SyncularBootstrapState | null;
  ready: boolean;
  phase: SyncularBootstrapSubscriptionPhase;
  progressPercent: number;
  snapshotRows: unknown[];
  commits: unknown[];
}

export interface SyncularBootstrapState {
  asOfCommitSeq: number;
  tables: string[];
  tableIndex: number;
  rowCursor: string | null;
}

export type SyncularBootstrapSubscriptionPhase =
  | 'pending'
  | 'bootstrapping'
  | 'live'
  | 'error'
  | string;

export type SyncularBootstrapChannelPhase =
  | 'idle'
  | 'bootstrapping'
  | 'live'
  | 'error'
  | string;

export interface SyncularBootstrapSubscriptionStatus {
  id: string;
  table: string;
  expected: boolean;
  ready: boolean;
  status: string | null;
  phase: SyncularBootstrapSubscriptionPhase;
  progressPercent: number;
  cursor: number | null;
  bootstrapState: SyncularBootstrapState | null;
  bootstrapPhase: number;
}

export interface SyncularBootstrapPhaseStatus {
  phase: number;
  expectedSubscriptionIds: string[];
  readySubscriptionIds: string[];
  pendingSubscriptionIds: string[];
  isReady: boolean;
  progressPercent: number;
}

export interface SyncularBootstrapStatus {
  channelPhase: SyncularBootstrapChannelPhase;
  progressPercent: number;
  isBootstrapping: boolean;
  criticalReady: boolean;
  interactiveReady: boolean;
  complete: boolean;
  activePhase: number | null;
  expectedSubscriptionIds: string[];
  readySubscriptionIds: string[];
  pendingSubscriptionIds: string[];
  subscriptions: SyncularBootstrapSubscriptionStatus[];
  phases: SyncularBootstrapPhaseStatus[];
}

export interface SyncularSchemaState {
  schemaId: string;
  schemaVersion: number | null;
  currentSchemaVersion: number;
  updatedAt: number | null;
}

export type SyncularLocalHealthSeverity = 'info' | 'warning' | 'error';

export type SyncularLocalHealthRepairAction =
  | 'forceRebootstrap'
  | 'clearOrphanedState'
  | 'clearOrphanedSyncedRows'
  | 'manualInspection';

export interface SyncularLocalHealthFinding {
  severity: SyncularLocalHealthSeverity;
  code: string;
  component: string;
  message: string;
  subscriptionId?: string;
  table?: string;
  repairAction?: SyncularLocalHealthRepairAction;
  details?: Record<string, unknown>;
}

export interface SyncularLocalHealthReport {
  generatedAt: number;
  ok: boolean;
  checkedSubscriptions: number;
  checkedSubscriptionStates: number;
  checkedVerifiedRoots: number;
  checkedOutboxCommits: number;
  checkedConflicts: number;
  checkedSyncedRows: number;
  checkedBlobReferences: number;
  checkedCrdtDocuments: number;
  checkedCrdtUpdateLogEntries: number;
  findings: SyncularLocalHealthFinding[];
}

export interface SyncularLocalHealthRepairRequest {
  action: SyncularLocalHealthRepairAction;
  subscriptionIds?: readonly string[];
  tables?: readonly string[];
}

export interface SyncularLocalHealthRepairReport {
  action: SyncularLocalHealthRepairAction;
  deletedSubscriptionStates: number;
  deletedVerifiedRoots: number;
  forcedRebootstrapSubscriptions: number;
  clearedOrphanedSyncedRows: number;
  clearedTables: string[];
}

export interface SyncularLocalSyncResetRequest {
  subscriptionIds?: readonly string[];
  clearSyncedRows?: boolean;
}

export interface SyncularLocalSyncResetReport {
  resetSubscriptions: number;
  deletedSubscriptionStates: number;
  deletedVerifiedRoots: number;
  clearedSyncedRows: number;
  clearedTables: string[];
}

export interface SyncularLocalSupportSubscription {
  id: string;
  table: string;
  scopeKeys: string[];
  scopeValueCount: number;
  paramsKeys: string[];
  paramsValueCount: number;
  bootstrapPhase: number;
}

export interface SyncularLocalSupportSubscriptionState {
  stateId: string;
  subscriptionId: string;
  table: string;
  scopeKeys: string[];
  scopeValueCount: number;
  paramsKeys: string[];
  paramsValueCount: number;
  cursor: number;
  status: string;
  bootstrapStatePresent: boolean;
  bootstrapStateByteLen: number;
}

export interface SyncularLocalSupportVerifiedRoot {
  stateId: string;
  subscriptionId: string;
  partitionIdPresent: boolean;
  partitionIdByteLen: number;
  commitSeq: number;
  rootByteLen: number;
  rootIsCanonicalHex: boolean;
}

export interface SyncularLocalSupportOutboxSummary {
  total: number;
  byStatus: Record<string, number>;
  bySchemaVersion: Record<string, number>;
}

export interface SyncularLocalSupportConflictSummary {
  total: number;
  unresolved: number;
  resolved: number;
  byResultStatus: Record<string, number>;
  byCode: Record<string, number>;
}

export interface SyncularLocalSupportBundle {
  formatVersion: number;
  generatedAt: number;
  redacted: true;
  source: string;
  health: SyncularLocalHealthReport;
  appSchemaState: SyncularSchemaState;
  subscriptions: SyncularLocalSupportSubscription[];
  subscriptionStates: SyncularLocalSupportSubscriptionState[];
  verifiedRoots: SyncularLocalSupportVerifiedRoot[];
  outbox: SyncularLocalSupportOutboxSummary;
  conflicts: SyncularLocalSupportConflictSummary;
  blob?: Record<string, number>;
  crdt?: Record<string, number>;
}

export interface SyncularLocalSupportBundleImportReport {
  formatVersion: number;
  generatedAt: number;
  redacted: boolean;
  source: string;
  healthOk: boolean;
  findingCount: number;
  subscriptionCount: number;
  subscriptionStateCount: number;
  verifiedRootCount: number;
  checkedSubscriptionStates: number;
  checkedVerifiedRoots: number;
  checkedOutboxCommits: number;
  checkedConflicts: number;
  checkedSyncedRows: number;
}

export interface SyncularRustRuntimeInfo {
  crateName: string;
  crateVersion: string;
  schemaVersion: number;
  features: string[];
}

export interface SyncularRuntimeInfo {
  packageName: string;
  packageVersion: string;
  workerProtocolVersion: number;
  storage?: SyncularStorage;
  storageFallback?: SyncularStorageFallbackInfo;
  workerUrl?: string;
  wasmGlueUrl: string;
  wasmUrl: string;
  rust?: SyncularRustRuntimeInfo;
}

export interface SyncularStorageFallbackInfo {
  from: SyncularStorage;
  to: SyncularStorage;
  reason: string;
}

export interface SyncularConnectionState {
  closed: boolean;
  pendingRequests: number;
  realtime: SyncularRealtimeConnectionState;
  storageFallback?: SyncularStorageFallbackInfo;
  lastDiagnostic?: SyncularDiagnosticEvent;
  lastError?: {
    message: string;
    code?: string;
  };
}

export interface SyncularDiagnosticSubscriptionSnapshot {
  id: string;
  table: string;
  scopeKeys: string[];
  scopeValueCount: number;
  paramsKeys: string[];
  paramsValueCount: number;
  status: string | null;
  ready: boolean;
  phase: SyncularBootstrapSubscriptionPhase;
  progressPercent: number;
  cursor: number | null;
  bootstrapPhase: number;
  bootstrapState: SyncularBootstrapState | null;
}

export interface SyncularDiagnosticSnapshot {
  generatedAt: number;
  runtime: SyncularRuntimeInfo;
  connection: SyncularConnectionState;
  subscriptions: SyncularDiagnosticSubscriptionSnapshot[];
  recentDiagnostics: SyncularDiagnosticEvent[];
  recentSyncTimings: SyncularSyncTimings[];
  bootstrap?: SyncularBootstrapStatus;
  transportStats?: SyncularTransportStats;
  outboxStats?: SyncularOutboxStats;
  conflictStats?: SyncularConflictStats;
  blobUploadStats?: SyncularBlobUploadQueueStats;
}

export interface SyncularSqlResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: Row[];
  numAffectedRows?: number;
  insertId?: number;
}

export interface SyncularLiveQuerySnapshot<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  rows: Row[];
}

export interface SyncularLiveQueryEvent<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  queryId: string;
  version: number;
  changedRows: SyncularChangedRow[];
  rows: Row[];
}

export interface SyncularLiveQueryDependencyHint {
  table: string;
  rowIds?: readonly string[];
  fields?: readonly string[];
}

export interface SyncularLiveQueryDiagnostic {
  id: string;
  tables: string[];
  dependencyHintCount: number;
  rerunCount: number;
  skippedRerunCount: number;
  emittedEventCount: number;
}

export interface SyncularLiveQueryDiagnostics {
  queries: SyncularLiveQueryDiagnostic[];
}

export interface SyncularLiveQueries {
  live<Row extends Record<string, unknown>>(
    query: { compile(): CompiledQuery },
    options: SyncularLiveQueryOptions<Row>
  ): Promise<SyncularLiveQuerySubscription>;
}

export interface SyncularLiveQueryOptions<Row extends Record<string, unknown>> {
  tables?: readonly string[];
  onChange(rows: Row[], event: SyncularLiveQueryChange<Row>): void;
}

export interface SyncularLiveQueryChange<Row extends Record<string, unknown>>
  extends SyncularLiveQueryEvent<Row> {
  initial: boolean;
}

export interface SyncularLiveQuerySubscription {
  id: string;
  unsubscribe(): void;
}

export interface SyncularSqlClient {
  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<SyncularSqlResult<Row>>;
  subscribeQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
    tables: readonly string[],
    hints?: readonly SyncularLiveQueryDependencyHint[]
  ): Promise<SyncularLiveQuerySnapshot<Row>>;
  unsubscribeQuery(id: string): Promise<void>;
  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Promise<Array<SyncularLiveQueryEvent<Row>>>;
  close(): Promise<void>;
}

export interface SyncularUnsafeSqlClient extends SyncularSqlClient {
  executeUnsafeSql<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, params?: readonly unknown[]): Promise<SyncularSqlResult<Row>>;
}

export interface SyncularBlobStoreOptions {
  mimeType?: string;
  immediate?: boolean;
}

export interface SyncularBlobLimits {
  maxPayloadBytes?: number;
}

export interface SyncularBlobUploadQueueStats {
  pending: number;
  uploading: number;
  failed: number;
}

export interface SyncularBlobCacheStats {
  count: number;
  totalBytes: number;
}

export interface SyncularStorageCompactionOptions {
  olderThanMs?: number;
  maxBlobCacheBytes?: number;
  pruneAckedOutbox?: boolean;
  pruneResolvedConflicts?: boolean;
  pruneFailedBlobUploads?: boolean;
  pruneInactiveSubscriptionStates?: boolean;
  pruneTombstones?: boolean;
  maxTombstoneServerVersion?: number;
  pruneEncryptedCrdtUpdates?: boolean;
  maxEncryptedCrdtCheckpointsPerStream?: number;
  pruneCrdtUpdateLog?: boolean;
}

export interface SyncularStorageCompactionReport {
  ackedOutboxCommitsDeleted: number;
  resolvedConflictsDeleted: number;
  failedBlobUploadsDeleted: number;
  inactiveSubscriptionStatesDeleted: number;
  tombstoneRowsDeleted: number;
  blobCacheBytesPruned: number;
  encryptedCrdtUpdatesDeleted: number;
  encryptedCrdtCheckpointsDeleted: number;
  crdtUpdateLogDeleted: number;
}

export interface SyncularBlobs {
  store(
    data: Blob | File | Uint8Array,
    options?: SyncularBlobStoreOptions
  ): Promise<BlobRef>;
  retrieve(ref: BlobRef): Promise<Uint8Array>;
  isLocal(hash: string): Promise<boolean>;
  preload(refs: readonly BlobRef[]): Promise<void>;
  processUploadQueue(): Promise<{ uploaded: number; failed: number }>;
  getUploadQueueStats(): Promise<SyncularBlobUploadQueueStats>;
  getCacheStats(): Promise<SyncularBlobCacheStats>;
  pruneCache(maxBytes?: number): Promise<number>;
  clearCache(): Promise<void>;
}

export interface SyncularRuntimeClient extends SyncularSqlClient {
  setAuthHeaders(headers: SyncularAuthHeaders): Promise<void>;
  issueAuthLease(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularAuthLeaseRecord>;
  upsertAuthLease(lease: SyncularAuthLeaseRecord): Promise<void>;
  authLease(leaseId: string): Promise<SyncularAuthLeaseRecord | null>;
  activeAuthLeases(
    actorId?: string | null,
    nowMs?: number
  ): Promise<SyncularAuthLeaseRecord[]>;
  setFieldEncryption(
    config: SyncularFieldEncryptionConfig | null
  ): Promise<void>;
  setEncryptedCrdt(config: SyncularEncryptedCrdtConfig | null): Promise<void>;
  setBlobEncryption(config: SyncularBlobEncryptionConfig | null): Promise<void>;
  startRealtime(options?: boolean | SyncularRealtimeOptions): Promise<void>;
  stopRealtime(): Promise<void>;
  setSubscriptions(
    subscriptions: readonly SyncularSubscriptionSpec[]
  ): Promise<void>;
  forceSubscriptionsBootstrap(
    subscriptionIds?: readonly string[]
  ): Promise<number>;
  applyMutation(operation: SyncOperation, localRow?: unknown): Promise<string>;
  applyLeasedMutation(
    operation: SyncOperation,
    localRow?: unknown
  ): Promise<string>;
  applyMutationsBatch(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string[]>;
  applyMutationsCommit(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string>;
  applyLeasedMutationsCommit(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string>;
  syncPull(options?: SyncularSyncRequestOptions): Promise<SyncularSyncResult>;
  syncPush(options?: SyncularSyncRequestOptions): Promise<SyncularSyncResult>;
  syncOnce(options?: SyncularSyncRequestOptions): Promise<SyncularSyncResult>;
  resumeFromBackground(
    options?: SyncularSyncRequestOptions
  ): Promise<SyncularSyncResult>;
  conflictSummaries(): Promise<SyncularConflictSummary[]>;
  retryConflictKeepLocal(id: string): Promise<string>;
  resolveConflict(
    id: string,
    resolution: SyncularConflictResolution
  ): Promise<void>;
  listTable<Row extends Record<string, unknown> = Record<string, unknown>>(
    table: string
  ): Promise<Row[]>;
  storeBlob(
    data: Uint8Array,
    options?: SyncularBlobStoreOptions
  ): Promise<BlobRef>;
  retrieveBlob(ref: BlobRef): Promise<Uint8Array>;
  isBlobLocal(hash: string): Promise<boolean>;
  processBlobUploadQueue(): Promise<{ uploaded: number; failed: number }>;
  blobUploadQueueStats(): Promise<SyncularBlobUploadQueueStats>;
  blobCacheStats(): Promise<SyncularBlobCacheStats>;
  pruneBlobCache(maxBytes?: number): Promise<number>;
  clearBlobCache(): Promise<void>;
  compactStorage(
    options?: SyncularStorageCompactionOptions
  ): Promise<SyncularStorageCompactionReport>;
  generatedSchemaState(): Promise<SyncularSchemaState>;
  localHealthCheck(): Promise<SyncularLocalHealthReport>;
  repairLocalHealth(
    request: SyncularLocalHealthRepairRequest
  ): Promise<SyncularLocalHealthRepairReport>;
  resetLocalSyncState(
    request?: SyncularLocalSyncResetRequest
  ): Promise<SyncularLocalSyncResetReport>;
  exportLocalSupportBundle(): Promise<SyncularLocalSupportBundle>;
  importLocalSupportBundle(
    bundle: SyncularLocalSupportBundle | string
  ): Promise<SyncularLocalSupportBundleImportReport>;
  buildYjsTextUpdate(
    args: SyncularBuildYjsTextUpdateArgs
  ): Promise<SyncularBuildYjsTextUpdateResult>;
  applyYjsTextUpdates(
    args: SyncularApplyYjsTextUpdatesArgs
  ): Promise<SyncularApplyYjsTextUpdatesResult>;
  applyYjsEnvelopeToPayload(
    args: SyncularApplyYjsEnvelopeToPayloadArgs
  ): Promise<Record<string, unknown>>;
  openCrdtField(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtFieldDescriptor>;
  applyCrdtFieldText(
    request: SyncularCrdtFieldTextRequest
  ): Promise<SyncularCrdtFieldWriteReceipt>;
  applyCrdtFieldYjsUpdate(
    request: SyncularCrdtFieldYjsUpdateRequest
  ): Promise<SyncularCrdtFieldWriteReceipt>;
  materializeCrdtField(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtFieldMaterialization>;
  crdtDocumentSnapshot(
    request: SyncularCrdtFieldRequest
  ): Promise<SyncularCrdtDocumentSnapshot>;
  crdtUpdateLog(
    request: SyncularCrdtFieldRequest & { limit?: number }
  ): Promise<SyncularCrdtUpdateLogEntry[]>;
  snapshotCrdtFieldStateVector(
    request: SyncularCrdtFieldRequest
  ): Promise<{ stateVectorBase64: string }>;
  compactCrdtField(
    request: SyncularCrdtFieldCompactionRequest
  ): Promise<SyncularCrdtFieldCompactionReceipt>;
  encryptionHelper(
    method: SyncularEncryptionHelperMethod,
    args?: unknown
  ): Promise<unknown>;
  runtimeInfo(): Promise<SyncularRuntimeInfo>;
  connectionState(): SyncularConnectionState;
  lifecycleState(): SyncularLifecycleState;
  diagnosticSnapshot(): Promise<SyncularDiagnosticSnapshot>;
  addDiagnosticListener(listener: SyncularDiagnosticSink): () => void;
  addEventListener<T extends SyncularClientEventType>(
    event: T,
    listener: SyncularClientEventSink<T>
  ): () => void;
  addRowsChangedListener(listener: SyncularRowsChangedSink): () => void;
  getPresence<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularPresenceEntry<TMetadata>[];
  joinPresence(scopeKey: string, metadata?: Record<string, unknown>): void;
  leavePresence(scopeKey: string): void;
  updatePresenceMetadata(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void;
  addPresenceListener<TMetadata = Record<string, unknown>>(
    listener: SyncularPresenceSink<TMetadata>
  ): () => void;
  addLiveQueryListener(
    queryId: string,
    listener: (event: SyncularLiveQueryEvent<Record<string, unknown>>) => void
  ): void;
  removeLiveQueryListener(queryId: string): void;
}
