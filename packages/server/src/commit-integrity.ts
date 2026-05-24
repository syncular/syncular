import {
  type SyncCommit,
  type SyncPullSubscriptionIntegrity,
  sha256Hex,
} from '@syncular/core';
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
      meta: parseJsonValue(commit.meta),
      result: parseJsonValue(commit.result_json),
      changeCount: coerceNumber(commit.change_count) ?? changes.length,
      affectedTables: args.dialect.dbToArray(commit.affected_tables).sort(),
      changes: changes.map((change) => ({
        table: change.table,
        rowId: change.row_id,
        op: change.op,
        row: parseJsonValue(change.row_json),
        rowVersion: coerceNumber(change.row_version),
        scopes: parseJsonValue(change.scopes),
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

export async function createWireSubscriptionIntegrity(args: {
  partitionId: string;
  subscriptionId: string;
  previousRoot?: string | null;
  commits: SyncCommit[];
}): Promise<SyncPullSubscriptionIntegrity | undefined> {
  if (args.commits.length === 0) {
    return undefined;
  }
  const firstPreviousChainRoot =
    args.previousRoot || SYNCULAR_COMMIT_GENESIS_ROOT;
  let previousChainRoot = args.previousRoot || SYNCULAR_COMMIT_GENESIS_ROOT;
  for (const commit of args.commits) {
    const commitDigest = await wireCommitDigest({
      partitionId: args.partitionId,
      subscriptionId: args.subscriptionId,
      commit,
    });
    const commitChainRoot = await wireCommitChainRootFromDigest({
      partitionId: args.partitionId,
      subscriptionId: args.subscriptionId,
      commitSeq: commit.commitSeq,
      previousChainRoot,
      commitDigest,
    });
    previousChainRoot = commitChainRoot;
  }
  const lastCommit = args.commits[args.commits.length - 1]!;
  return {
    partitionId: args.partitionId,
    previousChainRoot: firstPreviousChainRoot,
    commitChainRoot: previousChainRoot,
    commitSeq: lastCommit.commitSeq,
  };
}

export async function wireCommitDigest(args: {
  partitionId: string;
  subscriptionId: string;
  commit: SyncCommit;
}): Promise<string> {
  return sha256Hex(wireCommitDigestPayload(args));
}

export async function wireCommitChainRootFromDigest(args: {
  partitionId: string;
  subscriptionId: string;
  commitSeq: number;
  previousChainRoot: string;
  commitDigest: string;
}): Promise<string> {
  return sha256Hex(wireCommitChainRootPayload(args));
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
  const out: string[] = [];
  appendCanonicalJson(out, value);
  return out.join('');
}

function wireCommitDigestPayload(args: {
  partitionId: string;
  subscriptionId: string;
  commit: SyncCommit;
}): string {
  const out: string[] = [];
  out.push('{"actorId":');
  appendCanonicalJson(out, args.commit.actorId);
  out.push(',"changes":[');
  args.commit.changes.forEach((change, index) => {
    if (index > 0) out.push(',');
    out.push('{"op":');
    appendCanonicalJson(out, change.op);
    out.push(',"row":');
    appendCanonicalJson(out, parseJsonValue(change.row_json));
    out.push(',"rowId":');
    appendCanonicalJson(out, change.row_id);
    out.push(',"rowVersion":');
    appendCanonicalJson(
      out,
      change.row_version === null || change.row_version === undefined
        ? null
        : coerceNumber(change.row_version)
    );
    out.push(',"scopes":');
    appendCanonicalJson(out, parseJsonValue(change.scopes));
    out.push(',"table":');
    appendCanonicalJson(out, change.table);
    out.push('}');
  });
  out.push('],"commitSeq":');
  appendCanonicalJson(out, args.commit.commitSeq);
  out.push(',"createdAt":');
  appendCanonicalJson(out, args.commit.createdAt);
  out.push(',"partitionId":');
  appendCanonicalJson(out, args.partitionId);
  out.push(',"subscriptionId":');
  appendCanonicalJson(out, args.subscriptionId);
  out.push(',"version":');
  appendCanonicalJson(out, SYNCULAR_WIRE_COMMIT_DIGEST_VERSION);
  out.push('}');
  return out.join('');
}

function wireCommitChainRootPayload(args: {
  partitionId: string;
  subscriptionId: string;
  commitSeq: number;
  previousChainRoot: string;
  commitDigest: string;
}): string {
  const out: string[] = [];
  out.push('{"commitDigest":');
  appendCanonicalJson(out, args.commitDigest);
  out.push(',"commitSeq":');
  appendCanonicalJson(out, args.commitSeq);
  out.push(',"partitionId":');
  appendCanonicalJson(out, args.partitionId);
  out.push(',"previousChainRoot":');
  appendCanonicalJson(out, args.previousChainRoot);
  out.push(',"subscriptionId":');
  appendCanonicalJson(out, args.subscriptionId);
  out.push(',"version":');
  appendCanonicalJson(out, SYNCULAR_WIRE_COMMIT_CHAIN_ROOT_VERSION);
  out.push('}');
  return out.join('');
}

function appendCanonicalJson(out: string[], value: unknown): void {
  if (value === null || value === undefined) {
    out.push('null');
    return;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    out.push(JSON.stringify(value));
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot canonicalize non-finite number');
    }
    out.push(JSON.stringify(value));
    return;
  }
  if (typeof value === 'bigint') {
    out.push(JSON.stringify(value.toString()));
    return;
  }
  if (value instanceof Date) {
    out.push(JSON.stringify(value.toISOString()));
    return;
  }
  if (value instanceof Uint8Array) {
    out.push('{"bytesHex":');
    out.push(
      JSON.stringify(
        Array.from(value)
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
      )
    );
    out.push('}');
    return;
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) out.push(',');
      appendCanonicalJson(out, value[index]);
    }
    out.push(']');
    return;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    out.push('{');
    Object.keys(object)
      .sort()
      .forEach((key, index) => {
        if (index > 0) out.push(',');
        out.push(JSON.stringify(key));
        out.push(':');
        appendCanonicalJson(out, object[key]);
      });
    out.push('}');
    return;
  }

  out.push(JSON.stringify(String(value)));
}
