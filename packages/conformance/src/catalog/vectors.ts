/**
 * Golden-vector conformance stage (SPEC.md Appendix A, §11, §9): every
 * codec implementation — reference or future Rust — must decode each
 * vector, render it to the pinned §11 JSON, re-encode it byte-exactly,
 * and reject each invalid case with the named error code. Runs through
 * the CodecDriver seam.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, checkBytesEqual, checkEqual } from '../checks';
import type { CodecDriver } from '../driver';
import type { Scenario } from '../scenario';

const VECTORS_DIR = join(import.meta.dir, '../../../../spec/vectors');

interface ManifestCase {
  name: string;
  bin?: string;
  json: string;
}

interface ManifestInvalid {
  name: string;
  bin: string;
  error: string;
}

interface Manifest {
  kind: string;
  cases: ManifestCase[];
  invalid: ManifestInvalid[];
}

function loadManifest(kind: string): Manifest {
  return JSON.parse(
    readFileSync(join(VECTORS_DIR, kind, 'manifest.json'), 'utf8'),
  ) as Manifest;
}

function loadBin(kind: string, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(VECTORS_DIR, kind, file)));
}

function loadJson(kind: string, file: string): unknown {
  return JSON.parse(readFileSync(join(VECTORS_DIR, kind, file), 'utf8'));
}

async function runBinaryKind(
  codec: CodecDriver,
  kind: 'request' | 'response' | 'segment',
): Promise<void> {
  const roundtrip =
    kind === 'segment'
      ? codec.segmentRoundtrip.bind(codec)
      : codec.messageRoundtrip.bind(codec);
  const manifest = loadManifest(kind);
  check(manifest.cases.length > 0, `${kind}: manifest has cases`);
  for (const c of manifest.cases) {
    const what = `${kind}/${c.name}`;
    const bin = loadBin(kind, c.bin ?? `${c.name}.bin`);
    const result = await roundtrip(bin);
    check(result.ok, `${what}: decode failed`);
    if (!result.ok) continue;
    checkBytesEqual(result.bytes, bin, `${what}: byte-exact re-encode (§9)`);
    checkEqual(
      JSON.parse(result.renderedJson),
      loadJson(kind, c.json),
      `${what}: §11 canonical rendering`,
    );
  }
  for (const c of manifest.invalid) {
    const what = `${kind}/invalid/${c.name}`;
    const result = await roundtrip(loadBin(kind, c.bin));
    check(!result.ok, `${what}: must be rejected`);
    if (!result.ok) {
      checkEqual(result.errorCode, c.error, `${what}: named decode error`);
    }
  }
}

export const vectorScenarios: readonly Scenario[] = [
  {
    name: 'vectors/request-roundtrip',
    specRefs: ['Appendix A', '§11', '§9', '§1.5'],
    async run(ctx) {
      await runBinaryKind(ctx.pairing.codec, 'request');
    },
  },
  {
    name: 'vectors/response-roundtrip',
    specRefs: ['Appendix A', '§11', '§9', '§1.6'],
    async run(ctx) {
      await runBinaryKind(ctx.pairing.codec, 'response');
    },
  },
  {
    name: 'vectors/segment-roundtrip',
    specRefs: ['Appendix A', '§11', '§5.2'],
    async run(ctx) {
      await runBinaryKind(ctx.pairing.codec, 'segment');
    },
  },
  {
    name: 'vectors/realtime-control-events',
    specRefs: ['Appendix A', '§8.1', '§8.3'],
    async run(ctx) {
      const manifest = loadManifest('realtime');
      check(manifest.cases.length > 0, 'realtime: manifest has cases');
      for (const c of manifest.cases) {
        const text = readFileSync(
          join(VECTORS_DIR, 'realtime', c.json),
          'utf8',
        );
        check(
          await ctx.pairing.codec.realtimeKnown(text),
          `realtime/${c.name}: must parse as a known control event`,
        );
      }
    },
  },
];
