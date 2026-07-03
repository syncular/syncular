/**
 * Golden vector generator (SPEC.md Appendix A; spec/vectors/README.md).
 *
 * Generates every vector via the reference codec — never hand-hexed.
 * Invalid cases are built from the codec's own primitives (ByteWriter,
 * frame helpers) or by deterministic mutation of valid codec output.
 * Fully deterministic: all timestamps are fixed constants.
 *
 * Run from packages/core: `bun run generate:vectors`
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ByteWriter,
  canonicalScopeJson,
  encodeMessage,
  encodeRow,
  encodeRowsSegment,
  FrameType,
  type JsonValue,
  type RequestMessage,
  type ResponseMessage,
  type RowColumn,
  type RowValue,
  renderMessage,
  renderRowsSegment,
  utf8Encode,
} from '../src/index';

const vectorsDir = resolve(import.meta.dir, '../../../spec/vectors');

/** 2026-07-02T12:00:00Z — the sole timestamp base in the vector set. */
const FIXED_TIME_MS = Date.UTC(2026, 6, 2, 12, 0, 0);
const URL_TTL_MS = 15 * 60 * 1000;

/** Test schema exercising every §2.4 column type. */
const NOTES_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: true },
  { name: 'body', type: 'string', nullable: false },
  { name: 'count', type: 'integer', nullable: true },
  { name: 'score', type: 'float', nullable: false },
  { name: 'done', type: 'boolean', nullable: false },
  { name: 'meta', type: 'json', nullable: true },
  { name: 'blob', type: 'bytes', nullable: true },
];

// Edge-case row: non-BMP unicode (emoji + musical symbol), empty string
// (distinct from NULL), NULL integer/bytes, json raw string with
// non-canonical spacing that must survive round-trips verbatim.
const ROW_EDGE: readonly RowValue[] = [
  'n-1',
  '📝 déjà vu \u{1D11E}',
  '',
  null,
  3.5,
  true,
  '{"tags": ["a", "b"],  "unicode": "\u{1D518}"}',
  null,
];

// Every column non-null except title; negative integer, bytes payload.
const ROW_FULL: readonly RowValue[] = [
  'n-2',
  null,
  'plain body',
  -7,
  0.125,
  false,
  '{"k":true}',
  new Uint8Array([0, 1, 2, 254, 255]),
];

// i64 safe-integer boundary and empty (non-NULL) bytes.
const ROW_BOUNDARY: readonly RowValue[] = [
  'n-3',
  'ζ',
  'boundary',
  9007199254740991,
  -1.5,
  true,
  null,
  new Uint8Array(0),
];

const rowEdgeBytes = encodeRow(NOTES_COLUMNS, ROW_EDGE);
const rowFullBytes = encodeRow(NOTES_COLUMNS, ROW_FULL);

const EFFECTIVE_SCOPES = { project: ['p1'] };
const scopeDigest = createHash('sha256')
  .update(canonicalScopeJson(EFFECTIVE_SCOPES), 'utf8')
  .digest('hex');

function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function signedUrl(segmentId: string): {
  url: string;
  urlExpiresAtMs: number;
} {
  const urlExpiresAtMs = FIXED_TIME_MS + URL_TTL_MS;
  const payloadJson = JSON.stringify({
    v: 1,
    seg: segmentId,
    sd: scopeDigest,
    aud: 'aud-7f3d9c',
    exp: Math.floor(urlExpiresAtMs / 1000),
  });
  const mac = createHmac('sha256', 'vector-signing-key')
    .update(payloadJson, 'utf8')
    .digest();
  const st = `${Buffer.from(payloadJson, 'utf8').toString('base64url')}.${mac.toString('base64url')}`;
  return {
    url: `https://segments.example.com/${segmentId}?st=${st}`,
    urlExpiresAtMs,
  };
}

// ---------------------------------------------------------------------------
// Valid request vectors
// ---------------------------------------------------------------------------

const pullMinimal: RequestMessage = {
  wireVersion: 1,
  msgKind: 'request',
  frames: [
    { type: 'REQ_HEADER', clientId: 'client-a', schemaVersion: 1 },
    {
      type: 'PULL_HEADER',
      limitCommits: 0,
      limitSnapshotRows: 0,
      maxSnapshotPages: 0,
      accept: 0b0011,
    },
    {
      type: 'SUBSCRIPTION',
      id: 'sub-notes',
      table: 'notes',
      scopes: { project: ['p1'] },
      cursor: 42,
    },
  ],
};

const pullBootstrap: RequestMessage = {
  wireVersion: 1,
  msgKind: 'request',
  frames: [
    { type: 'REQ_HEADER', clientId: 'client-a', schemaVersion: 2 },
    {
      type: 'PULL_HEADER',
      limitCommits: 500,
      limitSnapshotRows: 2000,
      maxSnapshotPages: 8,
      accept: 0b1111,
    },
    {
      type: 'SUBSCRIPTION',
      id: 'sub-notes',
      table: 'notes',
      scopes: { project: ['p1', 'p2'], team: ['t9'] },
      params: '{"includeArchived": false}',
      cursor: -1,
    },
    {
      type: 'SUBSCRIPTION',
      id: 'sub-tasks',
      table: 'tasks',
      scopes: { project: ['p1'] },
      cursor: 100,
      bootstrapState:
        '{"asOfCommitSeq":100,"tables":["projects","tasks"],"tableIndex":1,"rowCursor":"task-0500"}',
    },
  ],
};

const pushMultiCommit: RequestMessage = {
  wireVersion: 1,
  msgKind: 'request',
  frames: [
    { type: 'REQ_HEADER', clientId: 'client-a', schemaVersion: 1 },
    {
      type: 'PUSH_COMMIT',
      clientCommitId: 'c-0001',
      operations: [
        {
          table: 'notes',
          rowId: 'n-1',
          op: 'upsert',
          baseVersion: 3,
          payload: rowEdgeBytes,
        },
        {
          table: 'notes',
          rowId: 'n-2',
          op: 'upsert',
          payload: rowFullBytes,
        },
      ],
    },
    {
      type: 'PUSH_COMMIT',
      clientCommitId: 'c-0002',
      operations: [{ table: 'notes', rowId: 'n-3', op: 'delete' }],
    },
  ],
};

const combined: RequestMessage = {
  wireVersion: 1,
  msgKind: 'request',
  frames: [
    { type: 'REQ_HEADER', clientId: 'client-a', schemaVersion: 1 },
    {
      type: 'PUSH_COMMIT',
      clientCommitId: 'c-0003',
      operations: [
        {
          table: 'notes',
          rowId: 'n-2',
          op: 'upsert',
          baseVersion: 1,
          payload: rowFullBytes,
        },
      ],
    },
    {
      type: 'PULL_HEADER',
      limitCommits: 0,
      limitSnapshotRows: 0,
      maxSnapshotPages: 0,
      accept: 0b0111,
    },
    {
      type: 'SUBSCRIPTION',
      id: 'sub-notes',
      table: 'notes',
      scopes: { project: ['p1'] },
      cursor: 42,
    },
  ],
};

// ---------------------------------------------------------------------------
// Valid response vectors
// ---------------------------------------------------------------------------

const pullEmpty: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER' },
    {
      type: 'SUB_START',
      id: 'sub-notes',
      status: 'active',
      reasonCode: '',
      effectiveScopes: EFFECTIVE_SCOPES,
      bootstrap: false,
    },
    { type: 'SUB_END', nextCursor: 57 },
  ],
};

const commitsIncremental: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER' },
    {
      type: 'SUB_START',
      id: 'sub-notes',
      status: 'active',
      reasonCode: '',
      effectiveScopes: EFFECTIVE_SCOPES,
      bootstrap: false,
    },
    {
      type: 'COMMIT',
      commitSeq: 43,
      createdAtMs: FIXED_TIME_MS,
      actorId: 'actor-1',
      tables: ['notes'],
      changes: [
        {
          tableIndex: 0,
          rowId: 'n-2',
          op: 'upsert',
          rowVersion: 1,
          scopes: { project: 'p1' },
          row: rowFullBytes,
        },
      ],
    },
    {
      type: 'COMMIT',
      commitSeq: 44,
      createdAtMs: FIXED_TIME_MS + 1000,
      actorId: 'actor-2',
      tables: ['notes', 'tasks'],
      changes: [
        {
          tableIndex: 0,
          rowId: 'n-1',
          op: 'upsert',
          rowVersion: 4,
          scopes: { project: 'p1' },
          row: rowEdgeBytes,
        },
        {
          tableIndex: 1,
          rowId: 'task-9',
          op: 'delete',
          scopes: { project: 'p1' },
        },
      ],
    },
    { type: 'SUB_END', nextCursor: 44 },
  ],
};

const inlineSegment = encodeRowsSegment({
  table: 'notes',
  schemaVersion: 1,
  columns: NOTES_COLUMNS,
  blocks: [[{ serverVersion: 5, values: ROW_BOUNDARY }]],
});

const sqliteSegmentId = `sha256:${sha256Hex('syncular-v2-vector:sqlite-segment')}`;
const rowsSegmentId = `sha256:${sha256Hex(inlineSegment)}`;
const sqliteUrl = signedUrl(sqliteSegmentId);

const bootstrapSegments: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER' },
    {
      type: 'SUB_START',
      id: 'sub-notes',
      status: 'active',
      reasonCode: '',
      effectiveScopes: EFFECTIVE_SCOPES,
      bootstrap: true,
    },
    {
      type: 'SEGMENT_REF',
      segmentId: sqliteSegmentId,
      mediaType: 'sqlite',
      table: 'notes',
      byteLength: 8192,
      rowCount: 250,
      asOfCommitSeq: 100,
      scopeDigest,
      nextRowCursor: 'n-0250',
      url: sqliteUrl.url,
      urlExpiresAtMs: sqliteUrl.urlExpiresAtMs,
    },
    {
      type: 'SEGMENT_REF',
      segmentId: rowsSegmentId,
      mediaType: 'rows',
      table: 'notes',
      byteLength: inlineSegment.length,
      rowCount: 1,
      asOfCommitSeq: 100,
      scopeDigest,
      rowCursor: 'n-0250',
    },
    { type: 'SEGMENT_INLINE', payload: inlineSegment },
    {
      type: 'SUB_END',
      nextCursor: 100,
      bootstrapState:
        '{"asOfCommitSeq":100,"tables":["notes"],"tableIndex":0,"rowCursor":"n-0251"}',
    },
  ],
};

const pushApplied: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER' },
    {
      type: 'PUSH_RESULT',
      clientCommitId: 'c-0001',
      status: 'applied',
      commitSeq: 58,
      results: [
        { opIndex: 0, status: 'applied' },
        { opIndex: 1, status: 'applied' },
      ],
    },
  ],
};

const pushConflict: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER' },
    {
      type: 'PUSH_RESULT',
      clientCommitId: 'c-0002',
      status: 'rejected',
      results: [
        {
          opIndex: 0,
          status: 'conflict',
          code: 'sync.version_conflict',
          message: 'baseVersion 3 does not match server_version 7',
          serverVersion: 7,
          serverRow: rowFullBytes,
        },
      ],
    },
  ],
};

const pushCached: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER' },
    {
      type: 'PUSH_RESULT',
      clientCommitId: 'c-0001',
      status: 'cached',
      commitSeq: 58,
      results: [
        { opIndex: 0, status: 'applied' },
        { opIndex: 1, status: 'applied' },
      ],
    },
  ],
};

const subscriptionRevoked: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER' },
    {
      type: 'SUB_START',
      id: 'sub-notes',
      status: 'revoked',
      reasonCode: 'sync.scope_revoked',
      effectiveScopes: {},
      bootstrap: false,
    },
    { type: 'SUB_END', nextCursor: 42 },
  ],
};

const cursorReset: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER' },
    {
      type: 'SUB_START',
      id: 'sub-notes',
      status: 'reset',
      reasonCode: 'sync.cursor_expired',
      effectiveScopes: {},
      bootstrap: false,
    },
    { type: 'SUB_END', nextCursor: 42 },
  ],
};

const errorMidStream: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER' },
    {
      type: 'SUB_START',
      id: 'sub-notes',
      status: 'active',
      reasonCode: '',
      effectiveScopes: EFFECTIVE_SCOPES,
      bootstrap: false,
    },
    {
      type: 'ERROR',
      code: 'sync.missing_scopes',
      message: 'handler emitted a change without stored scopes',
      category: 'internal',
      retryable: false,
      recommendedAction: 'inspectServer',
      details: '{"table": "notes"}',
    },
  ],
};

const unknownFrameSkip: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER' },
    {
      type: 'SUB_START',
      id: 'sub-notes',
      status: 'active',
      reasonCode: '',
      effectiveScopes: EFFECTIVE_SCOPES,
      bootstrap: false,
    },
    {
      // 0x17 is reserved (commit-chain integrity, SPEC.md §0); a wire-v1
      // reader must skip it via the length prefix (§1.2 rule 2, §9).
      type: 'UNKNOWN',
      frameType: 0x17,
      payload: utf8Encode('reserved-frame-payload'),
    },
    { type: 'SUB_END', nextCursor: 45 },
  ],
};

const schemaFloor: ResponseMessage = {
  wireVersion: 1,
  msgKind: 'response',
  frames: [
    { type: 'RESP_HEADER', requiredSchemaVersion: 3, latestSchemaVersion: 5 },
  ],
};

// ---------------------------------------------------------------------------
// Valid segment vector
// ---------------------------------------------------------------------------

// Per-row serverVersion (§5.2): deterministic, varied, incl. the i64
// safe-integer boundary.
const rowsTwoBlocks = encodeRowsSegment({
  table: 'notes',
  schemaVersion: 1,
  columns: NOTES_COLUMNS,
  blocks: [
    [
      { serverVersion: 7, values: ROW_FULL },
      { serverVersion: 4, values: ROW_EDGE },
    ],
    [{ serverVersion: 9007199254740991, values: ROW_BOUNDARY }],
  ],
});

// ---------------------------------------------------------------------------
// Realtime control vectors (JSON only — no binary form)
// ---------------------------------------------------------------------------

const realtimeHello = {
  event: 'hello',
  data: {
    protocolVersion: 1,
    sessionId: 'sess-0001',
    actorId: 'actor-1',
    clientId: 'client-a',
    cursor: 57,
    latestCursor: 64,
    requiresSync: true,
    timestamp: FIXED_TIME_MS,
  },
};

const realtimeWake = {
  event: 'sync',
  data: {
    cursor: 64,
    requiresPull: true,
    reason: 'catchup-required',
    timestamp: FIXED_TIME_MS,
  },
};

// ---------------------------------------------------------------------------
// Invalid cases — built from codec primitives or by deterministic mutation
// of valid codec output (never hand-hexed).
// ---------------------------------------------------------------------------

function frameInto(
  w: ByteWriter,
  frameType: number,
  build: (p: ByteWriter) => void,
): void {
  const p = new ByteWriter();
  build(p);
  const payload = p.finish();
  w.u8(frameType);
  w.u32(payload.length);
  w.raw(payload);
}

function envelopeHeader(w: ByteWriter, msgKind: number): void {
  w.raw(utf8Encode('SSP2'));
  w.u16(1);
  w.u8(msgKind);
  w.u8(0);
}

function endFrame(w: ByteWriter): void {
  w.u8(FrameType.END);
  w.u32(0);
}

const pullMinimalBytes = encodeMessage(pullMinimal);

// Truncated envelope: the terminating END frame (5 bytes) is missing.
const invalidTruncatedNoEnd = pullMinimalBytes.slice(
  0,
  pullMinimalBytes.length - 5,
);

// Bad magic: SSP2 -> SSP1.
const invalidBadMagic = pullMinimalBytes.slice();
invalidBadMagic[3] = 0x31;

// Unsupported wireVersion 999.
const invalidWireVersion = pullMinimalBytes.slice();
new DataView(invalidWireVersion.buffer).setUint16(4, 999, true);

// Non-zero envelope flags.
const invalidFlags = pullMinimalBytes.slice();
invalidFlags[7] = 0x01;

// Frame length exceeding the remaining bytes.
const invalidOverlongFrame = (() => {
  const w = new ByteWriter();
  envelopeHeader(w, 0x01);
  w.u8(FrameType.REQ_HEADER);
  w.u32(4096);
  w.raw(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
  return w.finish();
})();

// Push operation op byte 3 (only 1 = upsert, 2 = delete are defined).
const invalidOpEnum = (() => {
  const w = new ByteWriter();
  envelopeHeader(w, 0x01);
  frameInto(w, FrameType.REQ_HEADER, (p) => {
    p.str('client-a');
    p.i32(1);
  });
  frameInto(w, FrameType.PUSH_COMMIT, (p) => {
    p.str('c-bad');
    p.u32(1);
    p.str('notes');
    p.str('n-1');
    p.u8(3); // invalid op enum byte
    p.u8(0); // baseVersion absent
    p.u8(1); // payload present
    p.bytes(rowFullBytes);
  });
  endFrame(w);
  return w.finish();
})();

// Upsert operation with the payload option absent (§6.1 presence invariant).
const invalidUpsertNoPayload = (() => {
  const w = new ByteWriter();
  envelopeHeader(w, 0x01);
  frameInto(w, FrameType.REQ_HEADER, (p) => {
    p.str('client-a');
    p.i32(1);
  });
  frameInto(w, FrameType.PUSH_COMMIT, (p) => {
    p.str('c-bad');
    p.u32(1);
    p.str('notes');
    p.str('n-1');
    p.u8(1); // upsert
    p.u8(0); // baseVersion absent
    p.u8(0); // payload absent — violation
  });
  endFrame(w);
  return w.finish();
})();

// SUB_START.bootstrap bool byte 0x02 (only 0x00 / 0x01 are legal).
const invalidBoolByte = (() => {
  const w = new ByteWriter();
  envelopeHeader(w, 0x02);
  frameInto(w, FrameType.RESP_HEADER, (p) => {
    p.u8(0);
    p.u8(0);
  });
  frameInto(w, FrameType.SUB_START, (p) => {
    p.str('sub-notes');
    p.u8(1); // active
    p.str('');
    p.u32(0); // empty effectiveScopes map
    p.u8(2); // invalid bool byte
  });
  endFrame(w);
  return w.finish();
})();

// Rows segment with a null bit set on a non-nullable column.
const invalidNullBit = (() => {
  const w = new ByteWriter();
  w.raw(utf8Encode('SSG2'));
  w.u16(1);
  w.u16(0);
  w.str('notes');
  w.i32(1);
  w.u16(2);
  w.str('id');
  w.u8(1); // string
  w.u8(0); // non-nullable
  w.str('note');
  w.u8(1); // string
  w.u8(1); // nullable
  const row = new ByteWriter();
  row.i64(2); // serverVersion (valid, ≥ 1)
  row.u8(0b01); // null bit on column 0 (id, non-nullable) — violation
  row.str('x'); // note value
  const rowBytes = row.finish();
  w.u32(1);
  w.u32(rowBytes.length);
  w.raw(rowBytes);
  w.u32(0);
  return w.finish();
})();

// Rows segment truncated before its mandatory end marker.
const invalidMissingEndMarker = rowsTwoBlocks.slice(
  0,
  rowsTwoBlocks.length - 4,
);

// Rows segment whose json column value does not parse as a JSON document
// (§2.4 tag 5: the Conventions `json` MUST applies at row-codec decode).
const invalidJsonColumn = (() => {
  const w = new ByteWriter();
  w.raw(utf8Encode('SSG2'));
  w.u16(1);
  w.u16(0);
  w.str('notes');
  w.i32(1);
  w.u16(2);
  w.str('id');
  w.u8(1); // string
  w.u8(0); // non-nullable
  w.str('meta');
  w.u8(5); // json
  w.u8(1); // nullable
  const row = new ByteWriter();
  row.i64(2); // serverVersion (valid, ≥ 1)
  row.u8(0); // no nulls
  row.str('n-1');
  row.str('{not json'); // json column value that does not parse — violation
  const rowBytes = row.finish();
  w.u32(1);
  w.u32(rowBytes.length);
  w.raw(rowBytes);
  w.u32(0);
  return w.finish();
})();

// Rows segment whose row record carries serverVersion 0 (§5.2: MUST be ≥ 1).
const invalidServerVersionZero = (() => {
  const w = new ByteWriter();
  w.raw(utf8Encode('SSG2'));
  w.u16(1);
  w.u16(0);
  w.str('notes');
  w.i32(1);
  w.u16(1);
  w.str('id');
  w.u8(1); // string
  w.u8(0); // non-nullable
  const row = new ByteWriter();
  row.i64(0); // serverVersion 0 — violation
  row.u8(0); // no nulls
  row.str('n-1');
  const rowBytes = row.finish();
  w.u32(1);
  w.u32(rowBytes.length);
  w.raw(rowBytes);
  w.u32(0);
  return w.finish();
})();

// Realtime invalid cases (.json only — malformed *known* events; unknown
// event names are tolerated per §8.1 and are not invalid cases).
const invalidWakeRequiresPullFalse = {
  event: 'sync',
  data: {
    cursor: 64,
    requiresPull: false, // must be the literal true (§8.3) — violation
    reason: 'catchup-required',
    timestamp: FIXED_TIME_MS,
  },
};

const invalidHelloFractionalCursor = {
  event: 'hello',
  data: {
    protocolVersion: 1,
    sessionId: 'sess-0001',
    actorId: 'actor-1',
    clientId: 'client-a',
    cursor: 57.5, // realtime numbers are integers in the i64 safe range (§8.1)
    latestCursor: 64,
    requiresSync: true,
    timestamp: FIXED_TIME_MS,
  },
};

// ---------------------------------------------------------------------------
// File emission
// ---------------------------------------------------------------------------

interface BinaryCase {
  name: string;
  bytes: Uint8Array;
  render: (bytes: Uint8Array) => JsonValue;
  covers: string;
}

interface JsonCase {
  name: string;
  value: unknown;
  covers: string;
}

interface InvalidCase {
  name: string;
  bytes: Uint8Array;
  error: string;
  covers: string;
}

/** JSON-only invalid case (realtime): the text must fail control parsing. */
interface JsonInvalidCase {
  name: string;
  value: unknown;
  error: string;
  covers: string;
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function emitKind(
  kind: string,
  cases: BinaryCase[],
  jsonCases: JsonCase[],
  invalid: InvalidCase[],
  jsonInvalid: JsonInvalidCase[] = [],
): number {
  const kindDir = join(vectorsDir, kind);
  rmSync(kindDir, { recursive: true, force: true });
  mkdirSync(kindDir, { recursive: true });
  if (invalid.length > 0 || jsonInvalid.length > 0) {
    mkdirSync(join(kindDir, 'invalid'));
  }

  const manifestCases: Array<Record<string, string>> = [];
  for (const c of cases) {
    writeFileSync(join(kindDir, `${c.name}.bin`), c.bytes);
    writeFileSync(join(kindDir, `${c.name}.json`), jsonText(c.render(c.bytes)));
    manifestCases.push({
      name: c.name,
      bin: `${c.name}.bin`,
      json: `${c.name}.json`,
      covers: c.covers,
    });
  }
  for (const c of jsonCases) {
    writeFileSync(join(kindDir, `${c.name}.json`), jsonText(c.value));
    manifestCases.push({
      name: c.name,
      json: `${c.name}.json`,
      covers: c.covers,
    });
  }
  const manifestInvalid: Array<Record<string, string>> = invalid.map((c) => {
    writeFileSync(join(kindDir, 'invalid', `${c.name}.bin`), c.bytes);
    return {
      name: c.name,
      bin: `invalid/${c.name}.bin`,
      error: c.error,
      covers: c.covers,
    };
  });
  for (const c of jsonInvalid) {
    writeFileSync(
      join(kindDir, 'invalid', `${c.name}.json`),
      jsonText(c.value),
    );
    manifestInvalid.push({
      name: c.name,
      json: `invalid/${c.name}.json`,
      error: c.error,
      covers: c.covers,
    });
  }

  writeFileSync(
    join(kindDir, 'manifest.json'),
    jsonText({
      kind,
      generatedBy: 'packages/core/scripts/generate-vectors.ts',
      cases: manifestCases,
      invalid: manifestInvalid,
    }),
  );
  return manifestCases.length + manifestInvalid.length;
}

let total = 0;

total += emitKind(
  'request',
  [
    {
      name: 'pull-minimal',
      bytes: pullMinimalBytes,
      render: renderMessage,
      covers:
        'Smallest legal request: header + pull + one caught-up subscription',
    },
    {
      name: 'pull-bootstrap',
      bytes: encodeMessage(pullBootstrap),
      render: renderMessage,
      covers:
        'cursor = -1, accept bits incl. sqlite + signed URLs, params, resumed bootstrapState round-trip',
    },
    {
      name: 'push-multi-commit',
      bytes: encodeMessage(pushMultiCommit),
      render: renderMessage,
      covers:
        'Two commits: upsert with baseVersion, delete, row-codec payload edge cases (NULL bitmap, empty string, non-BMP unicode, json-typed column raw-string round-trip)',
    },
    {
      name: 'combined',
      bytes: encodeMessage(combined),
      render: renderMessage,
      covers: 'Push + pull in one envelope (SPEC.md §1.5 ordering)',
    },
  ],
  [],
  [
    {
      name: 'truncated-no-end',
      bytes: invalidTruncatedNoEnd,
      error: 'sync.invalid_request',
      covers: 'Truncated envelope: body ends without an END frame',
    },
    {
      name: 'bad-magic',
      bytes: invalidBadMagic,
      error: 'sync.invalid_request',
      covers: 'Envelope magic is SSP1, not SSP2',
    },
    {
      name: 'unsupported-wire-version',
      bytes: invalidWireVersion,
      error: 'sync.invalid_request',
      covers: 'wireVersion 999 is rejected before reading frames',
    },
    {
      name: 'nonzero-flags',
      bytes: invalidFlags,
      error: 'sync.invalid_request',
      covers: 'Envelope flags byte must be 0x00',
    },
    {
      name: 'overlong-frame-length',
      bytes: invalidOverlongFrame,
      error: 'sync.invalid_request',
      covers: 'Frame length prefix exceeds the remaining bytes',
    },
    {
      name: 'op-enum-out-of-range',
      bytes: invalidOpEnum,
      error: 'sync.invalid_request',
      covers: 'Push operation op byte 3 (unknown enum byte)',
    },
    {
      name: 'upsert-without-payload',
      bytes: invalidUpsertNoPayload,
      error: 'sync.invalid_request',
      covers: 'Upsert operation with absent payload (presence invariant)',
    },
  ],
);

total += emitKind(
  'response',
  [
    {
      name: 'pull-empty',
      bytes: encodeMessage(pullEmpty),
      render: renderMessage,
      covers:
        'Active subscription, zero commits, cursor advanced anyway (SPEC.md §4.5)',
    },
    {
      name: 'commits-incremental',
      bytes: encodeMessage(commitsIncremental),
      render: renderMessage,
      covers:
        'Two COMMIT frames; row codec exercising every column type incl. NULLs, bytes, non-BMP strings; scope map on changes',
    },
    {
      name: 'bootstrap-segments',
      bytes: encodeMessage(bootstrapSegments),
      render: renderMessage,
      covers:
        'SEGMENT_REF (sqlite, with signed URL) + SEGMENT_REF (rows, no URL) + SEGMENT_INLINE; incomplete bootstrapState in SUB_END',
    },
    {
      name: 'push-applied',
      bytes: encodeMessage(pushApplied),
      render: renderMessage,
      covers: 'All-applied result with commitSeq',
    },
    {
      name: 'push-conflict',
      bytes: encodeMessage(pushConflict),
      render: renderMessage,
      covers: 'Rejected commit; conflict record with serverVersion + serverRow',
    },
    {
      name: 'push-cached',
      bytes: encodeMessage(pushCached),
      render: renderMessage,
      covers: 'Idempotent replay: status = cached, original results',
    },
    {
      name: 'subscription-revoked',
      bytes: encodeMessage(subscriptionRevoked),
      render: renderMessage,
      covers:
        'SUB_START status revoked, reason sync.scope_revoked, empty effective scopes',
    },
    {
      name: 'cursor-reset',
      bytes: encodeMessage(cursorReset),
      render: renderMessage,
      covers:
        'SUB_START status reset, reason sync.cursor_expired (horizon signal)',
    },
    {
      name: 'error-mid-stream',
      bytes: encodeMessage(errorMidStream),
      render: renderMessage,
      covers:
        'RESP_HEADER + SUB_START + ERROR + END: partially streamed failure (SPEC.md §1.4 abort rule)',
    },
    {
      name: 'unknown-frame-skip',
      bytes: encodeMessage(unknownFrameSkip),
      render: renderMessage,
      covers:
        'A reserved/unknown frame type between known frames — MUST decode with the frame skipped (SPEC.md §9)',
    },
    {
      name: 'schema-floor',
      bytes: encodeMessage(schemaFloor),
      render: renderMessage,
      covers: 'requiredSchemaVersion present',
    },
  ],
  [],
  [
    {
      name: 'bool-byte-out-of-range',
      bytes: invalidBoolByte,
      error: 'sync.invalid_request',
      covers: 'SUB_START.bootstrap bool byte 0x02',
    },
  ],
);

total += emitKind(
  'segment',
  [
    {
      name: 'rows-two-blocks',
      bytes: rowsTwoBlocks,
      render: renderRowsSegment,
      covers:
        'SSG2 with two row blocks + end marker, all column types, nullable columns, varied per-row serverVersion incl. the i64 safe-integer boundary',
    },
  ],
  [],
  [
    {
      name: 'null-bit-on-non-nullable',
      bytes: invalidNullBit,
      error: 'sync.invalid_request',
      covers: 'Null bitmap bit set for a non-nullable column',
    },
    {
      name: 'missing-end-marker',
      bytes: invalidMissingEndMarker,
      error: 'sync.invalid_request',
      covers:
        'Rows segment truncated before the mandatory rowCount = 0 end marker',
    },
    {
      name: 'json-column-not-json',
      bytes: invalidJsonColumn,
      error: 'sync.invalid_request',
      covers:
        'json column value that does not parse as a JSON document (SPEC.md §2.4 tag 5)',
    },
    {
      name: 'server-version-zero',
      bytes: invalidServerVersionZero,
      error: 'sync.invalid_request',
      covers: 'Row record serverVersion 0 — must be ≥ 1 (SPEC.md §5.2)',
    },
  ],
);

total += emitKind(
  'realtime',
  [],
  [
    {
      name: 'hello',
      value: realtimeHello,
      covers: 'Connect handshake control message (SPEC.md §8.1)',
    },
    {
      name: 'wake',
      value: realtimeWake,
      covers: 'Wake-up control message (SPEC.md §8.3)',
    },
  ],
  [],
  [
    {
      name: 'wake-requires-pull-false',
      value: invalidWakeRequiresPullFalse,
      error: 'sync.invalid_request',
      covers:
        'sync event with requiresPull !== literal true is malformed (SPEC.md §8.3)',
    },
    {
      name: 'hello-fractional-cursor',
      value: invalidHelloFractionalCursor,
      error: 'sync.invalid_request',
      covers:
        'Fractional numeric field in a known event is malformed — realtime numbers are integers within the i64 safe range (SPEC.md §8.1)',
    },
  ],
);

console.log(`generated ${total} vector cases under ${vectorsDir}`);
