// Post-build: rewrite root-absolute href/src to the deploy base path.
// GitHub Pages serves project sites at /<repo>/, so the Pages workflow sets
// DOCS_BASE=/syncular/; a custom domain (or local dev) skips this entirely.
// Kept outside Astro's `base` so authored markdown links stay root-absolute.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = (process.env.DOCS_BASE ?? '/').replace(/\/?$/, '/');
if (base === '/') process.exit(0);

const dist = new URL('../dist', import.meta.url).pathname;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.html') || name.endsWith('.css')) {
      const src = readFileSync(path, 'utf8');
      const out = src
        .replace(/(href|src)="\//g, `$1="${base}`)
        .replace(/url\(\s*['"]?\/(?!\/)/g, (m) => m.replace('/', base));
      if (out !== src) writeFileSync(path, out);
    }
  }
};
walk(dist);
console.log(`rebased dist/ to ${base}`);
