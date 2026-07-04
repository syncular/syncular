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
import { PROTOCOL_WIRE_VERSION, SYNC_PACK_MAGIC } from './constants';
import { DecodeError } from './errors';
import {
  FrameType,
  KNOWN_FRAME_TYPES,
  REQUEST_FRAME_TYPES,
  RESPONSE_FRAME_TYPES,
} from './frames';
import { decodeRowsSegment } from './segment';

const MAGIC_BYTES = utf8Encode(SYNC_PACK_MAGIC);

export type ScopeMap = Record<string, string[]>;

export interface ReqHeaderFrame {
  type: 'REQ_HEADER';
  clientId: string;
  schemaVersion: number;
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
  operations: PushOperation[];
}

export interface PullHeaderFrame {
  type: 'PULL_HEADER';
  limitCommits: number;
  limitSnapshotRows: number;
  maxSnapshotPages: number;
  /** Bitmask (§4.2): bit 0 inline rows, 1 external rows, 2 sqlite, 3 signed URLs. */
  accept: number;
}

export interface SubscriptionFrame {
  type: 'SUBSCRIPTION';
  id: string;
  table: string;
  scopes: ScopeMap;
  /** Host-opaque JSON document, preserved verbatim. */
  params?: string;
  cursor: number;
  /** Opaque resume token JSON, round-tripped byte-for-byte (§4.7). */
  bootstrapState?: string;
}

export interface UnknownFrame {
  type: 'UNKNOWN';
  frameType: number;
  payload: Uint8Array;
}

export type RequestFrame =
  | ReqHeaderFrame
  | PushCommitFrame
  | PullHeaderFrame
  | SubscriptionFrame
  | UnknownFrame;

export interface RespHeaderFrame {
  type: 'RESP_HEADER';
  requiredSchemaVersion?: number;
  latestSchemaVersion?: number;
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
    }
  | {
      opIndex: number;
      status: 'error';
      code: string;
      message: string;
      retryable: boolean;
    };

export interface PushResultFrame {
  type: 'PUSH_RESULT';
  clientCommitId: string;
  status: 'applied' | 'cached' | 'rejected';
  /** Present iff `status` is `applied` or `cached` (§6.3). */
  commitSeq?: number;
  results: PushOperationResult[];
}

export interface SubStartFrame {
  type: 'SUB_START';
  id: string;
  status: 'active' | 'revoked' | 'reset';
  reasonCode: string;
  effectiveScopes: ScopeMap;
  bootstrap: boolean;
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
  /** Present iff the bootstrap is incomplete (§4.4). */
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
  | SubStartFrame
  | CommitFrame
  | SegmentRefFrame
  | SegmentInlineFrame
  | SubEndFrame
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

function invalid(message: string): never {
  throw new DecodeError('sync.invalid_request', message);
}

function requireJsonDocument(raw: string, what: string): string {
  try {
    JSON.parse(raw);
  } catch {
    invalid(`${what} is not a valid JSON document`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Frame payload decoders (each consumes exactly the frame payload)
// ---------------------------------------------------------------------------

function decodeReqHeader(r: ByteReader): ReqHeaderFrame {
  const clientId = r.str();
  if (clientId.length === 0) invalid('REQ_HEADER.clientId must be non-empty');
  const schemaVersion = r.i32();
  if (schemaVersion < 1) invalid('REQ_HEADER.schemaVersion must be >= 1');
  return { type: 'REQ_HEADER', clientId, schemaVersion };
}

function decodePushCommit(r: ByteReader): PushCommitFrame {
  const clientCommitId = r.str();
  if (clientCommitId.length === 0) {
    invalid('PUSH_COMMIT.clientCommitId must be non-empty');
  }
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
    operations.push({
      table,
      rowId,
      op,
      ...(baseVersion !== undefined ? { baseVersion } : {}),
      ...(payload !== undefined ? { payload } : {}),
    });
  }
  return { type: 'PUSH_COMMIT', clientCommitId, operations };
}

function decodePullHeader(r: ByteReader): PullHeaderFrame {
  const limitCommits = r.i32();
  const limitSnapshotRows = r.i32();
  const maxSnapshotPages = r.i32();
  const accept = r.u8();
  if ((accept & 0xf0) !== 0) {
    invalid('PULL_HEADER.accept bits 4-7 must be zero');
  }
  return {
    type: 'PULL_HEADER',
    limitCommits,
    limitSnapshotRows,
    maxSnapshotPages,
    accept,
  };
}

function decodeSubscription(r: ByteReader): SubscriptionFrame {
  const id = r.str();
  const table = r.str();
  const scopes = readStringListMap(r);
  const params = r.opt(() =>
    requireJsonDocument(r.str(), 'SUBSCRIPTION.params'),
  );
  const cursor = r.i64();
  const bootstrapState = r.opt(() =>
    requireJsonDocument(r.str(), 'SUBSCRIPTION.bootstrapState'),
  );
  return {
    type: 'SUBSCRIPTION',
    id,
    table,
    scopes,
    ...(params !== undefined ? { params } : {}),
    cursor,
    ...(bootstrapState !== undefined ? { bootstrapState } : {}),
  };
}

function decodeRespHeader(r: ByteReader): RespHeaderFrame {
  const requiredSchemaVersion = r.opt(() => r.i32());
  const latestSchemaVersion = r.opt(() => r.i32());
  return {
    type: 'RESP_HEADER',
    ...(requiredSchemaVersion !== undefined ? { requiredSchemaVersion } : {}),
    ...(latestSchemaVersion !== undefined ? { latestSchemaVersion } : {}),
  };
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
  return {
    type: 'PUSH_RESULT',
    clientCommitId,
    status,
    ...(commitSeq !== undefined ? { commitSeq } : {}),
    results,
  };
}

function decodeSubStart(r: ByteReader): SubStartFrame {
  const id = r.str();
  const statusByte = r.u8();
  let status: 'active' | 'revoked' | 'reset';
  if (statusByte === 1) status = 'active';
  else if (statusByte === 2) status = 'revoked';
  else if (statusByte === 3) status = 'reset';
  else invalid(`invalid SUB_START status byte ${statusByte}`);
  const reasonCode = r.str();
  const effectiveScopes = readStringListMap(r);
  const bootstrap = r.bool();
  return {
    type: 'SUB_START',
    id,
    status,
    reasonCode,
    effectiveScopes,
    bootstrap,
  };
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
    changes.push({
      tableIndex,
      rowId,
      op,
      ...(rowVersion !== undefined ? { rowVersion } : {}),
      scopes,
      ...(row !== undefined ? { row } : {}),
    });
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
  return {
    type: 'SEGMENT_REF',
    segmentId,
    mediaType,
    table,
    byteLength,
    rowCount,
    asOfCommitSeq,
    scopeDigest,
    ...(rowCursor !== undefined ? { rowCursor } : {}),
    ...(nextRowCursor !== undefined ? { nextRowCursor } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(urlExpiresAtMs !== undefined ? { urlExpiresAtMs } : {}),
  };
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
  const bootstrapState = r.opt(() =>
    requireJsonDocument(r.str(), 'SUB_END.bootstrapState'),
  );
  return {
    type: 'SUB_END',
    nextCursor,
    ...(bootstrapState !== undefined ? { bootstrapState } : {}),
  };
}

function decodeErrorFrame(r: ByteReader): ErrorFrame {
  const code = r.str();
  const message = r.str();
  const category = r.str();
  const retryable = r.bool();
  const recommendedAction = r.str();
  const details = r.opt(() => requireJsonDocument(r.str(), 'ERROR.details'));
  return {
    type: 'ERROR',
    code,
    message,
    category,
    retryable,
    recommendedAction,
    ...(details !== undefined ? { details } : {}),
  };
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
    case FrameType.PUSH_COMMIT:
      frame = decodePushCommit(r);
      break;
    case FrameType.PULL_HEADER:
      frame = decodePullHeader(r);
      break;
    case FrameType.SUBSCRIPTION:
      frame = decodeSubscription(r);
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
  for (const frame of frames.slice(1)) {
    switch (frame.type) {
      case 'REQ_HEADER':
        invalid('duplicate REQ_HEADER frame');
        break;
      case 'PUSH_COMMIT':
        if (hasPull) invalid('PUSH_COMMIT frame after PULL_HEADER');
        pushCount += 1;
        break;
      case 'PULL_HEADER':
        if (hasPull) invalid('duplicate PULL_HEADER frame');
        hasPull = true;
        break;
      case 'SUBSCRIPTION':
        if (!hasPull) invalid('SUBSCRIPTION frame without a PULL_HEADER');
        break;
      case 'UNKNOWN':
        break;
    }
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
  let inSubscription = false;
  let sawSubscription = false;
  let sawLease = false;
  let sawBody = false;
  let subscriptionHasCommits = false;
  let subscriptionHasSegments = false;
  let errorSeen = false;
  for (const frame of frames.slice(1)) {
    if (errorSeen) invalid('frames after ERROR (the next frame must be END)');
    switch (frame.type) {
      case 'RESP_HEADER':
        invalid('duplicate RESP_HEADER frame');
        break;
      case 'LEASE':
        // §7.3.2: at most one LEASE, immediately after RESP_HEADER (before
        // any PUSH_RESULT / subscription section / ERROR).
        if (sawLease) invalid('duplicate LEASE frame');
        if (sawBody) invalid('LEASE frame must immediately follow RESP_HEADER');
        sawLease = true;
        break;
      case 'PUSH_RESULT':
        if (sawSubscription) invalid('PUSH_RESULT frame after SUB_START');
        sawBody = true;
        break;
      case 'SUB_START':
        if (inSubscription) invalid('nested SUB_START frame');
        inSubscription = true;
        sawSubscription = true;
        sawBody = true;
        subscriptionHasCommits = false;
        subscriptionHasSegments = false;
        break;
      case 'COMMIT':
        if (!inSubscription) invalid('COMMIT frame outside a subscription');
        if (subscriptionHasSegments) {
          invalid(
            'COMMIT and segment frames must not both appear for one subscription',
          );
        }
        subscriptionHasCommits = true;
        break;
      case 'SEGMENT_REF':
      case 'SEGMENT_INLINE':
        if (!inSubscription) invalid('segment frame outside a subscription');
        if (subscriptionHasCommits) {
          invalid(
            'COMMIT and segment frames must not both appear for one subscription',
          );
        }
        subscriptionHasSegments = true;
        break;
      case 'SUB_END':
        if (!inSubscription) invalid('SUB_END frame without an open SUB_START');
        inSubscription = false;
        break;
      case 'ERROR':
        errorSeen = true;
        sawBody = true;
        break;
      case 'UNKNOWN':
        sawBody = true;
        break;
    }
  }
  if (inSubscription && !errorSeen) {
    invalid('subscription not terminated by SUB_END');
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
const MEDIA_TYPE_BYTES = { rows: 1, sqlite: 2 } as const;

function encodeFrame(frame: RequestFrame | ResponseFrame): {
  frameType: number;
  payload: Uint8Array;
} {
  const w = new ByteWriter();
  switch (frame.type) {
    case 'REQ_HEADER': {
      if (frame.clientId.length === 0) {
        throw new Error('REQ_HEADER.clientId must be non-empty');
      }
      if (frame.schemaVersion < 1) {
        throw new Error('REQ_HEADER.schemaVersion must be >= 1');
      }
      w.str(frame.clientId);
      w.i32(frame.schemaVersion);
      return { frameType: FrameType.REQ_HEADER, payload: w.finish() };
    }
    case 'PUSH_COMMIT': {
      if (frame.clientCommitId.length === 0) {
        throw new Error('PUSH_COMMIT.clientCommitId must be non-empty');
      }
      if (frame.operations.length === 0) {
        throw new Error('PUSH_COMMIT must carry at least one operation');
      }
      w.str(frame.clientCommitId);
      w.u32(frame.operations.length);
      for (const operation of frame.operations) {
        if (operation.op === 'upsert' && operation.payload === undefined) {
          throw new Error('upsert operation requires a payload');
        }
        if (operation.op === 'delete' && operation.payload !== undefined) {
          throw new Error('delete operation must not carry a payload');
        }
        w.str(operation.table);
        w.str(operation.rowId);
        w.u8(OP_BYTES[operation.op]);
        w.opt(operation.baseVersion, (v) => w.i64(v));
        w.opt(operation.payload, (v) => w.bytes(v));
      }
      return { frameType: FrameType.PUSH_COMMIT, payload: w.finish() };
    }
    case 'PULL_HEADER': {
      if ((frame.accept & 0xf0) !== 0) {
        throw new Error('PULL_HEADER.accept bits 4-7 must be zero');
      }
      w.i32(frame.limitCommits);
      w.i32(frame.limitSnapshotRows);
      w.i32(frame.maxSnapshotPages);
      w.u8(frame.accept);
      return { frameType: FrameType.PULL_HEADER, payload: w.finish() };
    }
    case 'SUBSCRIPTION': {
      w.str(frame.id);
      w.str(frame.table);
      writeStringListMap(w, frame.scopes);
      w.opt(frame.params, (v) => w.str(v));
      w.i64(frame.cursor);
      w.opt(frame.bootstrapState, (v) => w.str(v));
      return { frameType: FrameType.SUBSCRIPTION, payload: w.finish() };
    }
    case 'RESP_HEADER': {
      w.opt(frame.requiredSchemaVersion, (v) => w.i32(v));
      w.opt(frame.latestSchemaVersion, (v) => w.i32(v));
      return { frameType: FrameType.RESP_HEADER, payload: w.finish() };
    }
    case 'LEASE': {
      if (frame.leaseId.length === 0) {
        throw new Error('LEASE.leaseId must be non-empty');
      }
      w.str(frame.leaseId);
      w.i64(frame.expiresAtMs);
      return { frameType: FrameType.LEASE, payload: w.finish() };
    }
    case 'PUSH_RESULT': {
      if (frame.status === 'rejected' && frame.commitSeq !== undefined) {
        throw new Error('rejected PUSH_RESULT must not carry a commitSeq');
      }
      if (frame.status !== 'rejected' && frame.commitSeq === undefined) {
        throw new Error(`${frame.status} PUSH_RESULT requires a commitSeq`);
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
        } else {
          w.u8(3);
          w.str(result.code);
          w.str(result.message);
          w.bool(result.retryable);
        }
      }
      return { frameType: FrameType.PUSH_RESULT, payload: w.finish() };
    }
    case 'SUB_START': {
      w.str(frame.id);
      w.u8(SUB_STATUS_BYTES[frame.status]);
      w.str(frame.reasonCode);
      writeStringListMap(w, frame.effectiveScopes);
      w.bool(frame.bootstrap);
      return { frameType: FrameType.SUB_START, payload: w.finish() };
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
          throw new Error(
            `change tableIndex ${change.tableIndex} out of range`,
          );
        }
        if (
          change.op === 'upsert' &&
          (change.rowVersion === undefined || change.row === undefined)
        ) {
          throw new Error('upsert change requires rowVersion and row');
        }
        if (
          change.op === 'delete' &&
          (change.rowVersion !== undefined || change.row !== undefined)
        ) {
          throw new Error('delete change must not carry rowVersion or row');
        }
        w.u16(change.tableIndex);
        w.str(change.rowId);
        w.u8(OP_BYTES[change.op]);
        w.opt(change.rowVersion, (v) => w.i64(v));
        writeStringMap(w, change.scopes);
        w.opt(change.row, (v) => w.bytes(v));
      }
      return { frameType: FrameType.COMMIT, payload: w.finish() };
    }
    case 'SEGMENT_REF': {
      if ((frame.url === undefined) !== (frame.urlExpiresAtMs === undefined)) {
        throw new Error(
          'SEGMENT_REF.urlExpiresAtMs must be present iff url is',
        );
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
      return { frameType: FrameType.SEGMENT_REF, payload: w.finish() };
    }
    case 'SEGMENT_INLINE': {
      return { frameType: FrameType.SEGMENT_INLINE, payload: frame.payload };
    }
    case 'SUB_END': {
      w.i64(frame.nextCursor);
      w.opt(frame.bootstrapState, (v) => w.str(v));
      return { frameType: FrameType.SUB_END, payload: w.finish() };
    }
    case 'ERROR': {
      w.str(frame.code);
      w.str(frame.message);
      w.str(frame.category);
      w.bool(frame.retryable);
      w.str(frame.recommendedAction);
      w.opt(frame.details, (v) => w.str(v));
      return { frameType: FrameType.ERROR, payload: w.finish() };
    }
    case 'UNKNOWN': {
      if (
        !Number.isInteger(frame.frameType) ||
        frame.frameType < 0 ||
        frame.frameType > 0xff ||
        KNOWN_FRAME_TYPES.has(frame.frameType)
      ) {
        throw new Error(
          `UNKNOWN frame type ${frame.frameType} collides with a defined frame type`,
        );
      }
      return { frameType: frame.frameType, payload: frame.payload };
    }
  }
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export function encodeMessage(message: SyncMessage): Uint8Array {
  if (message.wireVersion !== PROTOCOL_WIRE_VERSION) {
    throw new Error(`unsupported wireVersion ${message.wireVersion}`);
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
  if (wireVersion !== PROTOCOL_WIRE_VERSION) {
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
      frames: readFrames(r, decodeRequestFrame),
    };
    validateRequestSequence(message.frames);
    return message;
  }
  const message: ResponseMessage = {
    wireVersion,
    msgKind: 'response',
    frames: readFrames(r, decodeResponseFrame),
  };
  validateResponseSequence(message.frames);
  return message;
}
