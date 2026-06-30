#!/usr/bin/env bun
/**
 * Publishes Syncular Rust crates in dependency order.
 *
 * Use --dry-run in checks and --allow-dirty after release version stamping.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type CargoCrate = {
  name: string;
  manifestPath: string;
};

const repoRoot = join(import.meta.dirname, '..');
const crates: CargoCrate[] = [
  {
    name: 'syncular',
    manifestPath: 'rust/crates/syncular/Cargo.toml',
  },
  {
    name: 'syncular-protocol',
    manifestPath: 'rust/crates/protocol/Cargo.toml',
  },
  {
    name: 'syncular-codegen',
    manifestPath: 'rust/crates/codegen/Cargo.toml',
  },
  {
    name: 'syncular-runtime',
    manifestPath: 'rust/crates/runtime/Cargo.toml',
  },
  {
    name: 'syncular-testkit',
    manifestPath: 'rust/crates/testkit/Cargo.toml',
  },
  {
    name: 'syncular-client',
    manifestPath: 'rust/crates/client/Cargo.toml',
  },
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const allowDirty = args.has('--allow-dirty');
const skipExisting = !args.has('--no-skip-existing');

for (const crate of crates) {
  const version = readManifestVersion(crate);
  if (
    !dryRun &&
    skipExisting &&
    (await isVersionPublished(crate.name, version))
  ) {
    console.warn(
      `[publish-cargo-crates] ${crate.name}@${version} is already published; skipping.`
    );
    continue;
  }

  const publishArgs = [
    'publish',
    '--manifest-path',
    crate.manifestPath,
    ...(dryRun ? ['--dry-run'] : []),
    ...(allowDirty ? ['--allow-dirty'] : []),
  ];

  console.log(
    `[publish-cargo-crates] cargo ${publishArgs.join(' ')} (${crate.name}@${version})`
  );
  const published = runCargo(publishArgs, {
    allowAlreadyPublished: !dryRun && skipExisting,
    crateName: crate.name,
    version,
  });

  if (published && !dryRun) {
    await waitForVersionPublished(crate.name, version);
  }
}

function readManifestVersion(crate: CargoCrate): string {
  const manifestPath = join(repoRoot, crate.manifestPath);
  const manifest = readFileSync(manifestPath, 'utf-8');
  const match = manifest.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(`Missing package version in ${crate.manifestPath}`);
  }
  return match[1];
}

async function isVersionPublished(
  crateName: string,
  version: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://crates.io/api/v1/crates/${crateName}/${version}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'syncular-release-script',
        },
      }
    );

    if (response.status === 200) {
      return true;
    }

    if (response.status !== 404) {
      console.warn(
        `[publish-cargo-crates] crates.io version check for ${crateName}@${version} returned HTTP ${response.status}; falling back to cargo info.`
      );
    } else {
      return false;
    }
  } catch (error) {
    console.warn(
      `[publish-cargo-crates] crates.io version check for ${crateName}@${version} failed; falling back to cargo info.`,
      error
    );
  }

  const result = Bun.spawnSync({
    cmd: ['cargo', 'info', `${crateName}@${version}`],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });

  if (result.exitCode !== 0) {
    return false;
  }

  const stdout = new TextDecoder().decode(result.stdout);
  return stdout.includes(`version: ${version}`);
}

function runCargo(
  cargoArgs: string[],
  options: {
    allowAlreadyPublished: boolean;
    crateName: string;
    version: string;
  }
): boolean {
  const result = Bun.spawnSync({
    cmd: ['cargo', ...cargoArgs],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  if (
    result.exitCode !== 0 &&
    options.allowAlreadyPublished &&
    `${stdout}\n${stderr}`.includes('already exists on crates.io index')
  ) {
    console.warn(
      `[publish-cargo-crates] ${options.crateName}@${options.version} is already published; continuing.`
    );
    return false;
  }

  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }

  return true;
}

async function waitForVersionPublished(
  crateName: string,
  version: string
): Promise<void> {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    if (await isVersionPublished(crateName, version)) {
      return;
    }

    console.log(
      `[publish-cargo-crates] waiting for ${crateName}@${version} to appear on crates.io (${attempt}/12).`
    );
    await Bun.sleep(10_000);
  }

  throw new Error(
    `${crateName}@${version} was published but did not become visible on crates.io in time`
  );
}
