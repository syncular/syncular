/**
 * SSP2 envelope, framing, and message-level codecs (SPEC.md §1).
 *
 * Decoding enforces, with named `DecodeError`s:
 * - the 8-byte header (magic, wireVersion, msgKind, zero flags);
 * - the frame grammar of §1.5/§1.6 (ordering, END termination, the
 *   unknown-frame-skip rule of §1.2 rule 2);
 * - per-frame record layouts including enum bytes and `opt()` presence
 *   invariants (Conventions), with exact-payload-length checks (§1.2 rule 3).
 *
 * Unknown frame types are preserved as `UNKNOWN` frames (skipped by the
 * grammar, retained so canonical re-encoding stays byte-exact).
 */
import {
  ByteReader,
  ByteWriter,
  readStringListMap,
  readStringMap,
  utf8Encode,
  writeStringListMap,
  writeStringMap,
} from './bytes';
import { isSupportedProtocolWireVersion, SYNC_PACK_MAGIC } from './constants';
import { DecodeError } from './errors';
import { parseJsonDocument } from './json-document';
import {
  FrameType,
  KNOWN_FRAME_TYPES,
  REQUEST_FRAME_TYPES,
  RESPONSE_FRAME_TYPES,
} from './frames';
import {
  normalizeRejectionDetails,
  type RejectionDetails,
} from './rejection-details';
import { decodeRowsSegment } from './segment';

const MAGIC_BYTES = utf8Encode(SYNC_PACK_MAGIC);

export type ScopeMap = Record<string, string[]>;

export interface ReqHeaderFrame {
  type: 'REQ_HEADER';
  clientId: string;
  schemaVersion: number;
  /** Partition log identity; absent requests epoch acquisition. */
  logEpoch?: string;
  /** Identity of the sender's outbox sequence (§6.3.2, §7.1); absent for a
   * sender without an outbox. Non-empty, at most 64 bytes. */
  outboxId?: string;
}

export interface PushOperation {
  table: string;
  rowId: string;
  op: 'upsert' | 'delete';
  /** Optimistic-concurrency token (§6.2); absent = last-write-wins. */
  baseVersion?: number;
  /** Generated-row-codec bytes; present iff `op` is `upsert` (§6.1). */
  payload?: Uint8Array;
}

export interface PushCommitFrame {
  type: 'PUSH_COMMIT';
  clientCommitId: string;
  /** Outbox sequence number (§6.3.2, §7.1); `0` without an outbox. */
  clientSeq: number;
  operations: PushOperation[];
}

export interface PullHeaderFrame {
  type: 'PULL_HEADER';
  limitCommits: number;
  limitSnapshotRows: number;
  maxSnapshotPages: number;
  /** Bitmask (§4.2): bit 0 inline rows, 1 external rows, 2 sqlite, 3 signed URLs. */
  accept: number;
  /** The replica cursor (§4.5); `-1` when no unit is live. */
  cursor: number;
  /** §4.1 registration digest: exactly 32 bytes. */
  registrationDigest: Uint8Array;
  /** The last processed `LIVE_END.echoDigest`: empty or 32 bytes (§4.2). */
  echoDigest: Uint8Array;
}

/** §4.3: one unit of a traveling registration list. */
export interface UnitFrame {
  type: 'UNIT';
  scopes: Record<string, string>;
}

/** §4.3: the progress of one catching-up unit. */
export interface ProgressFrame {
  type: 'PROGRESS';
  /** The unit id (§4.1): 32 lowercase hex characters. */
  id: string;
  /** `-1`, the §4.7 pin while a resume token is held, or the unit cursor. */
  cursor: number;
  /** Opaque resume token JSON, round-tripped byte-for-byte (§4.7). */
  bootstrapState?: string;
}

export interface UnknownFrame {
  type: 'UNKNOWN';
  frameType: number;
  payload: Uint8Array;
}

/**
 * §1.5: the code of the client's last round that failed where the server
 * could not see it. Reported once, immediately after `REQ_HEADER`.
 */
export interface RoundFailureFrame {
  type: 'ROUND_FAILURE';
  code: string;
}

export type RequestFrame =
  | ReqHeaderFrame
  | RoundFailureFrame
  | PushCommitFrame
  | PullHeaderFrame
  | UnitFrame
  | ProgressFrame
  | UnknownFrame;

export interface RespHeaderFrame {
  type: 'RESP_HEADER';
  requiredSchemaVersion?: number;
  latestSchemaVersion?: number;
  /** Partition log identity, non-empty. */
  logEpoch: string;
  /** True produces a header-only reset response. */
  resetRequired: boolean;
}

/** §7.3.2: a server-issued auth lease delivered to the client (opaque). */
export interface LeaseFrame {
  type: 'LEASE';
  leaseId: string;
  expiresAtMs: number;
}

export type PushOperationResult =
  | { opIndex: number; status: 'applied' }
  | {
      opIndex: number;
      status: 'conflict';
      code: string;
      message: string;
      serverVersion: number;
      serverRow: Uint8Array;
      /**
       * §6.3 (wire version 3): presence-bitmap layout over the row's columns,
       * marking the present columns whose `column_version` exceeded the
       * operation's `baseVersion`. A `baseVersion = 0` lost-insert conflict
       * marks every present non-crdt column.
       */
      conflictColumns: Uint8Array;
    }
  | {
      opIndex: number;
      status: 'error';
      code: string;
      message: string;
      retryable: boolean;
      /**
       * Host-safe structured metadata. It is emitted on the wire through the
       * additive PUSH_RESULT_DETAILS companion frame, not the legacy record.
       */
      details?: RejectionDetails;
    };

export interface PushResultFrame {
  type: 'PUSH_RESULT';
  clientCommitId: string;
  status: 'applied' | 'cached' | 'rejected';
  /** Present iff `status` is `applied` or `cached` (§6.3). */
  commitSeq?: number;
  results: PushOperationResult[];
}

/**
 * Additive companion metadata for host validation errors. Older clients see
 * this as an unknown frame and continue processing the normative PUSH_RESULT.
 */
export interface PushResultDetailsFrame {
  type: 'PUSH_RESULT_DETAILS';
  clientCommitId: string;
  entries: Array<{ opIndex: number; details: RejectionDetails }>;
}

/** §4.4: one (unit, table) pair the wildcard fence touched. */
export interface FencedRecord {
  table: string;
  status: 'active' | 'revoked';
  /** Effective lists of the variables the fence added; empty when revoked. */
  scopes: ScopeMap;
}

export interface SubStartFrame {
  type: 'SUB_START';
  /** The unit id (§4.1): 32 lowercase hex characters. */
  id: string;
  status: 'active' | 'revoked' | 'reset';
  reasonCode: string;
  bootstrap: boolean;
  /** The unit's echo, in ascending table order (§4.4). */
  fenced: FencedRecord[];
}

export interface LiveStartFrame {
  type: 'LIVE_START';
  status: 'active' | 'reset' | 'unregistered';
  reasonCode: string;
}

export interface LiveEndFrame {
  type: 'LIVE_END';
  /** Highest commitSeq the live section is complete through; `-1` for
   * `reset` and `unregistered` (§4.4). */
  throughSeq: number;
  /** Echo digest of the request: empty or 32 bytes (§4.4). */
  echoDigest: Uint8Array;
}

export interface CommitChange {
  tableIndex: number;
  rowId: string;
  op: 'upsert' | 'delete';
  /** Present iff `op` is `upsert` (§4.5). */
  rowVersion?: number;
  scopes: Record<string, string>;
  /** Generated-row-codec bytes; present iff `op` is `upsert` (§4.5). */
  row?: Uint8Array;
}

export interface CommitFrame {
  type: 'COMMIT';
  commitSeq: number;
  createdAtMs: number;
  actorId: string;
  tables: string[];
  changes: CommitChange[];
}

export interface SegmentRefFrame {
  type: 'SEGMENT_REF';
  segmentId: string;
  mediaType: 'rows' | 'sqlite';
  table: string;
  byteLength: number;
  rowCount: number;
  asOfCommitSeq: number;
  scopeDigest: string;
  rowCursor?: string;
  nextRowCursor?: string;
  url?: string;
  /** Present iff `url` is (§5.4). */
  urlExpiresAtMs?: number;
}

export interface SegmentInlineFrame {
  type: 'SEGMENT_INLINE';
  /** One complete SSG2 rows segment, including magic (§5.7). */
  payload: Uint8Array;
}

export interface SubEndFrame {
  type: 'SUB_END';
  nextCursor: number;
  /** Present iff the unit's bootstrap is incomplete (§4.4). */
  bootstrapState?: string;
}

export interface ErrorFrame {
  type: 'ERROR';
  code: string;
  message: string;
  category: string;
  retryable: boolean;
  recommendedAction: string;
  details?: string;
}

export type ResponseFrame =
  | RespHeaderFrame
  | LeaseFrame
  | PushResultFrame
  | PushResultDetailsFrame
  | SubStartFrame
  | CommitFrame
  | SegmentRefFrame
  | SegmentInlineFrame
  | SubEndFrame
  | LiveStartFrame
  | LiveEndFrame
  | ErrorFrame
  | UnknownFrame;

export interface RequestMessage {
  wireVersion: number;
  msgKind: 'request';
  frames: RequestFrame[];
}

export interface ResponseMessage {
  wireVersion: number;
  msgKind: 'response';
  frames: ResponseFrame[];
}

export type SyncMessage = RequestMessage | ResponseMessage;

type DefinedObject<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};
function definedObject<const T extends object>(record: T): DefinedObject<T> {
  for (const key of Object.keys(record) as (keyof T)[]) {
    if (record[key] === undefined) delete record[key];
  }
  return record as DefinedObject<T>;
}

function invalid(message: string): never {
  throw new DecodeError('sync.invalid_request', message);
}

/** A `json` field: a valid JSON document (Conventions), kept as raw text. */
function readJson(r: ByteReader, what: string): string {
  const raw = r.str();
  parseJsonDocument(raw, what);
  return raw;
}

/** §1.5: a `ROUND_FAILURE` code is a lowercase dotted catalog code. */
const ROUND_FAILURE_CODE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** §1.5: `code` is a legal `ROUND_FAILURE` code (grammar and byte length). */
export function isRoundFailureCode(code: string): boolean {
  // At most 64 bytes on the wire (§1.5), so the UTF-8 length decides it.
  return ROUND_FAILURE_CODE.test(code) && utf8Encode(code).length <= 64;
}

/** Shared by the frame decoder and encoder (§1.5 payload invariants). */
function validateRoundFailureCode(
  code: string,
  fail: (message: string) => never,
): void {
  if (!isRoundFailureCode(code)) {
    fail(
      'ROUND_FAILURE.code must be a lowercase dotted code of at most 64 bytes',
    );
  }
}

/** §1.5, §1.7: a present `outboxId` is non-empty and at most 64 bytes. */
function checkOutboxId(outboxId: string, fail: (message: string) => never) {
  if (outboxId.length === 0 || utf8Encode(outboxId).length > 64) {
    fail('REQ_HEADER.outboxId must be non-empty and at most 64 bytes');
  }
}

/** §4.3, §4.4: a unit id is 32 lowercase hex characters. */
function checkUnitId(
  id: string,
  frame: 'PROGRESS' | 'SUB_START',
  fail: (message: string) => never,
) {
  if (!/^[0-9a-f]{32}$/.test(id)) {
    fail(`${frame}.id must be 32 lowercase hex characters`);
  }
}

/** §4.2, §4.4: a digest is 32 bytes; an echo digest may also be empty. */
function checkDigest(
  digest: Uint8Array,
  field:
    | 'PULL_HEADER.registrationDigest'
    | 'PULL_HEADER.echoDigest'
    | 'LIVE_END.echoDigest',
  fail: (message: string) => never,
) {
  const emptyAllowed = field !== 'PULL_HEADER.registrationDigest';
  if (digest.length !== 32 && !(emptyAllowed && digest.length === 0)) {
    fail(`${field} must be ${emptyAllowed ? '0 or ' : ''}32 bytes`);
  }
}

/** §4.2, §4.3: a cursor is `-1` or a commitSeq. */
function checkCursor(
  cursor: number,
  field: 'PULL_HEADER.cursor' | 'PROGRESS.cursor',
  fail: (message: string) => never,
) {
  if (cursor < -1) fail(`${field} must be >= -1`);
}

/** §4.4: fenced records in strictly ascending code-unit order of `table`. */
function checkFencedOrder(
  fenced: readonly FencedRecord[],
  fail: (message: string) => never,
) {
  for (let i = 1; i < fenced.length; i++) {
    if (
      (fenced[i - 1] as FencedRecord).table >= (fenced[i] as FencedRecord).table
    ) {
      fail('SUB_START.fenced tables must be unique and in ascending order');
    }
  }
}

// ---------------------------------------------------------------------------
// Frame payload decoders (each consumes exactly the frame payload)
// ---------------------------------------------------------------------------

function decodeReqHeader(r: ByteReader): ReqHeaderFrame {
  const clientId = r.str();
  if (clientId.length === 0) invalid('REQ_HEADER.clientId must be non-empty');
  const schemaVersion = r.i32();
  if (schemaVersion < 1) invalid('REQ_HEADER.schemaVersion must be >= 1');
  const logEpoch = r.opt(() => {
    const value = r.str();
    if (value.length === 0) invalid('REQ_HEADER.logEpoch must be non-empty');
    return value;
  });
  const outboxId = r.opt(() => r.str());
  if (outboxId !== undefined) checkOutboxId(outboxId, invalid);
  return definedObject({
    type: 'REQ_HEADER',
    clientId,
    schemaVersion,
    logEpoch: logEpoch,
    outboxId: outboxId,
  });
}

function decodeRoundFailure(r: ByteReader): RoundFailureFrame {
  const code = r.str();
  validateRoundFailureCode(code, invalid);
  return { type: 'ROUND_FAILURE', code };
}

function decodePushCommit(r: ByteReader): PushCommitFrame {
  const clientCommitId = r.str();
  if (clientCommitId.length === 0) {
    invalid('PUSH_COMMIT.clientCommitId must be non-empty');
  }
  const clientSeq = r.i64();
  if (clientSeq < 0) invalid('PUSH_COMMIT.clientSeq must be >= 0');
  const operationCount = r.u32();
  if (operationCount === 0) {
    throw new DecodeError(
      'sync.empty_commit',
      'PUSH_COMMIT must carry at least one operation',
    );
  }
  const operations: PushOperation[] = [];
  for (let i = 0; i < operationCount; i++) {
    const table = r.str();
    const rowId = r.str();
    const opByte = r.u8();
    let op: 'upsert' | 'delete';
    if (opByte === 1) op = 'upsert';
    else if (opByte === 2) op = 'delete';
    else invalid(`invalid operation op byte ${opByte}`);
    const baseVersion = r.opt(() => r.i64());
    const payload = r.opt(() => r.bytes());
    if (op === 'upsert' && payload === undefined) {
      invalid('upsert operation requires a payload');
    }
    if (op === 'delete' && payload !== undefined) {
      invalid('delete operation must not carry a payload');
    }
    operations.push(
      definedObject({
        table,
        rowId,
        op,
        baseVersion: baseVersion,
        payload: payload,
      }),
    );
  }
  return { type: 'PUSH_COMMIT', clientCommitId, clientSeq, operations };
}

function decodePullHeader(r: ByteReader): PullHeaderFrame {
  const limitCommits = r.i32();
  const limitSnapshotRows = r.i32();
  const maxSnapshotPages = r.i32();
  const accept = r.u8();
  if ((accept & 0xf0) !== 0) {
    invalid('PULL_HEADER.accept bits 4-7 must be zero');
  }
  const cursor = r.i64();
  checkCursor(cursor, 'PULL_HEADER.cursor', invalid);
  const registrationDigest = r.bytes();
  checkDigest(registrationDigest, 'PULL_HEADER.registrationDigest', invalid);
  const echoDigest = r.bytes();
  checkDigest(echoDigest, 'PULL_HEADER.echoDigest', invalid);
  return {
    type: 'PULL_HEADER',
    limitCommits,
    limitSnapshotRows,
    maxSnapshotPages,
    accept,
    cursor,
    registrationDigest,
    echoDigest,
  };
}

function decodeProgress(r: ByteReader): ProgressFrame {
  const id = r.str();
  checkUnitId(id, 'PROGRESS', invalid);
  const cursor = r.i64();
  checkCursor(cursor, 'PROGRESS.cursor', invalid);
  const bootstrapState = r.opt(() => readJson(r, 'PROGRESS.bootstrapState'));
  return definedObject({
    type: 'PROGRESS',
    id,
    cursor,
    bootstrapState: bootstrapState,
  });
}

function decodeRespHeader(r: ByteReader): RespHeaderFrame {
  const requiredSchemaVersion = r.opt(() => r.i32());
  const latestSchemaVersion = r.opt(() => r.i32());
  const logEpoch = r.str();
  if (logEpoch.length === 0) {
    invalid('RESP_HEADER.logEpoch must be non-empty');
  }
  const resetRequired = r.bool();
  return definedObject({
    type: 'RESP_HEADER',
    requiredSchemaVersion: requiredSchemaVersion,
    latestSchemaVersion: latestSchemaVersion,
    logEpoch,
    resetRequired,
  });
}

function decodeLease(r: ByteReader): LeaseFrame {
  const leaseId = r.str();
  if (leaseId.length === 0) invalid('LEASE.leaseId must be non-empty');
  const expiresAtMs = r.i64();
  return { type: 'LEASE', leaseId, expiresAtMs };
}

function decodePushResult(r: ByteReader): PushResultFrame {
  const clientCommitId = r.str();
  const statusByte = r.u8();
  let status: 'applied' | 'cached' | 'rejected';
  if (statusByte === 1) status = 'applied';
  else if (statusByte === 2) status = 'cached';
  else if (statusByte === 3) status = 'rejected';
  else invalid(`invalid push result status byte ${statusByte}`);
  const commitSeq = r.opt(() => r.i64());
  if (status === 'rejected' && commitSeq !== undefined) {
    invalid('rejected PUSH_RESULT must not carry a commitSeq');
  }
  if (status !== 'rejected' && commitSeq === undefined) {
    invalid(`${status} PUSH_RESULT requires a commitSeq`);
  }
  const resultCount = r.u32();
  const results: PushOperationResult[] = [];
  for (let i = 0; i < resultCount; i++) {
    const opIndex = r.i32();
    const recordStatus = r.u8();
    if (recordStatus === 1) {
      results.push({ opIndex, status: 'applied' });
    } else if (recordStatus === 2) {
      results.push({
        opIndex,
        status: 'conflict',
        code: r.str(),
        message: r.str(),
        serverVersion: r.i64(),
        serverRow: r.bytes(),
        conflictColumns: r.bytes(),
      });
    } else if (recordStatus === 3) {
      results.push({
        opIndex,
        status: 'error',
        code: r.str(),
        message: r.str(),
        retryable: r.bool(),
      });
    } else {
      invalid(`invalid push result record status byte ${recordStatus}`);
    }
  }
  return definedObject({
    type: 'PUSH_RESULT',
    clientCommitId,
    status,
    commitSeq: commitSeq,
    results,
  });
}

function decodePushResultDetails(r: ByteReader): PushResultDetailsFrame {
  const clientCommitId = r.str();
  if (clientCommitId.length === 0) {
    invalid('PUSH_RESULT_DETAILS.clientCommitId must be non-empty');
  }
  const count = r.u32();
  if (count === 0) invalid('PUSH_RESULT_DETAILS must carry at least one entry');
  const entries: PushResultDetailsFrame['entries'] = [];
  const seen = new Set<number>();
  for (let index = 0; index < count; index++) {
    const opIndex = r.i32();
    if (opIndex < 0 || seen.has(opIndex)) {
      invalid(
        'PUSH_RESULT_DETAILS opIndex values must be unique and non-negative',
      );
    }
    seen.add(opIndex);
    const parsed = parseJsonDocument(r.str(), 'PUSH_RESULT_DETAILS.details');
    let details: RejectionDetails;
    try {
      details = normalizeRejectionDetails(parsed);
    } catch (error) {
      invalid(
        `invalid PUSH_RESULT_DETAILS.details: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    entries.push({ opIndex, details });
  }
  return { type: 'PUSH_RESULT_DETAILS', clientCommitId, entries };
}

function decodeSubStart(r: ByteReader): SubStartFrame {
  const id = r.str();
  checkUnitId(id, 'SUB_START', invalid);
  const statusByte = r.u8();
  let status: 'active' | 'revoked' | 'reset';
  if (statusByte === 1) status = 'active';
  else if (statusByte === 2) status = 'revoked';
  else if (statusByte === 3) status = 'reset';
  else invalid(`invalid SUB_START status byte ${statusByte}`);
  const reasonCode = r.str();
  const bootstrap = r.bool();
  const fencedCount = r.u32();
  const fenced: FencedRecord[] = [];
  for (let i = 0; i < fencedCount; i++) {
    const table = r.str();
    const fencedStatus = r.u8();
    if (fencedStatus !== 1 && fencedStatus !== 2) {
      invalid('invalid fenced record status byte');
    }
    fenced.push({
      table,
      status: fencedStatus === 1 ? 'active' : 'revoked',
      scopes: readStringListMap(r),
    });
  }
  checkFencedOrder(fenced, invalid);
  return { type: 'SUB_START', id, status, reasonCode, bootstrap, fenced };
}

function decodeLiveStart(r: ByteReader): LiveStartFrame {
  const statusByte = r.u8();
  let status: LiveStartFrame['status'];
  if (statusByte === 1) status = 'active';
  else if (statusByte === 3) status = 'reset';
  else if (statusByte === 4) status = 'unregistered';
  else invalid('invalid LIVE_START status byte');
  return { type: 'LIVE_START', status, reasonCode: r.str() };
}

function decodeLiveEnd(r: ByteReader): LiveEndFrame {
  const throughSeq = r.i64();
  const echoDigest = r.bytes();
  checkDigest(echoDigest, 'LIVE_END.echoDigest', invalid);
  return { type: 'LIVE_END', throughSeq, echoDigest };
}

function decodeCommit(r: ByteReader): CommitFrame {
  const commitSeq = r.i64();
  const createdAtMs = r.i64();
  const actorId = r.str();
  const tableCount = r.u32();
  const tables: string[] = [];
  for (let i = 0; i < tableCount; i++) tables.push(r.str());
  const changeCount = r.u32();
  const changes: CommitChange[] = [];
  for (let i = 0; i < changeCount; i++) {
    const tableIndex = r.u16();
    if (tableIndex >= tables.length) {
      invalid(
        `change tableIndex ${tableIndex} out of range (${tables.length} tables)`,
      );
    }
    const rowId = r.str();
    const opByte = r.u8();
    let op: 'upsert' | 'delete';
    if (opByte === 1) op = 'upsert';
    else if (opByte === 2) op = 'delete';
    else invalid(`invalid change op byte ${opByte}`);
    const rowVersion = r.opt(() => r.i64());
    const scopes = readStringMap(r);
    const row = r.opt(() => r.bytes());
    if (op === 'upsert' && (rowVersion === undefined || row === undefined)) {
      invalid('upsert change requires rowVersion and row');
    }
    if (op === 'delete' && (rowVersion !== undefined || row !== undefined)) {
      invalid('delete change must not carry rowVersion or row');
    }
    changes.push(
      definedObject({
        tableIndex,
        rowId,
        op,
        rowVersion: rowVersion,
        scopes,
        row: row,
      }),
    );
  }
  return { type: 'COMMIT', commitSeq, createdAtMs, actorId, tables, changes };
}

function decodeSegmentRef(r: ByteReader): SegmentRefFrame {
  const segmentId = r.str();
  const mediaTypeByte = r.u8();
  let mediaType: 'rows' | 'sqlite';
  if (mediaTypeByte === 1) mediaType = 'rows';
  else if (mediaTypeByte === 2) mediaType = 'sqlite';
  else invalid(`invalid SEGMENT_REF mediaType byte ${mediaTypeByte}`);
  const table = r.str();
  const byteLength = r.i64();
  const rowCount = r.i64();
  const asOfCommitSeq = r.i64();
  const scopeDigest = r.str();
  const rowCursor = r.opt(() => r.str());
  const nextRowCursor = r.opt(() => r.str());
  const url = r.opt(() => r.str());
  const urlExpiresAtMs = r.opt(() => r.i64());
  if ((url === undefined) !== (urlExpiresAtMs === undefined)) {
    invalid('SEGMENT_REF.urlExpiresAtMs must be present iff url is');
  }
  return definedObject({
    type: 'SEGMENT_REF',
    segmentId,
    mediaType,
    table,
    byteLength,
    rowCount,
    asOfCommitSeq,
    scopeDigest,
    rowCursor: rowCursor,
    nextRowCursor: nextRowCursor,
    url: url,
    urlExpiresAtMs: urlExpiresAtMs,
  });
}

function decodeSegmentInline(r: ByteReader): SegmentInlineFrame {
  const payload = r.raw(r.remaining);
  // Structural validation only (§5.7: the payload is one complete rows
  // segment); the schema checksum of §5.2 is the receiver's job.
  decodeRowsSegment(payload);
  return { type: 'SEGMENT_INLINE', payload };
}

function decodeSubEnd(r: ByteReader): SubEndFrame {
  const nextCursor = r.i64();
  const bootstrapState = r.opt(() => readJson(r, 'SUB_END.bootstrapState'));
  return definedObject({
    type: 'SUB_END',
    nextCursor,
    bootstrapState: bootstrapState,
  });
}

function decodeErrorFrame(r: ByteReader): ErrorFrame {
  const code = r.str();
  const message = r.str();
  const category = r.str();
  const retryable = r.bool();
  const recommendedAction = r.str();
  const details = r.opt(() => readJson(r, 'ERROR.details'));
  return definedObject({
    type: 'ERROR',
    code,
    message,
    category,
    retryable,
    recommendedAction,
    details: details,
  });
}

function decodeRequestFrame(
  frameType: number,
  payload: Uint8Array,
): RequestFrame {
  const r = new ByteReader(payload);
  let frame: RequestFrame;
  switch (frameType) {
    case FrameType.REQ_HEADER:
      frame = decodeReqHeader(r);
      break;
    case FrameType.ROUND_FAILURE:
      frame = decodeRoundFailure(r);
      break;
    case FrameType.PUSH_COMMIT:
      frame = decodePushCommit(r);
      break;
    case FrameType.PULL_HEADER:
      frame = decodePullHeader(r);
      break;
    case FrameType.UNIT:
      frame = { type: 'UNIT', scopes: readStringMap(r) };
      break;
    case FrameType.PROGRESS:
      frame = decodeProgress(r);
      break;
    default:
      if (RESPONSE_FRAME_TYPES.has(frameType)) {
        invalid(
          `response frame type 0x${frameType.toString(16)} is illegal in a request message`,
        );
      }
      return { type: 'UNKNOWN', frameType, payload };
  }
  r.expectFullyConsumed(`${frame.type} frame payload`);
  return frame;
}

function decodeResponseFrame(
  frameType: number,
  payload: Uint8Array,
): ResponseFrame {
  const r = new ByteReader(payload);
  let frame: ResponseFrame;
  switch (frameType) {
    case FrameType.RESP_HEADER:
      frame = decodeRespHeader(r);
      break;
    case FrameType.LEASE:
      frame = decodeLease(r);
      break;
    case FrameType.PUSH_RESULT:
      frame = decodePushResult(r);
      break;
    case FrameType.PUSH_RESULT_DETAILS:
      frame = decodePushResultDetails(r);
      break;
    case FrameType.SUB_START:
      frame = decodeSubStart(r);
      break;
    case FrameType.COMMIT:
      frame = decodeCommit(r);
      break;
    case FrameType.SEGMENT_REF:
      frame = decodeSegmentRef(r);
      break;
    case FrameType.SEGMENT_INLINE:
      frame = decodeSegmentInline(r);
      break;
    case FrameType.SUB_END:
      frame = decodeSubEnd(r);
      break;
    case FrameType.LIVE_START:
      frame = decodeLiveStart(r);
      break;
    case FrameType.LIVE_END:
      frame = decodeLiveEnd(r);
      break;
    case FrameType.ERROR:
      frame = decodeErrorFrame(r);
      break;
    default:
      if (REQUEST_FRAME_TYPES.has(frameType)) {
        invalid(
          `request frame type 0x${frameType.toString(16)} is illegal in a response message`,
        );
      }
      return { type: 'UNKNOWN', frameType, payload };
  }
  r.expectFullyConsumed(`${frame.type} frame payload`);
  return frame;
}

// ---------------------------------------------------------------------------
// Frame grammar validation (§1.5, §1.6) — shared by decode and encode
// ---------------------------------------------------------------------------

function validateRequestSequence(frames: readonly RequestFrame[]): void {
  const first = frames[0];
  if (first === undefined || first.type !== 'REQ_HEADER') {
    invalid('request must start with a REQ_HEADER frame');
  }
  let pushCount = 0;
  let hasPull = false;
  let hasProgress = false;
  let index = 1;
  let sawRoundFailure = false;
  for (const frame of frames.slice(1)) {
    switch (frame.type) {
      case 'REQ_HEADER':
        invalid('duplicate REQ_HEADER frame');
        break;
      case 'ROUND_FAILURE':
        // §1.5: at most one, immediately after REQ_HEADER.
        if (sawRoundFailure) invalid('duplicate ROUND_FAILURE frame');
        if (index !== 1) {
          invalid('ROUND_FAILURE frame must immediately follow REQ_HEADER');
        }
        sawRoundFailure = true;
        break;
      case 'PUSH_COMMIT':
        if (hasPull) invalid('PUSH_COMMIT frame after PULL_HEADER');
        pushCount += 1;
        break;
      case 'PULL_HEADER':
        if (hasPull) invalid('duplicate PULL_HEADER frame');
        hasPull = true;
        break;
      case 'UNIT':
        if (!hasPull) invalid('UNIT frame without a PULL_HEADER');
        if (hasProgress) invalid('UNIT frame after a PROGRESS frame');
        break;
      case 'PROGRESS':
        if (!hasPull) invalid('PROGRESS frame without a PULL_HEADER');
        hasProgress = true;
        break;
      case 'UNKNOWN':
        break;
    }
    index += 1;
  }
  if (pushCount === 0 && !hasPull) {
    invalid('request must contain PUSH_COMMIT or PULL_HEADER frames');
  }
}

function validateResponseSequence(frames: readonly ResponseFrame[]): void {
  const first = frames[0];
  if (first === undefined || first.type !== 'RESP_HEADER') {
    invalid('response must start with a RESP_HEADER frame');
  }
  // §1.6 sections: unit sections, then at most one live section.
  let section: 'none' | 'unit' | 'live' = 'none';
  let sawUnitSection = false;
  let sawLive = false;
  let sawLease = false;
  let sawBody = false;
  let errorSeen = false;
  let lastPushResult: PushResultFrame | undefined;
  let lastPushResultHasDetails = false;
  for (const frame of frames.slice(1)) {
    if (errorSeen) invalid('frames after ERROR (the next frame must be END)');
    switch (frame.type) {
      case 'RESP_HEADER':
        invalid('duplicate RESP_HEADER frame');
        break;
      case 'LEASE':
        // §7.3.2: at most one LEASE, immediately after RESP_HEADER.
        if (sawLease) invalid('duplicate LEASE frame');
        if (sawBody) invalid('LEASE frame must immediately follow RESP_HEADER');
        sawLease = true;
        break;
      case 'PUSH_RESULT':
        if (sawUnitSection || sawLive) {
          invalid('PUSH_RESULT frame after a unit or live section');
        }
        lastPushResult = frame;
        lastPushResultHasDetails = false;
        sawBody = true;
        break;
      case 'PUSH_RESULT_DETAILS': {
        if (sawUnitSection || sawLive) {
          invalid('PUSH_RESULT_DETAILS frame after a unit or live section');
        }
        if (lastPushResult === undefined) {
          invalid('PUSH_RESULT_DETAILS without a preceding PUSH_RESULT');
        }
        if (lastPushResultHasDetails) {
          invalid('duplicate PUSH_RESULT_DETAILS companion');
        }
        if (
          lastPushResult.clientCommitId !== frame.clientCommitId ||
          lastPushResult.status !== 'rejected'
        ) {
          invalid(
            'PUSH_RESULT_DETAILS does not match its rejected PUSH_RESULT',
          );
        }
        const errorIndexes = new Set(
          lastPushResult.results.flatMap((result) =>
            result.status === 'error' ? [result.opIndex] : [],
          ),
        );
        if (frame.entries.some((entry) => !errorIndexes.has(entry.opIndex))) {
          invalid('PUSH_RESULT_DETAILS entry does not match an error result');
        }
        lastPushResultHasDetails = true;
        sawBody = true;
        break;
      }
      case 'SUB_START':
        if (section === 'unit') invalid('nested SUB_START frame');
        if (sawLive)
          invalid('SUB_START frame inside or after the live section');
        section = 'unit';
        sawUnitSection = true;
        sawBody = true;
        lastPushResult = undefined;
        break;
      case 'SEGMENT_REF':
      case 'SEGMENT_INLINE':
        if (section !== 'unit') invalid('segment frame outside a unit section');
        break;
      case 'SUB_END':
        if (section !== 'unit')
          invalid('SUB_END frame without an open SUB_START');
        section = 'none';
        break;
      case 'LIVE_START':
        if (section === 'unit')
          invalid('LIVE_START frame inside a unit section');
        if (sawLive) invalid('second LIVE_START frame');
        section = 'live';
        sawLive = true;
        sawBody = true;
        lastPushResult = undefined;
        break;
      case 'COMMIT':
        if (section !== 'live')
          invalid('COMMIT frame outside the live section');
        break;
      case 'LIVE_END':
        if (section !== 'live')
          invalid('LIVE_END frame without an open LIVE_START');
        section = 'none';
        break;
      case 'ERROR':
        errorSeen = true;
        sawBody = true;
        lastPushResult = undefined;
        break;
      case 'UNKNOWN':
        sawBody = true;
        lastPushResult = undefined;
        break;
    }
  }
  if (section !== 'none' && !errorSeen) {
    invalid('unit or live section not terminated');
  }
}

export function validateFrameSequence(message: SyncMessage): void {
  if (message.msgKind === 'request') validateRequestSequence(message.frames);
  else validateResponseSequence(message.frames);
}

// ---------------------------------------------------------------------------
// Frame payload encoders
// ---------------------------------------------------------------------------

const OP_BYTES = { upsert: 1, delete: 2 } as const;
const PUSH_STATUS_BYTES = { applied: 1, cached: 2, rejected: 3 } as const;
const SUB_STATUS_BYTES = { active: 1, revoked: 2, reset: 3 } as const;
const LIVE_STATUS_BYTES = { active: 1, reset: 3, unregistered: 4 } as const;
const MEDIA_TYPE_BYTES = { rows: 1, sqlite: 2 } as const;

function encodeInvalid(message: string): never {
  throw new Error(message);
}

function encodeFrame(frame: RequestFrame | ResponseFrame): {
  frameType: number;
  payload: Uint8Array;
} {
  const w = new ByteWriter();
  switch (frame.type) {
    case 'REQ_HEADER': {
      if (frame.clientId.length === 0) {
        encodeInvalid('REQ_HEADER.clientId must be non-empty');
      }
      if (frame.schemaVersion < 1) {
        encodeInvalid('REQ_HEADER.schemaVersion must be >= 1');
      }
      w.str(frame.clientId);
      w.i32(frame.schemaVersion);
      if (frame.logEpoch === '') {
        encodeInvalid('REQ_HEADER.logEpoch must be non-empty');
      }
      w.opt(frame.logEpoch, (v) => w.str(v));
      if (frame.outboxId !== undefined) {
        checkOutboxId(frame.outboxId, encodeInvalid);
      }
      w.opt(frame.outboxId, (v) => w.str(v));
      break;
    }
    case 'ROUND_FAILURE': {
      validateRoundFailureCode(frame.code, encodeInvalid);
      w.str(frame.code);
      break;
    }
    case 'PUSH_COMMIT': {
      if (frame.clientCommitId.length === 0) {
        encodeInvalid('PUSH_COMMIT.clientCommitId must be non-empty');
      }
      if (frame.operations.length === 0) {
        encodeInvalid('PUSH_COMMIT must carry at least one operation');
      }
      if (frame.clientSeq < 0) {
        encodeInvalid('PUSH_COMMIT.clientSeq must be >= 0');
      }
      w.str(frame.clientCommitId);
      w.i64(frame.clientSeq);
      w.u32(frame.operations.length);
      for (const operation of frame.operations) {
        if (operation.op === 'upsert' && operation.payload === undefined) {
          encodeInvalid('upsert operation requires a payload');
        }
        if (operation.op === 'delete' && operation.payload !== undefined) {
          encodeInvalid('delete operation must not carry a payload');
        }
        w.str(operation.table);
        w.str(operation.rowId);
        w.u8(OP_BYTES[operation.op]);
        w.opt(operation.baseVersion, (v) => w.i64(v));
        w.opt(operation.payload, (v) => w.bytes(v));
      }
      break;
    }
    case 'PULL_HEADER': {
      if ((frame.accept & 0xf0) !== 0) {
        encodeInvalid('PULL_HEADER.accept bits 4-7 must be zero');
      }
      w.i32(frame.limitCommits);
      w.i32(frame.limitSnapshotRows);
      w.i32(frame.maxSnapshotPages);
      checkCursor(frame.cursor, 'PULL_HEADER.cursor', encodeInvalid);
      checkDigest(
        frame.registrationDigest,
        'PULL_HEADER.registrationDigest',
        encodeInvalid,
      );
      checkDigest(frame.echoDigest, 'PULL_HEADER.echoDigest', encodeInvalid);
      w.u8(frame.accept);
      w.i64(frame.cursor);
      w.bytes(frame.registrationDigest);
      w.bytes(frame.echoDigest);
      break;
    }
    case 'UNIT': {
      writeStringMap(w, frame.scopes);
      break;
    }
    case 'PROGRESS': {
      checkUnitId(frame.id, 'PROGRESS', encodeInvalid);
      checkCursor(frame.cursor, 'PROGRESS.cursor', encodeInvalid);
      w.str(frame.id);
      w.i64(frame.cursor);
      w.opt(frame.bootstrapState, (v) => w.str(v));
      break;
    }
    case 'RESP_HEADER': {
      w.opt(frame.requiredSchemaVersion, (v) => w.i32(v));
      w.opt(frame.latestSchemaVersion, (v) => w.i32(v));
      if (frame.logEpoch.length === 0) {
        encodeInvalid('RESP_HEADER.logEpoch must be non-empty');
      }
      w.str(frame.logEpoch);
      w.bool(frame.resetRequired);
      break;
    }
    case 'LEASE': {
      if (frame.leaseId.length === 0) {
        encodeInvalid('LEASE.leaseId must be non-empty');
      }
      w.str(frame.leaseId);
      w.i64(frame.expiresAtMs);
      break;
    }
    case 'PUSH_RESULT': {
      if (frame.status === 'rejected' && frame.commitSeq !== undefined) {
        encodeInvalid('rejected PUSH_RESULT must not carry a commitSeq');
      }
      if (frame.status !== 'rejected' && frame.commitSeq === undefined) {
        encodeInvalid(`${frame.status} PUSH_RESULT requires a commitSeq`);
      }
      w.str(frame.clientCommitId);
      w.u8(PUSH_STATUS_BYTES[frame.status]);
      w.opt(frame.commitSeq, (v) => w.i64(v));
      w.u32(frame.results.length);
      for (const result of frame.results) {
        w.i32(result.opIndex);
        if (result.status === 'applied') {
          w.u8(1);
        } else if (result.status === 'conflict') {
          w.u8(2);
          w.str(result.code);
          w.str(result.message);
          w.i64(result.serverVersion);
          w.bytes(result.serverRow);
          w.bytes(result.conflictColumns);
        } else {
          w.u8(3);
          w.str(result.code);
          w.str(result.message);
          w.bool(result.retryable);
        }
      }
      break;
    }
    case 'PUSH_RESULT_DETAILS': {
      if (frame.clientCommitId.length === 0) {
        encodeInvalid('PUSH_RESULT_DETAILS.clientCommitId must be non-empty');
      }
      if (frame.entries.length === 0) {
        encodeInvalid('PUSH_RESULT_DETAILS must carry at least one entry');
      }
      const seen = new Set<number>();
      w.str(frame.clientCommitId);
      w.u32(frame.entries.length);
      for (const entry of frame.entries) {
        if (!Number.isInteger(entry.opIndex) || entry.opIndex < 0) {
          encodeInvalid('PUSH_RESULT_DETAILS.opIndex must be non-negative');
        }
        if (seen.has(entry.opIndex)) {
          encodeInvalid('PUSH_RESULT_DETAILS.opIndex must be unique');
        }
        seen.add(entry.opIndex);
        w.i32(entry.opIndex);
        w.str(JSON.stringify(normalizeRejectionDetails(entry.details)));
      }
      break;
    }
    case 'SUB_START': {
      checkUnitId(frame.id, 'SUB_START', encodeInvalid);
      checkFencedOrder(frame.fenced, encodeInvalid);
      w.str(frame.id);
      w.u8(SUB_STATUS_BYTES[frame.status]);
      w.str(frame.reasonCode);
      w.bool(frame.bootstrap);
      w.u32(frame.fenced.length);
      for (const record of frame.fenced) {
        w.str(record.table);
        w.u8(SUB_STATUS_BYTES[record.status]);
        writeStringListMap(w, record.scopes);
      }
      break;
    }
    case 'LIVE_START': {
      w.u8(LIVE_STATUS_BYTES[frame.status]);
      w.str(frame.reasonCode);
      break;
    }
    case 'LIVE_END': {
      checkDigest(frame.echoDigest, 'LIVE_END.echoDigest', encodeInvalid);
      w.i64(frame.throughSeq);
      w.bytes(frame.echoDigest);
      break;
    }
    case 'COMMIT': {
      w.i64(frame.commitSeq);
      w.i64(frame.createdAtMs);
      w.str(frame.actorId);
      w.u32(frame.tables.length);
      for (const table of frame.tables) w.str(table);
      w.u32(frame.changes.length);
      for (const change of frame.changes) {
        if (change.tableIndex >= frame.tables.length) {
          encodeInvalid(`change tableIndex ${change.tableIndex} out of range`);
        }
        if (
          change.op === 'upsert' &&
          (change.rowVersion === undefined || change.row === undefined)
        ) {
          encodeInvalid('upsert change requires rowVersion and row');
        }
        if (
          change.op === 'delete' &&
          (change.rowVersion !== undefined || change.row !== undefined)
        ) {
          encodeInvalid('delete change must not carry rowVersion or row');
        }
        w.u16(change.tableIndex);
        w.str(change.rowId);
        w.u8(OP_BYTES[change.op]);
        w.opt(change.rowVersion, (v) => w.i64(v));
        writeStringMap(w, change.scopes);
        w.opt(change.row, (v) => w.bytes(v));
      }
      break;
    }
    case 'SEGMENT_REF': {
      if ((frame.url === undefined) !== (frame.urlExpiresAtMs === undefined)) {
        encodeInvalid('SEGMENT_REF.urlExpiresAtMs must be present iff url is');
      }
      w.str(frame.segmentId);
      w.u8(MEDIA_TYPE_BYTES[frame.mediaType]);
      w.str(frame.table);
      w.i64(frame.byteLength);
      w.i64(frame.rowCount);
      w.i64(frame.asOfCommitSeq);
      w.str(frame.scopeDigest);
      w.opt(frame.rowCursor, (v) => w.str(v));
      w.opt(frame.nextRowCursor, (v) => w.str(v));
      w.opt(frame.url, (v) => w.str(v));
      w.opt(frame.urlExpiresAtMs, (v) => w.i64(v));
      break;
    }
    case 'SEGMENT_INLINE': {
      return { frameType: FrameType.SEGMENT_INLINE, payload: frame.payload };
    }
    case 'SUB_END': {
      w.i64(frame.nextCursor);
      w.opt(frame.bootstrapState, (v) => w.str(v));
      break;
    }
    case 'ERROR': {
      w.str(frame.code);
      w.str(frame.message);
      w.str(frame.category);
      w.bool(frame.retryable);
      w.str(frame.recommendedAction);
      w.opt(frame.details, (v) => w.str(v));
      break;
    }
    case 'UNKNOWN': {
      if (
        !Number.isInteger(frame.frameType) ||
        frame.frameType < 0 ||
        frame.frameType > 0xff ||
        KNOWN_FRAME_TYPES.has(frame.frameType)
      ) {
        encodeInvalid(
          `UNKNOWN frame type ${frame.frameType} collides with a defined frame type`,
        );
      }
      return { frameType: frame.frameType, payload: frame.payload };
    }
  }
  return { frameType: FrameType[frame.type], payload: w.finish() };
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export function encodeMessage(message: SyncMessage): Uint8Array {
  if (!isSupportedProtocolWireVersion(message.wireVersion)) {
    encodeInvalid(`unsupported wireVersion ${message.wireVersion}`);
  }
  validateFrameSequence(message);
  const w = new ByteWriter();
  w.raw(MAGIC_BYTES);
  w.u16(message.wireVersion);
  w.u8(message.msgKind === 'request' ? 0x01 : 0x02);
  w.u8(0x00);
  for (const frame of message.frames) {
    const { frameType, payload } = encodeFrame(frame);
    w.u8(frameType);
    w.u32(payload.length);
    w.raw(payload);
  }
  w.u8(FrameType.END);
  w.u32(0);
  return w.finish();
}

function readFrames<T>(
  r: ByteReader,
  decodeFrame_: (frameType: number, payload: Uint8Array) => T,
): T[] {
  const frames: T[] = [];
  for (;;) {
    if (r.remaining === 0) {
      invalid('truncated message: missing END frame');
    }
    const frameType = r.u8();
    const frameLength = r.u32();
    if (frameLength > r.remaining) {
      invalid(
        `frame length ${frameLength} exceeds remaining ${r.remaining} bytes`,
      );
    }
    const payload = r.raw(frameLength);
    if (frameType === FrameType.END) {
      if (frameLength !== 0) invalid('END frame must have zero length');
      r.expectFullyConsumed('END frame');
      return frames;
    }
    frames.push(decodeFrame_(frameType, payload));
  }
}

export function decodeMessage(bytes: Uint8Array): SyncMessage {
  const r = new ByteReader(bytes);
  if (r.remaining < 8) invalid('truncated envelope header');
  const magic = r.raw(4);
  if (
    magic[0] !== MAGIC_BYTES[0] ||
    magic[1] !== MAGIC_BYTES[1] ||
    magic[2] !== MAGIC_BYTES[2] ||
    magic[3] !== MAGIC_BYTES[3]
  ) {
    invalid('bad envelope magic');
  }
  const wireVersion = r.u16();
  if (!isSupportedProtocolWireVersion(wireVersion)) {
    invalid(`unsupported wireVersion ${wireVersion}`);
  }
  const kindByte = r.u8();
  if (kindByte !== 0x01 && kindByte !== 0x02) {
    invalid(`unknown msgKind byte 0x${kindByte.toString(16)}`);
  }
  const flags = r.u8();
  if (flags !== 0) invalid(`non-zero envelope flags 0x${flags.toString(16)}`);
  if (kindByte === 0x01) {
    const message: RequestMessage = {
      wireVersion,
      msgKind: 'request',
      frames: readFrames(r, (frameType, payload) =>
        decodeRequestFrame(frameType, payload),
      ),
    };
    validateRequestSequence(message.frames);
    return message;
  }
  const message: ResponseMessage = {
    wireVersion,
    msgKind: 'response',
    frames: readFrames(r, (frameType, payload) =>
      decodeResponseFrame(frameType, payload),
    ),
  };
  validateResponseSequence(message.frames);
  return message;
}
