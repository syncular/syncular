#!/usr/bin/env bun
/**
 * Verifies publishable Cargo crate tarball contents before release.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

type CargoCrate = {
  name: string;
};

const releaseCrates: CargoCrate[] = [
  { name: 'syncular' },
  { name: 'syncular-protocol' },
  { name: 'syncular-codegen' },
  { name: 'syncular-runtime' },
  { name: 'syncular-testkit' },
  { name: 'syncular-client' },
];

const allowDirty = process.argv.includes('--allow-dirty');
const repoRoot = join(import.meta.dirname, '..');
const rustRoot = join(repoRoot, 'rust');

for (const crate of releaseCrates) {
  const files = packageFiles(crate.name);
  const badFiles = files.filter(isForbiddenPackageFile);

  if (badFiles.length > 0) {
    throw new Error(
      `${crate.name} package includes release junk:\n${badFiles.join('\n')}`
    );
  }

  console.log(
    `[check-cargo-package-contents] ${crate.name}: ${files.length} files`
  );
}

function packageFiles(crateName: string): string[] {
  const output = runCapture('cargo', [
    'package',
    '-p',
    crateName,
    '--list',
    ...dirtyArgs(),
  ]);

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isForbiddenPackageFile(path: string): boolean {
  if (
    path.startsWith('tests/') ||
    path.includes('/tests/') ||
    path.startsWith('target/') ||
    path.startsWith('.context/') ||
    path.includes('/node_modules/')
  ) {
    return true;
  }

  return path.includes('/generated/') && !path.startsWith('src/fixtures/');
}

function dirtyArgs(): string[] {
  return allowDirty ? ['--allow-dirty'] : [];
}

function runCapture(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: rustRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }

  return result.stdout;
}
