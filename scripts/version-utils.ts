import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type RootPackageJson = {
  version?: string;
  workspaces?: string[];
};

function getRepoRootDirectory(): string {
  return join(import.meta.dirname, '..');
}

function readRootPackageJson(
  rootDirectory = getRepoRootDirectory()
): RootPackageJson {
  const rootPackageJsonPath = join(rootDirectory, 'package.json');
  return JSON.parse(
    readFileSync(rootPackageJsonPath, 'utf-8')
  ) as RootPackageJson;
}

function toWorkspacePackageJsonGlob(workspacePattern: string): string {
  const normalized = workspacePattern
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');

  if (normalized.endsWith('package.json')) {
    return normalized;
  }

  return `${normalized}/package.json`;
}

export async function listWorkspacePackageJsonPaths(
  rootDirectory = getRepoRootDirectory()
): Promise<string[]> {
  const rootPackageJson = readRootPackageJson(rootDirectory);
  const workspacePatterns = rootPackageJson.workspaces;
  if (!Array.isArray(workspacePatterns) || workspacePatterns.length === 0) {
    throw new Error('No workspaces found in root package.json');
  }

  const packageJsonPaths = new Set<string>();

  for (const workspacePattern of workspacePatterns) {
    if (
      typeof workspacePattern !== 'string' ||
      workspacePattern.trim() === ''
    ) {
      continue;
    }

    const glob = new Bun.Glob(toWorkspacePackageJsonGlob(workspacePattern));
    for await (const relativePath of glob.scan({ cwd: rootDirectory })) {
      packageJsonPaths.add(join(rootDirectory, relativePath));
    }
  }

  return Array.from(packageJsonPaths).sort((left, right) =>
    left.localeCompare(right)
  );
}

function readRootVersion(): string | null {
  try {
    const packageJson = readRootPackageJson();
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

export function computeStampedVersion(suffix: string): string {
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
