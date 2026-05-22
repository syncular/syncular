import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SYNCULAR_CLIENT_PACKAGE_NAME,
  SYNCULAR_CLIENT_PACKAGE_VERSION,
  SYNCULAR_WASM_ARTIFACT_CATALOG_FILE,
  SYNCULAR_WASM_ARTIFACT_FILE,
} from '../src/runtime-contract';

interface RuntimeArtifactManifest {
  name: string;
  variant?: string;
  profile?: string;
  features: readonly string[];
  rustFeatures?: readonly string[];
  files: {
    wasmGlue: string;
    wasm: string;
  };
  rawBytes?: number;
  gzipBytes?: number;
}

const packageRoot = path.resolve(import.meta.dir, '..');
const outPath = path.resolve(
  packageRoot,
  readArgValue('--out') ?? `dist/${SYNCULAR_WASM_ARTIFACT_CATALOG_FILE}`
);
const artifactDirs = readArgValues('--artifact').map((dir) =>
  path.resolve(packageRoot, dir)
);
if (artifactDirs.length === 0) {
  artifactDirs.push(
    path.resolve(packageRoot, 'dist/wasm-core'),
    path.resolve(packageRoot, 'dist/wasm')
  );
}

const catalog = {
  catalogVersion: 1,
  packageName: SYNCULAR_CLIENT_PACKAGE_NAME,
  packageVersion: SYNCULAR_CLIENT_PACKAGE_VERSION,
  generatedAt: new Date().toISOString(),
  artifacts: artifactDirs.map(readArtifact),
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(
  `[syncular-wasm] wrote runtime artifact catalog with ${catalog.artifacts.length} artifacts to ${outPath}`
);

function readArtifact(artifactDir: string) {
  const manifestPath = path.join(artifactDir, SYNCULAR_WASM_ARTIFACT_FILE);
  const manifest = JSON.parse(
    readFileSync(manifestPath, 'utf8')
  ) as RuntimeArtifactManifest;
  const relativeDir = path
    .relative(path.dirname(outPath), artifactDir)
    .split(path.sep)
    .join('/');
  return {
    name: manifest.name,
    variant: manifest.variant,
    profile: manifest.profile,
    features: manifest.features,
    rustFeatures: manifest.rustFeatures,
    wasmGlueUrl: joinRelativeUrl(relativeDir, manifest.files.wasmGlue),
    wasmUrl: joinRelativeUrl(relativeDir, manifest.files.wasm),
    rawBytes: manifest.rawBytes,
    gzipBytes: manifest.gzipBytes,
  };
}

function joinRelativeUrl(dir: string, fileName: string): string {
  return dir === '' ? fileName : `${dir}/${fileName}`;
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

function readArgValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    values.push(value);
  }
  return values;
}
