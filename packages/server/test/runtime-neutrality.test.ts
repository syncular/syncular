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
 * Workers-facing helpers), we walk every relative `import`/`export … from`
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
function relativeSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re =
    /(?:import|export)(\s+type)?\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null = re.exec(source);
  while (match !== null) {
    const isTypeOnly = match[1] !== undefined;
    if (!isTypeOnly && match[2] !== undefined) out.push(match[2]);
    match = re.exec(source);
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
    for (const specifier of relativeSpecifiers(source)) {
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

const FORBIDDEN_IMPORT = /from\s+['"](bun:[^'"]+|node:[^'"]+)['"]/;
const FORBIDDEN_GLOBAL = /\bBun\.|\bBuffer\b/;

describe('runtime neutrality (static scan)', () => {
  const files = reachableCoreFiles();

  test('the core import graph is non-trivial (the walk actually ran)', () => {
    // Sanity: the handler alone pulls in pull/push/scopes/context/etc.
    expect(files.length).toBeGreaterThan(10);
  });

  test('no core file imports a bun:* or node:* builtin', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (FORBIDDEN_IMPORT.test(source)) {
        const line = source.split('\n').find((l) => FORBIDDEN_IMPORT.test(l));
        offenders.push(`${file.slice(SRC.length + 1)}: ${line?.trim()}`);
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
