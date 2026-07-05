/**
 * The Node ClientDatabase (better-sqlite3) adapter — bun-side coverage.
 *
 * bun CANNOT dlopen better-sqlite3 (ERR_DLOPEN_FAILED, oven-sh/bun#4290), so
 * the adapter's real behavior is verified under Node by
 * `test/node-database/verify-node.mjs` (see the web-client README recipe).
 * What we CAN prove under bun:
 *
 *  1. Type-level conformance — `openNodeDatabase` returns a `ClientDatabase`,
 *     the subpath export resolves, and the module imports without pulling the
 *     native peer at import time (it loads lazily on first construction).
 *  2. The behavioral CONTRACT the Node adapter must satisfy is exactly what
 *     the reference bun:sqlite adapter already passes — we run the SAME shared
 *     contract here against the bun adapter, so any divergence in the contract
 *     itself is caught in CI even though the native module cannot load.
 *  3. The missing/unloadable-peer error is helpful, not a raw dlopen failure —
 *     asserted against the real failure bun produces for better-sqlite3.
 */
import { expect, test } from 'bun:test';
// Subpath export resolves and is the same module.
import { openNodeDatabase as openViaSubpath } from '@syncular/client/node';
import { openBunDatabase } from '../src/bun-database';
import type { ClientDatabase } from '../src/database';
// Importing the module must NOT throw (peer is loaded lazily at construction).
import { NodeClientDatabase, openNodeDatabase } from '../src/node-database';
import { runAdapterContract } from './node-database/adapter-contract';

test('module imports without loading the native peer; symbols are typed', () => {
  // Purely type + reference-level: these are ClientDatabase factories.
  const factory: (path?: string) => ClientDatabase = openNodeDatabase;
  expect(typeof factory).toBe('function');
  expect(typeof NodeClientDatabase).toBe('function');
  expect(openViaSubpath).toBe(openNodeDatabase);
});

test('the shared adapter contract passes on the reference bun:sqlite backend', () => {
  // This is the exact contract the Node adapter satisfies under Node. Running
  // it here guards the contract itself and pins bun-adapter parity.
  expect(() => runAdapterContract(openBunDatabase)).not.toThrow();
});

test('missing/unloadable better-sqlite3 fails with a helpful, actionable error', () => {
  // Under bun, better-sqlite3 exists in node_modules but cannot be dlopen'd,
  // so construction hits the ERR_DLOPEN_FAILED branch — the same helpful
  // message a host without the peer installed would see (different wording,
  // both actionable). Assert it names better-sqlite3 and the /node vs /bun
  // guidance rather than surfacing a raw native error.
  let error: Error | undefined;
  try {
    openNodeDatabase();
  } catch (e) {
    error = e as Error;
  }
  expect(error).toBeDefined();
  expect(error?.message).toContain('better-sqlite3');
  expect(error?.message).toContain('openNodeDatabase()');
  // Points the user at the right backend for their runtime.
  expect(error?.message).toMatch(/bun|Node/);
});
