/**
 * Pull: units, the live section, bootstrap segments (SPEC.md §4, §5).
 */
import {
  type CommitChange,
  type CommitFrame,
  encodeRowsSegment,
  type FencedRecord,
  type PullHeaderFrame,
  type ResponseFrame,
  type ScopeMap,
  type SegmentRefFrame,
  type SegmentRow,
  type UnitScopes,
  unitId,
} from '@syncular/core';
import type { SyncRequestContext, SyncServerConfig } from './context';
import { clockOf, limitsOf } from './context';
import { syncError } from './errors';
import type { PullSegmentSummary } from './events';
import {
  type CompiledSchema,
  type CompiledTable,
  compileSchema,
} from './schema';
import { computeEffective, type ResolvedScopes, scopeDigest } from './scopes';
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

/** §4.2 defaults and silent clamps. */
export function clampPullLimits(header: PullHeaderFrame): PullLimits {
  return {
    limitCommits: clamp(header.limitCommits, 1, 1000, 1000),
    limitSnapshotRows: clamp(header.limitSnapshotRows, 1, 50000, 1000),
    maxSnapshotPages: clamp(header.maxSnapshotPages, 1, 50, 4),
    accept: header.accept,
  };
}

/** One unit of the effective list, resolved against the request (§3.2, §4.1). */
export interface UnitPlan {
  readonly id: string;
  readonly scopes: UnitScopes;
  /** Covered tables in bootstrap order (§4.1, §4.7). */
  readonly tables: readonly CompiledTable[];
  /** Active (unit, table) pairs: table → effective scopes (§3.2). */
  readonly pairs: ReadonlyMap<string, ScopeMap>;
  readonly status: 'active' | 'revoked';
  /** The echo (§4.4): ascending table order, empty when revoked. */
  readonly fenced: readonly FencedRecord[];
}

/**
 * §4.1 unit validation against one schema version: the covered tables, or
 * `sync.invalid_subscription` for an empty scope map, a requested `'*'`, a
 * variable no table declares, or no covered table.
 */
export function coveredTables(
  schema: CompiledSchema,
  scopes: UnitScopes,
): CompiledTable[] {
  const keys = Object.keys(scopes);
  const reason =
    keys.length === 0
      ? 'empty_scope_map'
      : keys.some((key) => scopes[key] === '*')
        ? 'wildcard_value'
        : keys.some((key) => !schema.declaredVariables.has(key))
          ? 'undeclared_variable'
          : undefined;
  const tables =
    reason === undefined
      ? [...schema.tables.values()].filter((table) =>
          keys.every((key) => table.declaredVariables.has(key)),
        )
      : [];
  if (tables.length === 0) {
    throw syncError(
      'sync.invalid_subscription',
      'the server cannot serve this unit (§4.1)',
      JSON.stringify({ reason: reason ?? 'no_covered_table', scopes }),
    );
  }
  return tables;
}

/** §3.2 per covered table: the unit's active pairs, status and echo. */
export function planUnit(
  scopes: UnitScopes,
  tables: readonly CompiledTable[],
  resolved: ResolvedScopes,
): UnitPlan {
  const requested: ScopeMap = {};
  for (const [key, value] of Object.entries(scopes)) requested[key] = [value];
  const pairs = new Map<string, ScopeMap>();
  const fenced: FencedRecord[] = [];
  for (const table of tables) {
    const outcome = computeEffective(
      table.declaredVariables,
      requested,
      resolved,
    );
    if (outcome.status === 'revoked') {
      fenced.push({ table: table.name, status: 'revoked', scopes: {} });
      continue;
    }
    pairs.set(table.name, outcome.effective);
    const added = Object.entries(outcome.effective).filter(
      ([key]) => !Object.hasOwn(scopes, key),
    );
    if (added.length > 0) {
      fenced.push({
        table: table.name,
        status: 'active',
        scopes: Object.fromEntries(added),
      });
    }
  }
  const active = pairs.size > 0;
  return {
    id: unitId(scopes),
    scopes,
    tables,
    pairs,
    status: active ? 'active' : 'revoked',
    fenced: active ? fenced.sort((a, b) => (a.table < b.table ? -1 : 1)) : [],
  };
}

/**
 * The `COMMIT` frame of one live-section commit (§4.5): its frame-local
 * table dictionary and every change, projected onto the client's codec.
 */
export function commitFrame(
  commit: StoredCommit,
  current: CompiledSchema,
  target: CompiledSchema,
): CommitFrame {
  const tables: string[] = [];
  const changes: CommitChange[] = commit.changes.map((change) => {
    // §4.5: apply is version-guarded, so every change carries its version:
    // an upsert the row's version after the write, a delete the version its
    // tombstone records. A change without one cannot be served.
    if (change.rowVersion === undefined) {
      throw new Error('a change record carries no row version (§4.5)');
    }
    let tableIndex = tables.indexOf(change.table);
    if (tableIndex === -1) tableIndex = tables.push(change.table) - 1;
    return {
      tableIndex,
      rowId: change.rowId,
      op: change.op,
      rowVersion: change.rowVersion,
      scopes: change.scopes,
      ...(change.payload !== undefined
        ? {
            row: projectRowPayload(
              current.tables.get(change.table)!,
              target.tables.get(change.table)!,
              change.payload,
            ),
          }
        : {}),
    };
  });
  return {
    type: 'COMMIT',
    commitSeq: commit.commitSeq,
    createdAtMs: commit.createdAtMs,
    actorId: commit.actorId,
    tables,
    changes,
  };
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
 * §4.7: a usable resume token, or `undefined`. A token whose pin is not a
 * commit sequence of this log (`0 ≤ asOfCommitSeq ≤ maxSeq`), whose tables
 * differ from the unit's covered tables in bootstrap order, or whose position
 * names none of them is unusable.
 */
function parseBootstrapToken(
  raw: string | undefined,
  tables: readonly CompiledTable[],
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
      parsed.tables.length !== tables.length ||
      parsed.tables.some((name, i) => name !== tables[i]?.name) ||
      !Number.isSafeInteger(parsed.tableIndex) ||
      parsed.tableIndex === undefined ||
      parsed.tableIndex < 0 ||
      parsed.tableIndex >= tables.length ||
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
    // The frame reports the digest THIS pair is authorized under. A stored
    // entry can carry several digests when identical content was published
    // under different scopes (§5.1), and the record's primary digest is not
    // necessarily the caller's (§5.5).
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

/** One active (unit, table) pair of a bootstrap (§3.2). */
interface BootstrapPair {
  readonly table: CompiledTable;
  readonly effective: ScopeMap;
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
  table: CompiledTable,
  startRowCursor: string | null,
): boolean {
  return (
    (limits.accept & ACCEPT_SQLITE) !== 0 &&
    startRowCursor === null &&
    table.encryptedColumnIndices.length === 0
  );
}

/** The reads a table's bootstrap needs before its first frame (§4.7, §5.3). */
interface TableStart {
  /**
   * `limitSnapshotRows + 1` rows from the start cursor: the first page and
   * the §5.3 image eligibility probe.
   */
  readonly firstPage: StoredRow[];
  /** On the sqlite lane: the §4.7 scope pin and a stored image under it. */
  readonly image?: {
    readonly scopePin: number;
    readonly stored: SegmentRecord | undefined;
  };
}

async function readTableStart(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  unit: UnitPlan,
  pair: BootstrapPair,
  startRowCursor: string | null,
  maxSeq: number,
  horizonSeq: number,
  logEpoch: string,
): Promise<TableStart> {
  const scan = ctx.storage.scanRows(ctx.partition, {
    table: pair.table.name,
    scopeFilter: pair.effective,
    afterRowId: startRowCursor,
    limit: limits.limitSnapshotRows + 1,
  });
  if (!sqliteLaneEligible(limits, pair.table, startRowCursor)) {
    return { firstPage: await scan };
  }
  // §4.7: a sqlite-lane table pins at the newest change carrying the unit's
  // index key (never below the horizon, never above maxCommitSeq), so a
  // stored image stays the reuse key's match until this scope changes
  // (§5.3). The server computes the pin; a client token never supplies it.
  const [firstPage, latest] = await Promise.all([
    scan,
    ctx.storage.latestScopedChangeSeq(ctx.partition, {
      table: pair.table.name,
      scopes: unit.scopes,
    }),
  ]);
  const scopePin = Math.min(maxSeq, Math.max(latest, horizonSeq));
  // §5.3 eligibility: a stored image only matches a snapshot larger than one
  // rows page, so the probe decides before the reuse lookup; a remote `find`
  // on a small table would be a wasted round trip.
  const stored =
    firstPage.length <= limits.limitSnapshotRows
      ? undefined
      : await ctx.segments.find(
          {
            partition: ctx.partition,
            logEpoch,
            table: pair.table.name,
            schemaVersion: schema.version,
            mediaType: 'sqlite',
            scopeDigest: await scopeDigest(pair.effective),
            asOfCommitSeq: scopePin,
          },
          clockOf(ctx)(),
        );
  return { firstPage, image: { scopePin, stored } };
}

/**
 * §5.3 sqlite-image lane: only when the snapshot exceeds one rows page.
 * Reuses an unexpired stored image for the same (partition, table,
 * schemaVersion, scope digest, scope pin) instead of rebuilding — the
 * bootstrap-storm rule. Returns false when no image is served (the rows lane
 * takes over).
 */
async function* sqliteImageSegment(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  pair: BootstrapPair,
  scopePin: number,
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
    table: pair.table.name,
    schemaVersion: schema.version,
    mediaType: 'sqlite' as const,
    scopeDigest: digest,
    asOfCommitSeq: scopePin,
  };
  const current = compileSchema(ctx.schema).tables.get(pair.table.name)!;
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
        table: pair.table,
        schemaVersion: schema.version,
        asOfCommitSeq: scopePin,
        scopeDigest: digest,
        rowBatches: (async function* () {
          rowCount += probe.length;
          yield probe.map((row) => ({
            ...row,
            payload: projectRowPayload(current, pair.table, row.payload),
          }));
          let afterRowId = probe[probe.length - 1]!.rowId;
          for (;;) {
            const rows = await storage.scanRows(partition, {
              table: pair.table.name,
              scopeFilter: pair.effective,
              afterRowId,
              limit: 5_000,
            });
            rowCount += rows.length;
            yield rows.map((row) => ({
              ...row,
              payload: projectRowPayload(current, pair.table, row.payload),
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

/**
 * One table's segments within the page budget. Returns the pages it used
 * and the row cursor to resume at, `null` once the table is exhausted.
 */
async function* tableSegments(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  pair: BootstrapPair,
  pin: number,
  startRowCursor: string | null,
  start: TableStart,
  pageBudget: number,
  trace: PullSectionTrace | undefined,
  logEpoch: string,
): AsyncGenerator<ResponseFrame, { pages: number; rowCursor: string | null }> {
  const { storage, segments, partition } = ctx;
  const serverLimits = limitsOf(ctx);
  const digest = await scopeDigest(pair.effective);
  const now = clockOf(ctx)();
  if (start.image !== undefined) {
    const imaged = yield* sqliteImageSegment(
      ctx,
      schema,
      limits,
      pair,
      start.image.scopePin,
      digest,
      trace,
      logEpoch,
      start.image.stored,
      start.firstPage,
    );
    if (imaged) return { pages: 1, rowCursor: null };
  }
  const current = compileSchema(ctx.schema).tables.get(pair.table.name)!;
  let rowCursor = startRowCursor;
  for (let page = 0; page < pageBudget; page++) {
    const scanned =
      page === 0
        ? start.firstPage
        : await storage.scanRows(partition, {
            table: pair.table.name,
            scopeFilter: pair.effective,
            afterRowId: rowCursor,
            limit: limits.limitSnapshotRows + 1,
          });
    const pageRows = scanned.slice(0, limits.limitSnapshotRows);
    const hasMore = scanned.length > limits.limitSnapshotRows;
    // §5.2: every row record carries the row's current server_version.
    const decoded = pageRows.map((row: StoredRow) => ({
      serverVersion: row.serverVersion,
      values: projectRowValues(current, pair.table, row.payload),
    }));
    const bytes = encodeRowsSegment({
      table: pair.table.name,
      schemaVersion: schema.version,
      columns: pair.table.columns,
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
          table: pair.table.name,
          schemaVersion: schema.version,
          mediaType: 'rows',
          scopeDigest: digest,
          asOfCommitSeq: pin,
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
    if (!hasMore) return { pages: page + 1, rowCursor: null };
    rowCursor = nextRowCursor;
  }
  return { pages: pageBudget, rowCursor };
}

/** A bootstrapping unit's position and its table starts, read ahead (§4.7). */
export interface BootstrapPlan {
  readonly unit: UnitPlan;
  /** The unit's pin: a usable resume token's, or `maxCommitSeq`. */
  readonly pin: number;
  readonly tableIndex: number;
  readonly rowCursor: string | null;
  /** Table index → its start reads. */
  readonly starts: ReadonlyMap<number, Promise<TableStart>>;
}

/**
 * Plan one unit's bootstrap and start the reads of every table it can reach
 * in this section: each visited table costs at least one page, so at most
 * `maxSnapshotPages` tables. The reads of every planned unit start before any
 * is awaited, so a storage that batches concurrent page reads (PostgreSQL,
 * D1) answers them in one statement per table.
 */
export function planBootstrap(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  unit: UnitPlan,
  bootstrapState: string | undefined,
  maxSeq: number,
  horizonSeq: number,
  logEpoch: string,
): BootstrapPlan {
  // §4.7: resume at the token's pin unless the token is unusable or the pin
  // fell behind the horizon; then restart from a fresh pin.
  const token = parseBootstrapToken(bootstrapState, unit.tables, maxSeq);
  const resume =
    token !== undefined && token.asOfCommitSeq >= horizonSeq
      ? token
      : undefined;
  const tableIndex = resume?.tableIndex ?? 0;
  const rowCursor = resume?.rowCursor ?? null;
  const starts = new Map<number, Promise<TableStart>>();
  for (
    let index = tableIndex;
    index < unit.tables.length && starts.size < limits.maxSnapshotPages;
    index++
  ) {
    const table = unit.tables[index]!;
    const effective = unit.pairs.get(table.name);
    if (effective === undefined) continue;
    const start = readTableStart(
      ctx,
      schema,
      limits,
      unit,
      { table, effective },
      index === tableIndex ? rowCursor : null,
      maxSeq,
      horizonSeq,
      logEpoch,
    );
    // A section that stops early never awaits the later starts.
    start.catch(() => undefined);
    starts.set(index, start);
  }
  return {
    unit,
    pin: resume?.asOfCommitSeq ?? maxSeq,
    tableIndex,
    rowCursor,
    starts,
  };
}

/**
 * The segments of one bootstrap section (§4.7): tables in bootstrap order,
 * each active pair's rows or image, up to `maxSnapshotPages` pages. Returns
 * the resume token, or `undefined` once every table is exhausted. A pair the
 * wildcard fence revoked receives no segment (§3.3).
 */
export async function* bootstrapSegments(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  limits: PullLimits,
  plan: BootstrapPlan,
  trace: PullSectionTrace | undefined,
  logEpoch: string,
): AsyncGenerator<ResponseFrame, string | undefined> {
  const { unit, pin } = plan;
  let { tableIndex, rowCursor } = plan;
  let pages = 0;
  for (;;) {
    while (
      tableIndex < unit.tables.length &&
      !unit.pairs.has(unit.tables[tableIndex]!.name)
    ) {
      tableIndex += 1;
      rowCursor = null;
    }
    if (tableIndex === unit.tables.length) return undefined;
    if (pages === limits.maxSnapshotPages) {
      const token: BootstrapToken = {
        asOfCommitSeq: pin,
        tables: unit.tables.map((table) => table.name),
        tableIndex,
        rowCursor,
      };
      return JSON.stringify(token);
    }
    const table = unit.tables[tableIndex]!;
    const outcome = yield* tableSegments(
      ctx,
      schema,
      limits,
      { table, effective: unit.pairs.get(table.name)! },
      pin,
      rowCursor,
      await plan.starts.get(tableIndex)!,
      limits.maxSnapshotPages - pages,
      trace,
      logEpoch,
    );
    pages += outcome.pages;
    rowCursor = outcome.rowCursor;
    if (rowCursor === null) tableIndex += 1;
  }
}

export interface PublishSqliteImageInput {
  /** The sync config the serving host runs, plus a `sqliteImageBuilder`. */
  readonly config: SyncServerConfig;
  readonly partition: string;
  readonly table: string;
  /** The unit whose clients bootstrap the table (§4.1). */
  readonly scopes: UnitScopes;
  /**
   * The allowed scopes of the actors that register the unit (§3.2). The
   * reuse key carries the digest of the pair's effective scopes, so a
   * wildcard fence on the table changes the image. Default: `'*'` for every
   * declared variable, which leaves the unit's own scope map.
   */
  readonly allowed?: ScopeMap;
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
 * Publish the §5.3 sqlite image that a pull of (`scopes`, `table`) looks up,
 * from a host with a SQLite engine (a Bun process with the production
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
  const table = coveredTables(schema, input.scopes).find(
    (candidate) => candidate.name === input.table,
  );
  if (table === undefined) {
    throw new Error('publishSqliteImage: the unit does not cover the table');
  }
  const allowed =
    input.allowed ??
    Object.fromEntries([...schema.declaredVariables].map((v) => [v, ['*']]));
  const unit = planUnit(input.scopes, [table], { ok: true, allowed });
  const effective = unit.pairs.get(table.name);
  if (effective === undefined) {
    throw new Error('publishSqliteImage: the allowed scopes revoke the pair');
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
  const plan = planBootstrap(
    ctx,
    schema,
    limits,
    unit,
    undefined,
    maxSeq,
    horizonSeq,
    logEpoch,
  );
  let ref: SegmentRefFrame | undefined;
  for await (const frame of bootstrapSegments(
    ctx,
    schema,
    limits,
    plan,
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
