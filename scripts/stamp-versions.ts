/**
 * Stamps all packages in /packages with a suffixed version.
 * Usage: bun scripts/stamp-versions.ts <suffix>
 * Example: bun scripts/stamp-versions.ts 123 → 0.0.1-123
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeStampedVersion,
  getPackagesDirectory,
  listPackageDirectories,
} from './version-utils';

type DependencySection =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

interface PackageEntry {
  dir: string;
  path: string;
  pkg: PackageJson;
}

const suffix = process.argv[2];
if (!suffix) {
  console.error('Usage: bun scripts/stamp-versions.ts <suffix>');
  process.exit(1);
}

const packagesDir = getPackagesDirectory();
const dirs = listPackageDirectories(packagesDir);
const version = computeStampedVersion(suffix, packagesDir);
console.log(`Stamping version: ${version}\n`);

const entries: PackageEntry[] = [];
const internalPackageNames = new Set<string>();

for (const dir of dirs) {
  const packageJsonPath = join(packagesDir, dir, 'package.json');
  try {
    const pkg = JSON.parse(
      readFileSync(packageJsonPath, 'utf-8')
    ) as PackageJson;
    entries.push({ dir, path: packageJsonPath, pkg });
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      internalPackageNames.add(pkg.name);
    }
  } catch {
    // skip
  }
}

for (const entry of entries) {
  const { dir, path, pkg } = entry;
  if (typeof pkg.version !== 'string') {
    continue;
  }

  pkg.version = version;
  stampInternalDependencies(pkg, internalPackageNames, version);

  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  const name =
    typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : dir;
  console.log(`  ${name} → ${version}`);
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
