import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { SYNCULAR_V2_WASM_BINARY_FILE } from '../src/runtime-contract';

const rawBudgetBytes = parseBudgetBytes(
  process.env.SYNCULAR_WASM_RAW_BUDGET_BYTES,
  3.3 * 1024 * 1024
);
const gzipBudgetBytes = parseBudgetBytes(
  process.env.SYNCULAR_WASM_GZIP_BUDGET_BYTES,
  1.36 * 1024 * 1024
);
const check = process.argv.includes('--check');
const attribution = process.argv.includes('--attribution');
const json = process.argv.includes('--json');
const reportPath = readArgValue('--report');
const packageRoot = path.resolve(import.meta.dir, '..');
const repoRoot = path.resolve(packageRoot, '../..');
const wasmArg = readArgValue('--wasm');
const wasmPath = wasmArg
  ? path.resolve(process.cwd(), wasmArg)
  : path.join(packageRoot, 'dist/wasm', SYNCULAR_V2_WASM_BINARY_FILE);
const profileWasmPath = path.join(
  repoRoot,
  '.context/wasm-size',
  SYNCULAR_V2_WASM_BINARY_FILE.replace(/\.wasm$/, '.profile.wasm')
);
const rawBytes = statSync(wasmPath).size;
const gzipBytes = gzipSync(readFileSync(wasmPath)).byteLength;
const rawWithinBudget = rawBytes <= rawBudgetBytes;
const gzipWithinBudget = gzipBytes <= gzipBudgetBytes;
const summaryLines = [
  'Syncular v2 Rust-owned SQLite WASM size',
  `raw: ${formatBytes(rawBytes)} / budget ${formatBytes(rawBudgetBytes)} (${formatDelta(rawBytes - rawBudgetBytes)})`,
  `gzip: ${formatBytes(gzipBytes)} / budget ${formatBytes(gzipBudgetBytes)} (${formatDelta(gzipBytes - gzipBudgetBytes)})`,
  `path: ${wasmPath}`,
];
const reportLines = [...summaryLines];

if (attribution || reportPath) {
  reportLines.push('', 'Section attribution');
  reportLines.push(runOptionalTool(['wasm-tools', 'objdump', wasmPath]));
  reportLines.push('', 'Top shallow size entries');
  reportLines.push(
    runOptionalTool([
      'twiggy',
      'top',
      '-n',
      '25',
      existsSync(profileWasmPath) ? profileWasmPath : wasmPath,
    ])
  );
  if (existsSync(profileWasmPath)) {
    reportLines.push('', `profile artifact: ${profileWasmPath}`);
  }
}

const consoleOutput = (attribution ? reportLines : summaryLines).join('\n');
const reportOutput = reportLines.join('\n');
if (json) {
  console.log(
    JSON.stringify(
      {
        path: wasmPath,
        rawBytes,
        gzipBytes,
        rawBudgetBytes,
        gzipBudgetBytes,
        rawWithinBudget,
        gzipWithinBudget,
      },
      null,
      2
    )
  );
} else {
  console.log(consoleOutput);
}

if (reportPath) {
  const absoluteReportPath = path.resolve(process.cwd(), reportPath);
  mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
  writeFileSync(absoluteReportPath, `${reportOutput}\n`);
  if (!json) {
    console.log(`report: ${absoluteReportPath}`);
  }
}

if (check && (!rawWithinBudget || !gzipWithinBudget)) {
  console.error(
    [
      '[syncular-v2-wasm] size budget exceeded.',
      `raw ${formatBytes(rawBytes)} <= ${formatBytes(rawBudgetBytes)}: ${rawWithinBudget ? 'ok' : 'fail'}`,
      `gzip ${formatBytes(gzipBytes)} <= ${formatBytes(gzipBudgetBytes)}: ${gzipWithinBudget ? 'ok' : 'fail'}`,
      'Adjust the budget only with a measured reason, or reduce enabled Rust features/dependencies.',
    ].join('\n')
  );
  process.exit(1);
}

function parseBudgetBytes(value: string | undefined, fallback: number): number {
  if (!value) return Math.round(fallback);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid size budget byte value: ${value}`);
  }
  return Math.round(parsed);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  }
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatDelta(bytes: number): string {
  if (bytes === 0) return 'at budget';
  if (bytes > 0) return `${formatBytes(bytes)} over`;
  return `${formatBytes(Math.abs(bytes))} headroom`;
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

function runOptionalTool(command: string[]): string {
  const result = Bun.spawnSync(command, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    return `Skipped ${command[0]}: ${stderr || `exit ${result.exitCode}`}`;
  }
  return result.stdout.toString().trimEnd();
}
