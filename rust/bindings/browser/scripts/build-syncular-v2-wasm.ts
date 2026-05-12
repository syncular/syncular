import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  SYNCULAR_V2_PACKAGE_NAME,
  SYNCULAR_V2_PACKAGE_VERSION,
  SYNCULAR_V2_WASM_BINARY_FILE,
  SYNCULAR_V2_WASM_GLUE_FILE,
  SYNCULAR_V2_WASM_OUT_NAME,
} from '../src/runtime-contract';

const packageRoot = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(packageRoot, '../../..');
const outDir = path.join(packageRoot, 'dist/wasm');
const dev = process.argv.includes('--dev');
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

rmSync(outDir, { recursive: true, force: true });

const args = [
  'build',
  'rust/crates/runtime',
  '--target',
  'web',
  '--out-dir',
  '../../bindings/browser/dist/wasm',
  '--out-name',
  SYNCULAR_V2_WASM_OUT_NAME,
  ...(dev ? ['--dev'] : []),
  '--no-pack',
  '--',
  '--no-default-features',
  '--features',
  'web-owned-sqlite',
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
console.log(
  `[syncular-v2-wasm] built ${profile} rust-owned SQLite artifact in ${outDir}`
);
