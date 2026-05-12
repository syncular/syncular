import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { SYNCULAR_V2_WASM_BINARY_FILE } from '../src/runtime-contract';

const packageRoot = path.resolve(import.meta.dir, '..');
const wasmPath = path.join(
  packageRoot,
  'dist/wasm',
  SYNCULAR_V2_WASM_BINARY_FILE
);
const rawBytes = statSync(wasmPath).size;
const gzipBytes = gzipSync(readFileSync(wasmPath)).byteLength;

console.log(
  [
    'Syncular v2 Rust-owned SQLite WASM size',
    `raw: ${formatBytes(rawBytes)}`,
    `gzip: ${formatBytes(gzipBytes)}`,
    `path: ${wasmPath}`,
  ].join('\n')
);

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  }
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
