#!/usr/bin/env node
/**
 * Post-build pass: TypeScript (moduleResolution: bundler) emits extensionless
 * relative specifiers (`from './foo'`), which Node's ESM resolver rejects at
 * runtime. Rewrite every relative import/export specifier in the emitted
 * dist files to carry an explicit `.js` extension:
 *   - './foo'  ->  './foo.js'   (in .js AND .d.ts)
 * TypeScript resolves `from './foo.js'` inside a .d.ts to the sibling
 * `./foo.d.ts`, so `.js` is the correct specifier in both file kinds.
 * Bare (package) specifiers and already-extensioned ones are left untouched.
 * All emitted dist trees are flat with sibling-only relative imports (verified
 * at build time), so no directory -> /index.js rewriting is needed.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("usage: fix-esm-extensions.mjs <dist-dir> [<dist-dir>...]");
  process.exit(1);
}

/** Matches the specifier in: from '...' , import('...') — relative only. */
const RE = /(\bfrom\s*['"]|\bimport\s*\(\s*['"])(\.\.?\/[^'"]*?)(['"])/g;

function rewrite(file) {
  const src = readFileSync(file, "utf8");
  const out = src.replace(RE, (m, pre, spec, post) => {
    // leave already-extensioned specifiers alone
    if (/\.(js|mjs|cjs|json|d\.ts|css|wasm)$/.test(spec)) return m;
    return `${pre}${spec}.js${post}`;
  });
  if (out !== src) writeFileSync(file, out);
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (p.endsWith(".js") || p.endsWith(".d.ts")) rewrite(p);
  }
}

for (const root of roots) walk(root);
