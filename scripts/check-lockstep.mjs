#!/usr/bin/env node
/**
 * Lockstep guard — the 0.4.0 release lesson. `bun pm pack` materializes
 * `workspace:*` dependency ranges from the LOCKFILE's workspace `version`
 * stamps, not from the package.json files on disk — and `bun install` after
 * a version bump reports "no changes" without rewriting those stamps. The
 * 0.4.0 tarballs therefore shipped pinning their @syncular/* siblings at
 * 0.3.1 (split-brain installs; server-hono crashed on a missing 0.4 export).
 *
 * This check fails the gate when:
 *   1. any two publish-set packages disagree on version, or
 *   2. any bun.lock workspace `version` stamp differs from that workspace's
 *      package.json version.
 *
 * Fix for (2): edit the stamps in bun.lock to match (they are plain
 * `"version"` fields on the workspace entries), then `bun install` to
 * validate — see docs/RELEASE.md.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// 1. Publish-set packages must share one version.
const versions = new Map();
for (const dir of readdirSync(join(root, 'packages'))) {
  const path = join(root, 'packages', dir, 'package.json');
  let pkg;
  try {
    pkg = readJson(path);
  } catch {
    continue;
  }
  versions.set(pkg.name, pkg.version);
}
const distinct = new Set(versions.values());
if (distinct.size !== 1) {
  console.error('lockstep: packages/* versions diverge:');
  for (const [name, version] of versions) console.error(`  ${name} ${version}`);
  process.exit(1);
}

// 2. bun.lock workspace stamps must match the on-disk package.json versions.
// bun.lock is JSONC-ish (trailing commas); strip them before parsing.
const lockText = readFileSync(join(root, 'bun.lock'), 'utf8');
const lock = JSON.parse(lockText.replace(/,(\s*[}\]])/g, '$1'));
const stale = [];
for (const [wsPath, entry] of Object.entries(lock.workspaces ?? {})) {
  if (wsPath === '' || entry.version === undefined) continue;
  let pkg;
  try {
    pkg = readJson(join(root, wsPath, 'package.json'));
  } catch {
    continue;
  }
  if (pkg.version !== undefined && pkg.version !== entry.version) {
    stale.push(`  ${wsPath}: bun.lock ${entry.version} != package.json ${pkg.version}`);
  }
}
if (stale.length > 0) {
  console.error(
    'lockstep: bun.lock workspace version stamps are stale — `bun pm pack` would',
  );
  console.error(
    'materialize these into published workspace:* dependency pins:',
  );
  for (const line of stale) console.error(line);
  process.exit(1);
}

console.log(`lockstep: ${versions.size} packages at ${[...distinct][0]}, bun.lock stamps in sync`);
