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

export interface SyncularV2ClientConfig {
  baseUrl: string;
  clientId: string;
  actorId: string;
  projectId?: string | null;
  pull?: SyncularV2PullOptions;
  fileName?: string;
  storage?: SyncularV2Storage;
  clearOnInit?: boolean;
  stateId?: string;
  schemaVersion?: number;
  appSchema?: SyncularV2AppSchema;
}

export interface SyncularV2PullOptions {
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

export interface SyncularV2TransportStats {
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

export type SyncularV2Storage = 'memory' | 'indexedDb' | 'opfsSahPool';

export type SyncularV2AuthHeaders = Record<string, string>;

export interface SyncularV2AuthLeaseRecord {
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

export interface SyncularV2FieldEncryptionRule {
  scope: string;
  table?: string;
  fields: string[];
  rowIdField?: string;
}

export interface SyncularV2FieldEncryptionConfig {
  rules: SyncularV2FieldEncryptionRule[];
  keys: Record<string, string | Uint8Array>;
  encryptionKid?: string;
  decryptionErrorMode?: 'throw' | 'keepCiphertext';
  envelopePrefix?: string;
}

export interface SyncularV2EncryptedCrdtConfig {
  keys: Record<string, string | Uint8Array>;
  encryptionKid?: string;
  partitionId?: string;
}

export interface SyncularV2BlobEncryptionConfig {
  keys: Record<string, string | Uint8Array>;
  encryptionKid?: string;
}

export type SyncularV2EncryptionHelperMethod =
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

export type SyncularV2RealtimeConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected';

export type SyncularV2DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error';

export type SyncularV2DiagnosticSource =
  | 'client'
  | 'worker'
  | 'sync'
  | 'auth'
  | 'realtime'
  | 'storage'
  | 'blob';

export interface SyncularV2DiagnosticEvent {
  at: number;
  level: SyncularV2DiagnosticLevel;
  source: SyncularV2DiagnosticSource;
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

export type SyncularV2DiagnosticSink = (
  event: SyncularV2DiagnosticEvent
) => void;

export interface SyncularV2SyncAttempt {
  syncAttemptId: string;
  traceId: string;
  spanId: string;
  traceparent: string;
}

export interface SyncularV2SyncRequestOptions {
  syncAttempt?: SyncularV2SyncAttempt;
}

export interface SyncularV2RealtimeOptions {
  enabled?: boolean;
  wsUrl?: string;
  params?: Record<string, string>;
  getParams?: (args: {
    clientId: string;
  }) => Record<string, string> | Promise<Record<string, string>>;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectBackoffFactor?: number;
  heartbeatTimeoutMs?: number;
}

export interface SyncularV2NetworkStatusSource {
  isOnline(): boolean | undefined;
  addEventListener?(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener?(type: 'online' | 'offline', listener: () => void): void;
}

export interface SyncularV2DatabaseSyncOptions {
  autoSyncAfterMutation?: boolean;
  mutationSyncDebounceMs?: number | false;
  network?: SyncularV2NetworkStatusSource | false;
  rowsChangedDebounceMs?: number | false;
  autoProcessBlobUploadsAfterStore?: boolean;
  blobUploadDebounceMs?: number | false;
}

export interface CreateSyncularV2DatabaseOptions {
  config: SyncularV2ClientConfig;
  worker?: Worker | (() => Worker);
  requestTimeoutMs?: number;
  runtime?: SyncularV2RuntimeArtifact;
  runtimeArtifacts?: readonly SyncularV2RuntimeArtifactCandidate[];
  requiredRuntimeFeatures?: readonly string[];
  blobLimits?: SyncularV2BlobLimits;
  codecs?: ColumnCodecSource;
  appTables?: readonly string[];
  tableConfig?: SyncularV2TableConfigMap;
  getHeaders?: () => SyncularV2AuthHeaders | Promise<SyncularV2AuthHeaders>;
  authLifecycle?: SyncAuthLifecycle;
  diagnostics?: SyncularV2DiagnosticSink;
  realtime?: boolean | SyncularV2RealtimeOptions;
  sync?: SyncularV2DatabaseSyncOptions;
}

export interface SyncularV2RuntimeArtifact {
  wasmGlueUrl?: string | URL;
  wasmUrl?: string | URL | Request;
}

export interface SyncularV2RuntimeArtifactCandidate
  extends SyncularV2RuntimeArtifact {
  name?: string;
  features: readonly string[];
}

export interface SyncularV2RuntimeArtifactCatalog {
  catalogVersion: 1;
  packageName: string;
  packageVersion: string;
  generatedAt?: string;
  artifacts: readonly SyncularV2RuntimeArtifactCatalogEntry[];
}

export interface SyncularV2RuntimeArtifactCatalogEntry {
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

export type SyncularV2TableConfigMap = Record<string, SyncularV2TableConfig>;

export interface SyncularV2TableConfig {
  primaryKeyColumn?: string;
  serverVersionColumn?: string | null;
  softDeleteColumn?: string | null;
  blobColumns?: readonly string[];
  crdtYjsFields?: readonly SyncularV2CrdtYjsFieldConfig[];
  encryptedFields?: readonly {
    field: string;
    scope?: string;
    rowIdField?: string;
  }[];
}

export interface SyncularV2AppSchema {
  schemaVersion: number;
  localBaseSchema?: SyncularV2LocalBaseSchema;
  tables: readonly SyncularV2AppTableMetadata[];
  migrations?: readonly SyncularV2EmbeddedMigration[];
}

export interface SyncularV2LocalBaseSchema {
  tableSetupSql: readonly string[];
}

export interface SyncularV2EmbeddedMigration {
  version: string;
  schemaVersion: number;
  name: string;
  upSql: string;
}

export interface SyncularV2AppTableMetadata {
  name: string;
  primaryKeyColumn: string;
  serverVersionColumn: string;
  softDeleteColumn?: string | null;
  subscriptionId: string;
  columns: readonly SyncularV2ColumnMetadata[];
  blobColumns: readonly string[];
  crdtYjsFields: readonly SyncularV2CrdtYjsFieldMetadata[];
  encryptedFields: readonly SyncularV2EncryptedFieldMetadata[];
  scopes: readonly SyncularV2ScopeMetadata[];
}

export interface SyncularV2ColumnMetadata {
  name: string;
  typeFamily: string;
  notnullRequired: boolean;
  primaryKey: boolean;
}

export interface SyncularV2ScopeMetadata {
  name: string;
  column: string;
  source: 'actorId' | 'projectId';
  required: boolean;
}

export interface SyncularV2CrdtYjsFieldMetadata {
  field: string;
  stateColumn: string;
  containerKey: string;
  rowIdField: string;
  kind: SyncularYjsFieldKind;
  syncMode: SyncularYjsSyncMode;
}

export interface SyncularV2EncryptedFieldMetadata {
  field: string;
  scope: string;
  rowIdField: string;
}

export type SyncularYjsFieldKind = 'text' | 'xml-fragment' | 'prosemirror';
export type SyncularYjsSyncMode = 'server-merge' | 'encrypted-update-log';

export interface SyncularV2CrdtYjsFieldConfig {
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

export interface SyncularV2CrdtFieldRequest {
  table: string;
  rowId: string;
  field: string;
}

export interface SyncularV2CrdtFieldDescriptor
  extends SyncularV2CrdtFieldRequest {
  stateColumn: string;
  containerKey: string;
  rowIdField: string;
  kind: SyncularYjsFieldKind;
  syncMode: SyncularYjsSyncMode;
}

export interface SyncularV2CrdtFieldTextRequest
  extends SyncularV2CrdtFieldRequest {
  nextText: string;
}

export interface SyncularV2CrdtFieldYjsUpdateRequest
  extends SyncularV2CrdtFieldRequest {
  update: SyncularYjsUpdateEnvelope;
}

export interface SyncularV2CrdtFieldCompactionRequest
  extends SyncularV2CrdtFieldRequest {
  minUncheckpointedUpdates?: number;
}

export interface SyncularV2CrdtFieldWriteReceipt {
  clientCommitId: string;
  syncMode: SyncularYjsSyncMode;
}

export interface SyncularV2CrdtFieldMaterialization {
  value: unknown;
  stateBase64?: string | null;
  stateVectorBase64: string;
}

export interface SyncularV2CrdtDocumentSnapshot
  extends SyncularV2CrdtFieldRequest {
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

export type SyncularV2CrdtUpdateOrigin = 'local' | 'remote' | 'compaction';
export type SyncularV2CrdtUpdateStatus =
  | 'pending'
  | 'flushed'
  | 'acked'
  | 'pruned';

export interface SyncularV2CrdtUpdateLogEntry {
  id: number;
  documentKey: string;
  updateId: string;
  clientCommitId?: string | null;
  origin: SyncularV2CrdtUpdateOrigin;
  status: SyncularV2CrdtUpdateStatus;
  updateBase64: string;
  stateVectorBase64: string;
  createdAt: number;
  flushedAt?: number | null;
  ackedAt?: number | null;
}

export interface SyncularV2CrdtFieldCompactionStats {
  pendingUpdates: number;
  flushedUpdates: number;
  ackedUpdates: number;
  logUpdates: number;
  stateVectorBase64: string;
  updatedAt: number;
  compactedAt?: number | null;
}

export interface SyncularV2EncryptedCrdtStreamStats {
  updateCount: number;
  checkpointCount: number;
  checkpointableUpdateCount: number;
  maxServerSeq?: number | null;
  latestCheckpointCoversSeq?: number | null;
}

export interface SyncularV2CrdtFieldCompactionReceipt {
  checkpointCreated: boolean;
  clientCommitId?: string | null;
  before: SyncularV2CrdtFieldCompactionStats;
  after: SyncularV2CrdtFieldCompactionStats;
  encryptedStreamBefore?: SyncularV2EncryptedCrdtStreamStats | null;
  encryptedStreamAfter?: SyncularV2EncryptedCrdtStreamStats | null;
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
  rules: readonly (SyncularV2CrdtYjsFieldConfig & { table: string })[];
  envelopeKey?: string;
  strict?: boolean;
  stripEnvelope?: boolean;
}

export interface SyncularV2SubscriptionSpec {
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

export interface SyncularV2ChangedRow {
  table: string;
  rowId?: string | null;
  operation: 'insert' | 'update' | 'delete' | 'compact' | string;
  changedFields: string[];
  crdtFields: string[];
  crdtFieldChanges?: SyncularV2ChangedCrdtField[];
  commitId?: string | null;
  commitSeq?: number | null;
  subscriptionId?: string | null;
  serverVersion?: number | null;
}

export interface SyncularV2ChangedCrdtField {
  field: string;
  stateColumn: string;
  containerKey: string;
  rowIdField: string;
  kind: string;
  syncMode: string;
}

export interface SyncularV2RowsChangedEvent {
  source: 'localWrite' | 'remotePull' | string;
  changedTables: string[];
  changedRows: SyncularV2ChangedRow[];
  changedRowsTruncated?: boolean;
}

export type SyncularV2RowsChangedSink = (
  event: SyncularV2RowsChangedEvent
) => void;

export interface SyncularV2OutboxStats {
  pending: number;
  sending: number;
  failed: number;
  acked: number;
  total: number;
}

export interface SyncularV2ConflictStats {
  unresolved: number;
  resolved: number;
  total: number;
}

export interface SyncularV2PresenceEntry<TMetadata = Record<string, unknown>> {
  clientId: string;
  actorId: string;
  joinedAt: number;
  metadata?: TMetadata;
}

export interface SyncularV2PresenceChangeEvent<
  TMetadata = Record<string, unknown>,
> {
  scopeKey: string;
  presence: SyncularV2PresenceEntry<TMetadata>[];
}

export type SyncularV2PresenceSink<TMetadata = Record<string, unknown>> = (
  event: SyncularV2PresenceChangeEvent<TMetadata>
) => void;

export interface SyncularV2BlobUploadEvent {
  ref: BlobRef;
}

export interface SyncularV2BlobUploadErrorEvent {
  hash: string;
  error: string;
  ref?: BlobRef;
}

export type SyncularV2LifecyclePhase =
  | 'closed'
  | 'offline'
  | 'connecting'
  | 'syncing'
  | 'recovering'
  | 'authRequired'
  | 'degraded'
  | 'complete';

export interface SyncularV2LifecycleState {
  phase: SyncularV2LifecyclePhase;
  realtime: SyncularV2RealtimeConnectionState;
  online: boolean;
  requiresAction: boolean;
  pendingRequests: number;
  bootstrap?: Pick<
    SyncularV2BootstrapStatus,
    | 'complete'
    | 'criticalReady'
    | 'interactiveReady'
    | 'isBootstrapping'
    | 'progressPercent'
  >;
  outbox?: SyncularV2OutboxStats;
  conflicts?: SyncularV2ConflictStats;
  blobUploads?: SyncularV2BlobUploadQueueStats;
  lastDiagnostic?: SyncularV2DiagnosticEvent;
  lastError?: {
    message: string;
    code?: string;
  };
}

export interface SyncularV2ClientEventMap {
  rowsChanged: SyncularV2RowsChangedEvent;
  lifecycleChanged: SyncularV2LifecycleState;
  bootstrapChanged: SyncularV2BootstrapStatus;
  outboxChanged: SyncularV2OutboxStats;
  conflictsChanged: SyncularV2ConflictStats;
  blobUploadsChanged: SyncularV2BlobUploadQueueStats;
  blobUploadCompleted: SyncularV2BlobUploadEvent;
  blobUploadFailed: SyncularV2BlobUploadErrorEvent;
  presenceChanged: SyncularV2PresenceChangeEvent;
}

export type SyncularV2ClientEventType = keyof SyncularV2ClientEventMap;

export type SyncularV2ClientEventSink<T extends SyncularV2ClientEventType> = (
  event: SyncularV2ClientEventMap[T]
) => void;

export type SyncularV2ErrorCode = CoreSyncularErrorCode;

export type SyncularV2ErrorCategory = CoreSyncularErrorCategory;

export type SyncularV2ErrorRecommendedAction =
  CoreSyncularErrorRecommendedAction;

export interface SyncularV2SyncResult {
  changedTables: string[];
  changedRows: SyncularV2ChangedRow[];
  changedRowsTruncated: boolean;
  subscriptions: SyncularV2SubscriptionResult[];
  bootstrap: SyncularV2BootstrapStatus;
  pushedCommits: number;
  timings: SyncularV2SyncTimings;
}

export interface SyncularV2SyncTimings {
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

export interface SyncularV2ConflictSummary {
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

export type SyncularV2ConflictResolution =
  | 'keep-local'
  | 'keep-server'
  | 'dismiss';

export interface SyncularV2SubscriptionResult {
  id: string;
  table: string;
  status: string;
  scopes: Record<string, string | string[]>;
  nextCursor: number;
  bootstrapPhase: number;
  bootstrapState: SyncularV2BootstrapState | null;
  ready: boolean;
  phase: SyncularV2BootstrapSubscriptionPhase;
  progressPercent: number;
  snapshotRows: unknown[];
  commits: unknown[];
}

export interface SyncularV2BootstrapState {
  asOfCommitSeq: number;
  tables: string[];
  tableIndex: number;
  rowCursor: string | null;
}

export type SyncularV2BootstrapSubscriptionPhase =
  | 'pending'
  | 'bootstrapping'
  | 'live'
  | 'error'
  | string;

export type SyncularV2BootstrapChannelPhase =
  | 'idle'
  | 'bootstrapping'
  | 'live'
  | 'error'
  | string;

export interface SyncularV2BootstrapSubscriptionStatus {
  id: string;
  table: string;
  expected: boolean;
  ready: boolean;
  status: string | null;
  phase: SyncularV2BootstrapSubscriptionPhase;
  progressPercent: number;
  cursor: number | null;
  bootstrapState: SyncularV2BootstrapState | null;
  bootstrapPhase: number;
}

export interface SyncularV2BootstrapPhaseStatus {
  phase: number;
  expectedSubscriptionIds: string[];
  readySubscriptionIds: string[];
  pendingSubscriptionIds: string[];
  isReady: boolean;
  progressPercent: number;
}

export interface SyncularV2BootstrapStatus {
  channelPhase: SyncularV2BootstrapChannelPhase;
  progressPercent: number;
  isBootstrapping: boolean;
  criticalReady: boolean;
  interactiveReady: boolean;
  complete: boolean;
  activePhase: number | null;
  expectedSubscriptionIds: string[];
  readySubscriptionIds: string[];
  pendingSubscriptionIds: string[];
  subscriptions: SyncularV2BootstrapSubscriptionStatus[];
  phases: SyncularV2BootstrapPhaseStatus[];
}

export interface SyncularV2SchemaState {
  schemaId: string;
  schemaVersion: number | null;
  currentSchemaVersion: number;
  updatedAt: number | null;
}

export type SyncularV2LocalHealthSeverity = 'info' | 'warning' | 'error';

export type SyncularV2LocalHealthRepairAction =
  | 'forceRebootstrap'
  | 'clearOrphanedState'
  | 'clearOrphanedSyncedRows'
  | 'manualInspection';

export interface SyncularV2LocalHealthFinding {
  severity: SyncularV2LocalHealthSeverity;
  code: string;
  component: string;
  message: string;
  subscriptionId?: string;
  table?: string;
  repairAction?: SyncularV2LocalHealthRepairAction;
  details?: Record<string, unknown>;
}

export interface SyncularV2LocalHealthReport {
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
  findings: SyncularV2LocalHealthFinding[];
}

export interface SyncularV2LocalHealthRepairRequest {
  action: SyncularV2LocalHealthRepairAction;
  subscriptionIds?: readonly string[];
  tables?: readonly string[];
}

export interface SyncularV2LocalHealthRepairReport {
  action: SyncularV2LocalHealthRepairAction;
  deletedSubscriptionStates: number;
  deletedVerifiedRoots: number;
  forcedRebootstrapSubscriptions: number;
  clearedOrphanedSyncedRows: number;
  clearedTables: string[];
}

export interface SyncularV2LocalSyncResetRequest {
  subscriptionIds?: readonly string[];
  clearSyncedRows?: boolean;
}

export interface SyncularV2LocalSyncResetReport {
  resetSubscriptions: number;
  deletedSubscriptionStates: number;
  deletedVerifiedRoots: number;
  clearedSyncedRows: number;
  clearedTables: string[];
}

export interface SyncularV2LocalSupportSubscription {
  id: string;
  table: string;
  scopeKeys: string[];
  scopeValueCount: number;
  paramsKeys: string[];
  paramsValueCount: number;
  bootstrapPhase: number;
}

export interface SyncularV2LocalSupportSubscriptionState {
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

export interface SyncularV2LocalSupportVerifiedRoot {
  stateId: string;
  subscriptionId: string;
  partitionIdPresent: boolean;
  partitionIdByteLen: number;
  commitSeq: number;
  rootByteLen: number;
  rootIsCanonicalHex: boolean;
}

export interface SyncularV2LocalSupportOutboxSummary {
  total: number;
  byStatus: Record<string, number>;
  bySchemaVersion: Record<string, number>;
}

export interface SyncularV2LocalSupportConflictSummary {
  total: number;
  unresolved: number;
  resolved: number;
  byResultStatus: Record<string, number>;
  byCode: Record<string, number>;
}

export interface SyncularV2LocalSupportBundle {
  formatVersion: number;
  generatedAt: number;
  redacted: true;
  source: string;
  health: SyncularV2LocalHealthReport;
  appSchemaState: SyncularV2SchemaState;
  subscriptions: SyncularV2LocalSupportSubscription[];
  subscriptionStates: SyncularV2LocalSupportSubscriptionState[];
  verifiedRoots: SyncularV2LocalSupportVerifiedRoot[];
  outbox: SyncularV2LocalSupportOutboxSummary;
  conflicts: SyncularV2LocalSupportConflictSummary;
  blob?: Record<string, number>;
  crdt?: Record<string, number>;
}

export interface SyncularV2LocalSupportBundleImportReport {
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

export interface SyncularV2RustRuntimeInfo {
  crateName: string;
  crateVersion: string;
  schemaVersion: number;
  features: string[];
}

export interface SyncularV2RuntimeInfo {
  packageName: string;
  packageVersion: string;
  workerProtocolVersion: number;
  storage?: SyncularV2Storage;
  storageFallback?: SyncularV2StorageFallbackInfo;
  workerUrl?: string;
  wasmGlueUrl: string;
  wasmUrl: string;
  rust?: SyncularV2RustRuntimeInfo;
}

export interface SyncularV2StorageFallbackInfo {
  from: SyncularV2Storage;
  to: SyncularV2Storage;
  reason: string;
}

export interface SyncularV2ConnectionState {
  closed: boolean;
  pendingRequests: number;
  realtime: SyncularV2RealtimeConnectionState;
  storageFallback?: SyncularV2StorageFallbackInfo;
  lastDiagnostic?: SyncularV2DiagnosticEvent;
  lastError?: {
    message: string;
    code?: string;
  };
}

export interface SyncularV2DiagnosticSubscriptionSnapshot {
  id: string;
  table: string;
  scopeKeys: string[];
  scopeValueCount: number;
  paramsKeys: string[];
  paramsValueCount: number;
  status: string | null;
  ready: boolean;
  phase: SyncularV2BootstrapSubscriptionPhase;
  progressPercent: number;
  cursor: number | null;
  bootstrapPhase: number;
  bootstrapState: SyncularV2BootstrapState | null;
}

export interface SyncularV2DiagnosticSnapshot {
  generatedAt: number;
  runtime: SyncularV2RuntimeInfo;
  connection: SyncularV2ConnectionState;
  subscriptions: SyncularV2DiagnosticSubscriptionSnapshot[];
  recentDiagnostics: SyncularV2DiagnosticEvent[];
  recentSyncTimings: SyncularV2SyncTimings[];
  bootstrap?: SyncularV2BootstrapStatus;
  transportStats?: SyncularV2TransportStats;
  outboxStats?: SyncularV2OutboxStats;
  conflictStats?: SyncularV2ConflictStats;
  blobUploadStats?: SyncularV2BlobUploadQueueStats;
}

export interface SyncularV2SqlResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  rows: Row[];
  numAffectedRows?: number;
  insertId?: number;
}

export interface SyncularV2LiveQuerySnapshot<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  rows: Row[];
}

export interface SyncularV2LiveQueryEvent<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  queryId: string;
  version: number;
  changedRows: SyncularV2ChangedRow[];
  rows: Row[];
}

export interface SyncularV2LiveQueryDependencyHint {
  table: string;
  rowIds?: readonly string[];
  fields?: readonly string[];
}

export interface SyncularV2LiveQueryDiagnostic {
  id: string;
  tables: string[];
  dependencyHintCount: number;
  rerunCount: number;
  skippedRerunCount: number;
  emittedEventCount: number;
}

export interface SyncularV2LiveQueryDiagnostics {
  queries: SyncularV2LiveQueryDiagnostic[];
}

export interface SyncularV2LiveQueries {
  live<Row extends Record<string, unknown>>(
    query: { compile(): CompiledQuery },
    options: SyncularV2LiveQueryOptions<Row>
  ): Promise<SyncularV2LiveQuerySubscription>;
}

export interface SyncularV2LiveQueryOptions<
  Row extends Record<string, unknown>,
> {
  tables?: readonly string[];
  onChange(rows: Row[], event: SyncularV2LiveQueryChange<Row>): void;
}

export interface SyncularV2LiveQueryChange<Row extends Record<string, unknown>>
  extends SyncularV2LiveQueryEvent<Row> {
  initial: boolean;
}

export interface SyncularV2LiveQuerySubscription {
  id: string;
  unsubscribe(): void;
}

export interface SyncularV2SqlClient {
  executeSql<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[]
  ): Promise<SyncularV2SqlResult<Row>>;
  subscribeQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[],
    tables: readonly string[],
    hints?: readonly SyncularV2LiveQueryDependencyHint[]
  ): Promise<SyncularV2LiveQuerySnapshot<Row>>;
  unsubscribeQuery(id: string): Promise<void>;
  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Promise<Array<SyncularV2LiveQueryEvent<Row>>>;
  close(): Promise<void>;
}

export interface SyncularV2UnsafeSqlClient extends SyncularV2SqlClient {
  executeUnsafeSql<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params?: readonly unknown[]
  ): Promise<SyncularV2SqlResult<Row>>;
}

export interface SyncularV2BlobStoreOptions {
  mimeType?: string;
  immediate?: boolean;
}

export interface SyncularV2BlobLimits {
  maxPayloadBytes?: number;
}

export interface SyncularV2BlobUploadQueueStats {
  pending: number;
  uploading: number;
  failed: number;
}

export interface SyncularV2BlobCacheStats {
  count: number;
  totalBytes: number;
}

export interface SyncularV2StorageCompactionOptions {
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

export interface SyncularV2StorageCompactionReport {
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

export interface SyncularV2Blobs {
  store(
    data: Blob | File | Uint8Array,
    options?: SyncularV2BlobStoreOptions
  ): Promise<BlobRef>;
  retrieve(ref: BlobRef): Promise<Uint8Array>;
  isLocal(hash: string): Promise<boolean>;
  preload(refs: readonly BlobRef[]): Promise<void>;
  processUploadQueue(): Promise<{ uploaded: number; failed: number }>;
  getUploadQueueStats(): Promise<SyncularV2BlobUploadQueueStats>;
  getCacheStats(): Promise<SyncularV2BlobCacheStats>;
  pruneCache(maxBytes?: number): Promise<number>;
  clearCache(): Promise<void>;
}

export interface SyncularV2Client extends SyncularV2SqlClient {
  setAuthHeaders(headers: SyncularV2AuthHeaders): Promise<void>;
  issueAuthLease(
    request: SyncAuthLeaseIssueRequest
  ): Promise<SyncularV2AuthLeaseRecord>;
  upsertAuthLease(lease: SyncularV2AuthLeaseRecord): Promise<void>;
  authLease(leaseId: string): Promise<SyncularV2AuthLeaseRecord | null>;
  activeAuthLeases(
    actorId?: string | null,
    nowMs?: number
  ): Promise<SyncularV2AuthLeaseRecord[]>;
  setFieldEncryption(
    config: SyncularV2FieldEncryptionConfig | null
  ): Promise<void>;
  setEncryptedCrdt(config: SyncularV2EncryptedCrdtConfig | null): Promise<void>;
  setBlobEncryption(
    config: SyncularV2BlobEncryptionConfig | null
  ): Promise<void>;
  startRealtime(options?: boolean | SyncularV2RealtimeOptions): Promise<void>;
  stopRealtime(): Promise<void>;
  setSubscriptions(
    subscriptions: readonly SyncularV2SubscriptionSpec[]
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
  syncPull(
    options?: SyncularV2SyncRequestOptions
  ): Promise<SyncularV2SyncResult>;
  syncPush(
    options?: SyncularV2SyncRequestOptions
  ): Promise<SyncularV2SyncResult>;
  syncOnce(
    options?: SyncularV2SyncRequestOptions
  ): Promise<SyncularV2SyncResult>;
  resumeFromBackground(
    options?: SyncularV2SyncRequestOptions
  ): Promise<SyncularV2SyncResult>;
  conflictSummaries(): Promise<SyncularV2ConflictSummary[]>;
  retryConflictKeepLocal(id: string): Promise<string>;
  resolveConflict(
    id: string,
    resolution: SyncularV2ConflictResolution
  ): Promise<void>;
  listTable<Row extends Record<string, unknown> = Record<string, unknown>>(
    table: string
  ): Promise<Row[]>;
  storeBlob(
    data: Uint8Array,
    options?: SyncularV2BlobStoreOptions
  ): Promise<BlobRef>;
  retrieveBlob(ref: BlobRef): Promise<Uint8Array>;
  isBlobLocal(hash: string): Promise<boolean>;
  processBlobUploadQueue(): Promise<{ uploaded: number; failed: number }>;
  blobUploadQueueStats(): Promise<SyncularV2BlobUploadQueueStats>;
  blobCacheStats(): Promise<SyncularV2BlobCacheStats>;
  pruneBlobCache(maxBytes?: number): Promise<number>;
  clearBlobCache(): Promise<void>;
  compactStorage(
    options?: SyncularV2StorageCompactionOptions
  ): Promise<SyncularV2StorageCompactionReport>;
  generatedSchemaState(): Promise<SyncularV2SchemaState>;
  localHealthCheck(): Promise<SyncularV2LocalHealthReport>;
  repairLocalHealth(
    request: SyncularV2LocalHealthRepairRequest
  ): Promise<SyncularV2LocalHealthRepairReport>;
  resetLocalSyncState(
    request?: SyncularV2LocalSyncResetRequest
  ): Promise<SyncularV2LocalSyncResetReport>;
  exportLocalSupportBundle(): Promise<SyncularV2LocalSupportBundle>;
  importLocalSupportBundle(
    bundle: SyncularV2LocalSupportBundle | string
  ): Promise<SyncularV2LocalSupportBundleImportReport>;
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
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtFieldDescriptor>;
  applyCrdtFieldText(
    request: SyncularV2CrdtFieldTextRequest
  ): Promise<SyncularV2CrdtFieldWriteReceipt>;
  applyCrdtFieldYjsUpdate(
    request: SyncularV2CrdtFieldYjsUpdateRequest
  ): Promise<SyncularV2CrdtFieldWriteReceipt>;
  materializeCrdtField(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtFieldMaterialization>;
  crdtDocumentSnapshot(
    request: SyncularV2CrdtFieldRequest
  ): Promise<SyncularV2CrdtDocumentSnapshot>;
  crdtUpdateLog(
    request: SyncularV2CrdtFieldRequest & { limit?: number }
  ): Promise<SyncularV2CrdtUpdateLogEntry[]>;
  snapshotCrdtFieldStateVector(
    request: SyncularV2CrdtFieldRequest
  ): Promise<{ stateVectorBase64: string }>;
  compactCrdtField(
    request: SyncularV2CrdtFieldCompactionRequest
  ): Promise<SyncularV2CrdtFieldCompactionReceipt>;
  encryptionHelper(
    method: SyncularV2EncryptionHelperMethod,
    args?: unknown
  ): Promise<unknown>;
  runtimeInfo(): Promise<SyncularV2RuntimeInfo>;
  connectionState(): SyncularV2ConnectionState;
  lifecycleState(): SyncularV2LifecycleState;
  diagnosticSnapshot(): Promise<SyncularV2DiagnosticSnapshot>;
  addDiagnosticListener(listener: SyncularV2DiagnosticSink): () => void;
  addEventListener<T extends SyncularV2ClientEventType>(
    event: T,
    listener: SyncularV2ClientEventSink<T>
  ): () => void;
  addRowsChangedListener(listener: SyncularV2RowsChangedSink): () => void;
  getPresence<TMetadata = Record<string, unknown>>(
    scopeKey: string
  ): SyncularV2PresenceEntry<TMetadata>[];
  joinPresence(scopeKey: string, metadata?: Record<string, unknown>): void;
  leavePresence(scopeKey: string): void;
  updatePresenceMetadata(
    scopeKey: string,
    metadata: Record<string, unknown>
  ): void;
  addPresenceListener<TMetadata = Record<string, unknown>>(
    listener: SyncularV2PresenceSink<TMetadata>
  ): () => void;
  addLiveQueryListener(
    queryId: string,
    listener: (event: SyncularV2LiveQueryEvent<Record<string, unknown>>) => void
  ): void;
  removeLiveQueryListener(queryId: string): void;
}
