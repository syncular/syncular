import {
  buildSqliteImage,
  SqliteBlobStore,
  SqliteLeaseStore,
  SqliteSegmentStore,
  SqliteServerStorage,
} from '../../src/sqlite-node.ts';
import { NodeSqliteDatabase } from '../../src/sqlite-node-driver.ts';
import { runServerSqliteContract } from './adapter-contract.ts';

await runServerSqliteContract({
  storage: (path) => new SqliteServerStorage(path),
  segments: () => new SqliteSegmentStore(),
  blobs: () => new SqliteBlobStore(),
  leases: () => new SqliteLeaseStore(),
  buildImage: buildSqliteImage,
});
console.log('server-sqlite: node:sqlite adapter passes the runtime contract');

// A repeated SQL text prepares once: `query` and `run` share the statement cache.
const cached = new NodeSqliteDatabase();
let prepared = 0;
const prepare = cached.native.prepare.bind(cached.native);
cached.native.prepare = (sql) => {
  prepared++;
  return prepare(sql);
};
cached.exec('CREATE TABLE t(a)');
for (let i = 0; i < 3; i++) {
  cached.query('INSERT INTO t(a) VALUES (?)').run(i);
  cached.run('INSERT INTO t(a) VALUES (?)', [i]);
  cached.query('SELECT count(*) AS n FROM t').get();
}
if (
  prepared !== 2 ||
  cached.query('SELECT count(*) AS n FROM t').get().n !== 6
) {
  throw new Error(
    `server-sqlite: expected 2 prepares for 2 distinct texts, got ${prepared}`,
  );
}
console.log('server-sqlite: node:sqlite adapter caches prepared statements');
