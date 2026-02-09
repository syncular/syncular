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

function readBasePackageVersion(
  packagesDirectory: string,
  packageDirectories: string[]
): string | null {
  for (const directory of packageDirectories) {
    const packageJsonPath = join(packagesDirectory, directory, 'package.json');
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (
        typeof packageJson.version === 'string' &&
        packageJson.version.length > 0
      ) {
        return packageJson.version;
      }
    } catch {
      // ignore missing or invalid package.json files
    }
  }

  return null;
}

export function computeStampedVersion(
  suffix: string,
  packagesDirectory = getPackagesDirectory()
): string {
  const normalizedSuffix = suffix.trim();
  if (normalizedSuffix.length === 0) {
    throw new Error('Stamp suffix is required');
  }

  const packageDirectories = listPackageDirectories(packagesDirectory);
  const baseVersion = readBasePackageVersion(
    packagesDirectory,
    packageDirectories
  );
  if (!baseVersion) {
    throw new Error('No package versions found under /packages');
  }

  return `${baseVersion}-${normalizedSuffix}`;
}
