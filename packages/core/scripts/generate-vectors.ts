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
  canonicalUnitJson,
  type CommitFrame,
  echoDigest,
  encodeMessage,
  encodeRow,
  encodeRowsSegment,
  encodeSparseRow,
  type FencedRecord,
  FrameType,
  type JsonValue,
  type PullHeaderFrame,
  registrationDigest,
  type RequestMessage,
  type RespHeaderFrame,
  type ResponseFrame,
  type ResponseMessage,
  type RowColumn,
  type RowValue,
  renderMessage,
  renderRowsSegment,
  renderSparseRowValue,
  type SparseRowValue,
  type UnitEcho,
  type UnitScopes,
  decodeSparseRow,
  serializeBlobRef,
  unitId,
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
// Wire version 3: push payloads are sparse rows (§2.4). The push request
// vectors carry these; COMMIT changes and conflict serverRow stay full-row.
const rowEdgeSparseBytes = encodeSparseRow(NOTES_COLUMNS, 0, ROW_EDGE);
const rowFullSparseBytes = encodeSparseRow(NOTES_COLUMNS, 0, ROW_FULL);

// CRDT column (§2.4 tag 8, §5.10). A dedicated fixture so the new tag is
// byte-pinned WITHOUT touching NOTES_COLUMNS (existing vectors stay
// byte-identical). `crdtType` is IR metadata, never on the wire.
const DOCS_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'doc', type: 'crdt', nullable: true, crdtType: 'yjs-doc' },
];

// A merged crdt value (opaque bytes — the codec never parses it), plus a
// NULL crdt (empty document) and an empty (non-NULL) crdt to exercise the
// bytes framing edges.
const DOC_MERGED: readonly RowValue[] = [
  'd-1',
  'shared note',
  new Uint8Array([0x01, 0x02, 0xfe, 0xff, 0x00, 0x2a]),
];
const DOC_EMPTY_CRDT: readonly RowValue[] = ['d-2', 'fresh', new Uint8Array(0)];
const DOC_NULL_CRDT: readonly RowValue[] = ['d-3', 'no doc yet', null];

const docMergedBytes = encodeRow(DOCS_COLUMNS, DOC_MERGED);

// RFC §6.1 sparse-row fixture: every §2.4 column type across 9 columns, so
// the presence bitmap spans two bytes and both bitmaps carry padding bits.
const SPARSE_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: true },
  { name: 'body', type: 'string', nullable: false },
  { name: 'count', type: 'integer', nullable: true },
  { name: 'score', type: 'float', nullable: false },
  { name: 'done', type: 'boolean', nullable: false },
  { name: 'meta', type: 'json', nullable: true },
  { name: 'blob', type: 'bytes', nullable: true },
  { name: 'doc', type: 'crdt', nullable: true, crdtType: 'yjs-doc' },
];
const SPARSE_PRIMARY_KEY = 'id';
const SPARSE_PRIMARY_KEY_INDEX = SPARSE_COLUMNS.findIndex(
  (column) => column.name === SPARSE_PRIMARY_KEY,
);

// A partial payload: id, a present-NULL title, and meta. count, score, done,
// blob, and doc are absent, so the server leaves their stored values alone.
const SPARSE_PARTIAL: readonly SparseRowValue[] = [
  'n-1',
  null,
  undefined,
  undefined,
  undefined,
  undefined,
  '{"tags": ["a"]}',
  undefined,
  undefined,
];

// Every presence bit set: the full-row special case (still byte-different
// from the full-row codec, which has no presence bitmap).
const SPARSE_FULL: readonly SparseRowValue[] = [
  'n-2',
  null,
  'body',
  -7,
  0.125,
  false,
  '{"k":true}',
  new Uint8Array([0, 1, 254, 255]),
  new Uint8Array([0x01, 0x02, 0xfe]),
];

/** §11 rule 11: the sparse payloads render through the codec itself. */
function renderSparseRow(bytes: Uint8Array): JsonValue {
  return renderSparseRowValue(
    SPARSE_COLUMNS,
    decodeSparseRow(SPARSE_COLUMNS, SPARSE_PRIMARY_KEY_INDEX, bytes),
  );
}

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
// Units, registration and echo (§4.1, §4.4)
// ---------------------------------------------------------------------------

const UNIT_NOTES = { project: 'p1' };
const UNIT_TEAM = { project: 'p1', team: 't9' };
const NOTES_ID = unitId(UNIT_NOTES);
const TEAM_ID = unitId(UNIT_TEAM);
const REGISTRATION = registrationDigest([UNIT_NOTES, UNIT_TEAM]);
/** The echo of both units: the wildcard fence added `assignee` to the notes
 * unit on `tasks` (§3.2 rule 4). */
const NOTES_ECHO: FencedRecord[] = [
  { table: 'tasks', status: 'active', scopes: { assignee: ['u1', 'u2'] } },
];
const ECHO = echoDigest([
  { id: NOTES_ID, status: 'active', fenced: NOTES_ECHO },
  { id: TEAM_ID, status: 'active', fenced: [] },
]);
const NO_DIGEST = new Uint8Array(0);

function pullHeader(fields: Partial<PullHeaderFrame> = {}): PullHeaderFrame {
  return {
    type: 'PULL_HEADER',
    limitCommits: 0,
    limitSnapshotRows: 0,
    maxSnapshotPages: 0,
    accept: 0b0011,
    cursor: 42,
    registrationDigest: REGISTRATION,
    echoDigest: ECHO,
    ...fields,
  };
}

const RESP_HEADER: RespHeaderFrame = {
  type: 'RESP_HEADER',
  logEpoch: 'epoch-2026-07-02-a',
  resetRequired: false,
};

/** A whole live section (§4.4, §4.5). */
function live(
  throughSeq: number,
  commits: CommitFrame[] = [],
  echo: Uint8Array = ECHO,
): ResponseFrame[] {
  return [
    { type: 'LIVE_START', status: 'active', reasonCode: '' },
    ...commits,
    { type: 'LIVE_END', throughSeq, echoDigest: echo },
  ];
}

// ---------------------------------------------------------------------------
// Valid request vectors
// ---------------------------------------------------------------------------

// Steady state: the list is referenced by digest, every unit is live.
const pullMinimal: RequestMessage = {
  wireVersion: 4,
  msgKind: 'request',
  frames: [
    { type: 'REQ_HEADER', clientId: 'client-a', schemaVersion: 1 },
    pullHeader(),
  ],
};

// The list travels: a fresh bootstrap and a resumed one.
const pullBootstrap: RequestMessage = {
  wireVersion: 4,
  msgKind: 'request',
  frames: [
    {
      type: 'REQ_HEADER',
      clientId: 'client-a',
      schemaVersion: 2,
      outboxId: 'outbox-7d1c',
    },
    pullHeader({
      limitCommits: 500,
      limitSnapshotRows: 2000,
      maxSnapshotPages: 8,
      accept: 0b1111,
      cursor: -1,
      echoDigest: NO_DIGEST,
    }),
    { type: 'UNIT', scopes: UNIT_NOTES },
    { type: 'UNIT', scopes: UNIT_TEAM },
    { type: 'PROGRESS', id: NOTES_ID, cursor: -1 },
    {
      type: 'PROGRESS',
      id: TEAM_ID,
      cursor: 100,
      bootstrapState:
        '{"asOfCommitSeq":100,"tables":["projects","tasks"],"tableIndex":1,"rowCursor":"task-0500"}',
    },
  ],
};

const pushMultiCommit: RequestMessage = {
  wireVersion: 4,
  msgKind: 'request',
  frames: [
    {
      type: 'REQ_HEADER',
      clientId: 'client-a',
      schemaVersion: 1,
      logEpoch: 'epoch-2026-07-02-a',
      outboxId: 'outbox-7d1c',
    },
    {
      type: 'PUSH_COMMIT',
      clientCommitId: 'c-0001',
      clientSeq: 7,
      operations: [
        {
          table: 'notes',
          rowId: 'n-1',
          op: 'upsert',
          baseVersion: 3,
          payload: rowEdgeSparseBytes,
        },
        {
          table: 'notes',
          rowId: 'n-2',
          op: 'upsert',
          payload: rowFullSparseBytes,
        },
      ],
    },
    {
      type: 'PUSH_COMMIT',
      clientCommitId: 'c-0002',
      clientSeq: 8,
      operations: [{ table: 'notes', rowId: 'n-3', op: 'delete' }],
    },
  ],
};

// Push plus a referenced list with one post-bootstrap unit catching up.
const combined: RequestMessage = {
  wireVersion: 4,
  msgKind: 'request',
  frames: [
    {
      type: 'REQ_HEADER',
      clientId: 'client-a',
      schemaVersion: 1,
      logEpoch: 'epoch-2026-07-02-a',
      outboxId: 'outbox-7d1c',
    },
    {
      type: 'PUSH_COMMIT',
      clientCommitId: 'c-0003',
      clientSeq: 9,
      operations: [
        {
          table: 'notes',
          rowId: 'n-2',
          op: 'upsert',
          baseVersion: 1,
          payload: rowFullSparseBytes,
        },
      ],
    },
    pullHeader({ accept: 0b0111 }),
    { type: 'PROGRESS', id: TEAM_ID, cursor: 30 },
  ],
};

const epochBound: RequestMessage = {
  wireVersion: 4,
  msgKind: 'request',
  frames: [
    {
      type: 'REQ_HEADER',
      clientId: 'client-a',
      schemaVersion: 2,
      logEpoch: 'epoch-2026-07-02-a',
      outboxId: 'outbox-7d1c',
    },
    pullHeader({
      limitCommits: 500,
      limitSnapshotRows: 2000,
      maxSnapshotPages: 8,
      accept: 0b1111,
    }),
  ],
};

// §1.5: a request reporting the code of a round the server could not see
// fail. The frame sits immediately after REQ_HEADER.
const roundFailureReport: RequestMessage = {
  wireVersion: 4,
  msgKind: 'request',
  frames: [
    { type: 'REQ_HEADER', clientId: 'client-a', schemaVersion: 1 },
    { type: 'ROUND_FAILURE', code: 'sync.transport_failed' },
    pullHeader(),
  ],
};

// §4.1: the empty list's digest carries the empty list.
const emptyRegistration: RequestMessage = {
  wireVersion: 4,
  msgKind: 'request',
  frames: [
    {
      type: 'REQ_HEADER',
      clientId: 'client-a',
      schemaVersion: 1,
      logEpoch: 'epoch-2026-07-02-a',
      outboxId: 'outbox-7d1c',
    },
    pullHeader({
      cursor: -1,
      registrationDigest: registrationDigest([]),
      echoDigest: NO_DIGEST,
    }),
  ],
};

// §6.10: a database-less producer has no outbox.
const producerPush: RequestMessage = {
  wireVersion: 4,
  msgKind: 'request',
  frames: [
    {
      type: 'REQ_HEADER',
      clientId: 'producer-ingest',
      schemaVersion: 1,
      logEpoch: 'epoch-2026-07-02-a',
    },
    {
      type: 'PUSH_COMMIT',
      clientCommitId: 'ingest-0001',
      clientSeq: 0,
      operations: [
        {
          table: 'notes',
          rowId: 'n-9',
          op: 'upsert',
          baseVersion: 0,
          payload: rowFullSparseBytes,
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Valid response vectors
// ---------------------------------------------------------------------------

const pullEmpty: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [RESP_HEADER, ...live(57)],
};

const epochReset: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    {
      type: 'RESP_HEADER',
      logEpoch: 'epoch-2026-07-02-b',
      resetRequired: true,
    },
  ],
};

const commitsIncremental: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    ...live(44, [
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
            scopes: { assignee: 'u1', project: 'p1' },
          },
        ],
      },
    ]),
  ],
};

const inlineSegment = encodeRowsSegment({
  table: 'notes',
  schemaVersion: 1,
  columns: NOTES_COLUMNS,
  blocks: [[{ serverVersion: 5, values: ROW_BOUNDARY }]],
});

const sqliteSegmentId = `sha256:${sha256Hex('syncular-vector:sqlite-segment')}`;
const rowsSegmentId = `sha256:${sha256Hex(inlineSegment)}`;
const sqliteUrl = signedUrl(sqliteSegmentId);

// A catching-up unit's bootstrap section across two tables, then the live
// section of the replica's live units.
const bootstrapSegments: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    {
      type: 'SUB_START',
      id: NOTES_ID,
      status: 'active',
      reasonCode: '',
      bootstrap: true,
      fenced: NOTES_ECHO,
    },
    {
      type: 'SEGMENT_REF',
      segmentId: sqliteSegmentId,
      mediaType: 'sqlite',
      table: 'projects',
      byteLength: 8192,
      rowCount: 250,
      asOfCommitSeq: 96,
      scopeDigest,
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
      nextRowCursor: 'n-0001',
    },
    { type: 'SEGMENT_INLINE', payload: inlineSegment },
    {
      type: 'SUB_END',
      nextCursor: 100,
      bootstrapState:
        '{"asOfCommitSeq":100,"tables":["projects","notes","tasks"],"tableIndex":1,"rowCursor":"n-0251"}',
    },
    ...live(100),
  ],
};

const pushApplied: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
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
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    {
      type: 'PUSH_RESULT',
      clientCommitId: 'c-0002',
      status: 'rejected',
      results: [
        {
          opIndex: 0,
          status: 'conflict',
          code: 'sync.version_conflict',
          message: 'present columns moved past baseVersion (§6.2)',
          serverVersion: 7,
          serverRow: rowFullBytes,
          conflictColumns: new Uint8Array([0b0000_0010]),
        },
      ],
    },
  ],
};

const pushCached: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
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

const unitRevoked: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    {
      type: 'SUB_START',
      id: NOTES_ID,
      status: 'revoked',
      reasonCode: 'sync.scope_revoked',
      bootstrap: false,
      fenced: [],
    },
    { type: 'SUB_END', nextCursor: 42 },
    {
      type: 'SUB_START',
      id: TEAM_ID,
      status: 'active',
      reasonCode: '',
      bootstrap: false,
      fenced: [
        { table: 'notes', status: 'revoked', scopes: {} },
        { table: 'tasks', status: 'active', scopes: { assignee: ['u1'] } },
      ],
    },
    { type: 'SUB_END', nextCursor: 42 },
    ...live(
      57,
      [],
      echoDigest([
        { id: NOTES_ID, status: 'revoked', fenced: [] },
        {
          id: TEAM_ID,
          status: 'active',
          fenced: [
            { table: 'notes', status: 'revoked', scopes: {} },
            { table: 'tasks', status: 'active', scopes: { assignee: ['u1'] } },
          ],
        },
      ]),
    ),
  ],
};

const cursorReset: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    {
      type: 'SUB_START',
      id: TEAM_ID,
      status: 'reset',
      reasonCode: 'sync.cursor_expired',
      bootstrap: false,
      fenced: [],
    },
    { type: 'SUB_END', nextCursor: 30 },
    { type: 'LIVE_START', status: 'reset', reasonCode: 'sync.cursor_expired' },
    { type: 'LIVE_END', throughSeq: -1, echoDigest: ECHO },
  ],
};

const errorMidStream: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    {
      type: 'SUB_START',
      id: NOTES_ID,
      status: 'active',
      reasonCode: '',
      bootstrap: true,
      fenced: [],
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
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    { type: 'LIVE_START', status: 'active', reasonCode: '' },
    {
      // 0x17 is reserved (commit-chain integrity, SPEC.md §0); a reader must
      // skip it via the length prefix (§1.2 rule 2, §9).
      type: 'UNKNOWN',
      frameType: 0x17,
      payload: utf8Encode('reserved-frame-payload'),
    },
    { type: 'LIVE_END', throughSeq: 45, echoDigest: ECHO },
  ],
};

const schemaFloor: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    {
      type: 'RESP_HEADER',
      requiredSchemaVersion: 3,
      latestSchemaVersion: 5,
      logEpoch: 'epoch-2026-07-02-a',
      resetRequired: false,
    },
  ],
};

// §5.10.3: a server-merged crdt column rides an ordinary upsert change —
// no CRDT-specific frame. The merged bytes are just the row's `crdt` column
// (tag 8, bytes machinery) in the change payload.
const commitCrdtMerge: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    ...live(71, [
      {
        type: 'COMMIT',
        commitSeq: 71,
        createdAtMs: FIXED_TIME_MS,
        actorId: 'actor-1',
        tables: ['docs'],
        changes: [
          {
            tableIndex: 0,
            rowId: 'd-1',
            op: 'upsert',
            rowVersion: 3,
            scopes: { project: 'p1' },
            row: docMergedBytes,
          },
        ],
      },
    ]),
  ],
};

// §7.3.2: a LEASE frame immediately after RESP_HEADER, then an empty live
// section — pins the 0x19 frame in its grammar position.
const leaseIssued: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    {
      type: 'LEASE',
      leaseId: 'lease_9f8e7d6c-5b4a-3210-fedc-ba9876543210',
      expiresAtMs: FIXED_TIME_MS + 900_000,
    },
    ...live(57),
  ],
};

// §4.1: the server stores no list or a different digest.
const unregistered: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    { type: 'LIVE_START', status: 'unregistered', reasonCode: '' },
    { type: 'LIVE_END', throughSeq: -1, echoDigest: NO_DIGEST },
  ],
};

// §8.2: a realtime delta holds every matching change of one commit in one
// COMMIT frame; LIVE_END names the commit and carries no echo digest.
const realtimeDelta: ResponseMessage = {
  wireVersion: 4,
  msgKind: 'response',
  frames: [
    RESP_HEADER,
    ...live(
      80,
      [
        {
          type: 'COMMIT',
          commitSeq: 80,
          createdAtMs: FIXED_TIME_MS + 2000,
          actorId: 'actor-2',
          tables: ['projects', 'notes', 'tasks'],
          changes: [
            {
              tableIndex: 1,
              rowId: 'n-2',
              op: 'upsert',
              rowVersion: 2,
              scopes: { project: 'p1' },
              row: rowFullBytes,
            },
            {
              tableIndex: 2,
              rowId: 'task-3',
              op: 'delete',
              scopes: { assignee: 'u2', project: 'p1' },
            },
            {
              tableIndex: 0,
              rowId: 'p1',
              op: 'delete',
              scopes: { project: 'p1' },
            },
          ],
        },
      ],
      NO_DIGEST,
    ),
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

// §2.4 tag 8 / §5.10: an SSG2 segment for a table with a `crdt` column.
// The column table carries the `crdt` type tag (8) + nullable; the crdt
// values ride the `bytes` machinery (merged bytes, empty, and NULL).
const crdtColumnSegment = encodeRowsSegment({
  table: 'docs',
  schemaVersion: 1,
  columns: DOCS_COLUMNS,
  blocks: [
    [
      { serverVersion: 3, values: DOC_MERGED },
      { serverVersion: 1, values: DOC_EMPTY_CRDT },
      { serverVersion: 1, values: DOC_NULL_CRDT },
    ],
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

// §8.6.2 presence: client→server publish and server→client join fanout.
const realtimePresencePublish = {
  event: 'presence',
  data: {
    scopeKey: 'project:p1',
    doc: { cursor: 42, name: 'Ada' },
  },
};

const realtimePresenceFanout = {
  event: 'presence',
  data: {
    scopeKey: 'project:p1',
    kind: 'join',
    actorId: 'actor-1',
    clientId: 'client-a',
    doc: { cursor: 42, name: 'Ada' },
    timestamp: FIXED_TIME_MS,
  },
};

// ---------------------------------------------------------------------------
// Invalid cases — built from codec primitives or by deterministic mutation
// of valid codec output (never hand-hexed).
// ---------------------------------------------------------------------------

type RawFrame = [frameType: number, build: (p: ByteWriter) => void];

/** An envelope from raw frame payloads, for bytes the encoder refuses. */
function rawMessage(msgKind: 1 | 2, frames: RawFrame[]): Uint8Array {
  const w = new ByteWriter();
  w.raw(utf8Encode('SSP2'));
  w.u16(4);
  w.u8(msgKind);
  w.u8(0);
  for (const [frameType, build] of frames) {
    const p = new ByteWriter();
    build(p);
    const payload = p.finish();
    w.u8(frameType);
    w.u32(payload.length);
    w.raw(payload);
  }
  w.u8(FrameType.END);
  w.u32(0);
  return w.finish();
}

const rawReqHeader = (outboxId?: string): RawFrame => [
  FrameType.REQ_HEADER,
  (p) => {
    p.str('client-a');
    p.i32(1);
    p.u8(0); // logEpoch absent
    p.u8(outboxId === undefined ? 0 : 1);
    if (outboxId !== undefined) p.str(outboxId);
  },
];

const rawPullHeader = (fields: Partial<PullHeaderFrame> = {}): RawFrame => [
  FrameType.PULL_HEADER,
  (p) => {
    const frame = pullHeader(fields);
    p.i32(frame.limitCommits);
    p.i32(frame.limitSnapshotRows);
    p.i32(frame.maxSnapshotPages);
    p.u8(frame.accept);
    p.i64(frame.cursor);
    p.bytes(frame.registrationDigest);
    p.bytes(frame.echoDigest);
  },
];

/** A one-operation PUSH_COMMIT; `op` and `payload` default to a delete. */
const rawPushCommit = (
  clientSeq: number,
  op = 2,
  payload?: Uint8Array,
): RawFrame => [
  FrameType.PUSH_COMMIT,
  (p) => {
    p.str('c-1');
    p.i64(clientSeq);
    p.u32(1);
    p.str('notes');
    p.str('n-1');
    p.u8(op);
    p.u8(0); // baseVersion absent
    p.u8(payload === undefined ? 0 : 1);
    if (payload !== undefined) p.bytes(payload);
  },
];

const rawUnit: RawFrame = [
  FrameType.UNIT,
  (p) => {
    p.u32(1);
    p.str('project');
    p.str('p1');
  },
];

const rawProgress = (
  id: string,
  cursor: number,
  bootstrapState?: string,
): RawFrame => [
  FrameType.PROGRESS,
  (p) => {
    p.str(id);
    p.i64(cursor);
    p.u8(bootstrapState === undefined ? 0 : 1);
    if (bootstrapState !== undefined) p.str(bootstrapState);
  },
];

const rawRoundFailure = (code: string): RawFrame => [
  FrameType.ROUND_FAILURE,
  (p) => p.str(code),
];

const rawRespHeader: RawFrame = [
  FrameType.RESP_HEADER,
  (p) => {
    p.u8(0); // requiredSchemaVersion absent
    p.u8(0); // latestSchemaVersion absent
    p.str('epoch-2026-07-02-a');
    p.u8(0); // resetRequired false
  },
];

const rawSubStart = (fencedTables: string[] = [], bootstrap = 0): RawFrame => [
  FrameType.SUB_START,
  (p) => {
    p.str(NOTES_ID);
    p.u8(1); // active
    p.str('');
    p.u8(bootstrap);
    p.u32(fencedTables.length);
    for (const table of fencedTables) {
      p.str(table);
      p.u8(1); // active
      p.u32(0); // no added variable
    }
  },
];

const rawSubEnd = (bootstrapState?: string): RawFrame => [
  FrameType.SUB_END,
  (p) => {
    p.i64(42);
    p.u8(bootstrapState === undefined ? 0 : 1);
    if (bootstrapState !== undefined) p.str(bootstrapState);
  },
];

const rawLiveStart: RawFrame = [
  FrameType.LIVE_START,
  (p) => {
    p.u8(1); // active
    p.str('');
  },
];

const rawLiveEnd = (echo: Uint8Array = ECHO): RawFrame => [
  FrameType.LIVE_END,
  (p) => {
    p.i64(57);
    p.bytes(echo);
  },
];

const rawCommit: RawFrame = [
  FrameType.COMMIT,
  (p) => {
    p.i64(43);
    p.i64(FIXED_TIME_MS);
    p.str('actor-1');
    p.u32(0); // no table
    p.u32(0); // no change
  },
];

const pullMinimalBytes = encodeMessage(pullMinimal);

// Truncated envelope: the terminating END frame (5 bytes) is missing.
const invalidTruncatedNoEnd = pullMinimalBytes.slice(
  0,
  pullMinimalBytes.length - 5,
);

// Bad magic: SSP2 -> SSP1.
const invalidBadMagic = pullMinimalBytes.slice();
invalidBadMagic[3] = 0x31;

// Wire version 3 is rejected as unknown (§9 migration).
const invalidWireVersion = pullMinimalBytes.slice();
new DataView(invalidWireVersion.buffer).setUint16(4, 3, true);

// Non-zero envelope flags.
const invalidFlags = pullMinimalBytes.slice();
invalidFlags[7] = 0x01;

// Frame length exceeding the remaining bytes.
const invalidOverlongFrame = (() => {
  const w = new ByteWriter();
  w.raw(pullMinimalBytes.subarray(0, 8));
  w.u8(FrameType.REQ_HEADER);
  w.u32(4096);
  w.raw(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
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

// Sparse-row decode violations (RFC §6.1), one per rule. Each payload is
// hand-built from the codec's bitmaps: the decoder rejects every one before
// a value is read, so the payloads stop at the offending byte.

// Column 9 does not exist: bit 9 of the 2-byte presence bitmap is padding.
const invalidSparsePresencePadding = new Uint8Array([0b0000_0001, 0b0000_0010]);

// Only column 0 is present, so null bitmap bit 3 is padding — a null bit for
// an absent column.
const invalidSparseNullForAbsentColumn = new Uint8Array([
  0b0000_0001, 0x00, 0b0000_1000,
]);

// Present indices 0 and 1 are id and title; bit 0 marks the non-nullable id
// NULL.
const invalidSparseNullOnNonNullable = new Uint8Array([
  0b0000_0011, 0x00, 0b0000_0001,
]);

// The presence bitmap omits column 0 (the primary key) and presents title;
// the null bitmap and title's value follow so the payload is otherwise
// well-formed.
const invalidSparseAbsentPrimaryKey = (() => {
  const w = new ByteWriter();
  w.raw(new Uint8Array([0b0000_0010, 0x00]));
  w.raw(new Uint8Array([0x00]));
  w.str('unnamed');
  return w.finish();
})();

// Push admission values (SPEC.md §2.4) and the JSON validity rule
// (Conventions). The admission table has one column per rule, so each probe
// is a sparse payload of the primary key plus one value. The encoders do not
// police values, so invalid payloads come straight from the codec.
const ADMISSION_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'text', type: 'string', nullable: true },
  { name: 'score', type: 'float', nullable: true },
  { name: 'meta', type: 'json', nullable: true },
  { name: 'file', type: 'blob_ref', nullable: true },
];
const admissionManifest = {
  columns: ADMISSION_COLUMNS.map((column) => ({
    name: column.name,
    type: column.type,
    nullable: column.nullable,
  })),
  primaryKey: 'id',
};

function admissionPayload(column: string, value: RowValue): Uint8Array {
  return encodeSparseRow(
    ADMISSION_COLUMNS,
    0,
    ADMISSION_COLUMNS.map((c) =>
      c.name === 'id' ? 'a-1' : c.name === column ? value : undefined,
    ),
  );
}

function renderAdmission(bytes: Uint8Array): JsonValue {
  return renderSparseRowValue(
    ADMISSION_COLUMNS,
    decodeSparseRow(ADMISSION_COLUMNS, 0, bytes),
  );
}

const jsonDepth = (depth: number): string =>
  `${'['.repeat(depth)}${']'.repeat(depth)}`;

// Valid under the rule although no core would emit it: whitespace, a
// duplicate key (the last value wins), the largest finite binary64 and an
// escaped surrogate pair next to an escaped control character.
const JSON_HOST_OPAQUE =
  '{ "a" : 1 , "a" : [true, null] , "max" : 1.7976931348623157e308 , "pair" : "\\ud83d\\ude00\\u0001" }';

const BLOB_ID = `sha256:${sha256Hex('syncular-vector:blob')}`;

// Canonical text whose name exercises every JSON.stringify escape class:
// quote, backslash, the five short escapes, \u00xx controls, and characters
// left raw (DEL, non-ASCII, a supplementary character, U+2028).
const BLOB_REF_CANONICAL = serializeBlobRef({
  blobId: BLOB_ID,
  byteLength: 1024,
  mediaType: 'text/plain',
  name: '"q" \\ \b\f\n\r\t\u0001\u001f\u007f é 😀 \u2028',
});

// Each fails the §5.9.1 canonical check on every decode path.
const BLOB_REF_INVALID: ReadonlyArray<{
  name: string;
  raw: string;
  covers: string;
}> = [
  {
    name: 'reordered-keys',
    raw: `{"byteLength":1024,"blobId":"${BLOB_ID}"}`,
    covers: 'byteLength before blobId',
  },
  {
    name: 'byte-length-exponent',
    raw: `{"blobId":"${BLOB_ID}","byteLength":1e2}`,
    covers: 'byteLength written 1e2',
  },
  {
    name: 'byte-length-fraction',
    raw: `{"blobId":"${BLOB_ID}","byteLength":3.0}`,
    covers: 'byteLength written 3.0',
  },
  {
    name: 'byte-length-negative-zero',
    raw: `{"blobId":"${BLOB_ID}","byteLength":-0}`,
    covers: 'byteLength written -0',
  },
  {
    name: 'whitespace',
    raw: `{"blobId": "${BLOB_ID}", "byteLength": 1024}`,
    covers: 'insignificant whitespace after the colons and comma',
  },
  {
    name: 'duplicate-key',
    raw: `{"blobId":"${BLOB_ID}","byteLength":1,"byteLength":1024}`,
    covers: 'byteLength twice; the parsed value serializes without the first',
  },
  {
    name: 'lone-surrogate-name',
    raw: `{"blobId":"${BLOB_ID}","byteLength":1024,"name":"\\ud800"}`,
    covers:
      'name holds an unpaired surrogate escape, the text JSON.stringify would write for it (JSON validity rule)',
  },
  {
    name: 'nul-name',
    raw: `{"blobId":"${BLOB_ID}","byteLength":1024,"name":"\\u0000"}`,
    covers: 'name holds U+0000 (JSON validity rule)',
  },
];

const FILES_COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'text', type: 'string', nullable: true },
  { name: 'file', type: 'blob_ref', nullable: true },
];

function filesSegment(values: readonly RowValue[]): Uint8Array {
  return encodeRowsSegment({
    table: 'files',
    schemaVersion: 1,
    columns: FILES_COLUMNS,
    blocks: [[{ serverVersion: 1, values }]],
  });
}

const jsonBoundaries: RequestMessage = {
  wireVersion: 4,
  msgKind: 'request',
  frames: [
    { type: 'REQ_HEADER', clientId: 'client-a', schemaVersion: 1 },
    pullHeader(),
    {
      type: 'PROGRESS',
      id: NOTES_ID,
      cursor: 100,
      bootstrapState: jsonDepth(64),
    },
    {
      type: 'PROGRESS',
      id: TEAM_ID,
      cursor: 100,
      bootstrapState: JSON_HOST_OPAQUE,
    },
  ],
};

const invalidErrorDetailsNulKey = encodeMessage({
  ...errorMidStream,
  frames: errorMidStream.frames.map((frame) =>
    frame.type === 'ERROR' ? { ...frame, details: '{"\\u0000":1}' } : frame,
  ),
});

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

// §8.6.2: a presence fanout whose `kind` is outside the closed set.
const invalidPresenceUnknownKind = {
  event: 'presence',
  data: {
    scopeKey: 'project:p1',
    kind: 'snapshot', // not one of join|update|leave (§8.6.2)
    actorId: 'actor-1',
    clientId: 'client-a',
    doc: { cursor: 42 },
    timestamp: FIXED_TIME_MS,
  },
};

// §8.6.2: a client→server publish whose `doc` is neither an object nor null.
const invalidPresenceScalarDoc = {
  event: 'presence',
  data: {
    scopeKey: 'project:p1',
    doc: 'online', // must be a JSON object or null (§8.6.2)
  },
};

// §8.6.2: the publisher-directed error codes are a closed set of two.
const invalidPresenceUnknownError = {
  event: 'presence',
  data: {
    scopeKey: 'project:p1',
    error: 'presence.rate_limited', // not presence.too_large|forbidden
    timestamp: FIXED_TIME_MS,
  },
};

// §8.6.2: a leave fanout carries `doc: null`, never a document value.
const invalidPresenceLeaveDoc = {
  event: 'presence',
  data: {
    scopeKey: 'project:p1',
    kind: 'leave',
    actorId: 'actor-1',
    clientId: 'client-a',
    doc: 'gone', // must be null (§8.6.2)
    timestamp: FIXED_TIME_MS,
  },
};

// §8.6.2: a client→server publish states its doc; leave is `doc: null`.
const invalidPresencePublishMissingDoc = {
  event: 'presence',
  data: { scopeKey: 'project:p1' },
};

// ---------------------------------------------------------------------------
// File emission
// ---------------------------------------------------------------------------

interface BinaryCase {
  name: string;
  bytes: Uint8Array;
  render: (bytes: Uint8Array) => JsonValue;
  covers: string;
  /** Codec-level kinds: a column table that overrides the kind's own. */
  manifest?: ManifestExtra;
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
  /** Codec-level kinds: a column table that overrides the kind's own. */
  manifest?: ManifestExtra;
}

/** Manifest fields shared by every case of a codec-level kind (the sparse
 * row codec decodes bytes that carry no column table of their own). */
interface ManifestExtra {
  columns?: readonly Record<string, unknown>[];
  primaryKey?: string;
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
  manifestExtra: ManifestExtra = {},
): number {
  const kindDir = join(vectorsDir, kind);
  rmSync(kindDir, { recursive: true, force: true });
  mkdirSync(kindDir, { recursive: true });
  if (invalid.length > 0 || jsonInvalid.length > 0) {
    mkdirSync(join(kindDir, 'invalid'));
  }

  const manifestCases: Array<Record<string, unknown>> = [];
  for (const c of cases) {
    writeFileSync(join(kindDir, `${c.name}.bin`), c.bytes);
    writeFileSync(join(kindDir, `${c.name}.json`), jsonText(c.render(c.bytes)));
    manifestCases.push({
      name: c.name,
      bin: `${c.name}.bin`,
      json: `${c.name}.json`,
      covers: c.covers,
      ...c.manifest,
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
  const manifestInvalid: Array<Record<string, unknown>> = invalid.map((c) => {
    writeFileSync(join(kindDir, 'invalid', `${c.name}.bin`), c.bytes);
    return {
      name: c.name,
      bin: `invalid/${c.name}.bin`,
      error: c.error,
      covers: c.covers,
      ...c.manifest,
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
      ...manifestExtra,
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
        'Smallest legal pull: PULL_HEADER refers to the list by digest, with a replica cursor and an echo digest; no UNIT frame (§4.1, §4.2)',
    },
    {
      name: 'pull-bootstrap',
      bytes: encodeMessage(pullBootstrap),
      render: renderMessage,
      covers:
        'A traveling list of two units + two PROGRESS frames: a fresh bootstrap (cursor = -1) and a resumed bootstrap (cursor at the §4.7 pin, bootstrapState round-trip); accept bits incl. sqlite + signed URLs; empty echoDigest',
    },
    {
      name: 'push-multi-commit',
      bytes: encodeMessage(pushMultiCommit),
      render: renderMessage,
      covers:
        'outboxId + two commits with increasing clientSeq: upsert with baseVersion, delete, sparse-row payload edge cases (presence and NULL bitmaps, empty string, non-BMP unicode, json-typed column raw-string round-trip)',
    },
    {
      name: 'combined',
      bytes: encodeMessage(combined),
      render: renderMessage,
      covers:
        'Push + pull in one envelope (§1.5 ordering): a referenced list with one post-bootstrap unit in PROGRESS',
    },
    {
      name: 'epoch-bound',
      bytes: encodeMessage(epochBound),
      render: renderMessage,
      covers:
        'Request header with the stored partition logEpoch (§2.1) and outboxId (§6.3.2)',
    },
    {
      name: 'json-boundaries',
      bytes: encodeMessage(jsonBoundaries),
      render: renderMessage,
      covers:
        'JSON validity rule (Conventions) at its accepting edge: one PROGRESS.bootstrapState nested exactly 64 containers deep, a second with whitespace, a duplicate key, the largest finite binary64 and escapes',
    },
    {
      name: 'round-failure-report',
      bytes: encodeMessage(roundFailureReport),
      render: renderMessage,
      covers:
        'ROUND_FAILURE (§1.5) immediately after REQ_HEADER: the client reports the code of its last round that failed where the server could not see it',
    },
    {
      name: 'empty-registration',
      bytes: encodeMessage(emptyRegistration),
      render: renderMessage,
      covers:
        "A pull whose registrationDigest is the empty list's digest and which carries no UNIT frame: the empty list travels (§4.1)",
    },
    {
      name: 'producer-push',
      bytes: encodeMessage(producerPush),
      render: renderMessage,
      covers:
        'A database-less producer push: no outboxId, clientSeq = 0 (§6.10)',
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
      name: 'wire-version-3',
      bytes: invalidWireVersion,
      error: 'sync.invalid_request',
      covers: 'wireVersion 3 is rejected as unknown before reading frames (§9)',
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
      bytes: rawMessage(1, [
        rawReqHeader(),
        rawPushCommit(0, 3, rowFullSparseBytes),
      ]),
      error: 'sync.invalid_request',
      covers: 'Push operation op byte 3 (unknown enum byte)',
    },
    {
      name: 'upsert-without-payload',
      bytes: rawMessage(1, [rawReqHeader(), rawPushCommit(0, 1)]),
      error: 'sync.invalid_request',
      covers: 'Upsert operation with absent payload (presence invariant)',
    },
    {
      name: 'round-failure-duplicate',
      bytes: rawMessage(1, [
        rawReqHeader(),
        rawRoundFailure('sync.transport_failed'),
        rawRoundFailure('sync.transport_failed'),
        rawPullHeader(),
      ]),
      error: 'sync.invalid_request',
      covers: 'Two ROUND_FAILURE frames (§1.5: at most one)',
    },
    {
      name: 'round-failure-after-push',
      bytes: rawMessage(1, [
        rawReqHeader(),
        rawPushCommit(0),
        rawRoundFailure('sync.transport_failed'),
      ]),
      error: 'sync.invalid_request',
      covers:
        'ROUND_FAILURE after a PUSH_COMMIT (§1.5: only directly after REQ_HEADER)',
    },
    {
      name: 'round-failure-bad-code',
      bytes: rawMessage(1, [
        rawReqHeader(),
        rawRoundFailure('sync.transport-failed'),
        rawPullHeader(),
      ]),
      error: 'sync.invalid_request',
      covers:
        'ROUND_FAILURE code outside the §1.5 grammar (hyphen instead of a dotted segment)',
    },
    {
      name: 'bootstrap-state-json-number-overflow',
      bytes: rawMessage(1, [
        rawReqHeader(),
        rawPullHeader(),
        rawProgress(NOTES_ID, 100, '{"asOfCommitSeq":1e999}'),
      ]),
      error: 'sync.invalid_request',
      covers:
        'PROGRESS.bootstrapState holds 1e999, outside finite binary64 (Conventions JSON validity rule)',
    },
    {
      name: 'bootstrap-state-json-depth-65',
      bytes: rawMessage(1, [
        rawReqHeader(),
        rawPullHeader(),
        rawProgress(NOTES_ID, 100, jsonDepth(65)),
      ]),
      error: 'sync.invalid_request',
      covers:
        'PROGRESS.bootstrapState nests 65 containers (Conventions JSON validity rule)',
    },
    {
      name: 'registration-digest-31-bytes',
      bytes: rawMessage(1, [
        rawReqHeader(),
        rawPullHeader({ registrationDigest: REGISTRATION.subarray(0, 31) }),
      ]),
      error: 'sync.invalid_request',
      covers: 'PULL_HEADER.registrationDigest of 31 bytes (§4.2: exactly 32)',
    },
    {
      name: 'echo-digest-16-bytes',
      bytes: rawMessage(1, [
        rawReqHeader(),
        rawPullHeader({ echoDigest: ECHO.subarray(0, 16) }),
      ]),
      error: 'sync.invalid_request',
      covers: 'PULL_HEADER.echoDigest of 16 bytes (§4.2: 0 or 32)',
    },
    {
      name: 'pull-cursor-below-minus-one',
      bytes: rawMessage(1, [rawReqHeader(), rawPullHeader({ cursor: -2 })]),
      error: 'sync.invalid_request',
      covers: 'PULL_HEADER.cursor = -2 (§4.2: -1 or above)',
    },
    {
      name: 'progress-id-uppercase',
      bytes: rawMessage(1, [
        rawReqHeader(),
        rawPullHeader(),
        rawProgress(NOTES_ID.toUpperCase(), -1),
      ]),
      error: 'sync.invalid_request',
      covers:
        'PROGRESS.id in uppercase hex (§4.3: 32 lowercase hex characters)',
    },
    {
      name: 'unit-after-progress',
      bytes: rawMessage(1, [
        rawReqHeader(),
        rawPullHeader(),
        rawProgress(NOTES_ID, -1),
        rawUnit,
      ]),
      error: 'sync.invalid_request',
      covers: 'UNIT after a PROGRESS frame (§1.5: PROGRESS follows every UNIT)',
    },
    {
      name: 'unit-without-pull-header',
      bytes: rawMessage(1, [rawReqHeader(), rawUnit]),
      error: 'sync.invalid_request',
      covers: 'UNIT without a PULL_HEADER (§1.5)',
    },
    {
      name: 'outbox-id-empty',
      bytes: rawMessage(1, [rawReqHeader(''), rawPullHeader()]),
      error: 'sync.invalid_request',
      covers: 'REQ_HEADER.outboxId present but empty (§1.5)',
    },
    {
      name: 'client-seq-negative',
      bytes: rawMessage(1, [rawReqHeader('outbox-7d1c'), rawPushCommit(-1)]),
      error: 'sync.invalid_request',
      covers: 'PUSH_COMMIT.clientSeq = -1 (§6.1: non-negative)',
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
        'Quiet replica: LIVE_START active, no COMMIT, LIVE_END with throughSeq advanced (§4.5)',
    },
    {
      name: 'epoch-reset',
      bytes: encodeMessage(epochReset),
      render: renderMessage,
      covers: 'Header-only reset after a partition log epoch change (§2.1)',
    },
    {
      name: 'commits-incremental',
      bytes: encodeMessage(commitsIncremental),
      render: renderMessage,
      covers:
        'A live section of two COMMIT frames, one spanning two tables; row codec exercising every column type incl. NULLs, bytes, non-BMP strings; scope map on changes',
    },
    {
      name: 'bootstrap-segments',
      bytes: encodeMessage(bootstrapSegments),
      render: renderMessage,
      covers:
        'A catching-up unit section with an echo: SEGMENT_REF (sqlite, with signed URL) + SEGMENT_REF (rows, no URL) + SEGMENT_INLINE across two tables; incomplete bootstrapState in SUB_END; then an empty live section',
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
      covers:
        'Rejected commit; conflict record with serverVersion, full-row serverRow, and the conflictColumns bitmap (§6.3)',
    },
    {
      name: 'push-cached',
      bytes: encodeMessage(pushCached),
      render: renderMessage,
      covers: 'Idempotent replay: status = cached, original results',
    },
    {
      name: 'unit-revoked',
      bytes: encodeMessage(unitRevoked),
      render: renderMessage,
      covers:
        'SUB_START status revoked, reason sync.scope_revoked, no fenced record; an active unit whose echo carries one revoked and one active fenced record (§4.4)',
    },
    {
      name: 'cursor-reset',
      bytes: encodeMessage(cursorReset),
      render: renderMessage,
      covers:
        'A unit section with SUB_START status reset and LIVE_START status reset, both reason sync.cursor_expired (horizon signal), throughSeq = -1',
    },
    {
      name: 'error-mid-stream',
      bytes: encodeMessage(errorMidStream),
      render: renderMessage,
      covers:
        'RESP_HEADER + SUB_START + ERROR + END: partially streamed failure (§1.4 abort rule)',
    },
    {
      name: 'unknown-frame-skip',
      bytes: encodeMessage(unknownFrameSkip),
      render: renderMessage,
      covers:
        'A reserved/unknown frame type inside the live section — MUST decode with the frame skipped (§9)',
    },
    {
      name: 'schema-floor',
      bytes: encodeMessage(schemaFloor),
      render: renderMessage,
      covers: 'requiredSchemaVersion present',
    },
    {
      name: 'commit-crdt-merge',
      bytes: encodeMessage(commitCrdtMerge),
      render: renderMessage,
      covers:
        'A COMMIT upsert carrying a server-merged crdt column (§2.4 tag 8, §5.10.3): merged bytes ride the ordinary change payload, no CRDT-specific frame',
    },
    {
      name: 'lease-issued',
      bytes: encodeMessage(leaseIssued),
      render: renderMessage,
      covers:
        'RESP_HEADER + LEASE (§7.3.2) + an empty live section: pins the 0x19 frame (leaseId, expiresAtMs) in its grammar position',
    },
    {
      name: 'unregistered',
      bytes: encodeMessage(unregistered),
      render: renderMessage,
      covers:
        'LIVE_START status unregistered, LIVE_END with throughSeq = -1 and an empty echoDigest (§4.1)',
    },
    {
      name: 'realtime-delta',
      bytes: encodeMessage(realtimeDelta),
      render: renderMessage,
      covers:
        'A delta: LIVE_START, one COMMIT spanning three tables, LIVE_END with throughSeq = its commitSeq and an empty echoDigest (§8.2)',
    },
  ],
  [],
  [
    {
      name: 'bool-byte-out-of-range',
      bytes: rawMessage(2, [rawRespHeader, rawSubStart([], 2), rawSubEnd()]),
      error: 'sync.invalid_request',
      covers: 'SUB_START.bootstrap bool byte 0x02',
    },
    {
      name: 'error-details-json-nul-key',
      bytes: invalidErrorDetailsNulKey,
      error: 'sync.invalid_request',
      covers:
        'ERROR.details has an object key holding U+0000 (Conventions JSON validity rule)',
    },
    {
      name: 'sub-end-bootstrap-state-lone-surrogate',
      bytes: rawMessage(2, [
        rawRespHeader,
        rawSubStart(),
        rawSubEnd('"\\udc00"'),
      ]),
      error: 'sync.invalid_request',
      covers:
        'SUB_END.bootstrapState is an unpaired low-surrogate escape (Conventions JSON validity rule)',
    },
    {
      name: 'commit-inside-unit-section',
      bytes: rawMessage(2, [
        rawRespHeader,
        rawSubStart(),
        rawCommit,
        rawSubEnd(),
        rawLiveStart,
        rawLiveEnd(),
      ]),
      error: 'sync.invalid_request',
      covers: 'COMMIT inside a unit section (§1.6)',
    },
    {
      name: 'sub-start-after-live-start',
      bytes: rawMessage(2, [
        rawRespHeader,
        rawLiveStart,
        rawLiveEnd(),
        rawSubStart(),
        rawSubEnd(),
      ]),
      error: 'sync.invalid_request',
      covers: 'SUB_START after the live section (§1.6)',
    },
    {
      name: 'second-live-start',
      bytes: rawMessage(2, [
        rawRespHeader,
        rawLiveStart,
        rawLiveEnd(),
        rawLiveStart,
        rawLiveEnd(),
      ]),
      error: 'sync.invalid_request',
      covers: 'A second LIVE_START (§1.6)',
    },
    {
      name: 'live-start-without-live-end',
      bytes: rawMessage(2, [rawRespHeader, rawLiveStart]),
      error: 'sync.invalid_request',
      covers: 'LIVE_START without LIVE_END before END (§1.6)',
    },
    {
      name: 'fenced-out-of-order',
      bytes: rawMessage(2, [
        rawRespHeader,
        rawSubStart(['tasks', 'notes']),
        rawSubEnd(),
        rawLiveStart,
        rawLiveEnd(),
      ]),
      error: 'sync.invalid_request',
      covers: 'Fenced records out of ascending table order (§4.4)',
    },
    {
      name: 'live-end-echo-digest-31-bytes',
      bytes: rawMessage(2, [
        rawRespHeader,
        rawLiveStart,
        rawLiveEnd(ECHO.subarray(0, 31)),
      ]),
      error: 'sync.invalid_request',
      covers: 'LIVE_END.echoDigest of 31 bytes (§4.4: 0 or 32)',
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
    {
      name: 'crdt-column',
      bytes: crdtColumnSegment,
      render: renderRowsSegment,
      covers:
        'SSG2 for a table with a crdt column (§2.4 tag 8, §5.10): the crdt value rides the bytes machinery (merged bytes, empty, and NULL)',
    },
    {
      name: 'full-row-admission-values',
      bytes: filesSegment(['f-1', 'nul \u0000 kept', BLOB_REF_CANONICAL]),
      render: renderRowsSegment,
      covers:
        'Full rows keep decoding a string with U+0000 (§2.4 push admission values apply to sparse rows only); a canonical blob_ref whose name exercises every escape class (§5.9.1)',
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
    ...BLOB_REF_INVALID.map((probe) => ({
      name: `blob-ref-${probe.name}`,
      bytes: filesSegment(['f-1', null, probe.raw]),
      error: 'sync.invalid_request',
      covers: `Full-row blob_ref that is not canonical (§5.9.1): ${probe.covers}`,
    })),
  ],
);

total += emitKind(
  'push',
  [
    {
      name: 'sparse-row',
      bytes: encodeSparseRow(
        SPARSE_COLUMNS,
        SPARSE_PRIMARY_KEY_INDEX,
        SPARSE_PARTIAL,
      ),
      render: renderSparseRow,
      covers:
        'Sparse push payload (RFC §6.1): a partial row — id, a present-NULL title, and meta — over a 9-column table, so the 2-byte presence bitmap and the present-column null bitmap both carry padding bits',
    },
    {
      name: 'sparse-row-full',
      bytes: encodeSparseRow(
        SPARSE_COLUMNS,
        SPARSE_PRIMARY_KEY_INDEX,
        SPARSE_FULL,
      ),
      render: renderSparseRow,
      covers:
        'The full-row special case: every presence bit set (incl. the second presence byte), a present-NULL title, and all nine §2.4 column types',
    },
    {
      name: 'admission-json-depth-64',
      bytes: admissionPayload('meta', jsonDepth(64)),
      render: renderAdmission,
      covers: 'json value nested exactly 64 containers deep (accepted)',
      manifest: admissionManifest,
    },
    {
      name: 'admission-json-host-opaque',
      bytes: admissionPayload('meta', JSON_HOST_OPAQUE),
      render: renderAdmission,
      covers:
        'json value with whitespace, a duplicate key, the largest finite binary64 and escapes (accepted, raw text preserved)',
      manifest: admissionManifest,
    },
    {
      name: 'admission-float-max',
      bytes: admissionPayload('score', Number.MAX_VALUE),
      render: renderAdmission,
      covers: 'float holding the largest finite binary64 (accepted)',
      manifest: admissionManifest,
    },
    {
      name: 'admission-blob-ref-canonical',
      bytes: admissionPayload('file', BLOB_REF_CANONICAL),
      render: renderAdmission,
      covers:
        'canonical blob_ref whose name exercises every escape class (accepted, §5.9.1)',
      manifest: admissionManifest,
    },
  ],
  [],
  [
    {
      name: 'presence-padding-bit',
      bytes: invalidSparsePresencePadding,
      error: 'sync.invalid_request',
      covers:
        'Sparse row presence bitmap with a set padding bit (bit 9 of a 9-column table)',
    },
    {
      name: 'null-bit-for-absent-column',
      bytes: invalidSparseNullForAbsentColumn,
      error: 'sync.invalid_request',
      covers:
        'Sparse row null bitmap with a set bit beyond the present columns — a null for an absent column',
    },
    {
      name: 'null-bit-on-non-nullable',
      bytes: invalidSparseNullOnNonNullable,
      error: 'sync.invalid_request',
      covers: 'Sparse row null bit for the non-nullable primary-key column',
    },
    {
      name: 'absent-primary-key',
      bytes: invalidSparseAbsentPrimaryKey,
      error: 'sync.invalid_request',
      covers:
        'Sparse row whose presence bitmap omits the primary-key column (RFC §6.1)',
    },
    ...[
      {
        name: 'string-nul',
        bytes: admissionPayload('text', 'a\u0000b'),
        covers: 'string value holding U+0000',
      },
      {
        name: 'json-depth-65',
        bytes: admissionPayload('meta', jsonDepth(65)),
        covers: 'json value nested 65 containers deep',
      },
      {
        name: 'json-number-overflow',
        bytes: admissionPayload('meta', '1e999'),
        covers: 'json number 1e999, outside finite binary64',
      },
      {
        name: 'json-number-above-max',
        bytes: admissionPayload('meta', '[1.7976931348623159e308]'),
        covers:
          'json number 1.7976931348623159e308, which rounds to infinity (the largest finite binary64 is accepted)',
      },
      {
        name: 'json-lone-surrogate',
        bytes: admissionPayload('meta', '"\\ud800"'),
        covers: 'json string that is an unpaired high-surrogate escape',
      },
      {
        name: 'json-lone-surrogate-key',
        bytes: admissionPayload('meta', '{"\\udc00":1}'),
        covers: 'json object key that is an unpaired low-surrogate escape',
      },
      {
        name: 'json-nul-escape',
        bytes: admissionPayload('meta', '"\\u0000"'),
        covers: 'json string holding U+0000',
      },
      {
        name: 'json-nul-key',
        bytes: admissionPayload('meta', '{"\\u0000":1}'),
        covers: 'json object key holding U+0000',
      },
      {
        name: 'json-shadowed-number-overflow',
        bytes: admissionPayload('meta', '{"a":1e999,"a":1}'),
        covers:
          'json number 1e999 under a key that a later duplicate key shadows',
      },
      {
        name: 'json-shadowed-lone-surrogate',
        bytes: admissionPayload('meta', '{"a":"\\ud800","a":1}'),
        covers:
          'json unpaired high-surrogate escape under a key that a later duplicate key shadows',
      },
      {
        name: 'json-shadowed-nul-escape',
        bytes: admissionPayload('meta', '{"a":"\\u0000","a":1}'),
        covers:
          'json U+0000 escape under a key that a later duplicate key shadows',
      },
      {
        name: 'json-shadowed-depth-65',
        bytes: admissionPayload('meta', `{"a":${jsonDepth(64)},"a":1}`),
        covers:
          'json nested 65 containers deep inside a value that a later duplicate key shadows',
      },
      {
        name: 'json-shadowed-depth-128',
        bytes: admissionPayload('meta', `{"a":${jsonDepth(127)},"a":1}`),
        covers:
          'json nested 128 containers deep inside a value that a later duplicate key shadows',
      },
      {
        name: 'float-nan',
        bytes: admissionPayload('score', Number.NaN),
        covers: 'float value NaN',
      },
      {
        name: 'float-infinity',
        bytes: admissionPayload('score', Number.POSITIVE_INFINITY),
        covers: 'float value Infinity',
      },
      {
        name: 'float-negative-infinity',
        bytes: admissionPayload('score', Number.NEGATIVE_INFINITY),
        covers: 'float value -Infinity',
      },
      ...BLOB_REF_INVALID.map((probe) => ({
        name: `blob-ref-${probe.name}`,
        bytes: admissionPayload('file', probe.raw),
        covers: `blob_ref that is not canonical (§5.9.1): ${probe.covers}`,
      })),
    ].map((probe) => ({
      name: `admission-${probe.name}`,
      bytes: probe.bytes,
      error: 'sync.invalid_request',
      covers: `Push admission value (SPEC.md §2.4): ${probe.covers}`,
      manifest: admissionManifest,
    })),
  ],
  [],
  {
    columns: SPARSE_COLUMNS.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
    })),
    primaryKey: SPARSE_PRIMARY_KEY,
  },
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
    {
      name: 'presence-publish',
      value: realtimePresencePublish,
      covers: 'Client→server presence publish control message (SPEC.md §8.6.2)',
    },
    {
      name: 'presence-fanout',
      value: realtimePresenceFanout,
      covers:
        'Server→client presence join fanout control message (SPEC.md §8.6.2)',
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
    {
      name: 'presence-unknown-kind',
      value: invalidPresenceUnknownKind,
      error: 'sync.invalid_request',
      covers:
        'Presence fanout with a kind outside the closed set join|update|leave is malformed (SPEC.md §8.6.2)',
    },
    {
      name: 'presence-scalar-doc',
      value: invalidPresenceScalarDoc,
      error: 'sync.invalid_request',
      covers:
        'Client→server presence publish with a non-object non-null doc is malformed (SPEC.md §8.6.2)',
    },
    {
      name: 'presence-unknown-error',
      value: invalidPresenceUnknownError,
      error: 'sync.invalid_request',
      covers:
        'Presence error outside the closed set presence.too_large|presence.forbidden is malformed (SPEC.md §8.6.2)',
    },
    {
      name: 'presence-leave-doc',
      value: invalidPresenceLeaveDoc,
      error: 'sync.invalid_request',
      covers:
        'Presence leave fanout whose doc is not null is malformed (SPEC.md §8.6.2)',
    },
    {
      name: 'presence-publish-missing-doc',
      value: invalidPresencePublishMissingDoc,
      error: 'sync.invalid_request',
      covers:
        'Client→server presence publish without a doc member is malformed (SPEC.md §8.6.2)',
    },
  ],
);

// §4.1, §4.4: unit ids, registration digests and echo digests (JSON only).
// The generator hashes its own canonical text with node:crypto and refuses
// to emit a case where the codec helpers disagree.
function checkedDigest(canonicalJson: string, digest: string): string {
  if (sha256Hex(canonicalJson).slice(0, digest.length) !== digest) {
    throw new Error('codec digest differs from node:crypto');
  }
  return digest;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

const DIGEST_UNITS: UnitScopes[] = [
  { campaign_id: 'c1' },
  { ruleset_id: 'r1' },
  // UTF-16 order puts U+1F600 (D83D) before U+FF01; UTF-8 order does not.
  { '\u{1f600}': 'x', '\uff01': 'y' },
  // Integer-like keys sort as text, never in JavaScript object order.
  { '9': 'a', '10': 'b' },
  { campaign_id: '7' },
  { note: 'q"b\\s\n\u0001\u2028é' },
];

const ECHO_CASES: UnitEcho[][] = [
  [],
  [
    {
      id: NOTES_ID,
      status: 'active',
      fenced: [
        {
          table: 'tasks',
          status: 'active',
          scopes: { assignee: ['u2', 'u1', 'u2'] },
        },
      ],
    },
    { id: TEAM_ID, status: 'active', fenced: [] },
  ],
  [
    { id: NOTES_ID, status: 'revoked', fenced: [] },
    {
      id: TEAM_ID,
      status: 'active',
      fenced: [
        { table: 'notes', status: 'revoked', scopes: {} },
        { table: 'tasks', status: 'active', scopes: { assignee: ['u1'] } },
      ],
    },
  ],
];

const registrationDigests = {
  units: DIGEST_UNITS.map((scopes) => ({
    scopes,
    canonicalJson: canonicalUnitJson(scopes),
    id: checkedDigest(canonicalUnitJson(scopes), unitId(scopes)),
  })),
  registrations: [
    DIGEST_UNITS.slice(0, 2),
    [],
    DIGEST_UNITS.slice(2),
    DIGEST_UNITS.slice(0, 2).reverse(),
  ].map((units) => {
    const canonicalJson = `[${units.map(canonicalUnitJson).join(',')}]`;
    return {
      units,
      canonicalJson,
      digest: checkedDigest(canonicalJson, hex(registrationDigest(units))),
    };
  }),
  echoes: ECHO_CASES.map((units) => {
    const entries = units.map((unit) => {
      const fenced = unit.fenced.map(
        (record) =>
          `{"scopes":${canonicalScopeJson(record.scopes)},"status":"${record.status}","table":${JSON.stringify(record.table)}}`,
      );
      return `{"fenced":[${fenced.join(',')}],"id":"${unit.id}","status":"${unit.status}"}`;
    });
    const canonicalJson = `[${entries.join(',')}]`;
    return {
      units,
      canonicalJson,
      digest: checkedDigest(canonicalJson, hex(echoDigest(units))),
    };
  }),
};

total += emitKind(
  'registration',
  [],
  [
    {
      name: 'digests',
      value: registrationDigests,
      covers:
        'Unit ids (§4.1), registration digests (§4.1: the golden example, the empty list, non-BMP and integer-like keys, an integer-text value, JSON escapes, reversed order) and echo digests (§4.4: sorted unique scope lists, revoked units and fenced records)',
    },
  ],
  [],
);

console.log(`generated ${total} vector cases under ${vectorsDir}`);
