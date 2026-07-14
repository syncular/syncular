import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('@syncular/tauri package contract', () => {
  test('requires the Tauri JavaScript API peer used by the default bridge', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
    ) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    expect(manifest.peerDependencies?.['@tauri-apps/api']).toBeDefined();
    expect(
      manifest.peerDependenciesMeta?.['@tauri-apps/api']?.optional,
    ).not.toBe(true);
  });

  test('keeps the default imports visible to browser bundlers', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'index.ts'),
      'utf8',
    );

    expect(source).toContain("import('@tauri-apps/api/core')");
    expect(source).toContain("import('@tauri-apps/api/event')");
    expect(source).not.toContain('import(/* @vite-ignore */');
  });
});
