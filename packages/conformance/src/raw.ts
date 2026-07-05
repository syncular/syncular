/**
 * Raw-bytes server surface: hand-built SSP2 requests via the REFERENCE
 * codec, for scenarios that must pin wire behavior below the client
 * driver (error catalog, stale retransmits, horizon boundaries, segment
 * re-authorization). Deliberately reference-codec-only: a server under
 * test must interoperate with spec-pinned bytes no matter which client
 * implementation is paired.
 */
import {
  decodeMessage,
  encodeMessage,
  encodeRow,
  PROTOCOL_WIRE_VERSION,
  type PushOperation,
  type PushResultFrame,
  type RequestFrame,
  type ResponseFrame,
  type ResponseMessage,
  type RowColumn,
  type RowValue,
  type ScopeMap,
  type SubEndFrame,
  type SubStartFrame,
} from '@syncular/core';
import type {
  DriverRow,
  DriverRowValue,
  DriverSchema,
  DriverScopeMap,
  DriverTable,
} from './driver';

// ---------------------------------------------------------------------------
// Driver row → row-codec bytes
// ---------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function toRowValue(value: DriverRowValue | undefined): RowValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return hexToBytes(value.$bytes);
  return value;
}

export function findTable(schema: DriverSchema, name: string): DriverTable {
  const table = schema.tables.find((t) => t.name === name);
  if (table === undefined) throw new Error(`fixture has no table ${name}`);
  return table;
}

/** Encode a driver row with the reference row codec (§2.4). */
export function encodeDriverRow(
  table: DriverTable,
  row: DriverRow,
): Uint8Array {
  const columns = table.columns as readonly RowColumn[];
  const values = table.columns.map((column) => toRowValue(row[column.name]));
  return encodeRow(columns, values);
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

export function rawUpsert(
  schema: DriverSchema,
  table: string,
  row: DriverRow,
  baseVersion?: number,
): PushOperation {
  const t = findTable(schema, table);
  const rowId = row[t.primaryKey];
  if (typeof rowId !== 'string') {
    throw new Error(`row is missing string primary key ${t.primaryKey}`);
  }
  return {
    table,
    rowId,
    op: 'upsert',
    payload: encodeDriverRow(t, row),
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  };
}

export function rawDelete(
  table: string,
  rowId: string,
  baseVersion?: number,
): PushOperation {
  return {
    table,
    rowId,
    op: 'delete',
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  };
}

export function rawPushCommit(
  clientCommitId: string,
  operations: readonly PushOperation[],
): RequestFrame {
  return { type: 'PUSH_COMMIT', clientCommitId, operations: [...operations] };
}

export function rawPullHeader(overrides?: {
  limitCommits?: number;
  limitSnapshotRows?: number;
  maxSnapshotPages?: number;
  accept?: number;
}): RequestFrame {
  return {
    type: 'PULL_HEADER',
    limitCommits: overrides?.limitCommits ?? 0,
    limitSnapshotRows: overrides?.limitSnapshotRows ?? 0,
    maxSnapshotPages: overrides?.maxSnapshotPages ?? 0,
    accept: overrides?.accept ?? 0b0011,
  };
}

export function rawSubscription(
  id: string,
  table: string,
  scopes: DriverScopeMap,
  cursor: number,
  extra?: { bootstrapState?: string; params?: string },
): RequestFrame {
  return {
    type: 'SUBSCRIPTION',
    id,
    table,
    scopes: scopes as ScopeMap,
    cursor,
    ...(extra?.bootstrapState !== undefined
      ? { bootstrapState: extra.bootstrapState }
      : {}),
    ...(extra?.params !== undefined ? { params: extra.params } : {}),
  };
}

export function rawRequestBytes(
  frames: readonly RequestFrame[],
  options?: { clientId?: string; schemaVersion?: number },
): Uint8Array {
  return encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      {
        type: 'REQ_HEADER',
        clientId: options?.clientId ?? 'raw-client',
        schemaVersion: options?.schemaVersion ?? 1,
      },
      ...frames,
    ],
  });
}

// ---------------------------------------------------------------------------
// Hand-built invalid requests
// ---------------------------------------------------------------------------

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ];
}

function strField(value: string): number[] {
  const utf8 = new TextEncoder().encode(value);
  return [...u32le(utf8.length), ...utf8];
}

function frame(type: number, payload: readonly number[]): number[] {
  return [type, ...u32le(payload.length), ...payload];
}

/**
 * Grammar-invalid request bytes the reference encoder refuses to produce
 * (its validation mirrors the decoder's): built by hand so scenarios can
 * pin the server's decode-layer rejections (§1.5, §1.7).
 */
export function rawInvalidRequestBytes(
  kind: 'empty-commit' | 'no-push-no-pull',
  clientId = 'raw-client',
): Uint8Array {
  const bytes: number[] = [
    0x53,
    0x53,
    0x50,
    0x32, // "SSP2"
    ...u16le(1), // wireVersion
    0x01, // msgKind: request
    0x00, // flags
  ];
  // REQ_HEADER (0x01): clientId str + schemaVersion i32 (always ≥ 1).
  bytes.push(...frame(0x01, [...strField(clientId), ...u32le(1)]));
  if (kind === 'empty-commit') {
    // PUSH_COMMIT (0x02) with zero operations (§6.1 sync.empty_commit).
    bytes.push(...frame(0x02, [...strField('empty'), ...u32le(0)]));
  }
  // END
  bytes.push(...frame(0x00, []));
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function decodeResponse(bytes: Uint8Array): ResponseMessage {
  const message = decodeMessage(bytes);
  if (message.msgKind !== 'response') {
    throw new Error('expected a response message');
  }
  return message;
}

export function responsePushResults(
  message: ResponseMessage,
): PushResultFrame[] {
  return message.frames.filter(
    (f): f is PushResultFrame => f.type === 'PUSH_RESULT',
  );
}

export interface ResponseSection {
  readonly start: SubStartFrame;
  readonly body: readonly ResponseFrame[];
  readonly end: SubEndFrame;
}

export function responseSections(
  message: ResponseMessage,
): Map<string, ResponseSection> {
  const result = new Map<string, ResponseSection>();
  let start: SubStartFrame | undefined;
  let body: ResponseFrame[] = [];
  for (const frame of message.frames) {
    if (frame.type === 'SUB_START') {
      start = frame;
      body = [];
    } else if (frame.type === 'SUB_END') {
      if (start !== undefined) {
        result.set(start.id, { start, body, end: frame });
      }
      start = undefined;
    } else if (start !== undefined) {
      body.push(frame);
    }
  }
  return result;
}

export function responseSection(
  message: ResponseMessage,
  id: string,
): ResponseSection {
  const section = responseSections(message).get(id);
  if (section === undefined) {
    throw new Error(`response has no subscription section ${id}`);
  }
  return section;
}
