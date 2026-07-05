/**
 * Node-run verification for the better-sqlite3 ClientDatabase adapter.
 *
 * bun cannot dlopen better-sqlite3 (ERR_DLOPEN_FAILED, oven-sh/bun#4290), so
 * the adapter's real behavior is proven here under Node against the actual
 * native module, by running the SAME framework-free contract the bun test
 * runs against the reference bun:sqlite adapter.
 *
 * The syncular TS sources use extensionless imports (bundler/bun resolution),
 * which Node's ESM resolver does not follow, so this entry is bundled with bun
 * first (transpile + resolve only — bun never executes better-sqlite3, which it
 * cannot dlopen) and the resulting plain-JS bundle is run under Node. From the
 * web-client package, with better-sqlite3 installed:
 *
 *     bun run verify:node
 *
 * which expands to (see package.json):
 *
 *     bun build ./test/node-database/verify-node.mjs --target=node \
 *       --external better-sqlite3 --outfile=./.verify-node.built.mjs \
 *       && node ./.verify-node.built.mjs
 *
 * The bundle is emitted INSIDE the package so Node's node_modules resolution
 * finds the better-sqlite3 peer. Exits 0 on pass, non-zero with the failing
 * assertion on any divergence.
 */
import { runAdapterContract } from './adapter-contract.ts';
import { openNodeDatabase } from '../../src/node-database.ts';

try {
  runAdapterContract(openNodeDatabase);
  console.log('node-database: better-sqlite3 adapter passes the full contract');
} catch (error) {
  console.error('node-database: VERIFICATION FAILED');
  console.error(error);
  process.exit(1);
}
