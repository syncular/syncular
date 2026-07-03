/**
 * Canonical JSON debug rendering (SPEC.md §11).
 *
 * Non-contractual for the wire; contractual for golden vectors. Rendering
 * rules: frames in wire order with END omitted, field order per the SPEC
 * field tables, absent opt() fields omitted, binary fields as standard
 * base64, enums by their spec names, i64 as JSON numbers, json-typed
 * fields embedded as parsed JSON.
 */
import type {
  CommitChange,
  PushOperation,
  PushOperationResult,
  RequestFrame,
  ResponseFrame,
  SyncMessage,
} from './message';
import { decodeMessage } from './message';
import type { RowColumn, RowValue } from './row-codec';
import type { RowsSegment } from './segment';
import { decodeRowsSegment, ROWS_SEGMENT_FORMAT_VERSION } from './segment';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (§11.1 rule 4). Dependency- and runtime-agnostic. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const chunk =
      ((bytes[i] ?? 0) << 16) |
      ((bytes[i + 1] ?? 0) << 8) |
      (bytes[i + 2] ?? 0);
    out +=
      BASE64_ALPHABET.charAt((chunk >> 18) & 63) +
      BASE64_ALPHABET.charAt((chunk >> 12) & 63) +
      BASE64_ALPHABET.charAt((chunk >> 6) & 63) +
      BASE64_ALPHABET.charAt(chunk & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const chunk = (bytes[i] ?? 0) << 16;
    out +=
      BASE64_ALPHABET.charAt((chunk >> 18) & 63) +
      BASE64_ALPHABET.charAt((chunk >> 12) & 63) +
      '==';
  } else if (rest === 2) {
    const chunk = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out +=
      BASE64_ALPHABET.charAt((chunk >> 18) & 63) +
      BASE64_ALPHABET.charAt((chunk >> 12) & 63) +
      BASE64_ALPHABET.charAt((chunk >> 6) & 63) +
      '=';
  }
  return out;
}

function parseJson(raw: string): JsonValue {
  return JSON.parse(raw) as JsonValue;
}

function renderScopeLists(
  scopes: Readonly<Record<string, string[]>>,
): JsonValue {
  return Object.fromEntries(
    Object.entries(scopes).map(([key, values]) => [key, [...values]]),
  );
}

function renderStringMap(map: Readonly<Record<string, string>>): JsonValue {
  return { ...map };
}

function renderOperation(operation: PushOperation): JsonValue {
  return {
    table: operation.table,
    rowId: operation.rowId,
    op: operation.op,
    ...(operation.baseVersion !== undefined
      ? { baseVersion: operation.baseVersion }
      : {}),
    ...(operation.payload !== undefined
      ? { payload: bytesToBase64(operation.payload) }
      : {}),
  };
}

function renderResult(result: PushOperationResult): JsonValue {
  if (result.status === 'applied') {
    return { opIndex: result.opIndex, status: 'applied' };
  }
  if (result.status === 'conflict') {
    return {
      opIndex: result.opIndex,
      status: 'conflict',
      code: result.code,
      message: result.message,
      serverVersion: result.serverVersion,
      serverRow: bytesToBase64(result.serverRow),
    };
  }
  return {
    opIndex: result.opIndex,
    status: 'error',
    code: result.code,
    message: result.message,
    retryable: result.retryable,
  };
}

function renderChange(change: CommitChange): JsonValue {
  return {
    tableIndex: change.tableIndex,
    rowId: change.rowId,
    op: change.op,
    ...(change.rowVersion !== undefined
      ? { rowVersion: change.rowVersion }
      : {}),
    scopes: renderStringMap(change.scopes),
    ...(change.row !== undefined ? { row: bytesToBase64(change.row) } : {}),
  };
}

function renderFrame(frame: RequestFrame | ResponseFrame): JsonValue {
  switch (frame.type) {
    case 'REQ_HEADER':
      return {
        type: 'REQ_HEADER',
        clientId: frame.clientId,
        schemaVersion: frame.schemaVersion,
      };
    case 'PUSH_COMMIT':
      return {
        type: 'PUSH_COMMIT',
        clientCommitId: frame.clientCommitId,
        operations: frame.operations.map(renderOperation),
      };
    case 'PULL_HEADER':
      return {
        type: 'PULL_HEADER',
        limitCommits: frame.limitCommits,
        limitSnapshotRows: frame.limitSnapshotRows,
        maxSnapshotPages: frame.maxSnapshotPages,
        accept: frame.accept,
      };
    case 'SUBSCRIPTION':
      return {
        type: 'SUBSCRIPTION',
        id: frame.id,
        table: frame.table,
        scopes: renderScopeLists(frame.scopes),
        ...(frame.params !== undefined
          ? { params: parseJson(frame.params) }
          : {}),
        cursor: frame.cursor,
        ...(frame.bootstrapState !== undefined
          ? { bootstrapState: parseJson(frame.bootstrapState) }
          : {}),
      };
    case 'RESP_HEADER':
      return {
        type: 'RESP_HEADER',
        ...(frame.requiredSchemaVersion !== undefined
          ? { requiredSchemaVersion: frame.requiredSchemaVersion }
          : {}),
        ...(frame.latestSchemaVersion !== undefined
          ? { latestSchemaVersion: frame.latestSchemaVersion }
          : {}),
      };
    case 'PUSH_RESULT':
      return {
        type: 'PUSH_RESULT',
        clientCommitId: frame.clientCommitId,
        status: frame.status,
        ...(frame.commitSeq !== undefined
          ? { commitSeq: frame.commitSeq }
          : {}),
        results: frame.results.map(renderResult),
      };
    case 'SUB_START':
      return {
        type: 'SUB_START',
        id: frame.id,
        status: frame.status,
        reasonCode: frame.reasonCode,
        effectiveScopes: renderScopeLists(frame.effectiveScopes),
        bootstrap: frame.bootstrap,
      };
    case 'COMMIT':
      return {
        type: 'COMMIT',
        commitSeq: frame.commitSeq,
        createdAtMs: frame.createdAtMs,
        actorId: frame.actorId,
        tables: [...frame.tables],
        changes: frame.changes.map(renderChange),
      };
    case 'SEGMENT_REF':
      return {
        type: 'SEGMENT_REF',
        segmentId: frame.segmentId,
        mediaType: frame.mediaType,
        table: frame.table,
        byteLength: frame.byteLength,
        rowCount: frame.rowCount,
        asOfCommitSeq: frame.asOfCommitSeq,
        scopeDigest: frame.scopeDigest,
        ...(frame.rowCursor !== undefined
          ? { rowCursor: frame.rowCursor }
          : {}),
        ...(frame.nextRowCursor !== undefined
          ? { nextRowCursor: frame.nextRowCursor }
          : {}),
        ...(frame.url !== undefined ? { url: frame.url } : {}),
        ...(frame.urlExpiresAtMs !== undefined
          ? { urlExpiresAtMs: frame.urlExpiresAtMs }
          : {}),
      };
    case 'SEGMENT_INLINE':
      return {
        type: 'SEGMENT_INLINE',
        payload: bytesToBase64(frame.payload),
      };
    case 'SUB_END':
      return {
        type: 'SUB_END',
        nextCursor: frame.nextCursor,
        ...(frame.bootstrapState !== undefined
          ? { bootstrapState: parseJson(frame.bootstrapState) }
          : {}),
      };
    case 'ERROR':
      return {
        type: 'ERROR',
        code: frame.code,
        message: frame.message,
        category: frame.category,
        retryable: frame.retryable,
        recommendedAction: frame.recommendedAction,
        ...(frame.details !== undefined
          ? { details: parseJson(frame.details) }
          : {}),
      };
    case 'UNKNOWN':
      return {
        type: 'UNKNOWN',
        frameType: frame.frameType,
        payload: bytesToBase64(frame.payload),
      };
  }
}

export function renderMessageValue(message: SyncMessage): JsonValue {
  return {
    magic: 'SSP2',
    wireVersion: message.wireVersion,
    msgKind: message.msgKind,
    frames: message.frames.map((frame: RequestFrame | ResponseFrame) =>
      renderFrame(frame),
    ),
  };
}

/** `render(bytes) → json` for SSP2 messages (§11). */
export function renderMessage(bytes: Uint8Array): JsonValue {
  return renderMessageValue(decodeMessage(bytes));
}

function renderRowValue(column: RowColumn, value: RowValue): JsonValue {
  if (value === null) return null;
  if (value instanceof Uint8Array) return bytesToBase64(value);
  if (
    (column.type === 'json' || column.type === 'blob_ref') &&
    typeof value === 'string'
  ) {
    // §11: json and blob_ref (tag 7) render as embedded parsed JSON.
    return parseJson(value);
  }
  return value;
}

export function renderRowsSegmentValue(segment: RowsSegment): JsonValue {
  return {
    magic: 'SSG2',
    formatVersion: ROWS_SEGMENT_FORMAT_VERSION,
    table: segment.table,
    schemaVersion: segment.schemaVersion,
    columns: segment.columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
    })),
    blocks: segment.blocks.map((block) =>
      block.map((row) => ({
        serverVersion: row.serverVersion,
        values: Object.fromEntries(
          segment.columns.map((column, i) => [
            column.name,
            renderRowValue(column, row.values[i] ?? null),
          ]),
        ),
      })),
    ),
  };
}

/** `render(bytes) → json` for standalone SSG2 rows segments (§11 rule 8). */
export function renderRowsSegment(bytes: Uint8Array): JsonValue {
  return renderRowsSegmentValue(decodeRowsSegment(bytes));
}
