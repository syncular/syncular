/**
 * Golden vector conformance (spec/vectors/README.md):
 * 1. every .bin decodes and its §11 rendering deep-equals the .json;
 * 2. re-encoding the decoded value reproduces the .bin byte-for-byte;
 * 3. every invalid/ case fails with the error named in manifest.json.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DecodeError,
  decodeMessage,
  decodeRowsSegment,
  encodeMessage,
  encodeRowsSegment,
  type JsonValue,
  parseRealtimeServerEvent,
  renderMessageValue,
  renderRowsSegmentValue,
} from './index';

const vectorsDir = join(import.meta.dir, '../../../spec/vectors');

interface ManifestCase {
  name: string;
  bin?: string;
  json: string;
  covers: string;
}

interface ManifestInvalid {
  name: string;
  /** Binary kinds: bytes that must fail decoding. */
  bin?: string;
  /** Realtime: JSON text that must fail control-message parsing. */
  json?: string;
  error: string;
  covers: string;
}

interface Manifest {
  kind: string;
  cases: ManifestCase[];
  invalid: ManifestInvalid[];
}

function loadManifest(kind: string): Manifest {
  return JSON.parse(
    readFileSync(join(vectorsDir, kind, 'manifest.json'), 'utf8'),
  ) as Manifest;
}

function loadBin(kind: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(vectorsDir, kind, file)));
}

function loadJson(kind: string, file: string): JsonValue {
  return JSON.parse(
    readFileSync(join(vectorsDir, kind, file), 'utf8'),
  ) as JsonValue;
}

function expectNamedDecodeError(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DecodeError);
  expect((thrown as DecodeError).code).toBe(code);
}

for (const kind of ['request', 'response'] as const) {
  const manifest = loadManifest(kind);
  describe(`vectors/${kind}`, () => {
    expect(manifest.cases.length).toBeGreaterThan(0);
    for (const c of manifest.cases) {
      it(`${c.name}: decode, render, byte-exact re-encode`, () => {
        const bin = loadBin(kind, c.bin ?? `${c.name}.bin`);
        const message = decodeMessage(bin);
        expect(message.msgKind).toBe(kind);
        expect(renderMessageValue(message)).toEqual(loadJson(kind, c.json));
        expect(encodeMessage(message)).toEqual(bin);
      });
    }
    for (const c of manifest.invalid) {
      it(`invalid/${c.name}: fails with ${c.error}`, () => {
        const bin = loadBin(kind, c.bin ?? `invalid/${c.name}.bin`);
        expectNamedDecodeError(() => decodeMessage(bin), c.error);
      });
    }
  });
}

describe('vectors/segment', () => {
  const manifest = loadManifest('segment');
  expect(manifest.cases.length).toBeGreaterThan(0);
  for (const c of manifest.cases) {
    it(`${c.name}: decode, render, byte-exact re-encode`, () => {
      const bin = loadBin('segment', c.bin ?? `${c.name}.bin`);
      const segment = decodeRowsSegment(bin);
      expect(renderRowsSegmentValue(segment)).toEqual(
        loadJson('segment', c.json),
      );
      expect(encodeRowsSegment(segment)).toEqual(bin);
    });
  }
  for (const c of manifest.invalid) {
    it(`invalid/${c.name}: fails with ${c.error}`, () => {
      const bin = loadBin('segment', c.bin ?? `invalid/${c.name}.bin`);
      expectNamedDecodeError(() => decodeRowsSegment(bin), c.error);
    });
  }
});

describe('vectors/realtime', () => {
  const manifest = loadManifest('realtime');
  expect(manifest.cases.length).toBeGreaterThan(0);
  for (const c of manifest.cases) {
    it(`${c.name}: parses as a known control event`, () => {
      const text = readFileSync(join(vectorsDir, 'realtime', c.json), 'utf8');
      const parsed = parseRealtimeServerEvent(text);
      expect(parsed.known).toBe(true);
      if (parsed.known) {
        expect(parsed.event).toEqual(JSON.parse(text));
      }
    });
  }
  for (const c of manifest.invalid) {
    it(`invalid/${c.name}: fails with ${c.error}`, () => {
      const text = readFileSync(
        join(vectorsDir, 'realtime', c.json ?? `invalid/${c.name}.json`),
        'utf8',
      );
      expectNamedDecodeError(() => parseRealtimeServerEvent(text), c.error);
    });
  }
});
