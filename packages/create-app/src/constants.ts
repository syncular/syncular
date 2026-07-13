import { createRequire } from 'node:module';

/**
 * The ONE place naming lives (TODO 6.3 is a product decision — final package
 * identity is not settled). Every user-visible name the scaffolder emits comes
 * from here so a rename is mechanical: change these constants, regenerate the
 * templates' generated files, done. No name is hardcoded elsewhere in this
 * package — grep for the literals below and you should only find them here.
 */

/** The scoped npm namespace for the v2 packages, e.g. `@syncular`. */
export const PACKAGE_SCOPE = '@syncular';

/** The typegen CLI binary name (`syncular generate`, `syncular init`). */
export const CLI_BIN = 'syncular';

/** This package's own bin (`bun create syncular …` / `bunx create-syncular-app …`). */
export const CREATE_BIN = 'create-syncular-app';

/** Human-facing product name in prose. */
export const PRODUCT_NAME = 'syncular';

/**
 * The scoped workspace packages a template may depend on. The scaffolder only
 * rewrites ranges for packages under {@link PACKAGE_SCOPE}, so this list is
 * documentation, not a gate — but it keeps the "what does a template pull in"
 * question answerable from one spot.
 */
export const WORKSPACE_PACKAGES = [
  `${PACKAGE_SCOPE}/core`,
  `${PACKAGE_SCOPE}/server`,
  `${PACKAGE_SCOPE}/server-hono`,
  `${PACKAGE_SCOPE}/client`,
  `${PACKAGE_SCOPE}/react`,
  `${PACKAGE_SCOPE}/tauri`,
  `${PACKAGE_SCOPE}/typegen`,
] as const;

/**
 * The dependency range written into a scaffolded app's package.json when NOT
 * scaffolding for in-tree testing (see {@link scaffoldApp}'s `local` flag).
 *
 * Derived from this package's own version: the release train bumps every
 * @syncular/* package in lockstep, so `^<own version>` is always an honest
 * published range — no constant to remember on each release.
 */
const ownVersion = createRequire(import.meta.url)('../package.json')
  .version as string;

export const PUBLISHED_DEPENDENCY_RANGE = `^${ownVersion}`;

/** Placeholder tokens substituted verbatim during scaffold (dumb + greppable). */
export const PLACEHOLDER = {
  /** Replaced by the chosen project name in package.json/README. */
  projectName: '__PROJECT_NAME__',
} as const;
