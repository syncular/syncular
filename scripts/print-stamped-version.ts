import { computeStampedVersion } from './version-utils';

const suffix = process.argv[2];
if (!suffix) {
  console.error('Usage: bun scripts/print-stamped-version.ts <suffix>');
  process.exit(1);
}

try {
  const version = computeStampedVersion(suffix);
  process.stdout.write(`${version}\n`);
} catch (error) {
  const message =
    error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
  console.error(message);
  process.exit(1);
}
