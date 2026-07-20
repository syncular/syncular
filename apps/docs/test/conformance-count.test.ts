import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from '../../../packages/conformance/src/catalog';

// The conformance catalog is Bun-only (import.meta.dir plus the full
// client/server stacks), so the docs cannot import it at Astro build time.
// This test keeps every reader-facing scenario count aligned with the
// catalog instead.

const docsRoot = join(import.meta.dir, '..');

const read = (relativePath: string) =>
  readFileSync(join(docsRoot, relativePath), 'utf8');

const extract = (source: string, pattern: RegExp, where: string) => {
  const match = pattern.exec(source);
  if (!match?.[1]) throw new Error(`no scenario count found in ${where}`);
  return Number(match[1]);
};

describe('conformance scenario count', () => {
  test('landing page constant matches the catalog', () => {
    expect(
      extract(
        read('src/pages/index.astro'),
        /const CONFORMANCE_SCENARIOS = (\d+);/,
        'src/pages/index.astro',
      ),
    ).toBe(CATALOG.length);
  });

  test('what-is page matches the catalog', () => {
    expect(
      extract(
        read('src/content/what-is.md'),
        /(\d+)-scenario\s*\nconformance catalog/,
        'src/content/what-is.md',
      ),
    ).toBe(CATALOG.length);
  });

  test('offline-first-writes article matches the catalog', () => {
    expect(
      extract(
        read('src/content/blog/offline-first-writes.md'),
        /catalog contains (\d+) scenarios/,
        'src/content/blog/offline-first-writes.md',
      ),
    ).toBe(CATALOG.length);
  });
});
