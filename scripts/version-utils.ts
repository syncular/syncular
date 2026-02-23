import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function getPackagesDirectory(): string {
  return join(import.meta.dirname, '..', 'packages');
}

export function listPackageDirectories(packagesDirectory: string): string[] {
  return readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function readRootVersion(): string | null {
  const rootPackageJsonPath = join(import.meta.dirname, '..', 'package.json');
  try {
    const packageJson = JSON.parse(readFileSync(rootPackageJsonPath, 'utf-8'));
    if (
      typeof packageJson.version === 'string' &&
      packageJson.version.length > 0
    ) {
      return packageJson.version;
    }
  } catch {
    // ignore missing or invalid package.json
  }
  return null;
}

export function computeStampedVersion(
  suffix: string,
  _packagesDirectory = getPackagesDirectory()
): string {
  const normalizedSuffix = suffix.trim();
  if (normalizedSuffix.length === 0) {
    throw new Error('Stamp suffix is required');
  }

  const baseVersion = readRootVersion();
  if (!baseVersion) {
    throw new Error('No version found in root package.json');
  }

  return `${baseVersion}-${normalizedSuffix}`;
}
