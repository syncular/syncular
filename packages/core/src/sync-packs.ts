/**
 * Binary sync-pack helpers.
 *
 * `binary-sync-pack-v1` removes the repeated JSON field-name envelope around
 * combined sync responses. Commit/subscription/snapshot protocol metadata is
 * encoded positionally, and incremental row bodies can be grouped into
 * generated binary table payloads when table encoders are available.
 *
 * Wire versions:
 * - v6: positional envelope with refs-only snapshot chunks, per-pack table
 *   dictionaries, and grouped generated binary row payloads for incremental
 *   changes.
 */

import {
  decodeBinarySnapshotTable,
  type BinarySnapshotRowsEncoder,
} from './snapshot-chunks';
import type {
  SyncChange,
  SyncCombinedResponse,
  SyncCommit,
  SyncOperationResult,
  SyncPullResponse,
  SyncPullSubscriptionResponse,
  SyncPushBatchResponse,
  SyncPushBatchCommitResponse,
  SyncSnapshot,
  SyncSnapshotChunkRef,
} from './schemas/sync';
import type { ScopeValues } from './scopes';

export const SYNC_PACK_ENCODING_JSON_V1 = 'json-v1';
export const SYNC_PACK_ENCODING_BINARY_V1 = 'binary-sync-pack-v1';
export const SYNC_PACK_ENCODINGS = [
  SYNC_PACK_ENCODING_JSON_V1,
  SYNC_PACK_ENCODING_BINARY_V1,
] as const;
export type SyncPackEncoding = (typeof SYNC_PACK_ENCODINGS)[number];

export const SYNC_PACK_CONTENT_TYPE = 'application/vnd.syncular.sync-pack.v1';

const MAGIC = new Uint8Array([0x53, 0x53, 0x50, 0x31]); // "SSP1"
const VERSION = 6;
const FLAG_NONE = 0;
// Row-group framing carries table/schema overhead; small commits are
// cheaper inline.
const MIN_BINARY_CHANGE_ROW_GROUP_ROWS = 8;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface BinarySyncPackEncodeOptions {
  changeRowEncoders?: Partial<Record<string, BinarySnapshotRowsEncoder>>;
}

interface BinaryChangeRowGroup {
  table: string;
  tableIndex: number;
  encoder: BinarySnapshotRowsEncoder;
  rows: unknown[];
}

interface BinaryChangeRowRef {
  groupIndex: number;
  rowIndex: number;
}

interface PendingBinaryChangeRowRef extends BinaryChangeRowRef {
  changeIndex: number;
  table: string;
}

export function isSyncPackEncoding(value: unknown): value is SyncPackEncoding {
  return (
    typeof value === 'string' &&
    (SYNC_PACK_ENCODINGS as readonly string[]).includes(value)
  );
}

export function isBinarySyncPackContentType(value: string | null): boolean {
  return value?.split(';', 1)[0]?.trim() === SYNC_PACK_CONTENT_TYPE;
}

export function prefersBinarySyncPack(
  encodings: readonly SyncPackEncoding[] | undefined
): boolean {
  return encodings?.includes(SYNC_PACK_ENCODING_BINARY_V1) === true;
}

export function encodeBinarySyncPack(
  response: SyncCombinedResponse,
  options: BinarySyncPackEncodeOptions = {}
): Uint8Array {
  const writer = new BinarySyncPackWriter();
  writer.bytes(MAGIC);
  writer.u16(VERSION);
  writer.u16(FLAG_NONE);
  writer.bool(response.ok);
  writer.optionalI32(response.requiredSchemaVersion);
  writer.optionalI32(response.latestSchemaVersion);
  writer.optionalValue(response.push, writePushResponse);
  writer.optionalValue(response.pull, (nextWriter, pull) =>
    writePullResponse(nextWriter, pull, options)
  );
  return writer.finish();
}

export function decodeBinarySyncPack(bytes: Uint8Array): SyncCombinedResponse {
  const reader = new BinarySyncPackReader(bytes);
  reader.expectMagic(MAGIC, 'binary sync pack');
  const version = reader.u16('binary sync pack version');
  if (version !== VERSION) {
    throw new Error(`Unsupported binary sync pack version: ${version}`);
  }
  const flags = reader.u16('binary sync pack flags');
  if (flags !== FLAG_NONE) {
    throw new Error(`Unsupported binary sync pack flags: ${flags}`);
  }
  const response: SyncCombinedResponse = {
    ok: reader.bool('combined response ok') as true,
  };
  const requiredSchemaVersion = reader.optionalI32('required schema version');
  if (requiredSchemaVersion !== undefined) {
    response.requiredSchemaVersion = requiredSchemaVersion;
  }
  const latestSchemaVersion = reader.optionalI32('latest schema version');
  if (latestSchemaVersion !== undefined) {
    response.latestSchemaVersion = latestSchemaVersion;
  }
  const push = reader.optionalValue(readPushResponse);
  if (push) response.push = push;
  const pull = reader.optionalValue(readPullResponse);
  if (pull) response.pull = pull;
  reader.assertDone();
  return response;
}

function writePushResponse(
  writer: BinarySyncPackWriter,
  push: SyncPushBatchResponse
): void {
  writer.bool(push.ok);
  writer.array(push.commits, writePushCommitResponse);
}

function readPushResponse(reader: BinarySyncPackReader): SyncPushBatchResponse {
  return {
    ok: reader.bool('push response ok') as true,
    commits: reader.array('push commits', readPushCommitResponse),
  };
}

function writePushCommitResponse(
  writer: BinarySyncPackWriter,
  commit: SyncPushBatchCommitResponse
): void {
  writer.bool(commit.ok);
  writer.string32(commit.clientCommitId);
  writer.string16(commit.status);
  writer.optionalI64(commit.commitSeq);
  writer.array(commit.results, writeOperationResult);
}

function readPushCommitResponse(
  reader: BinarySyncPackReader
): SyncPushBatchCommitResponse {
  const commit: SyncPushBatchCommitResponse = {
    ok: reader.bool('push commit ok') as true,
    clientCommitId: reader.string32('push client commit id'),
    status: reader.string16('push commit status') as
      | 'applied'
      | 'cached'
      | 'rejected',
    results: [],
  };
  const commitSeq = reader.optionalI64('push commit seq');
  if (commitSeq !== undefined) commit.commitSeq = commitSeq;
  commit.results = reader.array('push operation results', readOperationResult);
  return commit;
}

function writeOperationResult(
  writer: BinarySyncPackWriter,
  result: SyncOperationResult
): void {
  writer.i32(result.opIndex);
  writer.string16(result.status);
  if (result.status === 'applied') {
    writer.optionalString32(undefined);
    writer.optionalString32(undefined);
    writer.optionalString32(undefined);
    writer.optionalBool(undefined);
    writer.optionalI64(undefined);
    writer.optionalJson(undefined);
    return;
  }
  writer.optionalString32('message' in result ? result.message : undefined);
  writer.optionalString32('error' in result ? result.error : undefined);
  writer.optionalString32(result.code);
  writer.optionalBool('retriable' in result ? result.retriable : undefined);
  writer.optionalI64(
    'server_version' in result ? result.server_version : undefined
  );
  writer.optionalJson('server_row' in result ? result.server_row : undefined);
}

function readOperationResult(
  reader: BinarySyncPackReader
): SyncOperationResult {
  const opIndex = reader.i32('operation result index');
  const status = reader.string16('operation result status');
  const message = reader.optionalString32('operation result message');
  const error = reader.optionalString32('operation result error');
  const code = reader.optionalString32('operation result code');
  const retriable = reader.optionalBool('operation result retriable');
  const serverVersion = reader.optionalI64('operation result server version');
  const serverRow = reader.optionalJson('operation result server row');

  if (status === 'applied') {
    return { opIndex, status };
  }
  if (status === 'conflict') {
    if (message === undefined || serverVersion === undefined) {
      throw new Error('Binary sync pack conflict result is incomplete');
    }
    return {
      opIndex,
      status,
      message,
      ...(code !== undefined ? { code } : {}),
      server_version: serverVersion,
      server_row: serverRow,
    };
  }
  if (status === 'error') {
    if (error === undefined) {
      throw new Error('Binary sync pack error result is incomplete');
    }
    return {
      opIndex,
      status,
      error,
      ...(code !== undefined ? { code } : {}),
      ...(retriable !== undefined ? { retriable } : {}),
    };
  }
  throw new Error(`Unsupported operation result status: ${status}`);
}

function writePullResponse(
  writer: BinarySyncPackWriter,
  pull: SyncPullResponse,
  options: BinarySyncPackEncodeOptions
): void {
  writer.bool(pull.ok);
  writer.array(pull.subscriptions, (nextWriter, subscription) =>
    writeSubscriptionResponse(nextWriter, subscription, options)
  );
}

function readPullResponse(reader: BinarySyncPackReader): SyncPullResponse {
  return {
    ok: reader.bool('pull response ok') as true,
    subscriptions: reader.array('pull subscriptions', readSubscriptionResponse),
  };
}

function writeSubscriptionResponse(
  writer: BinarySyncPackWriter,
  subscription: SyncPullSubscriptionResponse,
  options: BinarySyncPackEncodeOptions
): void {
  writer.string32(subscription.id);
  writer.string16(subscription.status);
  writer.json(subscription.scopes);
  writer.bool(subscription.bootstrap);
  writer.optionalJson(subscription.bootstrapState ?? undefined);
  writer.i64(subscription.nextCursor);
  writer.array(subscription.commits, (nextWriter, commit) =>
    writeCommit(nextWriter, commit, options)
  );
  writer.optionalArray(subscription.snapshots, writeSnapshot);
}

function readSubscriptionResponse(
  reader: BinarySyncPackReader
): SyncPullSubscriptionResponse {
  const subscription: SyncPullSubscriptionResponse = {
    id: reader.string32('subscription id'),
    status: reader.string16('subscription status') as 'active' | 'revoked',
    scopes: reader.json('subscription scopes') as ScopeValues,
    bootstrap: reader.bool('subscription bootstrap'),
    nextCursor: 0,
    commits: [],
  };
  const bootstrapState = reader.optionalJson('subscription bootstrap state');
  subscription.bootstrapState =
    (bootstrapState as SyncPullSubscriptionResponse['bootstrapState']) ?? null;
  subscription.nextCursor = reader.i64('subscription next cursor');
  subscription.commits = reader.array('subscription commits', readCommit);
  const snapshots = reader.optionalArray(
    'subscription snapshots',
    readSnapshot
  );
  if (snapshots) subscription.snapshots = snapshots;
  return subscription;
}

function writeCommit(
  writer: BinarySyncPackWriter,
  commit: SyncCommit,
  options: BinarySyncPackEncodeOptions
): void {
  writer.i64(commit.commitSeq);
  writer.string32(commit.createdAt);
  writer.string32(commit.actorId);
  writeChanges(writer, commit.changes, options);
}

function readCommit(reader: BinarySyncPackReader): SyncCommit {
  return {
    commitSeq: reader.i64('commit seq'),
    createdAt: reader.string32('commit createdAt'),
    actorId: reader.string32('commit actorId'),
    changes: readChangesV6(reader),
  };
}

function writeChanges(
  writer: BinarySyncPackWriter,
  changes: readonly SyncChange[],
  options: BinarySyncPackEncodeOptions
): void {
  const encodedRowCountsByTable = new Map<string, number>();
  const tableIndexesByName = new Map<string, number>();
  const tableNames: string[] = [];
  const tableIndexFor = (table: string): number => {
    let tableIndex = tableIndexesByName.get(table);
    if (tableIndex !== undefined) return tableIndex;
    tableIndex = tableNames.length;
    tableIndexesByName.set(table, tableIndex);
    tableNames.push(table);
    return tableIndex;
  };

  for (const change of changes) {
    tableIndexFor(change.table);
    if (change.op === 'delete' || change.row_json == null) continue;
    if (!options.changeRowEncoders?.[change.table]) continue;
    encodedRowCountsByTable.set(
      change.table,
      (encodedRowCountsByTable.get(change.table) ?? 0) + 1
    );
  }

  const rowRefs = new Map<number, BinaryChangeRowRef>();
  const groups: BinaryChangeRowGroup[] = [];
  const groupIndexesByTable = new Map<string, number>();

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    if (change.op === 'delete' || change.row_json == null) continue;
    const encoder = options.changeRowEncoders?.[change.table];
    if (!encoder) continue;
    if (
      (encodedRowCountsByTable.get(change.table) ?? 0) <
      MIN_BINARY_CHANGE_ROW_GROUP_ROWS
    ) {
      continue;
    }
    let groupIndex = groupIndexesByTable.get(change.table);
    if (groupIndex === undefined) {
      const tableIndex = tableIndexFor(change.table);
      groupIndex = groups.length;
      groupIndexesByTable.set(change.table, groupIndex);
      groups.push({ table: change.table, tableIndex, encoder, rows: [] });
    }
    const group = groups[groupIndex]!;
    const rowIndex = group.rows.length;
    group.rows.push(change.row_json);
    rowRefs.set(index, { groupIndex, rowIndex });
  }

  writer.array(tableNames, (nextWriter, table) => nextWriter.string16(table));
  writer.u32(changes.length);
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]!;
    writeChangeMetadataV6(
      writer,
      change,
      tableIndexFor(change.table),
      rowRefs.get(index)
    );
  }
  writer.u32(groups.length);
  for (const group of groups) {
    writer.u16(group.tableIndex);
    writer.bytes32(group.encoder(group.rows));
  }
}

function writeChangeMetadataV6(
  writer: BinarySyncPackWriter,
  change: SyncChange,
  tableIndex: number,
  rowRef: BinaryChangeRowRef | undefined
): void {
  writer.u16(tableIndex);
  writer.string32(change.row_id);
  writer.u8(change.op === 'upsert' ? 1 : 2);
  if (change.row_json == null) {
    writer.u8(0);
  } else if (rowRef) {
    writer.u8(2);
    writer.u32(rowRef.groupIndex);
    writer.u32(rowRef.rowIndex);
  } else {
    writer.u8(1);
    writer.json(change.row_json);
  }
  writer.optionalI64(change.row_version ?? undefined);
  writer.stringMap(change.scopes);
}

function readChangesV6(reader: BinarySyncPackReader): SyncChange[] {
  const tableNames = reader.array('commit change table dictionary', (reader) =>
    reader.string16('commit change table')
  );
  const changeCount = reader.u32('commit changes length');
  const changes: SyncChange[] = [];
  const rowRefs: PendingBinaryChangeRowRef[] = [];
  for (let index = 0; index < changeCount; index += 1) {
    const change = readChangeMetadataV6(reader, index, tableNames, rowRefs);
    changes.push(change);
  }

  const groupCount = reader.u32('binary change row group count');
  const groupRows = new Map<number, Record<string, unknown>[]>();
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const table = tableNameAt(
      tableNames,
      reader.u16('binary change row group table index')
    );
    const decoded = decodeBinarySnapshotTable(
      reader.bytes32('binary change row group payload')
    );
    if (decoded.table !== table) {
      throw new Error(
        `Binary sync pack row group table mismatch: expected ${table}, got ${decoded.table}`
      );
    }
    groupRows.set(groupIndex, decoded.rows);
  }

  for (const ref of rowRefs) {
    const rows = groupRows.get(ref.groupIndex);
    const row = rows?.[ref.rowIndex];
    if (!row) {
      throw new Error(
        `Binary sync pack change row ref is invalid: group=${ref.groupIndex}, row=${ref.rowIndex}`
      );
    }
    if (changes[ref.changeIndex]?.table !== ref.table) {
      throw new Error('Binary sync pack row ref table mismatch');
    }
    changes[ref.changeIndex]!.row_json = row;
  }

  return changes;
}

function readChangeMetadataV6(
  reader: BinarySyncPackReader,
  changeIndex: number,
  tableNames: readonly string[],
  rowRefs: PendingBinaryChangeRowRef[]
): SyncChange {
  const table = tableNameAt(tableNames, reader.u16('change table index'));
  const rowId = reader.string32('change row id');
  const opByte = reader.u8('change op');
  if (opByte !== 1 && opByte !== 2) {
    throw new Error(`Unsupported binary sync pack change op byte: ${opByte}`);
  }
  let rowJson: SyncChange['row_json'] = null;
  const rowPayloadKind = reader.u8('change row payload kind');
  if (rowPayloadKind === 1) {
    rowJson = reader.json('change row json');
  } else if (rowPayloadKind === 2) {
    rowRefs.push({
      changeIndex,
      table,
      groupIndex: reader.u32('change row group index'),
      rowIndex: reader.u32('change row group row index'),
    });
  } else if (rowPayloadKind !== 0) {
    throw new Error(
      `Unsupported binary sync pack change row payload kind: ${rowPayloadKind}`
    );
  }
  return {
    table,
    row_id: rowId,
    op: opByte === 1 ? 'upsert' : 'delete',
    row_json: rowJson,
    row_version: reader.optionalI64('change row version') ?? null,
    scopes: reader.stringMap('change scopes'),
  };
}

function tableNameAt(tableNames: readonly string[], index: number): string {
  const table = tableNames[index];
  if (table === undefined) {
    throw new Error(`Binary sync pack table index is invalid: ${index}`);
  }
  return table;
}

function writeSnapshot(
  writer: BinarySyncPackWriter,
  snapshot: SyncSnapshot
): void {
  writer.string16(snapshot.table);
  writer.array(snapshot.rows, (nextWriter, row) => nextWriter.json(row));
  writer.optionalArray(snapshot.chunks, writeSnapshotChunkRef);
  writer.bool(snapshot.isFirstPage);
  writer.bool(snapshot.isLastPage);
}

function readSnapshot(reader: BinarySyncPackReader): SyncSnapshot {
  const snapshot: SyncSnapshot = {
    table: reader.string16('snapshot table'),
    rows: reader.array('snapshot rows', (nextReader) =>
      nextReader.json('snapshot row')
    ),
    isFirstPage: false,
    isLastPage: false,
  };
  const chunks = reader.optionalArray('snapshot chunks', readSnapshotChunkRef);
  if (chunks) snapshot.chunks = chunks;
  snapshot.isFirstPage = reader.bool('snapshot first page');
  snapshot.isLastPage = reader.bool('snapshot last page');
  return snapshot;
}

function writeSnapshotChunkRef(
  writer: BinarySyncPackWriter,
  chunk: SyncSnapshotChunkRef
): void {
  writer.string32(chunk.id);
  writer.i64(chunk.byteLength);
  writer.string16(chunk.sha256);
  writer.string16(chunk.encoding);
  writer.string16(chunk.compression);
}

function readSnapshotChunkRef(
  reader: BinarySyncPackReader
): SyncSnapshotChunkRef {
  return {
    id: reader.string32('snapshot chunk id'),
    byteLength: reader.i64('snapshot chunk byte length'),
    sha256: reader.string16('snapshot chunk sha256'),
    encoding: reader.string16(
      'snapshot chunk encoding'
    ) as SyncSnapshotChunkRef['encoding'],
    compression: reader.string16(
      'snapshot chunk compression'
    ) as SyncSnapshotChunkRef['compression'],
  };
}

class BinarySyncPackWriter {
  private bytesOut: Uint8Array;
  private view: DataView;
  private offset = 0;

  constructor(initialCapacity = 1024) {
    this.bytesOut = new Uint8Array(Math.max(64, initialCapacity));
    this.view = new DataView(
      this.bytesOut.buffer,
      this.bytesOut.byteOffset,
      this.bytesOut.length
    );
  }

  finish(): Uint8Array {
    return this.bytesOut.subarray(0, this.offset);
  }

  bytes(value: Uint8Array): void {
    this.ensure(value.length);
    this.bytesOut.set(value, this.offset);
    this.offset += value.length;
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  optionalBool(value: boolean | undefined): void {
    this.optionalValue(value, (writer, nextValue) => writer.bool(nextValue));
  }

  u8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  u16(value: number): void {
    assertUnsigned(value, 0xffff, 'uint16');
    this.ensure(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  u32(value: number): void {
    assertUnsigned(value, 0xffff_ffff, 'uint32');
    this.ensure(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }

  i32(value: number): void {
    assertSigned(value, -0x8000_0000, 0x7fff_ffff, 'int32');
    this.ensure(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  optionalI32(value: number | undefined): void {
    this.optionalValue(value, (writer, nextValue) => writer.i32(nextValue));
  }

  i64(value: number): void {
    if (!Number.isSafeInteger(value)) {
      throw new Error('int64 value must be a safe integer');
    }
    this.ensure(8);
    if (value >= 0) {
      this.view.setUint32(this.offset, value >>> 0, true);
      this.view.setUint32(
        this.offset + 4,
        Math.floor(value / 0x1_0000_0000),
        true
      );
    } else {
      this.view.setBigInt64(this.offset, BigInt(value), true);
    }
    this.offset += 8;
  }

  optionalI64(value: number | undefined | null): void {
    this.optionalValue(value ?? undefined, (writer, nextValue) =>
      writer.i64(nextValue)
    );
  }

  string16(value: string): void {
    if (this.writeAsciiString16(value)) return;
    const bytes = textEncoder.encode(value);
    this.u16(bytes.length);
    this.bytes(bytes);
  }

  string32(value: string): void {
    if (this.writeAsciiString32(value)) return;
    const bytes = textEncoder.encode(value);
    this.u32(bytes.length);
    this.bytes(bytes);
  }

  optionalString32(value: string | undefined): void {
    this.optionalValue(value, (writer, nextValue) =>
      writer.string32(nextValue)
    );
  }

  bytes32(value: Uint8Array): void {
    this.u32(value.length);
    this.bytes(value);
  }

  json(value: unknown): void {
    this.string32(JSON.stringify(value) ?? 'null');
  }

  stringMap(value: Record<string, string>): void {
    const entries = Object.entries(value);
    this.u32(entries.length);
    for (const [key, nextValue] of entries) {
      this.string16(key);
      this.string32(nextValue);
    }
  }

  optionalJson(value: unknown | undefined): void {
    this.optionalValue(value, (writer, nextValue) => writer.json(nextValue));
  }

  array<T>(
    values: readonly T[],
    write: (writer: BinarySyncPackWriter, value: T) => void
  ): void {
    this.u32(values.length);
    for (const value of values) {
      write(this, value);
    }
  }

  optionalArray<T>(
    values: readonly T[] | undefined,
    write: (writer: BinarySyncPackWriter, value: T) => void
  ): void {
    this.optionalValue(values, (writer, nextValues) =>
      writer.array(nextValues, write)
    );
  }

  optionalValue<T>(
    value: T | undefined,
    write: (writer: BinarySyncPackWriter, value: T) => void
  ): void {
    if (value === undefined) {
      this.u8(0);
      return;
    }
    this.u8(1);
    write(this, value);
  }

  private ensure(length: number): void {
    const required = this.offset + length;
    if (required <= this.bytesOut.length) return;
    let nextLength = this.bytesOut.length;
    while (nextLength < required) {
      nextLength *= 2;
    }
    const next = new Uint8Array(nextLength);
    next.set(this.bytesOut, 0);
    this.bytesOut = next;
    this.view = new DataView(
      this.bytesOut.buffer,
      this.bytesOut.byteOffset,
      this.bytesOut.length
    );
  }

  private writeAsciiString16(value: string): boolean {
    assertUnsigned(value.length, 0xffff, 'uint16');
    const start = this.offset;
    this.u16(value.length);
    return this.tryWriteAsciiBytes(value, start);
  }

  private writeAsciiString32(value: string): boolean {
    assertUnsigned(value.length, 0xffff_ffff, 'uint32');
    const start = this.offset;
    this.u32(value.length);
    return this.tryWriteAsciiBytes(value, start);
  }

  private tryWriteAsciiBytes(value: string, rollbackOffset: number): boolean {
    this.ensure(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code > 0x7f) {
        this.offset = rollbackOffset;
        return false;
      }
      this.bytesOut[this.offset + index] = code;
    }
    this.offset += value.length;
    return true;
  }
}

class BinarySyncPackReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  expectMagic(magic: Uint8Array, label: string): void {
    const actual = this.bytesSlice(magic.length, `${label} magic`);
    for (let index = 0; index < magic.length; index += 1) {
      if (actual[index] !== magic[index]) {
        throw new Error(`Unexpected ${label} magic`);
      }
    }
  }

  bool(label: string): boolean {
    const value = this.u8(label);
    if (value !== 0 && value !== 1) {
      throw new Error(`${label} expected boolean byte`);
    }
    return value === 1;
  }

  optionalBool(label: string): boolean | undefined {
    return this.optionalValue((reader) => reader.bool(label));
  }

  u8(label: string): number {
    this.require(1, label);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(label: string): number {
    this.require(2, label);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(label: string): number {
    this.require(4, label);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(label: string): number {
    this.require(4, label);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  optionalI32(label: string): number | undefined {
    return this.optionalValue((reader) => reader.i32(label));
  }

  i64(label: string): number {
    this.require(8, label);
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber) || BigInt(asNumber) !== value) {
      throw new Error(`${label} exceeds JavaScript safe integer bounds`);
    }
    return asNumber;
  }

  optionalI64(label: string): number | undefined {
    return this.optionalValue((reader) => reader.i64(label));
  }

  string16(label: string): string {
    const length = this.u16(`${label} length`);
    return textDecoder.decode(this.bytesSlice(length, label));
  }

  string32(label: string): string {
    const length = this.u32(`${label} length`);
    return textDecoder.decode(this.bytesSlice(length, label));
  }

  optionalString32(label: string): string | undefined {
    return this.optionalValue((reader) => reader.string32(label));
  }

  bytes32(label: string): Uint8Array {
    const length = this.u32(`${label} length`);
    return this.bytesSlice(length, label);
  }

  json(label: string): unknown {
    return JSON.parse(this.string32(label));
  }

  stringMap(label: string): Record<string, string> {
    const length = this.u32(`${label} length`);
    const out: Record<string, string> = {};
    for (let index = 0; index < length; index += 1) {
      out[this.string16(`${label} key`)] = this.string32(`${label} value`);
    }
    return out;
  }

  optionalJson(label: string): unknown | undefined {
    return this.optionalValue((reader) => reader.json(label));
  }

  array<T>(label: string, read: (reader: BinarySyncPackReader) => T): T[] {
    const length = this.u32(`${label} length`);
    const values: T[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(read(this));
    }
    return values;
  }

  optionalArray<T>(
    label: string,
    read: (reader: BinarySyncPackReader) => T
  ): T[] | undefined {
    return this.optionalValue((reader) => reader.array(label, read));
  }

  optionalValue<T>(read: (reader: BinarySyncPackReader) => T): T | undefined {
    const present = this.u8('optional value present');
    if (present === 0) return undefined;
    if (present !== 1) {
      throw new Error(`Optional value marker must be 0 or 1, got ${present}`);
    }
    return read(this);
  }

  bytesSlice(length: number, label: string): Uint8Array {
    this.require(length, label);
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  assertDone(): void {
    if (this.offset !== this.bytes.length) {
      throw new Error('Binary sync pack has trailing bytes');
    }
  }

  private require(length: number, label: string): void {
    if (this.offset + length > this.bytes.length) {
      throw new Error(`${label} exceeds binary sync pack bounds`);
    }
  }
}

function assertUnsigned(value: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} value is out of range`);
  }
}

function assertSigned(
  value: number,
  min: number,
  max: number,
  label: string
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} value is out of range`);
  }
}
