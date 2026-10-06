/**
 * Runtime-neutrality enforcement.
 *
 * The claim: the **core** — the sync handler, the realtime session, the D1
 * storage, the memory stores, the signed-URL/segment/blob machinery, and
 * everything they transitively import — runs without any Bun- or Node-only
 * builtin, so it deploys unchanged on Cloudflare Workers / Deno / the edge.
 *
 * The enforcement is a static import-graph scan (not a runtime emulation):
 * starting from the neutral entry files a Workers deployment actually loads
 * (`handler.ts`, `realtime.ts`, `d1-storage.ts`, the memory stores, the
 * Workers-facing helpers), we walk every relative static or dynamic import and `export … from`
 * and assert none of the reachable files:
 *   - import a `bun:*` or `node:*` builtin, or
 *   - reference `Bun.` or the `Buffer` global.
 *
 * The shared SQLite stores are runtime-neutral. Only `sqlite-bun.ts`,
 * `sqlite-node.ts`, and their concrete drivers may import runtime builtins. If
 * a future edit makes one of the checked neutral entries reach for a runtime
 * builtin, this test fails at the source that introduced it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '..', 'src');

/**
 * The files a runtime-neutral deployment loads. A Workers entry imports the
 * HTTP handler (server-hono → these), the realtime session (for the DO
 * follow-up), D1 storage, and the memory stores; the graph walk pulls in
 * their transitive deps.
 */
const ENTRIES = [
  'handler.ts',
  'realtime.ts',
  'd1-storage.ts',
  'segment-store.ts',
  'blob-store.ts',
  'signed-url.ts',
  'segment-download.ts',
  'blob-handlers.ts',
  'content-encoding.ts',
  'admin.ts',
  'events.ts',
  'events-ring.ts',
  'sqlite-driver.ts',
  'sqlite-storage.ts',
  'sqlite-segment-store.ts',
  'sqlite-blob-store.ts',
  'sqlite-lease-store.ts',
  'sqlite-image.ts',
];

/** Resolve a relative import specifier to a `.ts` file under `src`. */
function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // package import, not our source
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, resolve(base, 'index.ts')]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Every relative import/export specifier in a source file that survives to
 * runtime. `import type` / `export type … from` edges are erased by the TS
 * compiler and never load the target module, so they do NOT create a runtime
 * dependency and are excluded — a type-only reference to a Bun-specific
 * module's *types* is neutral.
 */
function runtimeSpecifiers(source: string): string[] {
  source = stripComments(source);
  const out: string[] = [];
  const re =
    /(?:import|export)(\s+type)?\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null = re.exec(source);
  while (match !== null) {
    const isTypeOnly = match[1] !== undefined;
    if (!isTypeOnly && match[2] !== undefined) out.push(match[2]);
    match = re.exec(source);
  }
  for (const dynamic of source.matchAll(
    /\bimport\s*\(\s*(?:'([^']+)'|"([^"]+)"|`([^`$]+)`)/g,
  )) {
    const specifier = dynamic[1] ?? dynamic[2] ?? dynamic[3];
    if (specifier !== undefined) out.push(specifier);
  }
  return out;
}

/** Walk the import graph from the entries; return every reachable file. */
function reachableCoreFiles(): string[] {
  const seen = new Set<string>();
  const queue = ENTRIES.map((name) => resolve(SRC, name));
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of runtimeSpecifiers(source)) {
      const resolved = resolveImport(file, specifier);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen];
}

/** Strip line + block comments so doc-comment mentions do not false-positive. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN_IMPORT = /^(bun|node):/;
const FORBIDDEN_GLOBAL = /\bBun\.|\bBuffer\b/;

describe('runtime neutrality (static scan)', () => {
  const files = reachableCoreFiles();

  test('scanner includes guarded dynamic imports and excludes erased types and comments', () => {
    expect(
      runtimeSpecifiers(`
      import type { Driver } from './sqlite-bun';
      export type { Driver } from './sqlite-node';
      // import('./commented');
      /* import('node:fs'); */
      import './side-effect';
      export { handler } from './handler';
      if (globalThis.Bun) await import('./sqlite-bun');
      await import('bun:sqlite');
      await import(\`./sqlite-node\`);
    `),
    ).toEqual([
      './side-effect',
      './handler',
      './sqlite-bun',
      'bun:sqlite',
      './sqlite-node',
    ]);
  });

  test('neutral entry bundles for browsers without minification', async () => {
    const result = await Bun.build({
      entrypoints: [resolve(SRC, 'index.ts')],
      target: 'browser',
      minify: false,
      conditions: ['browser'],
    });
    expect(result.logs).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.outputs.length).toBeGreaterThan(0);
    for (const output of result.outputs) {
      expect(await output.text()).not.toMatch(
        /(?:bun|node):(?:sqlite|fs|path)/,
      );
    }
  });

  test('the core import graph is non-trivial (the walk actually ran)', () => {
    // Sanity: the handler alone pulls in pull/push/scopes/context/etc.
    expect(files.length).toBeGreaterThan(10);
  });

  test('no core file imports a bun:* or node:* builtin', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const specifier of runtimeSpecifiers(source)) {
        if (FORBIDDEN_IMPORT.test(specifier)) {
          offenders.push(`${file.slice(SRC.length + 1)}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no core file references the Bun or Buffer globals', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (FORBIDDEN_GLOBAL.test(source)) {
        const line = source.split('\n').find((l) => FORBIDDEN_GLOBAL.test(l));
        offenders.push(`${file.slice(SRC.length + 1)}: ${line?.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the D1 storage and memory stores are in the reachable core', () => {
    const names = files.map((f) => f.slice(SRC.length + 1));
    expect(names).toContain('d1-storage.ts');
    expect(names).toContain('segment-store.ts');
    expect(names).toContain('blob-store.ts');
    expect(names).toContain('sqlite-storage.ts');
    expect(names).toContain('sqlite-segment-store.ts');
    expect(names).toContain('sqlite-blob-store.ts');
    expect(names).not.toContain('sqlite-bun.ts');
    expect(names).not.toContain('sqlite-node.ts');
  });
});
