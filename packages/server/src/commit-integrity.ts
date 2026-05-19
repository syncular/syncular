import { sha256Hex, type SyncCommit } from '@syncular/core';
import { sql } from 'kysely';
import {
  coerceIsoString,
  coerceNumber,
  parseJsonValue,
} from './dialect/helpers';
import type { DbExecutor, ServerSyncDialect } from './dialect/types';
import type { SyncCoreDb } from './schema';

export const SYNCULAR_COMMIT_DIGEST_VERSION = 'syncular-commit-digest-v1';
export const SYNCULAR_COMMIT_CHAIN_ROOT_VERSION =
  'syncular-commit-chain-root-v1';
export const SYNCULAR_WIRE_COMMIT_DIGEST_VERSION =
  'syncular-wire-commit-digest-v1';
export const SYNCULAR_WIRE_COMMIT_CHAIN_ROOT_VERSION =
  'syncular-wire-commit-chain-root-v1';
export const SYNCULAR_COMMIT_GENESIS_ROOT = '0'.repeat(64);

export interface FinalizedCommitIntegrity {
  commitDigest: string;
  commitChainRoot: string;
  previousChainRoot: string;
}

interface PersistedCommitRow {
  commit_seq: unknown;
  partition_id: string;
  actor_id: string;
  client_id: string;
  client_commit_id: string;
  created_at: unknown;
  meta: unknown | null;
  result_json: unknown | null;
  change_count: unknown;
  affected_tables: unknown;
}

interface PersistedChangeRow {
  table: string;
  row_id: string;
  op: string;
  row_json: unknown | null;
  row_version: unknown | null;
  scopes: unknown;
}

type CanonicalJson =
  | null
  | string
  | number
  | boolean
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export async function finalizeCommitIntegrity<DB extends SyncCoreDb>(args: {
  db: DbExecutor<DB>;
  dialect: ServerSyncDialect;
  partitionId: string;
  commitSeq: number;
}): Promise<FinalizedCommitIntegrity> {
  const commit = await readPersistedCommit(args);
  const changes = await readPersistedChanges(args);
  const commitDigest = await sha256Hex(
    canonicalStringify({
      version: SYNCULAR_COMMIT_DIGEST_VERSION,
      partitionId: commit.partition_id,
      commitSeq: coerceNumber(commit.commit_seq) ?? args.commitSeq,
      actorId: commit.actor_id,
      clientId: commit.client_id,
      clientCommitId: commit.client_commit_id,
      createdAt: coerceIsoString(commit.created_at),
      meta: toCanonicalJson(parseJsonValue(commit.meta)),
      result: toCanonicalJson(parseJsonValue(commit.result_json)),
      changeCount: coerceNumber(commit.change_count) ?? changes.length,
      affectedTables: args.dialect.dbToArray(commit.affected_tables).sort(),
      changes: changes.map((change) => ({
        table: change.table,
        rowId: change.row_id,
        op: change.op,
        row: toCanonicalJson(parseJsonValue(change.row_json)),
        rowVersion: coerceNumber(change.row_version),
        scopes: toCanonicalJson(parseJsonValue(change.scopes)),
      })),
    })
  );
  const previousChainRoot = await readPreviousChainRoot(args);
  const commitChainRoot = await sha256Hex(
    canonicalStringify({
      version: SYNCULAR_COMMIT_CHAIN_ROOT_VERSION,
      partitionId: commit.partition_id,
      commitSeq: coerceNumber(commit.commit_seq) ?? args.commitSeq,
      previousChainRoot,
      commitDigest,
    })
  );

  await sql`
    UPDATE sync_commits
    SET
      commit_digest = ${commitDigest},
      commit_chain_root = ${commitChainRoot}
    WHERE partition_id = ${args.partitionId}
      AND commit_seq = ${args.commitSeq}
  `.execute(args.db);

  return {
    commitDigest,
    commitChainRoot,
    previousChainRoot,
  };
}

export async function attachWireCommitIntegrity(args: {
  partitionId: string;
  subscriptionId: string;
  previousRoot?: string | null;
  commits: SyncCommit[];
}): Promise<void> {
  let previousChainRoot = args.previousRoot || SYNCULAR_COMMIT_GENESIS_ROOT;
  for (const commit of args.commits) {
    commit.partitionId = args.partitionId;
    commit.previousChainRoot = previousChainRoot;
    const commitDigest = await wireCommitDigest({
      partitionId: args.partitionId,
      subscriptionId: args.subscriptionId,
      commit,
    });
    commit.commitDigest = commitDigest;
    const commitChainRoot = await sha256Hex(
      canonicalStringify({
        version: SYNCULAR_WIRE_COMMIT_CHAIN_ROOT_VERSION,
        partitionId: args.partitionId,
        subscriptionId: args.subscriptionId,
        commitSeq: commit.commitSeq,
        previousChainRoot,
        commitDigest,
      })
    );
    commit.commitChainRoot = commitChainRoot;
    previousChainRoot = commitChainRoot;
  }
}

export async function wireCommitDigest(args: {
  partitionId: string;
  subscriptionId: string;
  commit: SyncCommit;
}): Promise<string> {
  return sha256Hex(
    canonicalStringify({
      version: SYNCULAR_WIRE_COMMIT_DIGEST_VERSION,
      partitionId: args.partitionId,
      subscriptionId: args.subscriptionId,
      commitSeq: args.commit.commitSeq,
      createdAt: args.commit.createdAt,
      actorId: args.commit.actorId,
      changes: args.commit.changes.map((change) => ({
        table: change.table,
        rowId: change.row_id,
        op: change.op,
        row: toCanonicalJson(parseJsonValue(change.row_json)),
        rowVersion:
          change.row_version === null || change.row_version === undefined
            ? null
            : coerceNumber(change.row_version),
        scopes: toCanonicalJson(parseJsonValue(change.scopes)),
      })),
    })
  );
}

async function readPersistedCommit<DB extends SyncCoreDb>(args: {
  db: DbExecutor<DB>;
  partitionId: string;
  commitSeq: number;
}): Promise<PersistedCommitRow> {
  const result = await sql<PersistedCommitRow>`
    SELECT
      commit_seq,
      partition_id,
      actor_id,
      client_id,
      client_commit_id,
      created_at,
      meta,
      result_json,
      change_count,
      affected_tables
    FROM sync_commits
    WHERE partition_id = ${args.partitionId}
      AND commit_seq = ${args.commitSeq}
    LIMIT 1
  `.execute(args.db);

  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `Cannot finalize missing sync commit ${args.partitionId}:${args.commitSeq}`
    );
  }
  return row;
}

async function readPersistedChanges<DB extends SyncCoreDb>(args: {
  db: DbExecutor<DB>;
  partitionId: string;
  commitSeq: number;
}): Promise<PersistedChangeRow[]> {
  const result = await sql<PersistedChangeRow>`
    SELECT
      "table",
      row_id,
      op,
      row_json,
      row_version,
      scopes
    FROM sync_changes
    WHERE partition_id = ${args.partitionId}
      AND commit_seq = ${args.commitSeq}
    ORDER BY change_id ASC
  `.execute(args.db);

  return result.rows;
}

async function readPreviousChainRoot<DB extends SyncCoreDb>(args: {
  db: DbExecutor<DB>;
  partitionId: string;
  commitSeq: number;
}): Promise<string> {
  const result = await sql<{ commit_chain_root: string | null }>`
    SELECT commit_chain_root
    FROM sync_commits
    WHERE partition_id = ${args.partitionId}
      AND commit_seq < ${args.commitSeq}
      AND commit_chain_root IS NOT NULL
    ORDER BY commit_seq DESC
    LIMIT 1
  `.execute(args.db);

  return result.rows[0]?.commit_chain_root ?? SYNCULAR_COMMIT_GENESIS_ROOT;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(toCanonicalJson(value));
}

function toCanonicalJson(value: unknown): CanonicalJson {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot canonicalize non-finite number');
    }
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return {
      bytesHex: Array.from(value)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    };
  }
  if (Array.isArray(value)) {
    return value.map(toCanonicalJson);
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const result: { [key: string]: CanonicalJson } = {};
    for (const key of Object.keys(object).sort()) {
      result[key] = toCanonicalJson(object[key]);
    }
    return result;
  }

  return String(value);
}
