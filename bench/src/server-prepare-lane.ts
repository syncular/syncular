/**
 * Statement accounting for `SqliteServerStorage` on `bun:sqlite`: replays a
 * steady-state mix of pushes and pulls and reports how many statements go
 * through the cached `db.query` path, how many go through the uncached
 * `db.exec` path, and how many distinct SQL texts the cache holds. Bun
 * caches `db.query` by SQL text, so a distinct text costs one parse and
 * every repeat costs none; `db.exec` parses on every call.
 *
 * Run: `bun src/server-prepare-lane.ts [--rounds 2000]`.
 */
import {
  encodeMessage,
  encodeSparseRow,
  PROTOCOL_WIRE_VERSION,
  type RequestFrame,
  type RowColumn,
} from '@syncular/core';
import {
  compileSchema,
  handleSyncRequest,
  MemorySegmentStore,
  type ServerSchema,
  SqliteServerStorage,
  type SqliteValue,
  type SyncRequestContext,
} from '@syncular/server';
import { BunSqliteDatabase } from '@syncular/server/sqlite';

const roundsArg = process.argv.indexOf('--rounds');
const ROUNDS = roundsArg === -1 ? 2_000 : Number(process.argv[roundsArg + 1]);

const COLUMNS: readonly RowColumn[] = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: true },
];
const SCHEMA: ServerSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      primaryKey: 'id',
      columns: COLUMNS,
      scopes: ['project:{project_id}'],
    },
  ],
};

class CountingDatabase extends BunSqliteDatabase {
  readonly queried = new Map<string, number>();
  readonly executed = new Map<string, number>();
  readonly ran = new Map<string, number>();

  override exec(sql: string): void {
    this.executed.set(sql, (this.executed.get(sql) ?? 0) + 1);
    super.exec(sql);
  }

  override run(sql: string, bindings: readonly SqliteValue[] = []) {
    this.ran.set(sql, (this.ran.get(sql) ?? 0) + 1);
    return super.run(sql, bindings);
  }

  override query<Row, Params extends readonly SqliteValue[]>(sql: string) {
    this.queried.set(sql, (this.queried.get(sql) ?? 0) + 1);
    return super.query<Row, Params>(sql);
  }
}

const db = new CountingDatabase();
const storage = new SqliteServerStorage(db);
await storage.ensureSchema(compileSchema(SCHEMA));
await storage.touchPartition('p', 1_000, 'epoch');
let now = 1_000;
const ctx: SyncRequestContext = {
  partition: 'p',
  actorId: 'actor',
  schema: SCHEMA,
  storage,
  segments: new MemorySegmentStore(),
  resolveScopes: () => ({ project_id: ['a', 'b', 'c'] }),
  clock: () => now,
};

const request = (frames: readonly RequestFrame[]): Uint8Array =>
  encodeMessage({
    wireVersion: PROTOCOL_WIRE_VERSION,
    msgKind: 'request',
    frames: [
      {
        type: 'REQ_HEADER',
        clientId: 'client-1',
        schemaVersion: 1,
        logEpoch: 'epoch',
      },
      ...frames,
    ],
  });
const pull: RequestFrame = {
  type: 'PULL_HEADER',
  limitCommits: 100,
  limitSnapshotRows: 100,
  maxSnapshotPages: 1,
  accept: 3,
};
const subscription = (cursor: number): RequestFrame => ({
  type: 'SUBSCRIPTION',
  id: 'tasks/a',
  table: 'tasks',
  scopes: { project_id: ['a'] },
  cursor,
});

// Warm the schema, partition registry, and client record before counting.
await handleSyncRequest(request([pull, subscription(0)]), ctx);
for (const map of [db.queried, db.executed, db.ran]) map.clear();

for (let round = 0; round < ROUNDS; round++) {
  now += 1;
  await handleSyncRequest(
    request([
      {
        type: 'PUSH_COMMIT',
        clientCommitId: `c${round}`,
        operations: [
          {
            table: 'tasks',
            rowId: `r${round % 50}`,
            op: 'upsert',
            payload: encodeSparseRow(COLUMNS, 0, [
              `r${round % 50}`,
              'a',
              `t${round}`,
            ]),
          },
        ],
      },
      pull,
    ]),
    ctx,
  );
  await handleSyncRequest(request([pull, subscription(round)]), ctx);
}

const total = (map: Map<string, number>): number =>
  [...map.values()].reduce((sum, count) => sum + count, 0);
const row = (label: string, map: Map<string, number>): void => {
  console.log(
    `${label.padEnd(22)} ${String(total(map)).padStart(8)} calls  ${String(map.size).padStart(4)} distinct SQL texts  ${(total(map) / ROUNDS).toFixed(1)} per round`,
  );
};
console.log(`rounds=${ROUNDS} (one push round + one pull round each)`);
row('db.query (cached)', db.queried);
row('db.exec (uncached)', db.executed);
row('db.run (uncached)', db.ran);
for (const [sql, count] of [...db.executed].sort((a, b) => b[1] - a[1])) {
  console.log(`  exec x${count}: ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
}
