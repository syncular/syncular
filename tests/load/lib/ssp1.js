/**
 * Minimal SSP1 (binary-sync-pack-v1, wire version 14) reader for k6.
 *
 * Mirrors the decoder in packages/core/src/sync-packs.ts, but is
 * dependency-free so it runs inside k6's JS runtime (no zlib, no
 * TextDecoder, no Buffer). Little-endian throughout.
 *
 * What this reader CAN extract (the SSP1 envelope is not compressed):
 * - top-level: ok, requiredSchemaVersion, latestSchemaVersion
 * - push: ok + per-commit { ok, clientCommitId, status, commitSeq,
 *   results[] } including conflict/error details
 * - pull subscriptions: id, status, scopes, bootstrap flag,
 *   bootstrapState (plain JSON in the pack - round-trips into the next
 *   request body unchanged), nextCursor, integrity, commits with full
 *   per-change metadata (table, row_id, op, row_version, scopes), and
 *   snapshots (table, inline rows as JSON, chunk refs, page flags,
 *   bootstrapStateAfter, manifest, artifacts)
 *
 * What it CANNOT extract (and why):
 * - row_json bodies of changes that the server grouped into binary
 *   row-group payloads (SBT1 frames, typically gzip-backed). Those
 *   payloads are length-prefixed, so we skip them without decompressing;
 *   the affected changes keep row_json: null and carry a rowRef marker.
 *   Their row_id/op/scopes metadata is still fully available, so row-id
 *   level convergence tracking is unaffected.
 * - row contents of refs-only snapshots whose rows live in external
 *   gzip chunks (fetched via /api/sync/snapshot-chunks/:id). The chunk
 *   refs (id, byteLength, sha256) and the snapshot manifest JSON are
 *   readable; the row bytes are not.
 */

const SSP1_VERSION = 14;

/**
 * Quick envelope sniff: does the body start with the "SSP1" magic?
 * @param {ArrayBuffer|Uint8Array|null|undefined} body
 * @returns {boolean}
 */
export function isSyncPackBody(body) {
  const bytes = toUint8(body);
  return (
    bytes != null &&
    bytes.length >= 4 &&
    bytes[0] === 0x53 && // S
    bytes[1] === 0x53 && // S
    bytes[2] === 0x50 && // P
    bytes[3] === 0x31 // 1
  );
}

/**
 * Parse a full SSP1 combined sync response.
 * Throws on malformed/unsupported input; returns the decoded
 * SyncCombinedResponse-shaped object on success:
 * { ok, requiredSchemaVersion?, latestSchemaVersion?, push?, pull? }
 * @param {ArrayBuffer|Uint8Array} body
 */
export function parseSyncPack(body) {
  const bytes = toUint8(body);
  if (!bytes) {
    throw new Error('SSP1: body is not binary');
  }
  const r = new Ssp1Reader(bytes);
  r.magic();
  const version = r.u16();
  if (version !== SSP1_VERSION) {
    throw new Error(`SSP1: unsupported version ${version}`);
  }
  const flags = r.u16();
  if (flags !== 0) {
    throw new Error(`SSP1: unsupported flags ${flags}`);
  }

  const response = { ok: r.bool() };
  const requiredSchemaVersion = r.optional(() => r.i32());
  if (requiredSchemaVersion !== undefined) {
    response.requiredSchemaVersion = requiredSchemaVersion;
  }
  const latestSchemaVersion = r.optional(() => r.i32());
  if (latestSchemaVersion !== undefined) {
    response.latestSchemaVersion = latestSchemaVersion;
  }
  const push = r.optional(() => readPush(r));
  if (push) response.push = push;
  const pull = r.optional(() => readPull(r));
  if (pull) response.pull = pull;
  if (r.offset !== bytes.length) {
    throw new Error('SSP1: trailing bytes after pack');
  }
  return response;
}

function readPush(r) {
  return {
    ok: r.bool(),
    commits: r.list(() => readPushCommit(r)),
  };
}

function readPushCommit(r) {
  const commit = {
    ok: r.bool(),
    clientCommitId: r.string32(),
    status: pushCommitStatus(r.u8()),
  };
  const commitSeq = r.optional(() => r.i64());
  if (commitSeq !== undefined) commit.commitSeq = commitSeq;
  commit.results = r.list(() => readOperationResult(r));
  return commit;
}

function pushCommitStatus(byte) {
  if (byte === 1) return 'applied';
  if (byte === 2) return 'cached';
  if (byte === 3) return 'rejected';
  throw new Error(`SSP1: bad push commit status byte ${byte}`);
}

function readOperationResult(r) {
  const opIndex = r.i32();
  const status = r.u8();
  if (status === 1) {
    return { opIndex, status: 'applied' };
  }
  if (status === 2) {
    const message = r.string32();
    const code = r.optional(() => r.string32());
    const serverVersion = r.i64();
    const serverRow = r.json();
    const result = {
      opIndex,
      status: 'conflict',
      message,
      server_version: serverVersion,
      server_row: serverRow,
    };
    if (code !== undefined) result.code = code;
    return result;
  }
  if (status === 3) {
    const error = r.string32();
    const code = r.optional(() => r.string32());
    const retriable = r.optional(() => r.bool());
    const result = { opIndex, status: 'error', error };
    if (code !== undefined) result.code = code;
    if (retriable !== undefined) result.retriable = retriable;
    return result;
  }
  throw new Error(`SSP1: bad operation result status byte ${status}`);
}

function readPull(r) {
  return {
    ok: r.bool(),
    subscriptions: r.list(() => readSubscription(r)),
  };
}

function readSubscription(r) {
  const subscription = {
    id: r.string32(),
    status: r.string16(),
    scopes: r.json(),
    bootstrap: r.bool(),
  };
  // bootstrapState is plain JSON inside the pack; null when absent. The
  // value round-trips verbatim into the next pull request body.
  subscription.bootstrapState = r.optional(() => r.json()) ?? null;
  subscription.nextCursor = r.i64();
  const integrity = r.optional(() => ({
    partitionId: r.string32(),
    previousChainRoot: r.string32(),
    commitChainRoot: r.string32(),
    commitSeq: r.i64(),
  }));
  if (integrity) subscription.integrity = integrity;
  subscription.commits = r.list(() => readCommit(r));
  const snapshots = r.optional(() => r.list(() => readSnapshot(r)));
  if (snapshots) subscription.snapshots = snapshots;
  return subscription;
}

function readCommit(r) {
  return {
    commitSeq: r.i64(),
    createdAt: r.string32(),
    actorId: r.string32(),
    changes: readChanges(r),
  };
}

function readChanges(r) {
  const tableNames = r.list(() => r.string16());
  const scopeDict = r.list(() => r.stringMap());
  const changeCount = r.u32();
  const changes = [];
  for (let index = 0; index < changeCount; index += 1) {
    const tableIndex = r.u16();
    const table = tableNames[tableIndex];
    if (table === undefined) {
      throw new Error(`SSP1: bad change table index ${tableIndex}`);
    }
    const rowId = r.string32();
    const opByte = r.u8();
    if (opByte !== 1 && opByte !== 2) {
      throw new Error(`SSP1: bad change op byte ${opByte}`);
    }
    let rowJson = null;
    let rowRef;
    const payloadKind = r.u8();
    if (payloadKind === 1) {
      rowJson = r.json();
    } else if (payloadKind === 2) {
      // Row body lives in a (possibly gzip-backed) binary row group we
      // cannot decode in k6. Metadata below is still complete.
      rowRef = { groupIndex: r.u32(), rowIndex: r.u32() };
    } else if (payloadKind !== 0) {
      throw new Error(`SSP1: bad change row payload kind ${payloadKind}`);
    }
    const change = {
      table,
      row_id: rowId,
      op: opByte === 1 ? 'upsert' : 'delete',
      row_json: rowJson,
      row_version: r.optional(() => r.i64()) ?? null,
    };
    if (rowRef) change.rowRef = rowRef;
    const scopeIndex = r.u32();
    const scopes = scopeDict[scopeIndex];
    if (scopes === undefined) {
      throw new Error(`SSP1: bad change scope index ${scopeIndex}`);
    }
    change.scopes = scopes;
    changes.push(change);
  }

  // Binary row groups: length-prefixed SBT1 payloads. Skip the bytes
  // without decompressing; only validate the framing.
  const groupCount = r.u32();
  for (let group = 0; group < groupCount; group += 1) {
    r.u16(); // table index
    const byteLength = r.u32();
    r.skip(byteLength);
  }

  return changes;
}

function readSnapshot(r) {
  const snapshot = {
    table: r.string16(),
    rows: r.list(() => r.json()),
  };
  const chunks = r.optional(() =>
    r.list(() => ({
      id: r.string32(),
      byteLength: r.i64(),
      sha256: r.string16(),
      encoding: r.string16(),
      compression: r.string16(),
    }))
  );
  if (chunks) snapshot.chunks = chunks;
  snapshot.isFirstPage = r.bool();
  snapshot.isLastPage = r.bool();
  snapshot.bootstrapStateAfter = r.optional(() => r.json()) ?? null;
  const manifest = r.optional(() => r.json());
  if (manifest !== undefined) snapshot.manifest = manifest;
  const artifacts = r.optional(() => r.json());
  if (artifacts !== undefined) snapshot.artifacts = artifacts;
  return snapshot;
}

function toUint8(body) {
  if (body == null) return null;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  // k6 hands binary bodies over as ArrayBuffer; tolerate views.
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return null;
}

class Ssp1Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  require(length) {
    if (this.offset + length > this.bytes.length) {
      throw new Error('SSP1: read past end of pack');
    }
  }

  magic() {
    this.require(4);
    if (!isSyncPackBody(this.bytes)) {
      throw new Error('SSP1: bad magic');
    }
    this.offset += 4;
  }

  skip(length) {
    this.require(length);
    this.offset += length;
  }

  u8() {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  bool() {
    const value = this.u8();
    if (value !== 0 && value !== 1) {
      throw new Error(`SSP1: bad boolean byte ${value}`);
    }
    return value === 1;
  }

  u16() {
    this.require(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32() {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32() {
    this.require(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  // 64-bit little-endian signed integer without BigInt: exact for any
  // |value| <= Number.MAX_SAFE_INTEGER, which is what the writer enforces.
  i64() {
    this.require(8);
    const lo = this.view.getUint32(this.offset, true);
    const hi = this.view.getUint32(this.offset + 4, true);
    this.offset += 8;
    const signedHi = hi >= 0x80000000 ? hi - 0x100000000 : hi;
    const value = signedHi * 0x100000000 + lo;
    if (!Number.isSafeInteger(value)) {
      throw new Error('SSP1: int64 exceeds safe integer bounds');
    }
    return value;
  }

  string16() {
    return this.stringBytes(this.u16());
  }

  string32() {
    return this.stringBytes(this.u32());
  }

  stringBytes(length) {
    this.require(length);
    const start = this.offset;
    this.offset += length;
    return decodeUtf8(this.bytes, start, start + length);
  }

  json() {
    return JSON.parse(this.string32());
  }

  stringMap() {
    const length = this.u32();
    const out = {};
    for (let index = 0; index < length; index += 1) {
      const key = this.string16();
      out[key] = this.string32();
    }
    return out;
  }

  list(read) {
    const length = this.u32();
    const values = [];
    for (let index = 0; index < length; index += 1) {
      values.push(read());
    }
    return values;
  }

  optional(read) {
    const present = this.u8();
    if (present === 0) return undefined;
    if (present !== 1) {
      throw new Error(`SSP1: bad optional marker ${present}`);
    }
    return read();
  }
}

// Manual UTF-8 decoder (k6 has no TextDecoder). Handles the full range
// including surrogate pairs; invalid sequences become U+FFFD.
function decodeUtf8(bytes, start, end) {
  let out = '';
  let codes = [];
  for (let i = start; i < end; ) {
    const byte = bytes[i];
    let codePoint;
    if (byte < 0x80) {
      codePoint = byte;
      i += 1;
    } else if (byte < 0xc0) {
      codePoint = 0xfffd;
      i += 1;
    } else if (byte < 0xe0) {
      if (i + 1 < end) {
        codePoint = ((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
        i += 2;
      } else {
        codePoint = 0xfffd;
        i += 1;
      }
    } else if (byte < 0xf0) {
      if (i + 2 < end) {
        codePoint =
          ((byte & 0x0f) << 12) |
          ((bytes[i + 1] & 0x3f) << 6) |
          (bytes[i + 2] & 0x3f);
        i += 3;
      } else {
        codePoint = 0xfffd;
        i = end;
      }
    } else {
      if (i + 3 < end) {
        codePoint =
          ((byte & 0x07) << 18) |
          ((bytes[i + 1] & 0x3f) << 12) |
          ((bytes[i + 2] & 0x3f) << 6) |
          (bytes[i + 3] & 0x3f);
        i += 4;
      } else {
        codePoint = 0xfffd;
        i = end;
      }
    }

    if (codePoint > 0xffff) {
      const offsetPoint = codePoint - 0x10000;
      codes.push(0xd800 + (offsetPoint >> 10), 0xdc00 + (offsetPoint & 0x3ff));
    } else {
      codes.push(codePoint);
    }

    if (codes.length >= 4096) {
      out += String.fromCharCode.apply(null, codes);
      codes = [];
    }
  }
  if (codes.length > 0) {
    out += String.fromCharCode.apply(null, codes);
  }
  return out;
}
