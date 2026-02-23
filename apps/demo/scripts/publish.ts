import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { computeStampedVersion } from '../../../scripts/version-utils';
import {
  DEFAULT_DEMO_SENTRY_ENVIRONMENT,
  DEMO_BROWSER_SENTRY_DSN,
  DEMO_WORKER_SENTRY_DSN,
} from '../src/sentry-config';

const ROOT = resolve(import.meta.dirname, '..');
const WRANGLER_BIN = join(ROOT, 'node_modules', '.bin', 'wrangler');
const isDryRun = process.argv.includes('--dry-run');

function readReleaseSuffix(): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

function run(
  command: string,
  args: string[],
  envOverrides: Record<string, string>
): void {
  if (isDryRun) {
    console.log(`[publish][dry-run] ${command} ${args.join(' ')}`);
    return;
  }
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...envOverrides,
    },
  });
}

const releaseSuffix = readReleaseSuffix();
const release = computeStampedVersion(releaseSuffix);
const environment = process.env.SYNCULAR_SENTRY_ENVIRONMENT?.trim()
  ? process.env.SYNCULAR_SENTRY_ENVIRONMENT.trim()
  : DEFAULT_DEMO_SENTRY_ENVIRONMENT;
const browserDsn = process.env.SYNCULAR_SENTRY_DSN?.trim()
  ? process.env.SYNCULAR_SENTRY_DSN.trim()
  : DEMO_BROWSER_SENTRY_DSN;
const workerDsn = process.env.SENTRY_DSN?.trim()
  ? process.env.SENTRY_DSN.trim()
  : DEMO_WORKER_SENTRY_DSN;

console.log(`[publish] release=${release}`);
console.log(`[publish] environment=${environment}`);
if (isDryRun) {
  console.log('[publish] dry-run enabled');
}

run('bun', ['run', 'build'], {
  SYNCULAR_SENTRY_DSN: browserDsn,
  SYNCULAR_SENTRY_ENVIRONMENT: environment,
  SYNCULAR_SENTRY_RELEASE: release,
});

run(
  WRANGLER_BIN,
  [
    'deploy',
    '--var',
    `SENTRY_DSN:${workerDsn}`,
    '--var',
    `SENTRY_ENVIRONMENT:${environment}`,
    '--var',
    `SENTRY_RELEASE:${release}`,
  ],
  {}
);
