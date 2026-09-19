import type { SAHPoolUtil } from '@sqlite.org/sqlite-wasm';

/**
 * RFC 0005 sibling-container scenario. The names and directories are shared by
 * the worker that runs the scenario and the test that asserts on it.
 */
export const SIBLING_REPLICA = 'opfs-sibling-replica';
export const SIBLING_FLOOR = 'opfs-sibling-floor';
export const SIBLING_NAME = 'prev-context';
export const SIBLING_SECOND = 'second-container';
export const SIBLING_FLOOR_NAME = 'floor-container';

/** The adapter's pool directory for a database name (wasm-database.ts). */
export function siblingDirectory(name: string): string {
  return `.syncular/${name}`;
}

/**
 * Slot for the pool util the wrapper in `opfs-sibling-sqlite.js` records. Both
 * the adapter and this test ride the same sqlite-wasm instance, so the util is
 * the adapter's real pool (a second `sqlite3InitModule()` would be a distinct
 * instance and could not open the same pool directory at all).
 */
export interface SahPoolProbeGlobal {
  __sahPools?: Map<string, SAHPoolUtil>;
}

/**
 * Everything the in-worker scenario observed, as JSON-safe values. Assertions
 * live in the test file; the worker only reports.
 */
export interface SiblingEvidence {
  /** Pool capacity the adapter requested: sqlite-wasm's default of 6. */
  capacity: number;
  filesAfterReplicaOpen: string[];
  fileCountAfterReplicaOpen: number;
  /** The replica's own tables, used as the D3 baseline. */
  replicaTables: string[];

  /** `siblingExists` on two names that were never created. */
  existsBeforeCreate: boolean;
  existsBeforeSecond: boolean;
  filesAfterProbe: string[];
  fileCountAfterProbe: number;

  /** First sibling: create, write, close, reopen. */
  existsAfterCreate: boolean;
  existsAfterClose: boolean;
  filesAfterCreate: string[];
  siblingTables: string[];
  siblingVisibleTables: string[];
  row: Record<string, unknown>[];

  /** The replica connection must not see the sibling's table (D3). */
  replicaTablesWhileSiblingOpen: string[];

  /** A second sibling while the replica and first sibling are open. */
  capacityWhileTwoSiblings: number;
  secondSiblingExists: boolean;
  filesAfterSecondCreate: string[];
  filesAfterSecondRemove: string[];
  secondSiblingExistsAfterRemove: boolean;

  /** Physical removal of the first sibling. */
  existsAfterRemove: boolean;
  filesAfterRemove: string[];
  /** Reopened after removal: a fresh empty file, not the old data. */
  freshTables: string[];
  filesAtEnd: string[];
  fileCountAtEnd: number;

  /** Capacity floor: `initialCapacity: 1` must clamp up to 3. */
  floorCapacity: number;
  floorRowCount: number;
  floorFilesAtEnd: string[];
}
