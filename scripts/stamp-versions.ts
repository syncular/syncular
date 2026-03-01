/**
 * Stamps all publishable workspace packages with a suffixed version.
 * Usage: bun scripts/stamp-versions.ts <suffix>
 * Example: bun scripts/stamp-versions.ts 123 → 0.0.1-123
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  computeStampedVersion,
  listWorkspacePackageJsonPaths,
} from './version-utils';

type DependencySection =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

type PackageJson = {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string | undefined>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

interface PackageEntry {
  path: string;
  pkg: PackageJson;
  shouldStamp: boolean;
}

const suffix = process.argv[2];
if (!suffix) {
  console.error('Usage: bun scripts/stamp-versions.ts <suffix>');
  process.exit(1);
}

const version = computeStampedVersion(suffix);
console.log(`Stamping version: ${version}\n`);

const packageJsonPaths = await listWorkspacePackageJsonPaths();
const entries: PackageEntry[] = [];
const internalPackageNames = new Set<string>();

for (const packageJsonPath of packageJsonPaths) {
  try {
    const pkg = JSON.parse(
      readFileSync(packageJsonPath, 'utf-8')
    ) as PackageJson;
    const shouldStamp = isPublishableWorkspacePackage(pkg);
    entries.push({ path: packageJsonPath, pkg, shouldStamp });
    if (shouldStamp && typeof pkg.name === 'string' && pkg.name.length > 0) {
      internalPackageNames.add(pkg.name);
    }
  } catch {
    // skip
  }
}

for (const entry of entries) {
  const { path, pkg, shouldStamp } = entry;
  if (!shouldStamp || typeof pkg.version !== 'string') {
    continue;
  }

  pkg.version = version;
  stampInternalDependencies(pkg, internalPackageNames, version);

  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  const name =
    typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : path;
  console.log(`  ${name} → ${version}`);
}

function isPublishableWorkspacePackage(pkg: PackageJson): boolean {
  if (pkg.private === true || typeof pkg.version !== 'string') {
    return false;
  }

  const releaseScript = pkg.scripts?.release;
  return (
    typeof releaseScript === 'string' &&
    releaseScript.includes('syncular-publish')
  );
}

function stampInternalDependencies(
  pkg: PackageJson,
  internalPackageNames: Set<string>,
  version: string
): void {
  const sections: DependencySection[] = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];

  for (const section of sections) {
    const deps = pkg[section];
    if (!deps) {
      continue;
    }

    for (const [name, currentRange] of Object.entries(deps)) {
      if (!internalPackageNames.has(name) || typeof currentRange !== 'string') {
        continue;
      }
      deps[name] = version;
    }
  }
}
