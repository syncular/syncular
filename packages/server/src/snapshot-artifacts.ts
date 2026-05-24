/**
 * @syncular/server - Scoped snapshot artifact metadata
 *
 * Artifacts are larger immutable bootstrap payloads, such as scoped SQLite
 * snapshots. They are keyed by the same product semantics as row chunks, but
 * kept separate from row chunks because they have stronger eligibility and
 * recovery requirements.
 */

import {
  type BinarySnapshotColumn,
  createScopedSnapshotArtifactManifest,
  randomId,
  type ScopedSnapshotArtifactManifest,
  type ScopeValues,
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
  SYNC_SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION,
  SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE,
  SYNC_SNAPSHOT_CHUNK_COMPRESSION,
  type SyncScopedSnapshotArtifactKind,
  type SyncSnapshotArtifactCompression,
  sha256Hex,
  snapshotScopeDigestFromCacheKey,
} from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import type { ServerHandlerCollection } from './handlers/collection';
import type { ServerTableHandler, SyncServerAuth } from './handlers/types';
import type { SyncCoreDb } from './schema';
import { scopesToSnapshotChunkScopeKey } from './snapshot-chunks';

export interface ScopedSnapshotArtifactScopeCacheKeyInput {
  partitionId: string;
  subscriptionId: string;
  scopes: ScopeValues;
  schemaVersion: number | string;
  artifactKind?: SyncScopedSnapshotArtifactKind;
  compression?: SyncSnapshotArtifactCompression;
  features?: readonly string[];
}

export interface ScopedSnapshotArtifactPageKey {
  partitionId: string;
  scopeKey: string;
  subscriptionId: string;
  table: string;
  asOfCommitSeq: number;
  rowCursor: string | null;
  rowLimit: number;
  artifactKind: SyncScopedSnapshotArtifactKind;
  schemaVersion: string;
  compression: SyncSnapshotArtifactCompression;
}

export interface ScopedSnapshotArtifactPageCapacityKey
  extends Omit<ScopedSnapshotArtifactPageKey, 'rowLimit'> {
  maxRowLimit: number;
}

export interface ScopedSnapshotArtifactRef {
  id: string;
  byteLength: number;
  sha256: string;
  manifestDigest: string;
  artifactKind: SyncScopedSnapshotArtifactKind;
  compression: SyncSnapshotArtifactCompression;
  rowCount: number;
  nextRowCursor: string | null;
  isFirstPage: boolean;
  isLastPage: boolean;
  manifest: ScopedSnapshotArtifactManifest;
}

export interface ScopedSnapshotArtifactRow extends ScopedSnapshotArtifactRef {
  artifactId: string;
  partitionId: string;
  scopeKey: string;
  subscriptionId: string;
  table: string;
  schemaVersion: string;
  asOfCommitSeq: number;
  rowCursor: string | null;
  rowLimit: number;
  blobHash: string;
  expiresAt: string;
  featureSet: string[];
}

export interface ScopedSnapshotArtifactBodyMetadata {
  artifactId: string;
  partitionId: string;
  scopeKey: string;
  subscriptionId: string;
  table: string;
  schemaVersion: string;
  asOfCommitSeq: number;
  rowCursor: string | null;
  rowLimit: number;
  rowCount: number;
  nextRowCursor: string | null;
  isFirstPage: boolean;
  isLastPage: boolean;
  artifactKind: SyncScopedSnapshotArtifactKind;
  compression: SyncSnapshotArtifactCompression;
  sha256: string;
  byteLength: number;
  featureSet: string[];
  expiresAt: string;
}

export interface StoredScopedSnapshotArtifactBody {
  blobHash: string;
}

export interface SnapshotArtifactStorage {
  readonly name: string;
  storeArtifact?(
    artifact: ScopedSnapshotArtifactBodyMetadata & { body: Uint8Array }
  ): Promise<StoredScopedSnapshotArtifactBody>;
  readArtifact(artifact: ScopedSnapshotArtifactRow): Promise<Uint8Array | null>;
  readArtifactStream?(
    artifact: ScopedSnapshotArtifactRow
  ): Promise<ReadableStream<Uint8Array> | null>;
}

export interface ScopedSnapshotSqliteArtifactEncoder {
  readonly artifactKind: SyncScopedSnapshotArtifactKind;
  readonly compression: SyncSnapshotArtifactCompression;
  readonly featureSet?: readonly string[];
  encode(args: {
    table: string;
    primaryKeyColumn?: string;
    columns: readonly BinarySnapshotColumn[];
    rows: readonly Record<string, unknown>[];
  }): Uint8Array | Promise<Uint8Array>;
}

export interface PrecomputeScopedSnapshotArtifactArgs<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
> {
  db: Kysely<DB>;
  storage: SnapshotArtifactStorage;
  handlers: ServerHandlerCollection<DB, Auth>;
  auth: Auth;
  partitionId: string;
  subscriptionId: string;
  table: string;
  scopes: ScopeValues;
  params?: Record<string, unknown>;
  schemaVersion: number | string;
  asOfCommitSeq: number;
  rowCursor?: string | null;
  rowLimit: number;
  expiresAt: string;
  artifactId?: string;
  encoder: ScopedSnapshotSqliteArtifactEncoder;
}

export interface PrecomputeScopedSnapshotArtifactsArgs<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
> extends Omit<
    PrecomputeScopedSnapshotArtifactArgs<DB, Auth>,
    'artifactId' | 'rowCursor'
  > {
  rowCursor?: string | null;
  artifactIdPrefix?: string;
  maxPages?: number;
}

type ScopedSnapshotArtifactDbRow = {
  artifact_id: string;
  partition_id: string;
  scope_key: string;
  subscription_id: string;
  table: string;
  artifact_kind: string;
  schema_version: string;
  as_of_commit_seq: number;
  row_cursor: string;
  row_limit: number;
  row_count: number;
  next_row_cursor: unknown;
  is_first_page: unknown;
  is_last_page: unknown;
  compression: string;
  sha256: string;
  byte_length: number;
  manifest_digest: string;
  feature_set_json: string;
  manifest_json: string;
  blob_hash: string;
  expires_at: unknown;
};

function coerceOptionalString(value: unknown): string | null {
  if (value == null || value === '') return null;
  return String(value);
}

function coerceFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function coerceIsoString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeFeatures(features: readonly string[] | undefined): string[] {
  return Array.from(new Set(features ?? [])).sort();
}

function parseJsonRecord(
  value: unknown,
  context: string
): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${context} must be a JSON object`);
}

function parseStringArray(value: unknown, context: string): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === 'string')
  ) {
    throw new Error(`${context} must be a JSON string array`);
  }
  return normalizeFeatures(parsed);
}

function isArtifactKind(
  value: string
): value is SyncScopedSnapshotArtifactKind {
  return value === SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1;
}

function isArtifactCompression(
  value: string
): value is SyncSnapshotArtifactCompression {
  return value === SYNC_SNAPSHOT_ARTIFACT_COMPRESSION_NONE || value === 'gzip';
}

async function coerceStoredManifest(
  value: unknown
): Promise<ScopedSnapshotArtifactManifest> {
  const record = parseJsonRecord(value, 'Scoped snapshot artifact manifest');
  const manifest = record as unknown as ScopedSnapshotArtifactManifest;
  const expected = await createScopedSnapshotArtifactManifest(manifest);
  if (expected.digest !== manifest.digest) {
    throw new Error(
      `Scoped snapshot artifact manifest digest mismatch: expected ${manifest.digest}, got ${expected.digest}`
    );
  }
  return {
    ...manifest,
    featureSet: normalizeFeatures(manifest.featureSet),
  };
}

function artifactRefFromRow(
  row: ScopedSnapshotArtifactDbRow,
  manifest: ScopedSnapshotArtifactManifest
): ScopedSnapshotArtifactRef {
  if (!isArtifactKind(row.artifact_kind)) {
    throw new Error(
      `Unexpected scoped snapshot artifact kind: ${row.artifact_kind}`
    );
  }
  if (!isArtifactCompression(row.compression)) {
    throw new Error(
      `Unexpected scoped snapshot artifact compression: ${row.compression}`
    );
  }
  if (manifest.digest !== row.manifest_digest) {
    throw new Error(
      `Scoped snapshot artifact digest mismatch: ${manifest.digest} != ${row.manifest_digest}`
    );
  }

  return {
    id: row.artifact_id,
    byteLength: Number(row.byte_length ?? 0),
    sha256: row.sha256,
    manifestDigest: row.manifest_digest,
    artifactKind: row.artifact_kind,
    compression: row.compression,
    rowCount: Number(row.row_count ?? 0),
    nextRowCursor: coerceOptionalString(row.next_row_cursor),
    isFirstPage: coerceFlag(row.is_first_page),
    isLastPage: coerceFlag(row.is_last_page),
    manifest,
  };
}

/**
 * Generate the semantic cache key for scoped snapshot artifacts.
 */
export async function createScopedSnapshotArtifactScopeCacheKey(
  input: ScopedSnapshotArtifactScopeCacheKeyInput
): Promise<string> {
  const scopeDigest = await scopesToSnapshotChunkScopeKey(input.scopes);
  const digest = await sha256Hex(
    JSON.stringify({
      version: 1,
      partitionId: input.partitionId,
      subscriptionId: input.subscriptionId,
      schemaVersion: String(input.schemaVersion),
      artifactKind:
        input.artifactKind ?? SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
      compression: input.compression ?? SYNC_SNAPSHOT_CHUNK_COMPRESSION,
      features: normalizeFeatures(input.features),
      scopeDigest,
    })
  );
  return `snapshot-artifact-v1:${digest}:scope:${scopeDigest}`;
}

export async function createScopedSnapshotArtifactManifestForPage(args: {
  partitionId: string;
  scopeKey: string;
  subscriptionId: string;
  table: string;
  schemaVersion: number | string;
  asOfCommitSeq: number;
  rowCursor: string | null;
  rowLimit: number;
  rowCount: number;
  nextRowCursor: string | null;
  isFirstPage: boolean;
  isLastPage: boolean;
  compression?: SyncSnapshotArtifactCompression;
  byteLength: number;
  sha256: string;
  featureSet?: readonly string[];
  artifactKind?: SyncScopedSnapshotArtifactKind;
}): Promise<ScopedSnapshotArtifactManifest> {
  return createScopedSnapshotArtifactManifest({
    version: SYNC_SCOPED_SNAPSHOT_ARTIFACT_MANIFEST_VERSION,
    artifactKind:
      args.artifactKind ?? SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1,
    partitionId: args.partitionId,
    subscriptionId: args.subscriptionId,
    table: args.table,
    schemaVersion: String(args.schemaVersion),
    asOfCommitSeq: args.asOfCommitSeq,
    scopeDigest: snapshotScopeDigestFromCacheKey(args.scopeKey),
    rowCursor: args.rowCursor,
    rowLimit: args.rowLimit,
    rowCount: args.rowCount,
    nextRowCursor: args.nextRowCursor,
    isFirstPage: args.isFirstPage,
    isLastPage: args.isLastPage,
    compression: args.compression ?? SYNC_SNAPSHOT_CHUNK_COMPRESSION,
    byteLength: args.byteLength,
    sha256: args.sha256,
    featureSet: normalizeFeatures(args.featureSet),
  });
}

export async function readScopedSnapshotArtifactRefByPageKey<
  DB extends SyncCoreDb,
>(
  db: Kysely<DB>,
  args: ScopedSnapshotArtifactPageKey & { nowIso?: string }
): Promise<ScopedSnapshotArtifactRef | null> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const rowCursorKey = args.rowCursor ?? '';
  const rowResult = await sql<ScopedSnapshotArtifactDbRow>`
    select
      artifact_id,
      partition_id,
      scope_key,
      subscription_id,
      "table",
      artifact_kind,
      schema_version,
      as_of_commit_seq,
      row_cursor,
      row_limit,
      row_count,
      next_row_cursor,
      is_first_page,
      is_last_page,
      compression,
      sha256,
      byte_length,
      manifest_digest,
      feature_set_json,
      manifest_json,
      blob_hash,
      expires_at
    from ${sql.table('sync_snapshot_artifacts')}
    where
      partition_id = ${args.partitionId}
      and scope_key = ${args.scopeKey}
      and subscription_id = ${args.subscriptionId}
      and "table" = ${args.table}
      and as_of_commit_seq = ${args.asOfCommitSeq}
      and row_cursor = ${rowCursorKey}
      and row_limit = ${args.rowLimit}
      and artifact_kind = ${args.artifactKind}
      and schema_version = ${args.schemaVersion}
      and compression = ${args.compression}
      and expires_at > ${nowIso}
    limit 1
  `.execute(db);
  const row = rowResult.rows[0];
  if (!row) return null;
  const manifest = await coerceStoredManifest(row.manifest_json);
  return artifactRefFromRow(row, manifest);
}

export async function readBestScopedSnapshotArtifactRefForPageCapacity<
  DB extends SyncCoreDb,
>(
  db: Kysely<DB>,
  args: ScopedSnapshotArtifactPageCapacityKey & { nowIso?: string }
): Promise<ScopedSnapshotArtifactRef | null> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const rowCursorKey = args.rowCursor ?? '';
  const rowResult = await sql<ScopedSnapshotArtifactDbRow>`
    select
      artifact_id,
      partition_id,
      scope_key,
      subscription_id,
      "table",
      artifact_kind,
      schema_version,
      as_of_commit_seq,
      row_cursor,
      row_limit,
      row_count,
      next_row_cursor,
      is_first_page,
      is_last_page,
      compression,
      sha256,
      byte_length,
      manifest_digest,
      feature_set_json,
      manifest_json,
      blob_hash,
      expires_at
    from ${sql.table('sync_snapshot_artifacts')}
    where
      partition_id = ${args.partitionId}
      and scope_key = ${args.scopeKey}
      and subscription_id = ${args.subscriptionId}
      and "table" = ${args.table}
      and as_of_commit_seq = ${args.asOfCommitSeq}
      and row_cursor = ${rowCursorKey}
      and row_limit <= ${args.maxRowLimit}
      and artifact_kind = ${args.artifactKind}
      and schema_version = ${args.schemaVersion}
      and compression = ${args.compression}
      and expires_at > ${nowIso}
    order by row_limit desc
    limit 1
  `.execute(db);
  const row = rowResult.rows[0];
  if (!row) return null;
  const manifest = await coerceStoredManifest(row.manifest_json);
  return artifactRefFromRow(row, manifest);
}

export async function insertScopedSnapshotArtifact<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  args: {
    artifactId: string;
    partitionId: string;
    scopeKey: string;
    subscriptionId: string;
    table: string;
    schemaVersion: number | string;
    asOfCommitSeq: number;
    rowCursor: string | null;
    rowLimit: number;
    rowCount: number;
    nextRowCursor?: string | null;
    isFirstPage: boolean;
    isLastPage: boolean;
    compression?: SyncSnapshotArtifactCompression;
    sha256: string;
    byteLength: number;
    featureSet?: readonly string[];
    blobHash: string;
    expiresAt: string;
    artifactKind?: SyncScopedSnapshotArtifactKind;
  }
): Promise<ScopedSnapshotArtifactRef> {
  const artifactKind =
    args.artifactKind ?? SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1;
  const compression = args.compression ?? SYNC_SNAPSHOT_CHUNK_COMPRESSION;
  const schemaVersion = String(args.schemaVersion);
  const rowCursorKey = args.rowCursor ?? '';
  const featureSet = normalizeFeatures(args.featureSet);
  const manifest = await createScopedSnapshotArtifactManifestForPage({
    ...args,
    schemaVersion,
    artifactKind,
    compression,
    nextRowCursor: args.nextRowCursor ?? null,
    featureSet,
  });
  const manifestJson = JSON.stringify(manifest);
  const featureSetJson = JSON.stringify(featureSet);
  const now = new Date().toISOString();

  await sql`
    insert into ${sql.table('sync_snapshot_artifacts')} (
      artifact_id,
      partition_id,
      scope_key,
      subscription_id,
      "table",
      artifact_kind,
      schema_version,
      as_of_commit_seq,
      row_cursor,
      row_limit,
      row_count,
      next_row_cursor,
      is_first_page,
      is_last_page,
      compression,
      sha256,
      byte_length,
      manifest_digest,
      feature_set_json,
      manifest_json,
      blob_hash,
      created_at,
      expires_at
    )
    values (
      ${args.artifactId},
      ${args.partitionId},
      ${args.scopeKey},
      ${args.subscriptionId},
      ${args.table},
      ${artifactKind},
      ${schemaVersion},
      ${args.asOfCommitSeq},
      ${rowCursorKey},
      ${args.rowLimit},
      ${args.rowCount},
      ${args.nextRowCursor ?? null},
      ${args.isFirstPage ? 1 : 0},
      ${args.isLastPage ? 1 : 0},
      ${compression},
      ${args.sha256},
      ${args.byteLength},
      ${manifest.digest},
      ${featureSetJson},
      ${manifestJson},
      ${args.blobHash},
      ${now},
      ${args.expiresAt}
    )
    on conflict (
      partition_id,
      scope_key,
      subscription_id,
      "table",
      as_of_commit_seq,
      row_cursor,
      row_limit,
      artifact_kind,
      schema_version,
      compression
    )
    do update set
      expires_at = ${args.expiresAt},
      row_count = ${args.rowCount},
      next_row_cursor = ${args.nextRowCursor ?? null},
      is_first_page = ${args.isFirstPage ? 1 : 0},
      is_last_page = ${args.isLastPage ? 1 : 0},
      sha256 = ${args.sha256},
      byte_length = ${args.byteLength},
      manifest_digest = ${manifest.digest},
      feature_set_json = ${featureSetJson},
      manifest_json = ${manifestJson},
      blob_hash = ${args.blobHash}
  `.execute(db);

  const ref = await readScopedSnapshotArtifactRefByPageKey(db, {
    partitionId: args.partitionId,
    scopeKey: args.scopeKey,
    subscriptionId: args.subscriptionId,
    table: args.table,
    asOfCommitSeq: args.asOfCommitSeq,
    rowCursor: args.rowCursor,
    rowLimit: args.rowLimit,
    artifactKind,
    schemaVersion,
    compression,
  });
  if (!ref) {
    throw new Error('Failed to read inserted scoped snapshot artifact');
  }
  return ref;
}

export async function storeScopedSnapshotArtifact<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  storage: SnapshotArtifactStorage,
  args: {
    artifactId?: string;
    partitionId: string;
    scopeKey: string;
    subscriptionId: string;
    table: string;
    schemaVersion: number | string;
    asOfCommitSeq: number;
    rowCursor: string | null;
    rowLimit: number;
    rowCount: number;
    nextRowCursor?: string | null;
    isFirstPage: boolean;
    isLastPage: boolean;
    compression?: SyncSnapshotArtifactCompression;
    body: Uint8Array;
    featureSet?: readonly string[];
    expiresAt: string;
    artifactKind?: SyncScopedSnapshotArtifactKind;
  }
): Promise<ScopedSnapshotArtifactRef> {
  if (!storage.storeArtifact) {
    throw new Error(
      `Snapshot artifact storage ${storage.name} cannot store artifacts`
    );
  }

  const artifactKind =
    args.artifactKind ?? SYNC_SCOPED_SNAPSHOT_ARTIFACT_KIND_SQLITE_V1;
  const compression = args.compression ?? SYNC_SNAPSHOT_CHUNK_COMPRESSION;
  const artifactId = args.artifactId ?? randomId();
  const schemaVersion = String(args.schemaVersion);
  const featureSet = normalizeFeatures(args.featureSet);
  const sha256 = await sha256Hex(args.body);
  const byteLength = args.body.byteLength;
  const metadata: ScopedSnapshotArtifactBodyMetadata = {
    artifactId,
    partitionId: args.partitionId,
    scopeKey: args.scopeKey,
    subscriptionId: args.subscriptionId,
    table: args.table,
    schemaVersion,
    asOfCommitSeq: args.asOfCommitSeq,
    rowCursor: args.rowCursor,
    rowLimit: args.rowLimit,
    rowCount: args.rowCount,
    nextRowCursor: args.nextRowCursor ?? null,
    isFirstPage: args.isFirstPage,
    isLastPage: args.isLastPage,
    artifactKind,
    compression,
    sha256,
    byteLength,
    featureSet,
    expiresAt: args.expiresAt,
  };
  const stored = await storage.storeArtifact({ ...metadata, body: args.body });

  return insertScopedSnapshotArtifact(db, {
    artifactId,
    partitionId: metadata.partitionId,
    scopeKey: metadata.scopeKey,
    subscriptionId: metadata.subscriptionId,
    table: metadata.table,
    schemaVersion: metadata.schemaVersion,
    asOfCommitSeq: metadata.asOfCommitSeq,
    rowCursor: metadata.rowCursor,
    rowLimit: metadata.rowLimit,
    rowCount: metadata.rowCount,
    nextRowCursor: metadata.nextRowCursor,
    isFirstPage: metadata.isFirstPage,
    isLastPage: metadata.isLastPage,
    compression: metadata.compression,
    sha256: metadata.sha256,
    byteLength: metadata.byteLength,
    featureSet: metadata.featureSet,
    blobHash: stored.blobHash,
    expiresAt: metadata.expiresAt,
    artifactKind: metadata.artifactKind,
  });
}

function snapshotRowsAsObjects(
  rows: readonly unknown[]
): Record<string, unknown>[] {
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(
        `Snapshot artifact row ${index} must be an object before SQLite encoding`
      );
    }
    return row as Record<string, unknown>;
  });
}

function resolveSnapshotBinaryColumns<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(
  handler: ServerTableHandler<DB, Auth>,
  schemaVersion: number
): readonly BinarySnapshotColumn[] | undefined {
  const versioned = handler.snapshotBinaryColumnsForVersion?.(schemaVersion);
  return versioned === undefined
    ? handler.snapshotBinaryColumns
    : (versioned ?? undefined);
}

export async function precomputeScopedSnapshotArtifact<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  args: PrecomputeScopedSnapshotArtifactArgs<DB, Auth>
): Promise<ScopedSnapshotArtifactRef> {
  const handler = args.handlers.byTable.get(args.table);
  if (!handler) {
    throw new Error(
      `Unknown table for scoped snapshot artifact: ${args.table}`
    );
  }
  const schemaVersion = Number(args.schemaVersion);
  const snapshotBinaryColumns = resolveSnapshotBinaryColumns(
    handler,
    schemaVersion
  );
  if (!snapshotBinaryColumns) {
    throw new Error(
      `Table ${args.table} cannot build SQLite snapshot artifacts without generated snapshotBinaryColumns`
    );
  }

  const rowCursor = args.rowCursor ?? null;
  const page = await handler.snapshot(
    {
      db: args.db,
      actorId: args.auth.actorId,
      auth: args.auth,
      scopeValues: args.scopes,
      cursor: rowCursor,
      limit: args.rowLimit,
      schemaVersion,
    },
    args.params
  );
  const rows = snapshotRowsAsObjects(page.rows ?? []);
  const featureSet = normalizeFeatures(args.encoder.featureSet);
  const scopeKey = await createScopedSnapshotArtifactScopeCacheKey({
    partitionId: args.partitionId,
    subscriptionId: args.subscriptionId,
    scopes: args.scopes,
    schemaVersion: args.schemaVersion,
    artifactKind: args.encoder.artifactKind,
    compression: args.encoder.compression,
    features: featureSet,
  });
  const body = await args.encoder.encode({
    table: args.table,
    primaryKeyColumn: handler.primaryKeyColumn,
    columns: snapshotBinaryColumns,
    rows,
  });

  return storeScopedSnapshotArtifact(args.db, args.storage, {
    artifactId: args.artifactId,
    partitionId: args.partitionId,
    scopeKey,
    subscriptionId: args.subscriptionId,
    table: args.table,
    schemaVersion: args.schemaVersion,
    asOfCommitSeq: args.asOfCommitSeq,
    rowCursor,
    rowLimit: args.rowLimit,
    rowCount: rows.length,
    nextRowCursor: page.nextCursor ?? null,
    isFirstPage: rowCursor == null,
    isLastPage: page.nextCursor == null,
    compression: args.encoder.compression,
    body,
    featureSet,
    expiresAt: args.expiresAt,
    artifactKind: args.encoder.artifactKind,
  });
}

export async function precomputeScopedSnapshotArtifacts<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  args: PrecomputeScopedSnapshotArtifactsArgs<DB, Auth>
): Promise<ScopedSnapshotArtifactRef[]> {
  const maxPages = args.maxPages ?? Number.MAX_SAFE_INTEGER;
  if (maxPages < 1) {
    throw new Error(`maxPages must be positive: ${maxPages}`);
  }

  const refs: ScopedSnapshotArtifactRef[] = [];
  let rowCursor = args.rowCursor ?? null;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const ref = await precomputeScopedSnapshotArtifact({
      ...args,
      rowCursor,
      artifactId: args.artifactIdPrefix
        ? `${args.artifactIdPrefix}-${pageIndex}`
        : undefined,
    });
    refs.push(ref);
    if (ref.isLastPage || ref.nextRowCursor == null) break;
    rowCursor = ref.nextRowCursor;
  }
  return refs;
}

export async function readScopedSnapshotArtifact<DB extends SyncCoreDb>(
  db: Kysely<DB>,
  artifactId: string
): Promise<ScopedSnapshotArtifactRow | null> {
  const rowResult = await sql<ScopedSnapshotArtifactDbRow>`
    select
      artifact_id,
      partition_id,
      scope_key,
      subscription_id,
      "table",
      artifact_kind,
      schema_version,
      as_of_commit_seq,
      row_cursor,
      row_limit,
      row_count,
      next_row_cursor,
      is_first_page,
      is_last_page,
      compression,
      sha256,
      byte_length,
      manifest_digest,
      feature_set_json,
      manifest_json,
      blob_hash,
      expires_at
    from ${sql.table('sync_snapshot_artifacts')}
    where artifact_id = ${artifactId}
    limit 1
  `.execute(db);
  const row = rowResult.rows[0];
  if (!row) return null;
  const manifest = await coerceStoredManifest(row.manifest_json);
  const ref = artifactRefFromRow(row, manifest);
  return {
    ...ref,
    artifactId: row.artifact_id,
    partitionId: row.partition_id,
    scopeKey: row.scope_key,
    subscriptionId: row.subscription_id,
    table: row.table,
    schemaVersion: row.schema_version,
    asOfCommitSeq: Number(row.as_of_commit_seq ?? 0),
    rowCursor: coerceOptionalString(row.row_cursor),
    rowLimit: Number(row.row_limit ?? 0),
    blobHash: row.blob_hash,
    expiresAt: coerceIsoString(row.expires_at),
    featureSet: parseStringArray(
      row.feature_set_json,
      'Scoped snapshot artifact feature set'
    ),
  };
}

export async function deleteExpiredScopedSnapshotArtifacts<
  DB extends SyncCoreDb,
>(db: Kysely<DB>, nowIso = new Date().toISOString()): Promise<number> {
  const res = await sql`
    delete from ${sql.table('sync_snapshot_artifacts')}
    where expires_at <= ${nowIso}
  `.execute(db);

  return Number(res.numAffectedRows ?? 0);
}
