/**
 * The local-dev dependency mechanism, made testable.
 *
 * A scaffolded app's package.json carries `workspace:*` ranges (with `--local`)
 * that only resolve inside this repo's workspace. A temp scaffold sits OUTSIDE
 * the workspace, so we link a `node_modules` into it by hand rather than
 * running a (network-dependent) `bun install`:
 *
 * - `@syncular-v2/<pkg>` → the real package directory in `packages/`
 *   (a workspace link, exactly what `bun install` would materialize).
 * - external deps the templates use (`hono`, `@sqlite.org/sqlite-wasm`) →
 *   the already-installed copies under the workspace's `.bun/node_modules`
 *   hoist store. Their own transitive deps resolve by walking up into that
 *   same store, so this stays a thin, offline link.
 *
 * This is the mechanism the README documents. The full-fidelity alternative —
 * a real `bun install` in the temp dir — is gated behind an env flag in the
 * smoke test because it needs the network.
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_PACKAGES } from '../src/constants';

/** The v2 workspace root (…/v2), derived from this file's location. */
export function workspaceRoot(): string {
  // test/ -> packages/create-app -> packages -> v2
  return fileURLToPath(new URL('../../..', import.meta.url));
}

/**
 * External (non-workspace) packages the templates depend on at runtime, plus
 * the type packages their tsconfig needs (`@types/bun` pulls `bun-types`).
 */
const EXTERNAL_DEPS = [
  'hono',
  '@sqlite.org/sqlite-wasm',
  '@types/bun',
  'bun-types',
] as const;

function link(target: string, linkPath: string): void {
  const parent = join(linkPath, '..');
  mkdirSync(parent, { recursive: true });
  if (!existsSync(linkPath)) symlinkSync(target, linkPath);
}

/**
 * Build `<appDir>/node_modules` so a `--local` scaffold resolves offline.
 * Returns the node_modules path.
 */
export function linkWorkspaceInto(appDir: string): string {
  const root = workspaceRoot();
  const nm = join(appDir, 'node_modules');
  mkdirSync(nm, { recursive: true });

  for (const pkg of WORKSPACE_PACKAGES) {
    // "@syncular-v2/server" → packages/server
    const shortName = pkg.slice(pkg.indexOf('/') + 1);
    link(join(root, 'packages', shortName), join(nm, pkg));
  }

  const hoist = join(root, 'node_modules', '.bun', 'node_modules');
  for (const dep of EXTERNAL_DEPS) {
    link(join(hoist, dep), join(nm, dep));
  }

  return nm;
}
