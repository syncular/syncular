import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const OUTPUTS: string[] = [];

afterAll(async () => {
  await Promise.all(
    OUTPUTS.map((output) => rm(output, { recursive: true, force: true })),
  );
});

describe('Vite no-top-level-await fixture', () => {
  test('builds the synchronous retained-resource recipe for ordinary compatible targets', async () => {
    const output = await mkdtemp(join(tmpdir(), 'syncular-vite-no-tla-'));
    OUTPUTS.push(output);
    const entry = fileURLToPath(
      new URL('./fixtures/vite-no-tla.ts', import.meta.url),
    );
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: output,
        emptyOutDir: true,
        target: ['chrome87', 'edge88', 'es2020', 'firefox78', 'safari14'],
        lib: {
          entry,
          formats: ['es'],
          fileName: () => 'fixture.js',
        },
      },
    });

    const bundle = await readFile(join(output, 'fixture.js'), 'utf8');
    expect(bundle.length).toBeGreaterThan(0);
    expect(bundle).not.toMatch(/\bawait\s+createViteSyncClientResource\b/u);
  });
});
