import type {
  BlobRef,
  ColumnCodecSource,
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
  snapshotChunkJsonCount: number;
  snapshotChunkBinaryCount: number;
  snapshotChunkRowCount: number;
  snapshotChunkFetchMs: number;
  snapshotChunkDecompressMs: number;
  snapshotChunkHashMs: number;
  snapshotChunkDecodeMs: number;
  serverBootstrapSnapshotQueryMs: number;
  serverBootstrapRowFrameEncodeMs: number;
  serverBootstrapChunkCacheLookupMs: number;
  serverBootstrapChunkGzipMs: number;
  serverBootstrapChunkHashMs: number;
  serverBootstrapChunkPersistMs: number;
}

export type SyncularV2Storage = 'memory' | 'indexedDb' | 'opfsSahPool';

export type SyncularV2AuthHeaders = Record<string, string>;

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
  details?: Record<string, unknown>;
}

export type SyncularV2DiagnosticSink = (
  event: SyncularV2DiagnosticEvent
) => void;

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

export interface CreateSyncularV2DatabaseOptions {
  config: SyncularV2ClientConfig;
  worker?: Worker | (() => Worker);
  requestTimeoutMs?: number;
  runtime?: SyncularV2RuntimeArtifact;
  runtimeArtifacts?: readonly SyncularV2RuntimeArtifactCandidate[];
  requiredRuntimeFeatures?: readonly string[];
  codecs?: ColumnCodecSource;
  appTables?: readonly string[];
  tableConfig?: SyncularV2TableConfigMap;
  getHeaders?: () => SyncularV2AuthHeaders | Promise<SyncularV2AuthHeaders>;
  authLifecycle?: SyncAuthLifecycle;
  diagnostics?: SyncularV2DiagnosticSink;
  realtime?: boolean | SyncularV2RealtimeOptions;
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
  crdtYjsFields?: readonly SyncularV2CrdtYjsFieldConfig[];
}

export interface SyncularV2AppSchema {
  schemaVersion: number;
  tables: readonly SyncularV2AppTableMetadata[];
  migrations?: readonly SyncularV2EmbeddedMigration[];
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

export interface SyncularV2CrdtFieldCompactionReceipt {
  checkpointCreated: boolean;
  clientCommitId?: string | null;
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
}

export interface SyncularV2ChangedRow {
  table: string;
  rowId?: string | null;
  operation: 'insert' | 'update' | 'delete' | 'compact' | string;
  changedFields: string[];
  crdtFields: string[];
  commitId?: string | null;
  commitSeq?: number | null;
  subscriptionId?: string | null;
  serverVersion?: number | null;
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

export interface SyncularV2SyncResult {
  changedTables: string[];
  changedRows: SyncularV2ChangedRow[];
  changedRowsTruncated: boolean;
  subscriptions: SyncularV2SubscriptionResult[];
  pushedCommits: number;
  timings: SyncularV2SyncTimings;
}

export interface SyncularV2SyncTimings {
  totalMs: number;
  pushMs: number;
  pullMs: number;
  pullRequestMs: number;
  pullTransformMs: number;
  snapshotFetchMs: number;
  pullApplyMs: number;
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
  | 'dismiss'
  | 'accept-server'
  | (string & {});

export interface SyncularV2SubscriptionResult {
  id: string;
  table: string;
  status: string;
  scopes: Record<string, string | string[]>;
  nextCursor: number;
  snapshotRows: unknown[];
  commits: unknown[];
}

export interface SyncularV2SchemaState {
  schemaId: string;
  schemaVersion: number | null;
  currentSchemaVersion: number;
  updatedAt: number | null;
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
    tables: readonly string[]
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
  setFieldEncryption(
    config: SyncularV2FieldEncryptionConfig | null
  ): Promise<void>;
  setEncryptedCrdt(config: SyncularV2EncryptedCrdtConfig | null): Promise<void>;
  startRealtime(options?: boolean | SyncularV2RealtimeOptions): Promise<void>;
  stopRealtime(): Promise<void>;
  setSubscriptions(
    subscriptions: readonly SyncularV2SubscriptionSpec[]
  ): Promise<void>;
  applyLocalOperation(
    operation: SyncOperation,
    localRow?: unknown
  ): Promise<string>;
  applyLocalOperationsBatch(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string[]>;
  applyLocalOperationsCommit(
    operations: Array<{ operation: SyncOperation; localRow?: unknown | null }>
  ): Promise<string>;
  syncPull(): Promise<SyncularV2SyncResult>;
  syncPush(): Promise<SyncularV2SyncResult>;
  syncOnce(): Promise<SyncularV2SyncResult>;
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
  addDiagnosticListener(listener: SyncularV2DiagnosticSink): () => void;
  addRowsChangedListener(listener: SyncularV2RowsChangedSink): () => void;
  addLiveQueryListener(
    queryId: string,
    listener: (event: SyncularV2LiveQueryEvent<Record<string, unknown>>) => void
  ): void;
  removeLiveQueryListener(queryId: string): void;
}
