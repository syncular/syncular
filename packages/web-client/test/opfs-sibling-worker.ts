/**
 * RFC 0005 sibling-container scenario, run in a real Web Worker so the OPFS
 * SAH pool exists. The pool util is read from the `__sahPools` slot filled by
 * `opfs-sibling-sqlite.js`, the interposed module that wraps
 * `installOpfsSAHPoolVfs` — the adapter installs its pool through that shim, so
 * this is the adapter's own util with its real `getFileNames()`/`getCapacity()`.
 */
import type { ClientDatabase, SiblingDatabase } from '../src/database';
import { openPersistentWasmDatabase } from '../src/wasm-database';
import {
  SIBLING_FLOOR,
  SIBLING_FLOOR_NAME,
  SIBLING_NAME,
  SIBLING_REPLICA,
  SIBLING_SECOND,
  siblingDirectory,
  type SahPoolProbeGlobal,
  type SiblingEvidence,
} from './opfs-sibling-fixture';

const scope = globalThis as typeof globalThis &
  SahPoolProbeGlobal & {
    postMessage(message: unknown): void;
  };

function poolFor(directory: string) {
  const pool = scope.__sahPools?.get(directory);
  if (pool === undefined)
    throw new Error(
      `the adapter installed no SAH pool for ${JSON.stringify(directory)}`,
    );
  return pool;
}

function tableNames(rows: unknown[]): string[] {
  return rows.map((row) => String((row as { name: unknown }).name));
}

/**
 * The sibling capability is optional on `ClientDatabase`; bind it once so the
 * scenario can use it directly. A persistent wasm database always has it, so a
 * missing capability is a hard failure, not a skipped branch.
 */
function siblingCapability(db: ClientDatabase): {
  siblingExists(name: string): boolean;
  openSibling(name: string): SiblingDatabase;
} {
  const siblingExists = db.siblingExists?.bind(db);
  const openSibling = db.openSibling?.bind(db);
  if (siblingExists === undefined || openSibling === undefined)
    throw new Error(
      'the persistent wasm database offered no sibling capability',
    );
  return {
    siblingExists,
    openSibling: (name) => {
      const handle = openSibling(name);
      if (handle === undefined)
        throw new Error(`no sibling handle for ${name}`);
      return handle;
    },
  };
}

async function runSiblingScenario(): Promise<SiblingEvidence> {
  const directory = siblingDirectory(SIBLING_REPLICA);
  const database = await openPersistentWasmDatabase(SIBLING_REPLICA);
  const pool = poolFor(directory);
  const siblings = siblingCapability(database);

  // A table on the replica makes the sibling itself, not emptiness, the
  // discriminator for the off-connection (D3) assertions below.
  database.exec(
    'CREATE TABLE replica_only (id INTEGER PRIMARY KEY, note TEXT)',
  );
  database.exec("INSERT INTO replica_only VALUES (1, 'replica')");
  const replicaTables = tableNames(
    database.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ),
  );

  const filesAfterReplicaOpen = pool.getFileNames();
  const fileCountAfterReplicaOpen = pool.getFileCount();

  // 2. The existence probe must answer false AND create nothing: the pool's
  // file list is compared byte-for-byte either side of the probes.
  const existsBeforeCreate = siblings.siblingExists(SIBLING_NAME);
  const existsBeforeSecond = siblings.siblingExists(SIBLING_SECOND);
  const filesAfterProbe = pool.getFileNames();
  const fileCountAfterProbe = pool.getFileCount();

  // 3. Create the sibling on the pool, write, close the handle, reopen.
  const handle = siblings.openSibling(SIBLING_NAME);
  const existsAfterCreate = siblings.siblingExists(SIBLING_NAME);
  handle.database.exec(
    'CREATE TABLE sibling_only (id INTEGER PRIMARY KEY, note TEXT)',
  );
  handle.database.exec("INSERT INTO sibling_only VALUES (1, 'container')");
  const siblingTables = tableNames(
    handle.database.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ),
  );
  const replicaTablesWhileSiblingOpen = tableNames(
    database.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ),
  );
  const filesAfterCreate = pool.getFileNames();
  handle.close();
  const existsAfterClose = siblings.siblingExists(SIBLING_NAME);

  const reopened = siblings.openSibling(SIBLING_NAME);
  const row = reopened.database.query(
    'SELECT id, note FROM sibling_only ORDER BY id',
  );
  const siblingVisibleTables = tableNames(
    reopened.database.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ),
  );

  // 4. Capacity headroom: the replica and the first sibling are both live, so
  // a second sibling file (plus its transient journal) must still fit.
  const capacityWhileTwoSiblings = pool.getCapacity();
  const second = siblings.openSibling(SIBLING_SECOND);
  second.database.exec('CREATE TABLE second_only (id INTEGER PRIMARY KEY)');
  second.database.exec('INSERT INTO second_only VALUES (1)');
  const secondSiblingExists = siblings.siblingExists(SIBLING_SECOND);
  const filesAfterSecondCreate = pool.getFileNames();
  second.close();
  second.removeFile();
  const secondSiblingExistsAfterRemove = siblings.siblingExists(SIBLING_SECOND);
  const filesAfterSecondRemove = pool.getFileNames();

  // 5. Physical removal: unlink (not an OPFS entry removal) drops the file, and
  // reopening after removal yields an empty file, which is what proves the
  // bytes are gone rather than only the name mapping.
  reopened.close();
  reopened.removeFile();
  const existsAfterRemove = siblings.siblingExists(SIBLING_NAME);
  const filesAfterRemove = pool.getFileNames();
  const fresh = siblings.openSibling(SIBLING_NAME);
  const freshTables = tableNames(
    fresh.database.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ),
  );
  fresh.close();
  fresh.removeFile();
  const filesAtEnd = pool.getFileNames();
  const fileCountAtEnd = pool.getFileCount();
  database.close();

  // 6. The floor: a request below SAH_POOL_MIN_CAPACITY must clamp to 3, and 3
  // slots must actually carry the replica plus a writable sibling.
  const floor = await openPersistentWasmDatabase(SIBLING_FLOOR, {
    initialCapacity: 1,
  });
  const floorPool = poolFor(siblingDirectory(SIBLING_FLOOR));
  const floorCapacity = floorPool.getCapacity();
  const floorSibling = siblingCapability(floor).openSibling(SIBLING_FLOOR_NAME);
  floorSibling.database.exec(
    'CREATE TABLE floor_only (id INTEGER PRIMARY KEY)',
  );
  floorSibling.database.exec('INSERT INTO floor_only VALUES (1)');
  const floorRowCount = Number(
    floorSibling.database.query('SELECT count(*) AS n FROM floor_only')[0]?.n,
  );
  floorSibling.close();
  floorSibling.removeFile();
  const floorFilesAtEnd = floorPool.getFileNames();
  floor.close();

  return {
    capacity: pool.getCapacity(),
    filesAfterReplicaOpen,
    fileCountAfterReplicaOpen,
    replicaTables,
    existsBeforeCreate,
    existsBeforeSecond,
    filesAfterProbe,
    fileCountAfterProbe,
    existsAfterCreate,
    existsAfterClose,
    filesAfterCreate,
    siblingTables,
    siblingVisibleTables,
    row,
    replicaTablesWhileSiblingOpen,
    capacityWhileTwoSiblings,
    secondSiblingExists,
    filesAfterSecondCreate,
    filesAfterSecondRemove,
    secondSiblingExistsAfterRemove,
    existsAfterRemove,
    filesAfterRemove,
    freshTables,
    filesAtEnd,
    fileCountAtEnd,
    floorCapacity,
    floorRowCount,
    floorFilesAtEnd,
  };
}

scope.addEventListener('message', (event: MessageEvent) => {
  if ((event.data as { t?: string } | null)?.t !== 'run') return;
  runSiblingScenario().then(
    (evidence) => scope.postMessage({ t: 'report', evidence }),
    (error: unknown) =>
      scope.postMessage({
        t: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});
