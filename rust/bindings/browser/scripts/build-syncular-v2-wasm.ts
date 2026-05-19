import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  SYNCULAR_V2_CORE_RUNTIME_FEATURES,
  SYNCULAR_V2_FULL_RUNTIME_FEATURES,
  SYNCULAR_V2_PACKAGE_NAME,
  SYNCULAR_V2_PACKAGE_VERSION,
  SYNCULAR_V2_WASM_ARTIFACT_FILE,
  SYNCULAR_V2_WASM_BINARY_FILE,
  SYNCULAR_V2_WASM_GLUE_FILE,
  SYNCULAR_V2_WASM_OUT_NAME,
} from '../src/runtime-contract';

const packageRoot = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(packageRoot, '../../..');
const outDir = path.resolve(
  packageRoot,
  readArgValue('--out-dir') ?? 'dist/wasm'
);
const buildLockDir = path.join(
  packageRoot,
  'dist/.syncular-v2-wasm-build.lock'
);
const sizeReportDir = path.join(repoRoot, '.context/wasm-size');
const buildLockStaleMs = 10 * 60 * 1000;
const dev = process.argv.includes('--dev');
const wasmFeatures = readArgValue('--features') ?? 'web-owned-sqlite';
const wasmVariant = readArgValue('--variant') ?? inferWasmVariant(wasmFeatures);
const artifactName = readArgValue('--artifact-name') ?? wasmVariant;
const wasmClang =
  process.env.CC_wasm32_unknown_unknown ??
  [
    '/opt/homebrew/opt/llvm/bin/clang',
    '/opt/homebrew/Cellar/llvm@20/20.1.8/bin/clang',
    '/usr/local/opt/llvm/bin/clang',
  ].find((candidate) => existsSync(candidate));

const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
) as { name?: string; version?: string };
if (packageJson.name !== SYNCULAR_V2_PACKAGE_NAME) {
  throw new Error(
    `runtime contract package name ${SYNCULAR_V2_PACKAGE_NAME} does not match package.json ${packageJson.name}`
  );
}
if (packageJson.version !== SYNCULAR_V2_PACKAGE_VERSION) {
  throw new Error(
    `runtime contract package version ${SYNCULAR_V2_PACKAGE_VERSION} does not match package.json ${packageJson.version}`
  );
}

const releaseBuildLock = await acquireBuildLock();
process.on('exit', releaseBuildLock);
process.on('SIGINT', () => {
  releaseBuildLock();
  process.exit(130);
});
process.on('SIGTERM', () => {
  releaseBuildLock();
  process.exit(143);
});

rmSync(outDir, { recursive: true, force: true });

const args = [
  'build',
  'rust/crates/runtime',
  '--target',
  'web',
  '--out-dir',
  path.relative(path.join(repoRoot, 'rust/crates/runtime'), outDir),
  '--out-name',
  SYNCULAR_V2_WASM_OUT_NAME,
  ...(dev ? ['--dev'] : []),
  '--no-pack',
  '--',
  '--no-default-features',
  '--features',
  wasmFeatures,
];

const result = Bun.spawnSync(['wasm-pack', ...args], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ...(wasmClang ? { CC_wasm32_unknown_unknown: wasmClang } : {}),
  },
  stdout: 'pipe',
  stderr: 'pipe',
});

if (result.exitCode !== 0) {
  console.error('[syncular-v2-wasm] wasm-pack failed');
  console.error(result.stdout.toString());
  console.error(result.stderr.toString());
  process.exit(result.exitCode);
}

const profile = dev ? 'dev' : 'release';
rmSync(path.join(outDir, '.gitignore'), { force: true });
for (const fileName of [
  SYNCULAR_V2_WASM_GLUE_FILE,
  SYNCULAR_V2_WASM_BINARY_FILE,
]) {
  const filePath = path.join(outDir, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`[syncular-v2-wasm] expected ${filePath} to exist`);
  }
}
const wasmPath = path.join(outDir, SYNCULAR_V2_WASM_BINARY_FILE);
if (!dev) {
  optimizeWasmRelease(wasmPath);
  writeWasmProfileArtifact(wasmPath);
}
stripWasmCustomSections(wasmPath);
writeFileSync(path.join(outDir, '.syncular-v2-wasm-profile'), `${profile}\n`);
writeRuntimeArtifactManifest({
  artifactName,
  outDir,
  profile,
  wasmFeatures,
  wasmVariant,
  wasmPath,
});
console.log(
  `[syncular-v2-wasm] built ${profile} ${wasmVariant} rust-owned SQLite artifact (${wasmFeatures}) in ${outDir}`
);

async function acquireBuildLock(): Promise<() => void> {
  const ownerPath = path.join(buildLockDir, 'owner');
  const owner = `${process.pid}:${Date.now()}:${Math.random()}`;
  mkdirSync(path.dirname(buildLockDir), { recursive: true });

  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    try {
      mkdirSync(buildLockDir);
      writeFileSync(ownerPath, `${owner}\n`);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        let currentOwner: string | null = null;
        try {
          currentOwner = readFileSync(ownerPath, 'utf8').trim();
        } catch {
          currentOwner = null;
        }
        if (currentOwner === owner) {
          rmSync(buildLockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(buildLockDir).mtimeMs;
      } catch {
        await Bun.sleep(200);
        continue;
      }
      if (ageMs > buildLockStaleMs) {
        rmSync(buildLockDir, { recursive: true, force: true });
        continue;
      }
      await Bun.sleep(200);
    }
  }

  throw new Error(
    `[syncular-v2-wasm] timed out waiting for build lock at ${buildLockDir}`
  );
}

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function writeRuntimeArtifactManifest(options: {
  artifactName: string;
  outDir: string;
  profile: string;
  wasmFeatures: string;
  wasmPath: string;
  wasmVariant: string;
}): void {
  const wasm = readFileSync(options.wasmPath);
  const manifest = {
    name: options.artifactName,
    variant: options.wasmVariant,
    profile: options.profile,
    features: runtimeFeaturesForRustFeatures(options.wasmFeatures),
    rustFeatures: rustFeatureList(options.wasmFeatures),
    files: {
      wasmGlue: SYNCULAR_V2_WASM_GLUE_FILE,
      wasm: SYNCULAR_V2_WASM_BINARY_FILE,
    },
    rawBytes: statSync(options.wasmPath).size,
    gzipBytes: gzipSync(wasm).byteLength,
  };
  writeFileSync(
    path.join(options.outDir, SYNCULAR_V2_WASM_ARTIFACT_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

function runtimeFeaturesForRustFeatures(
  wasmFeaturesValue: string
): readonly string[] {
  const rustFeatures = new Set(rustFeatureList(wasmFeaturesValue));
  if (rustFeatures.has('web-owned-sqlite')) {
    return SYNCULAR_V2_FULL_RUNTIME_FEATURES;
  }

  const features = new Set<string>(SYNCULAR_V2_CORE_RUNTIME_FEATURES);
  if (rustFeatures.has('web-blobs')) features.add('blobs');
  if (rustFeatures.has('crdt-yjs')) features.add('crdt-yjs');
  if (rustFeatures.has('e2ee')) features.add('e2ee');
  return [...features];
}

function rustFeatureList(wasmFeaturesValue: string): readonly string[] {
  return wasmFeaturesValue
    .split(/[,\s]+/)
    .map((feature) => feature.trim())
    .filter(Boolean);
}

function inferWasmVariant(wasmFeaturesValue: string): string {
  const rustFeatures = new Set(rustFeatureList(wasmFeaturesValue));
  if (rustFeatures.has('web-owned-sqlite')) return 'full';
  if (rustFeatures.has('web-owned-sqlite-core')) return 'core';
  return 'custom';
}

function optimizeWasmRelease(wasmPath: string): void {
  const version = Bun.spawnSync(['wasm-opt', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (version.exitCode !== 0) {
    throw new Error(
      [
        '[syncular-v2-wasm] release builds require wasm-opt for package size.',
        'Install Binaryen (`brew install binaryen`, `apt install binaryen`, or equivalent) and rerun build:wasm.',
      ].join(' ')
    );
  }

  const tmpPath = `${wasmPath}.opt`;
  const result = Bun.spawnSync(
    [
      'wasm-opt',
      '--all-features',
      '-Oz',
      '--strip-producers',
      '--zero-filled-memory',
      '--vacuum',
      wasmPath,
      '-o',
      tmpPath,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  if (result.exitCode !== 0) {
    console.error('[syncular-v2-wasm] wasm-opt failed');
    console.error(result.stdout.toString());
    console.error(result.stderr.toString());
    process.exit(result.exitCode);
  }
  renameSync(tmpPath, wasmPath);
}

function writeWasmProfileArtifact(wasmPath: string): void {
  mkdirSync(sizeReportDir, { recursive: true });
  copyFileSync(
    wasmPath,
    path.join(
      sizeReportDir,
      SYNCULAR_V2_WASM_BINARY_FILE.replace(/\.wasm$/, '.profile.wasm')
    )
  );
}

function stripWasmCustomSections(wasmPath: string): void {
  const input = readFileSync(wasmPath);
  if (
    input.length < 8 ||
    input[0] !== 0x00 ||
    input[1] !== 0x61 ||
    input[2] !== 0x73 ||
    input[3] !== 0x6d
  ) {
    throw new Error(`[syncular-v2-wasm] invalid wasm binary: ${wasmPath}`);
  }

  const chunks: Uint8Array[] = [input.subarray(0, 8)];
  let offset = 8;
  while (offset < input.length) {
    const sectionStart = offset;
    const id = input[offset++];
    const size = readLebU32(input, offset);
    offset = size.nextOffset;
    const payloadStart = offset;
    const payloadEnd = payloadStart + size.value;
    if (payloadEnd > input.length) {
      throw new Error(`[syncular-v2-wasm] corrupt wasm section in ${wasmPath}`);
    }
    if (id !== 0) {
      chunks.push(input.subarray(sectionStart, payloadEnd));
    }
    offset = payloadEnd;
  }

  const outputSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(outputSize);
  let writeOffset = 0;
  for (const chunk of chunks) {
    output.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  writeFileSync(wasmPath, output);
}

function readLebU32(
  bytes: Uint8Array,
  start: number
): { value: number; nextOffset: number } {
  let result = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, nextOffset: offset };
    }
    shift += 7;
    if (shift > 35) break;
  }
  throw new Error('[syncular-v2-wasm] invalid wasm section size');
}
