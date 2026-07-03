/**
 * Pull: incremental commit delivery, cursors, bootstrap segments
 * (SPEC.md §4, §5).
 */
import {
  type CommitChange,
  decodeRow,
  encodeRowsSegment,
  type PullHeaderFrame,
  type ResponseFrame,
  type ScopeMap,
  type SegmentRow,
  type SubscriptionFrame,
} from '@syncular-v2/core';
import type { SyncRequestContext } from './context';
import { clockOf, limitsOf } from './context';
import type { CompiledSchema, CompiledTable } from './schema';
import { scopeDigest } from './scopes';
import { signSegmentToken } from './signed-url';
import type { StoredCommit, StoredRow } from './storage';

/** §4.2 accept bitmask. */
export const ACCEPT_INLINE_ROWS = 1 << 0;
export const ACCEPT_EXTERNAL_ROWS = 1 << 1;
export const ACCEPT_SQLITE = 1 << 2;
export const ACCEPT_SIGNED_URLS = 1 << 3;

export interface PullLimits {
  readonly limitCommits: number;
  readonly limitSnapshotRows: number;
  readonly maxSnapshotPages: number;
  readonly accept: number;
}

function clamp(value: number, min: number, max: number, dflt: number): number {
  if (value === 0) return dflt;
  return Math.min(max, Math.max(min, value));
}

/** §4.2 defaults and silent clamps (the v1 values). */
export function clampPullLimits(header: PullHeaderFrame): PullLimits {
  return {
    limitCommits: clamp(header.limitCommits, 1, 1000, 1000),
    limitSnapshotRows: clamp(header.limitSnapshotRows, 1, 50000, 1000),
    maxSnapshotPages: clamp(header.maxSnapshotPages, 1, 50, 4),
    accept: header.accept,
  };
}

export interface SubscriptionPlan {
  readonly frame: SubscriptionFrame;
  readonly table: CompiledTable;
  readonly status: 'active' | 'revoked';
  readonly effective: ScopeMap;
}

export interface SubscriptionResult {
  readonly nextCursor: number;
  readonly active: boolean;
}

interface BootstrapToken {
  asOfCommitSeq: number;
  tables: string[];
  tableIndex: number;
  rowCursor: string | null;
}

function parseBootstrapToken(
  raw: string | undefined,
  table: string,
): BootstrapToken | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<BootstrapToken>;
    if (
      typeof parsed.asOfCommitSeq !== 'number' ||
      !Array.isArray(parsed.tables) ||
      typeof parsed.tableIndex !== 'number' ||
      (parsed.rowCursor !== null && typeof parsed.rowCursor !== 'string') ||
      parsed.tables[0] !== table
    ) {
      return undefined;
    }
    return {
      asOfCommitSeq: parsed.asOfCommitSeq,
      tables: parsed.tables as string[],
      tableIndex: parsed.tableIndex,
      rowCursor: parsed.rowCursor ?? null,
    };
  } catch {
    return undefined;
  }
}

function commitFrame(table: string, commit: StoredCommit): ResponseFrame {
  const changes: CommitChange[] = commit.changes.map((change) => ({
    tableIndex: 0,
    rowId: change.rowId,
    op: change.op,
    ...(change.rowVersion !== undefined
      ? { rowVersion: change.rowVersion }
      : {}),
    scopes: change.scopes,
    ...(change.payload !== undefined ? { row: change.payload } : {}),
  }));
  return {
    type: 'COMMIT',
    commitSeq: commit.commitSeq,
    createdAtMs: commit.createdAtMs,
    actorId: commit.actorId,
    tables: [table],
    changes,
  };
}

function chunkRows(rows: SegmentRow[], size: number): SegmentRow[][] {
  if (rows.length === 0) return [];
  const blocks: SegmentRow[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    blocks.push(rows.slice(i, i + size));
  }
  return blocks;
}

async function* bootstrapSegments(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  plan: SubscriptionPlan,
  asOf: number,
  startRowCursor: string | null,
): AsyncGenerator<
  ResponseFrame,
  { complete: boolean; rowCursor: string | null }
> {
  const { storage, segments, partition } = ctx;
  const serverLimits = limitsOf(ctx);
  const digest = await scopeDigest(plan.effective);
  const now = clockOf(ctx)();
  let rowCursor = startRowCursor;
  for (let page = 0; page < limits.maxSnapshotPages; page++) {
    const scanned = await storage.scanRows(partition, {
      table: plan.table.name,
      scopeFilter: plan.effective,
      afterRowId: rowCursor,
      limit: limits.limitSnapshotRows + 1,
    });
    const pageRows = scanned.slice(0, limits.limitSnapshotRows);
    const hasMore = scanned.length > limits.limitSnapshotRows;
    // §5.2: every row record carries the row's current server_version.
    const decoded = pageRows.map((row: StoredRow) => ({
      serverVersion: row.serverVersion,
      values: decodeRow(plan.table.columns, row.payload),
    }));
    const bytes = encodeRowsSegment({
      table: plan.table.name,
      schemaVersion: schema.version,
      columns: plan.table.columns,
      blocks: chunkRows(decoded, 1000),
    });
    const lastRow = pageRows[pageRows.length - 1];
    const nextRowCursor =
      hasMore && lastRow !== undefined ? lastRow.rowId : null;

    const canInline = (limits.accept & ACCEPT_INLINE_ROWS) !== 0;
    const canExternal = (limits.accept & ACCEPT_EXTERNAL_ROWS) !== 0;
    const inline =
      canInline &&
      (bytes.length <= serverLimits.inlineSegmentMaxBytes || !canExternal);
    if (inline) {
      yield { type: 'SEGMENT_INLINE', payload: bytes };
    } else {
      const record = await segments.put(
        {
          partition,
          table: plan.table.name,
          schemaVersion: schema.version,
          mediaType: 'rows',
          scopeDigest: digest,
          asOfCommitSeq: asOf,
          rowCount: pageRows.length,
          rowCursor,
          nextRowCursor,
        },
        bytes,
        now,
      );
      let url: string | undefined;
      let urlExpiresAtMs: number | undefined;
      if ((limits.accept & ACCEPT_SIGNED_URLS) !== 0 && ctx.signedUrls) {
        const exp = Math.floor(now / 1000) + (ctx.signedUrls.ttlSeconds ?? 900);
        const token = await signSegmentToken(ctx.signedUrls.key, {
          v: 1,
          seg: record.segmentId,
          sd: digest,
          aud: ctx.signedUrls.audience(partition),
          exp,
        });
        url = `${ctx.signedUrls.baseUrl}/${record.segmentId}?st=${token}`;
        urlExpiresAtMs = exp * 1000;
      }
      yield {
        type: 'SEGMENT_REF',
        segmentId: record.segmentId,
        mediaType: 'rows',
        table: plan.table.name,
        byteLength: bytes.length,
        rowCount: pageRows.length,
        asOfCommitSeq: asOf,
        scopeDigest: digest,
        ...(rowCursor !== null ? { rowCursor } : {}),
        ...(nextRowCursor !== null ? { nextRowCursor } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(urlExpiresAtMs !== undefined ? { urlExpiresAtMs } : {}),
      };
    }
    if (!hasMore) return { complete: true, rowCursor: null };
    rowCursor = nextRowCursor;
  }
  return { complete: false, rowCursor };
}

/**
 * Produce the `SUB_START … SUB_END` section for one subscription (§1.6),
 * returning the cursor recorded for the retention watermark (§4.5).
 */
export async function* subscriptionSection(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  plan: SubscriptionPlan,
  maxSeq: number,
  horizonSeq: number,
): AsyncGenerator<ResponseFrame, SubscriptionResult> {
  const sub = plan.frame;

  if (plan.status === 'revoked') {
    yield {
      type: 'SUB_START',
      id: sub.id,
      status: 'revoked',
      reasonCode: 'sync.scope_revoked',
      effectiveScopes: {},
      bootstrap: false,
    };
    yield { type: 'SUB_END', nextCursor: sub.cursor };
    return { nextCursor: sub.cursor, active: false };
  }

  const token = parseBootstrapToken(sub.bootstrapState, sub.table);

  // §4.6: a cursor behind the horizon (and not resuming a bootstrap)
  // cannot compute deltas — answer `reset` and echo the cursor.
  if (token === undefined && sub.cursor >= 0 && sub.cursor < horizonSeq) {
    yield {
      type: 'SUB_START',
      id: sub.id,
      status: 'reset',
      reasonCode: 'sync.cursor_expired',
      effectiveScopes: {},
      bootstrap: false,
    };
    yield { type: 'SUB_END', nextCursor: sub.cursor };
    return { nextCursor: sub.cursor, active: false };
  }

  const bootstrapping =
    token !== undefined || sub.cursor < 0 || sub.cursor > maxSeq;

  if (bootstrapping) {
    // §4.7: resume at the pinned point unless the pin fell behind the
    // horizon (or the token is unusable) — then restart from a fresh pin.
    const resume =
      token !== undefined && token.asOfCommitSeq >= horizonSeq
        ? token
        : undefined;
    const asOf = resume?.asOfCommitSeq ?? maxSeq;
    const startCursor = resume?.rowCursor ?? null;
    yield {
      type: 'SUB_START',
      id: sub.id,
      status: 'active',
      reasonCode: '',
      effectiveScopes: plan.effective,
      bootstrap: true,
    };
    const outcome = yield* bootstrapSegments(
      ctx,
      schema,
      limits,
      plan,
      asOf,
      startCursor,
    );
    if (outcome.complete) {
      yield { type: 'SUB_END', nextCursor: asOf };
    } else {
      const nextToken: BootstrapToken = {
        asOfCommitSeq: asOf,
        tables: [sub.table],
        tableIndex: 0,
        rowCursor: outcome.rowCursor,
      };
      yield {
        type: 'SUB_END',
        nextCursor: asOf,
        bootstrapState: JSON.stringify(nextToken),
      };
    }
    return { nextCursor: asOf, active: true };
  }

  // Incremental (§4.5): window cursor < commitSeq <= maxSeq, oldest first,
  // cut off at limitCommits total changes, never splitting a commit.
  yield {
    type: 'SUB_START',
    id: sub.id,
    status: 'active',
    reasonCode: '',
    effectiveScopes: plan.effective,
    bootstrap: false,
  };
  const commits = await ctx.storage.readCommitWindow(ctx.partition, {
    table: sub.table,
    scopeFilter: plan.effective,
    afterSeq: sub.cursor,
    throughSeq: maxSeq,
    limitChanges: limits.limitCommits + 1,
  });
  let delivered = 0;
  let deliveredCommits = 0;
  let lastDeliveredSeq = sub.cursor;
  for (const commit of commits) {
    if (
      delivered > 0 &&
      delivered + commit.changes.length > limits.limitCommits
    ) {
      break;
    }
    yield commitFrame(sub.table, commit);
    delivered += commit.changes.length;
    deliveredCommits += 1;
    lastDeliveredSeq = commit.commitSeq;
    if (delivered >= limits.limitCommits) break;
  }
  const totalReturned = commits.reduce((n, c) => n + c.changes.length, 0);
  // The window is proven exhausted only when the storage lookahead came
  // back under budget (it scanned to `throughSeq`) and every returned
  // commit was delivered.
  const exhausted =
    totalReturned <= limits.limitCommits && deliveredCommits === commits.length;
  // §4.5: the cursor advances even when no matching changes exist; when
  // the change limit truncated the window it stops at the last fully
  // delivered commit.
  const nextCursor = exhausted
    ? Math.max(sub.cursor, maxSeq)
    : Math.max(sub.cursor, lastDeliveredSeq);
  yield { type: 'SUB_END', nextCursor };
  return { nextCursor, active: true };
}
