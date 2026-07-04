/**
 * Primitive readers/writers for the SPEC.md Conventions table.
 *
 * All multi-byte integers are little-endian, fixed-width (no varints).
 * The encoding is canonical: for every value there is exactly one valid
 * byte sequence, so the reader rejects non-minimal presence bytes,
 * out-of-order map keys, out-of-range bools, and i64 values outside the
 * JS safe-integer contract.
 */
import { DecodeError } from './errors';

const MAX_SAFE_I64 = 9007199254740991n; // 2^53 - 1
const MIN_SAFE_I64 = -9007199254740991n;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

/** Growable little-endian byte sink. Encoder misuse throws plain `Error`. */
export class ByteWriter {
  #buffer = new Uint8Array(256);
  #view = new DataView(this.#buffer.buffer);
  #length = 0;

  #reserve(extra: number): number {
    const offset = this.#length;
    const needed = offset + extra;
    if (needed > this.#buffer.length) {
      let capacity = this.#buffer.length;
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.#buffer.subarray(0, offset));
      this.#buffer = grown;
      this.#view = new DataView(grown.buffer);
    }
    this.#length = needed;
    return offset;
  }

  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new Error(`u8 out of range: ${value}`);
    }
    const offset = this.#reserve(1);
    this.#view.setUint8(offset, value);
  }

  u16(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`u16 out of range: ${value}`);
    }
    const offset = this.#reserve(2);
    this.#view.setUint16(offset, value, true);
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`u32 out of range: ${value}`);
    }
    const offset = this.#reserve(4);
    this.#view.setUint32(offset, value, true);
  }

  i32(value: number): void {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
      throw new Error(`i32 out of range: ${value}`);
    }
    const offset = this.#reserve(4);
    this.#view.setInt32(offset, value, true);
  }

  i64(value: number): void {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`i64 outside the safe-integer contract: ${value}`);
    }
    const offset = this.#reserve(8);
    this.#view.setBigInt64(offset, BigInt(value), true);
  }

  f64(value: number): void {
    const offset = this.#reserve(8);
    this.#view.setFloat64(offset, value, true);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  str(value: string): void {
    const encoded = textEncoder.encode(value);
    this.u32(encoded.length);
    this.raw(encoded);
  }

  bytes(value: Uint8Array): void {
    this.u32(value.length);
    this.raw(value);
  }

  raw(value: Uint8Array): void {
    const offset = this.#reserve(value.length);
    this.#buffer.set(value, offset);
  }

  opt<T>(value: T | undefined, write: (value: T) => void): void {
    if (value === undefined) {
      this.u8(0);
    } else {
      this.u8(1);
      write(value);
    }
  }

  finish(): Uint8Array {
    return this.#buffer.slice(0, this.#length);
  }
}

/** Bounds-checked little-endian reader. Failures throw `DecodeError`. */
export class ByteReader {
  #data: Uint8Array;
  #view: DataView;
  #position = 0;

  constructor(data: Uint8Array) {
    this.#data = data;
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.#data.length - this.#position;
  }

  #take(size: number): number {
    if (this.remaining < size) {
      throw new DecodeError(
        'sync.invalid_request',
        `truncated input: needed ${size} bytes, have ${this.remaining}`,
      );
    }
    const offset = this.#position;
    this.#position += size;
    return offset;
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1));
  }

  u16(): number {
    return this.#view.getUint16(this.#take(2), true);
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4), true);
  }

  i32(): number {
    return this.#view.getInt32(this.#take(4), true);
  }

  i64(): number {
    const value = this.#view.getBigInt64(this.#take(8), true);
    if (value > MAX_SAFE_I64 || value < MIN_SAFE_I64) {
      throw new DecodeError(
        'sync.invalid_request',
        `i64 outside the safe-integer contract: ${value}`,
      );
    }
    return Number(value);
  }

  f64(): number {
    return this.#view.getFloat64(this.#take(8), true);
  }

  bool(): boolean {
    const byte = this.u8();
    if (byte > 1) {
      throw new DecodeError(
        'sync.invalid_request',
        `invalid bool byte 0x${byte.toString(16)}`,
      );
    }
    return byte === 1;
  }

  raw(size: number): Uint8Array {
    const offset = this.#take(size);
    return this.#data.slice(offset, offset + size);
  }

  bytes(): Uint8Array {
    return this.raw(this.u32());
  }

  str(): string {
    const encoded = this.bytes();
    try {
      return textDecoder.decode(encoded);
    } catch {
      throw new DecodeError('sync.invalid_request', 'invalid UTF-8 in string');
    }
  }

  opt<T>(read: () => T): T | undefined {
    const presence = this.u8();
    if (presence === 0) return undefined;
    if (presence === 1) return read();
    throw new DecodeError(
      'sync.invalid_request',
      `invalid option presence byte 0x${presence.toString(16)}`,
    );
  }

  expectFullyConsumed(what: string): void {
    if (this.remaining !== 0) {
      throw new DecodeError(
        'sync.invalid_request',
        `trailing bytes after ${what}`,
      );
    }
  }
}

/**
 * `map` of `str` → `list(str)` (scope maps, SPEC.md Conventions).
 * Encoders emit keys in ascending code-unit order; the reader rejects
 * duplicate or out-of-order keys (canonical encoding).
 */
export function writeStringListMap(
  writer: ByteWriter,
  map: Readonly<Record<string, readonly string[]>>,
): void {
  const keys = Object.keys(map).sort();
  writer.u32(keys.length);
  for (const key of keys) {
    writer.str(key);
    const values = map[key] ?? [];
    writer.u32(values.length);
    for (const value of values) writer.str(value);
  }
}

export function readStringListMap(
  reader: ByteReader,
): Record<string, string[]> {
  const count = reader.u32();
  const entries: Array<[string, string[]]> = [];
  let previousKey: string | undefined;
  for (let i = 0; i < count; i++) {
    const key = reader.str();
    if (previousKey !== undefined && key <= previousKey) {
      throw new DecodeError(
        'sync.invalid_request',
        `map keys must be unique and in ascending code-unit order (saw ${JSON.stringify(key)} after ${JSON.stringify(previousKey)})`,
      );
    }
    previousKey = key;
    const valueCount = reader.u32();
    const values: string[] = [];
    for (let j = 0; j < valueCount; j++) values.push(reader.str());
    entries.push([key, values]);
  }
  return Object.fromEntries(entries);
}

/** `map` of `str` → `str` (stored scopes on change records, SPEC.md §4.5). */
export function writeStringMap(
  writer: ByteWriter,
  map: Readonly<Record<string, string>>,
): void {
  const keys = Object.keys(map).sort();
  writer.u32(keys.length);
  for (const key of keys) {
    writer.str(key);
    const value = map[key];
    writer.str(value ?? '');
  }
}

export function readStringMap(reader: ByteReader): Record<string, string> {
  const count = reader.u32();
  const entries: Array<[string, string]> = [];
  let previousKey: string | undefined;
  for (let i = 0; i < count; i++) {
    const key = reader.str();
    if (previousKey !== undefined && key <= previousKey) {
      throw new DecodeError(
        'sync.invalid_request',
        `map keys must be unique and in ascending code-unit order (saw ${JSON.stringify(key)} after ${JSON.stringify(previousKey)})`,
      );
    }
    previousKey = key;
    entries.push([key, reader.str()]);
  }
  return Object.fromEntries(entries);
}
