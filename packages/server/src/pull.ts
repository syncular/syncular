/**
 * Pull: incremental commit delivery, cursors, bootstrap segments
 * (SPEC.md §4, §5).
 */
import {
  type CommitChange,
  encodeRowsSegment,
  type PullHeaderFrame,
  type ResponseFrame,
  type ScopeMap,
  type SegmentRefFrame,
  type SegmentRow,
  type SubscriptionFrame,
} from '@syncular/core';
import type { SyncRequestContext, SyncServerConfig } from './context';
import { clockOf, limitsOf } from './context';
import type { PullSegmentSummary } from './events';
import {
  type CompiledSchema,
  type CompiledTable,
  compileSchema,
} from './schema';
import { scopeDigest } from './scopes';
import type { SegmentRecord, SegmentStore } from './segment-store';
import { issueSegmentUrl } from './signed-url';
import type { ServerStorage, StoredCommit, StoredRow } from './storage';
import { projectRowPayload, projectRowValues } from './schema-window';

// One artifact build per owning storage pair and complete immutable identity.
const imageBuilds = new WeakMap<
  ServerStorage,
  WeakMap<SegmentStore, Map<string, Promise<SegmentRecord>>>
>();

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

/**
 * Mutable per-section collector for the `pull.served` event. Only created
 * when an events sink is configured — with `trace` undefined the pull path
 * does zero extra work (`trace?.…` short-circuits argument evaluation).
 */
export interface PullSectionTrace {
  readonly segments: PullSegmentSummary[];
}

interface BootstrapToken {
  asOfCommitSeq: number;
  tables: string[];
  tableIndex: number;
  rowCursor: string | null;
}

/**
 * §4.7: a usable resume token for `table`, or `undefined`. A token whose pin
 * is not a commit sequence of this log (`0 ≤ asOfCommitSeq ≤ maxSeq`) or
 * whose position does not name one of its tables is unusable.
 */
function parseBootstrapToken(
  raw: string | undefined,
  table: string,
  maxSeq: number,
): BootstrapToken | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<BootstrapToken>;
    if (
      !Number.isSafeInteger(parsed.asOfCommitSeq) ||
      parsed.asOfCommitSeq === undefined ||
      parsed.asOfCommitSeq < 0 ||
      parsed.asOfCommitSeq > maxSeq ||
      !Array.isArray(parsed.tables) ||
      parsed.tables[0] !== table ||
      !Number.isSafeInteger(parsed.tableIndex) ||
      parsed.tableIndex === undefined ||
      parsed.tableIndex < 0 ||
      parsed.tableIndex >= parsed.tables.length ||
      (parsed.rowCursor !== null && typeof parsed.rowCursor !== 'string')
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

function commitFrame(
  table: string,
  commit: StoredCommit,
  current: CompiledTable,
  target: CompiledTable,
): ResponseFrame {
  const changes: CommitChange[] = commit.changes.map((change) => ({
    tableIndex: 0,
    rowId: change.rowId,
    op: change.op,
    ...(change.rowVersion !== undefined
      ? { rowVersion: change.rowVersion }
      : {}),
    scopes: change.scopes,
    ...(change.payload !== undefined
      ? { row: projectRowPayload(current, target, change.payload) }
      : {}),
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

/** §5.4 signed-URL fields for a descriptor, when the client asked (bit 3). */
async function signedUrlFields(
  ctx: SyncRequestContext,
  limits: PullLimits,
  segmentId: string,
  digest: string,
  now: number,
): Promise<{ url?: string; urlExpiresAtMs?: number }> {
  if ((limits.accept & ACCEPT_SIGNED_URLS) === 0 || !ctx.signedUrls) return {};
  return issueSegmentUrl(ctx.signedUrls, {
    segmentId,
    partition: ctx.partition,
    scopeDigest: digest,
    nowMs: now,
  });
}

function segmentRefFrame(
  record: SegmentRecord,
  scopeDigest: string,
  extra: { url?: string; urlExpiresAtMs?: number },
): ResponseFrame {
  return {
    type: 'SEGMENT_REF',
    segmentId: record.segmentId,
    mediaType: record.mediaType,
    table: record.table,
    byteLength: record.byteLength,
    rowCount: record.rowCount,
    asOfCommitSeq: record.asOfCommitSeq,
    // The frame reports the digest THIS subscription is authorized under. A
    // stored entry can carry several digests when identical content was
    // published under different scopes (§5.1), and the record's primary
    // digest is not necessarily the caller's (§5.5).
    scopeDigest,
    ...(record.rowCursor !== null ? { rowCursor: record.rowCursor } : {}),
    ...(record.nextRowCursor !== null
      ? { nextRowCursor: record.nextRowCursor }
      : {}),
    ...(extra.url !== undefined ? { url: extra.url } : {}),
    ...(extra.urlExpiresAtMs !== undefined
      ? { urlExpiresAtMs: extra.urlExpiresAtMs }
      : {}),
  };
}

/**
 * §5.3: the sqlite-image lane — whole-table, chosen only at the start of a
 * table (a mid-table resume stays on the rows lane, never switching lanes),
 * and only when the client advertised bit 2. §5.11: a table with any
 * encrypted column is image-INELIGIBLE — an image copies ciphertext
 * wholesale with no per-row decrypt pass, so it MUST be served on the rows
 * lane (which decrypts per row on the client).
 */
function sqliteLaneEligible(
  limits: PullLimits,
  plan: SubscriptionPlan,
  startRowCursor: string | null,
): boolean {
  return (
    (limits.accept & ACCEPT_SQLITE) !== 0 &&
    startRowCursor === null &&
    plan.table.encryptedColumnIndices.length === 0
  );
}

/**
 * §5.3 sqlite-image lane: only at the start of a table, only when the
 * client advertised bit 2, and only when the snapshot exceeds one rows
 * page. Reuses an unexpired stored image for the same (partition, table,
 * schemaVersion, scope digest, pin) instead of rebuilding — the
 * bootstrap-storm rule. Returns false when the table is not eligible
 * (the rows lane takes over).
 */
async function* sqliteImageSegment(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  plan: SubscriptionPlan,
  asOf: number,
  digest: string,
  trace: PullSectionTrace | undefined,
  logEpoch: string,
  existing: SegmentRecord | undefined,
  probe: StoredRow[],
): AsyncGenerator<ResponseFrame, boolean> {
  const { storage, segments, partition } = ctx;
  const now = clockOf(ctx)();
  if (existing !== undefined) {
    trace?.segments.push({
      mediaType: 'sqlite',
      delivery: 'ref',
      origin: 'reused',
      bytes: existing.byteLength,
      rows: existing.rowCount,
    });
    yield segmentRefFrame(
      existing,
      digest,
      await signedUrlFields(ctx, limits, existing.segmentId, digest, now),
    );
    return true;
  }
  // Eligibility probe (§5.3): image only when the snapshot exceeds one
  // rows page — smaller tables stay on the (typically inline) rows lane.
  // The probe is the rows lane's first page, read by `prepareSections`.
  if (probe.length <= limits.limitSnapshotRows) return false;
  // §5.3: hosts opt into image construction with a runtime-specific builder.
  // Without one, matching stored images remain usable and cold pulls use rows.
  const buildImage = ctx.sqliteImageBuilder;
  if (buildImage === undefined) return false;
  let stores = imageBuilds.get(storage);
  if (stores === undefined) {
    stores = new WeakMap();
    imageBuilds.set(storage, stores);
  }
  let builds = stores.get(segments);
  if (builds === undefined) {
    builds = new Map();
    stores.set(segments, builds);
  }
  const identity = {
    partition,
    logEpoch,
    table: plan.table.name,
    schemaVersion: schema.version,
    mediaType: 'sqlite' as const,
    scopeDigest: digest,
    asOfCommitSeq: asOf,
  };
  const key = JSON.stringify(identity);
  let building = builds.get(key);
  let builtHere = false;
  if (building === undefined) {
    building = (async () => {
      // Another request can finish while this one's eligibility probe awaits.
      const cached = await segments.find(identity, clockOf(ctx)());
      if (cached !== undefined) return cached;
      builtHere = true;
      let rowCount = 0;
      const bytes = await buildImage({
        table: plan.table,
        schemaVersion: schema.version,
        asOfCommitSeq: asOf,
        scopeDigest: digest,
        rowBatches: (async function* () {
          rowCount += probe.length;
          yield probe.map((row) => ({
            ...row,
            payload: projectRowPayload(
              compileSchema(ctx.schema).tables.get(plan.table.name)!,
              plan.table,
              row.payload,
            ),
          }));
          let afterRowId = probe[probe.length - 1]!.rowId;
          for (;;) {
            const rows = await storage.scanRows(partition, {
              table: plan.table.name,
              scopeFilter: plan.effective,
              afterRowId,
              limit: 5_000,
            });
            rowCount += rows.length;
            yield rows.map((row) => ({
              ...row,
              payload: projectRowPayload(
                compileSchema(ctx.schema).tables.get(plan.table.name)!,
                plan.table,
                row.payload,
              ),
            }));
            const last = rows[rows.length - 1];
            if (rows.length < 5_000 || last === undefined) break;
            afterRowId = last.rowId;
          }
        })(),
      });
      return segments.put(
        { ...identity, rowCount, rowCursor: null, nextRowCursor: null },
        bytes,
        clockOf(ctx)(),
      );
    })();
    builds.set(key, building);
  }
  let record: SegmentRecord;
  try {
    record = await building;
  } finally {
    if (builds.get(key) === building) builds.delete(key);
  }
  trace?.segments.push({
    mediaType: 'sqlite',
    delivery: 'ref',
    origin: builtHere ? 'built' : 'reused',
    bytes: record.byteLength,
    rows: record.rowCount,
  });
  yield segmentRefFrame(
    record,
    digest,
    await signedUrlFields(
      ctx,
      limits,
      record.segmentId,
      digest,
      clockOf(ctx)(),
    ),
  );
  return true;
}

async function* bootstrapSegments(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  plan: SubscriptionPlan,
  asOf: number,
  startRowCursor: string | null,
  trace: PullSectionTrace | undefined,
  logEpoch: string,
  firstPage: StoredRow[],
  image: SegmentRecord | undefined,
): AsyncGenerator<
  ResponseFrame,
  { complete: boolean; rowCursor: string | null }
> {
  const { storage, segments, partition } = ctx;
  const serverLimits = limitsOf(ctx);
  const digest = await scopeDigest(plan.effective);
  const now = clockOf(ctx)();
  if (sqliteLaneEligible(limits, plan, startRowCursor)) {
    const imaged = yield* sqliteImageSegment(
      ctx,
      schema,
      limits,
      plan,
      asOf,
      digest,
      trace,
      logEpoch,
      image,
      firstPage,
    );
    if (imaged) return { complete: true, rowCursor: null };
  }
  let rowCursor = startRowCursor;
  for (let page = 0; page < limits.maxSnapshotPages; page++) {
    const scanned =
      page === 0
        ? firstPage
        : await storage.scanRows(partition, {
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
      values: projectRowValues(
        compileSchema(ctx.schema).tables.get(plan.table.name)!,
        plan.table,
        row.payload,
      ),
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
      trace?.segments.push({
        mediaType: 'rows',
        delivery: 'inline',
        origin: 'built',
        bytes: bytes.length,
        rows: pageRows.length,
      });
      yield { type: 'SEGMENT_INLINE', payload: bytes };
    } else {
      const record = await segments.put(
        {
          partition,
          logEpoch,
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
      trace?.segments.push({
        mediaType: 'rows',
        delivery: 'ref',
        origin: 'built',
        bytes: record.byteLength,
        rows: record.rowCount,
      });
      yield segmentRefFrame(
        record,
        digest,
        await signedUrlFields(ctx, limits, record.segmentId, digest, now),
      );
    }
    if (!hasMore) return { complete: true, rowCursor: null };
    rowCursor = nextRowCursor;
  }
  return { complete: false, rowCursor };
}

/**
 * One subscription's section decision (§4.5–§4.7) with the storage reads it
 * needs before its first frame.
 */
export type PreparedSection =
  | { readonly kind: 'revoked' }
  /** §4.6: the cursor is behind the horizon. */
  | { readonly kind: 'reset' }
  /** §4.5 window read for an in-range cursor. */
  | { readonly kind: 'incremental'; readonly commits: StoredCommit[] }
  | {
      readonly kind: 'bootstrap';
      /** §4.7 pin: a usable resume token's, the sqlite lane's scope pin, or `maxCommitSeq`. */
      readonly asOf: number;
      readonly startCursor: string | null;
      /**
       * The first snapshot page (`limitSnapshotRows + 1` rows from
       * `startCursor`), which is also the §5.3 image eligibility probe.
       */
      readonly firstPage: StoredRow[];
      /** §5.3 stored image under the reuse key, read only for an eligible probe. */
      readonly image: SegmentRecord | undefined;
    };

/**
 * Decide the section of every plan and run its pre-frame storage reads. The
 * reads of all plans start before any is awaited, so a storage that batches
 * concurrent page reads (PostgreSQL, D1) answers the first pages of every
 * plan in one statement per table, and the horizon re-check runs once.
 */
export async function prepareSections(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  plans: readonly SubscriptionPlan[],
  maxSeq: number,
  horizonSeq: number,
  logEpoch: string,
): Promise<PreparedSection[]> {
  const prepared = await Promise.all(
    plans.map(async (plan): Promise<PreparedSection> => {
      const sub = plan.frame;
      if (plan.status === 'revoked') return { kind: 'revoked' };
      // §4.7: a present resume token keeps the subscription bootstrapping,
      // whether or not it is usable.
      if (
        sub.bootstrapState === undefined &&
        sub.cursor >= 0 &&
        sub.cursor <= maxSeq
      ) {
        if (sub.cursor < horizonSeq) return { kind: 'reset' };
        return {
          kind: 'incremental',
          commits: await ctx.storage.readCommitWindow(ctx.partition, {
            table: sub.table,
            scopeFilter: plan.effective,
            afterSeq: sub.cursor,
            throughSeq: maxSeq,
            limitChanges: limits.limitCommits + 1,
          }),
        };
      }
      // §4.7: resume at the token's pin unless the token is unusable or the
      // pin fell behind the horizon; then restart from a fresh pin.
      const token = parseBootstrapToken(sub.bootstrapState, sub.table, maxSeq);
      const resume =
        token !== undefined && token.asOfCommitSeq >= horizonSeq
          ? token
          : undefined;
      const startCursor = resume?.rowCursor ?? null;
      const scan = ctx.storage.scanRows(ctx.partition, {
        table: plan.table.name,
        scopeFilter: plan.effective,
        afterRowId: startCursor,
        limit: limits.limitSnapshotRows + 1,
      });
      if (!sqliteLaneEligible(limits, plan, startCursor)) {
        return {
          kind: 'bootstrap',
          asOf: resume?.asOfCommitSeq ?? maxSeq,
          startCursor,
          firstPage: await scan,
          image: undefined,
        };
      }
      // §4.7: a sqlite-lane bootstrap starts at the table start and pins at
      // the newest change in its scope (never below the horizon, never above
      // maxCommitSeq), so a stored image stays the reuse key's match until
      // this scope changes (§5.3). The server computes the pin; a client
      // token never supplies the reuse key.
      const [firstPage, latest] = await Promise.all([
        scan,
        ctx.storage.latestScopedChangeSeq(ctx.partition, {
          table: plan.table.name,
          scopeFilter: plan.effective,
        }),
      ]);
      const asOf = Math.min(maxSeq, Math.max(latest, horizonSeq));
      // §5.3 eligibility: a stored image only matches a snapshot larger than
      // one rows page, so the probe decides before the reuse lookup; a remote
      // `find` on a small table would be a wasted round trip.
      const image =
        firstPage.length <= limits.limitSnapshotRows
          ? undefined
          : await ctx.segments.find(
              {
                partition: ctx.partition,
                logEpoch,
                table: plan.table.name,
                schemaVersion: schema.version,
                mediaType: 'sqlite',
                scopeDigest: await scopeDigest(plan.effective),
                asOfCommitSeq: asOf,
              },
              clockOf(ctx)(),
            );
      return { kind: 'bootstrap', asOf, startCursor, firstPage, image };
    }),
  );
  // Validate continuity before committing to an active section. A prune
  // during a paged read can otherwise make an incomplete window look empty.
  if (!prepared.some((section) => section.kind === 'incremental')) {
    return prepared;
  }
  const windowHorizon = await ctx.storage.getHorizonSeq(ctx.partition);
  return prepared.map((section, index) =>
    section.kind === 'incremental' &&
    (plans[index]?.frame.cursor ?? -1) < windowHorizon
      ? { kind: 'reset' }
      : section,
  );
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
  trace?: PullSectionTrace,
  logEpoch?: string,
): AsyncGenerator<ResponseFrame, SubscriptionResult> {
  if (logEpoch === undefined || logEpoch.length === 0) {
    throw new Error('subscriptionSection requires a non-empty log epoch');
  }
  const [prepared] = await prepareSections(
    ctx,
    schema,
    limits,
    [plan],
    maxSeq,
    horizonSeq,
    logEpoch,
  );
  if (prepared === undefined) throw new Error('prepareSections lost a plan');
  return yield* preparedSection(
    ctx,
    schema,
    limits,
    plan,
    maxSeq,
    prepared,
    trace,
    logEpoch,
  );
}

/** The section of one subscription whose reads `prepareSections` ran. */
export async function* preparedSection(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  plan: SubscriptionPlan,
  maxSeq: number,
  prepared: PreparedSection,
  trace?: PullSectionTrace,
  logEpoch?: string,
): AsyncGenerator<ResponseFrame, SubscriptionResult> {
  const sub = plan.frame;
  if (logEpoch === undefined || logEpoch.length === 0) {
    throw new Error('subscriptionSection requires a non-empty log epoch');
  }

  if (prepared.kind === 'revoked') {
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

  // §4.6: a cursor behind the horizon (and not resuming a bootstrap)
  // cannot compute deltas — answer `reset` and echo the cursor.
  if (prepared.kind === 'reset') {
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

  if (prepared.kind === 'bootstrap') {
    const { asOf } = prepared;
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
      prepared.startCursor,
      trace,
      logEpoch,
      prepared.firstPage,
      prepared.image,
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
  let delivered = 0;
  let deliveredCommits = 0;
  let lastDeliveredSeq = sub.cursor;
  const { commits } = prepared;
  for (const commit of commits) {
    if (
      delivered > 0 &&
      delivered + commit.changes.length > limits.limitCommits
    ) {
      break;
    }
    yield commitFrame(
      sub.table,
      commit,
      compileSchema(ctx.schema).tables.get(sub.table)!,
      plan.table,
    );
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

export interface PublishSqliteImageInput {
  /** The sync config the serving host runs, plus a `sqliteImageBuilder`. */
  readonly config: SyncServerConfig;
  readonly partition: string;
  readonly table: string;
  /**
   * The effective scopes the subscribing clients hold for `table` (§3.2):
   * the reuse key carries their digest, so publish once per distinct scope
   * set that clients subscribe with.
   */
  readonly scopes: ScopeMap;
}

export interface PublishedSqliteImage {
  readonly segmentId: string;
  /** The §4.7 scope pin the image is stored under. */
  readonly asOfCommitSeq: number;
  readonly scopeDigest: string;
  readonly rowCount: number;
  readonly byteLength: number;
  /** `reused` when an unexpired image for the same reuse key already existed. */
  readonly origin: 'built' | 'reused';
}

/**
 * Publish the §5.3 sqlite image that a pull for (`table`, `scopes`) looks
 * up, from a host with a SQLite engine (a Bun process with the production
 * storage). It runs the pull's own bootstrap path (the §4.7 scope pin, the
 * reuse key, the build), so the stored identity is exactly the one a
 * serving host without a builder finds. The image stays current until a
 * change reaches the scope; its lifetime is the segment store's TTL at
 * publication.
 */
export async function publishSqliteImage(
  input: PublishSqliteImageInput,
): Promise<PublishedSqliteImage> {
  const { config, partition } = input;
  if (config.sqliteImageBuilder === undefined) {
    throw new Error('publishSqliteImage requires config.sqliteImageBuilder');
  }
  const schema = compileSchema(config.schema);
  const table = schema.tables.get(input.table);
  if (table === undefined) {
    throw new Error('publishSqliteImage: the schema has no such table');
  }
  await config.storage.ensureSchema(schema, config.checkpoints);
  const logEpoch = await config.storage.getPartitionLogEpoch(partition);
  if (logEpoch === undefined) {
    throw new Error('publishSqliteImage: the partition has no log epoch');
  }
  const ctx: SyncRequestContext = {
    ...config,
    partition,
    actorId: 'syncular.image-publisher',
  };
  const plan: SubscriptionPlan = {
    frame: {
      type: 'SUBSCRIPTION',
      id: 'image',
      table: input.table,
      scopes: input.scopes,
      cursor: -1,
    },
    table,
    status: 'active',
    effective: input.scopes,
  };
  // One-row pages make every table above one row image-eligible (§5.3).
  const limits: PullLimits = {
    limitCommits: 1,
    limitSnapshotRows: 1,
    maxSnapshotPages: 1,
    accept: ACCEPT_SQLITE,
  };
  const maxSeq = await config.storage.getMaxCommitSeq(partition);
  const horizonSeq = await config.storage.getHorizonSeq(partition);
  const trace: PullSectionTrace = { segments: [] };
  const [prepared] = await prepareSections(
    ctx,
    schema,
    limits,
    [plan],
    maxSeq,
    horizonSeq,
    logEpoch,
  );
  if (prepared === undefined) throw new Error('prepareSections lost a plan');
  let ref: SegmentRefFrame | undefined;
  for await (const frame of preparedSection(
    ctx,
    schema,
    limits,
    plan,
    maxSeq,
    prepared,
    trace,
    logEpoch,
  )) {
    if (frame.type === 'SEGMENT_REF' && frame.mediaType === 'sqlite') {
      ref = frame;
    }
  }
  const image = trace.segments.find(
    (segment) => segment.mediaType === 'sqlite',
  );
  if (ref === undefined || image === undefined) {
    throw new Error(
      'publishSqliteImage: the scope holds at most one row, which pulls serve inline',
    );
  }
  return {
    segmentId: ref.segmentId,
    asOfCommitSeq: ref.asOfCommitSeq,
    scopeDigest: ref.scopeDigest,
    rowCount: ref.rowCount,
    byteLength: ref.byteLength,
    origin: image.origin === 'reused' ? 'reused' : 'built',
  };
}
