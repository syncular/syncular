import type { ClientDatabase } from '../src/database';
import { httpSegmentDownloader } from '../src/http';
import { openPersistentWasmDatabase } from '../src/wasm-database';
import { startSyncWorker } from '../src/worker-entry';
import type {
  CrashPoint,
  CrashReceipt,
  OpfsProbe,
} from './opfs-bootstrap-fixture';

// The physical-write notification lets the page interrupt real synchronous SQL.
// A held synchronous test request keeps the mid-write boundary stable until
// the page terminates this worker. No timing sleeps or CPU parking loops.
const scope = globalThis as typeof globalThis & {
  postMessage(message: unknown): void;
};
let armed: CrashPoint | undefined;
let database: ClientDatabase;
let importing = false;
const databaseHandles = new WeakSet<object>();

function stopAt(point: CrashPoint, bytes = 0, databaseWrite = false): void {
  if (armed !== point) return;
  armed = undefined;
  const receipt: CrashReceipt = { point, bytes, databaseWrite };
  scope.postMessage({ t: 'crash-point', receipt });
  if (point === 'mid-import') {
    const barrier = new XMLHttpRequest();
    barrier.open('GET', '/crash-barrier', false);
    barrier.send();
    throw new Error('test.crash_barrier_released');
  }
  if (point === 'before-import' || point === 'after-import') {
    throw new Error('test.bootstrap_interrupted');
  }
}

const originalWrite = scope.FileSystemSyncAccessHandle.prototype.write;
scope.FileSystemSyncAccessHandle.prototype.write = function (buffer, options) {
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  // SAH pool data starts at byte 4096 in sqlite-wasm 3.53. Checking the
  // offset excludes SQLite page images written inside a rollback journal.
  if (
    options?.at === 4096 &&
    new TextDecoder().decode(bytes.subarray(0, 16)) === 'SQLite format 3\0'
  ) {
    databaseHandles.add(this);
  }
  const written = originalWrite.call(this, buffer, options);
  if (importing && databaseHandles.has(this))
    stopAt('mid-import', written, true);
  return written;
};

scope.addEventListener('message', (event: MessageEvent) => {
  if (event.data.t === 'arm') {
    armed = event.data.point;
    scope.postMessage({ t: 'armed' });
  }
  if (event.data.t === 'probe') {
    try {
      const integrity = database.query('PRAGMA integrity_check');
      // FTS5's integrity command uses INSERT syntax. Only this disposable
      // test database is inspected; the public query API remains read-only.
      let ftsIntegrity = 'ok';
      try {
        database.exec(
          "INSERT INTO catalogue_fts(catalogue_fts) VALUES ('integrity-check')",
        );
      } catch (error) {
        ftsIntegrity = String(error);
      }
      const probe: OpfsProbe = {
        integrity,
        sqliteVersion: String(
          database.query('SELECT sqlite_version() AS version')[0]?.version,
        ),
        journal: database.query('PRAGMA journal_mode'),
        synchronous: database.query('PRAGMA synchronous'),
        ftsCount: Number(
          database.query(
            "SELECT count(*) AS n FROM catalogue_fts WHERE catalogue_fts MATCH 'needle'",
          )[0]?.n,
        ),
        ftsIntegrity,
      };
      scope.postMessage({ t: 'probe-result', probe });
    } catch (error) {
      scope.postMessage({ t: 'probe-error', message: String(error) });
    }
  }
});

startSyncWorker({
  openDatabase: async (config) => {
    if (config.database.mode !== 'persistent')
      throw new Error('OPFS persistence required');
    try {
      // Exercise a closed/reopened pool before opening the replica's other pool.
      // Their shared I/O callback must outlive the first database connection.
      for (let pass = 0; pass < 2; pass++) {
        const prior = await openPersistentWasmDatabase(
          'opfs-callback-lifetime',
        );
        try {
          if (pass === 0) {
            prior.exec(
              'CREATE TABLE IF NOT EXISTS marker (id INTEGER PRIMARY KEY)',
            );
            prior.exec('INSERT OR REPLACE INTO marker VALUES (1)');
          } else if (prior.query('SELECT id FROM marker')[0]?.id !== 1) {
            throw new Error('OPFS close/reopen lost committed data');
          }
        } finally {
          prior.close();
        }
      }
      database = await openPersistentWasmDatabase(config.database.name, {
        ...(config.database.directory
          ? { directory: config.database.directory }
          : {}),
      });
    } catch (error) {
      scope.postMessage({ t: 'storage-open-failed' });
      throw error;
    }
    // Force dirty database pages to spill before COMMIT, so mid-import
    // interruption exercises a hot rollback journal, not just a memory loss.
    database.exec('PRAGMA cache_size=8');
    database.exec('PRAGMA cache_spill=ON');
    const exec = database.exec.bind(database);
    database.exec = (sql, params) => {
      const imageInsert =
        sql.startsWith('INSERT INTO "catalogue"') && sql.includes('SELECT');
      if (imageInsert) importing = true;
      try {
        exec(sql, params);
      } finally {
        if (imageInsert) importing = false;
      }
    };
    const withImage = database.withSqliteImage?.bind(database);
    if (!withImage) throw new Error('SQLite image support required');
    database.withSqliteImage = (bytes, alias, apply) => {
      stopAt('before-import', bytes.byteLength);
      const result = withImage(bytes, alias, apply);
      scope.postMessage({ t: 'image-committed' });
      stopAt('after-import', bytes.byteLength);
      return result;
    };
    return database;
  },
  createSegments: (config) => {
    if (!config.endpoints.segmentsUrl)
      throw new Error('segment endpoint required');
    return httpSegmentDownloader(config.endpoints.segmentsUrl, {
      fetch: Object.assign(
        async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          const response = await fetch(input, init);
          if (armed === 'download') {
            const chunk = await response.body?.getReader().read();
            if (!chunk?.value?.byteLength)
              throw new Error('partial segment bytes required');
            stopAt('download', chunk.value.byteLength);
            await new Promise(() => {});
          }
          return response;
        },
        { preconnect: fetch.preconnect },
      ),
    });
  },
});
