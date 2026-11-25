import { decodeMessage, unitId } from '@syncular/core';
/**
 * Schema-bump flow (SPEC.md §7.4): NO client-side migration
 * engine. On a schema version increase the client keeps its (schema-agnostic)
 * outbox, wipes local tables, re-bootstraps at the new version, and replays.
 *
 * Two triggers converge on one flow: the local generated-version change on
 * boot (§7.4.2 trigger 1) and the server schema floor after an app update
 * (§7.4.2 trigger 2). A pending commit that cannot re-encode under the new
 * schema surfaces as `sync.outbox_incompatible` (§7.4.4). The re-bootstrap
 * rides the image lane (§5.3) exactly like any fresh bootstrap.
 */
import { check, checkEqual } from '../checks';
import {
  doc,
  FIXTURE_SCHEMA,
  FIXTURE_SCHEMA_V2,
  FIXTURE_SCHEMA_V2_DROP_DOCS,
  FIXTURE_SCHEMA_V2_DROP_META,
  task,
} from '../fixture';
import {
  rawDelete,
  rawPull,
  rawPushCommit,
  rawUpsert,
  responseLive,
  responsePushResults,
  responseSection,
} from '../raw';
import type { DriverRow, DriverSchema, DriverTable } from '../driver';
import type { ClientHandle, Scenario, ScenarioContext } from '../scenario';
import {
  expectConverged,
  seedRows,
  seedTasks,
  syncIdle,
  syncOk,
  unitProgress,
} from './util';

const P1 = { project_id: ['p1'] } as const;
const U1 = { project_id: 'p1' } as const;

/** Rows baseline + sqlite images (§5.3). */
const WITH_SQLITE = 0b0111;

/** Version 2 appends a nullable `tasks.note` (§7.4.4 insert intent). */
const TASKS_WITH_NOTE: DriverSchema = {
  version: 2,
  tables: [
    {
      ...(FIXTURE_SCHEMA.tables[0] as DriverTable),
      columns: [
        ...(FIXTURE_SCHEMA.tables[0] as DriverTable).columns,
        { name: 'note', type: 'string', nullable: true },
      ],
    },
    FIXTURE_SCHEMA.tables[1] as DriverTable,
  ],
};

/** Version 2 maps `tasks.project_id` to the variable `team_id` (§3.1). */
const TASKS_BY_TEAM: DriverSchema = {
  version: 2,
  tables: [
    {
      ...(FIXTURE_SCHEMA.tables[0] as DriverTable),
      scopes: [{ pattern: 'team:{team_id}', column: 'project_id' }],
    },
    FIXTURE_SCHEMA.tables[1] as DriverTable,
  ],
};

/** §7.4.3: version 2 only declares an index on `tasks`; the generation
 * excludes indexes, so it stays. */
const INDEX_V1: DriverSchema = {
  version: 1,
  tables: [
    { ...(FIXTURE_SCHEMA.tables[0] as DriverTable), generation: 'tasks-1' },
    { ...(FIXTURE_SCHEMA.tables[1] as DriverTable), generation: 'docs-1' },
  ],
};
const INDEX_V2: DriverSchema = {
  version: 2,
  tables: [
    {
      ...(INDEX_V1.tables[0] as DriverTable),
      indexes: [{ name: 'tasks_by_title', columns: ['title'], unique: false }],
    },
    INDEX_V1.tables[1] as DriverTable,
  ],
};

/** §3.1 re-key: version 2 adds a second scope pattern to `docs`; `tasks`
 * keeps its patterns and its generation. */
const REKEY_V1: DriverSchema = {
  version: 1,
  tables: [
    { ...(FIXTURE_SCHEMA.tables[0] as DriverTable), generation: 'tasks-1' },
    {
      ...(FIXTURE_SCHEMA.tables[1] as DriverTable),
      generation: 'docs-1',
      scopes: [{ pattern: 'org:{org_id}' }],
    },
  ],
};
const REKEY_V2: DriverSchema = {
  version: 2,
  tables: [
    REKEY_V1.tables[0] as DriverTable,
    { ...(FIXTURE_SCHEMA.tables[1] as DriverTable), generation: 'docs-2' },
  ],
};

/** §3.1 re-key inside a unit: `docs` also declares `project_id`, so U1
 * covers `tasks` and `docs`. Version 2 adds a pattern to `docs`; version 3
 * maps its `project_id` to `body`, so the history of `docs` names the
 * project of rows the pattern no longer matches. */
const sharedDocs = (
  generation: string,
  scopes: DriverTable['scopes'],
): DriverTable => ({
  ...(FIXTURE_SCHEMA.tables[1] as DriverTable),
  generation,
  scopes,
});
const REKEY_SHARED_V1: DriverSchema = {
  version: 1,
  tables: [
    REKEY_V1.tables[0] as DriverTable,
    sharedDocs('docs-1', [
      { pattern: 'org:{org_id}' },
      { pattern: 'project:{project_id}' },
    ]),
  ],
};
const REKEY_SHARED_V2: DriverSchema = {
  version: 2,
  tables: [
    REKEY_V1.tables[0] as DriverTable,
    sharedDocs('docs-2', [
      { pattern: 'org:{org_id}' },
      { pattern: 'project:{project_id}' },
      { pattern: 'doc:{doc_id}', column: 'id' },
    ]),
  ],
};
const REKEY_SHARED_V3: DriverSchema = {
  version: 3,
  tables: [
    REKEY_V1.tables[0] as DriverTable,
    sharedDocs('docs-3', [
      { pattern: 'org:{org_id}' },
      { pattern: 'project:{project_id}', column: 'body' },
    ]),
  ],
};

/** §7.4.3: `tasks` keeps its generation across the bump; `docs` appends a
 * nullable `note` and takes a new one. */
const KEEP_V1: DriverSchema = {
  version: 1,
  tables: [
    { ...(FIXTURE_SCHEMA.tables[0] as DriverTable), generation: 'tasks-1' },
    { ...(FIXTURE_SCHEMA.tables[1] as DriverTable), generation: 'docs-1' },
  ],
};
const KEEP_V2: DriverSchema = {
  version: 2,
  tables: [
    KEEP_V1.tables[0] as DriverTable,
    {
      ...(FIXTURE_SCHEMA.tables[1] as DriverTable),
      generation: 'docs-2',
      columns: [
        ...(FIXTURE_SCHEMA.tables[1] as DriverTable).columns,
        { name: 'note', type: 'string', nullable: true },
      ],
    },
  ],
};

/** §2.4 relaxing a required column: version 2 makes `docs.body` nullable,
 * so `docs` takes a new generation and `tasks` keeps its own. */
const RELAX_V2: DriverSchema = {
  version: 2,
  tables: [
    KEEP_V1.tables[0] as DriverTable,
    {
      ...(FIXTURE_SCHEMA.tables[1] as DriverTable),
      generation: 'docs-relaxed',
      columns: (FIXTURE_SCHEMA.tables[1] as DriverTable).columns.map(
        (column) =>
          column.name === 'body' ? { ...column, nullable: true } : column,
      ),
    },
  ],
};

/** §7.4.3 restriction: `docs` also declares `project_id`, so U1 covers
 * `tasks` (kept) and `docs` (changed: a new nullable `note`). */
const docsByProject = (generation: string): DriverTable => ({
  ...(FIXTURE_SCHEMA.tables[1] as DriverTable),
  generation,
  scopes: [{ pattern: 'org:{org_id}' }, { pattern: 'project:{project_id}' }],
});
const RESTRICT_V1: DriverSchema = {
  version: 1,
  tables: [KEEP_V1.tables[0] as DriverTable, docsByProject('docs-1')],
};
const RESTRICT_V2: DriverSchema = {
  version: 2,
  tables: [
    KEEP_V1.tables[0] as DriverTable,
    {
      ...docsByProject('docs-2'),
      columns: [
        ...(FIXTURE_SCHEMA.tables[1] as DriverTable).columns,
        { name: 'note', type: 'string', nullable: true },
      ],
    },
  ],
};

/**
 * Client A holds U1 live at v1 over three tasks and two docs; then t4 and d3
 * commit above its replica cursor, and A reopens at v2. Returns the cursor.
 */
async function restrictedBump(ctx: ScenarioContext): Promise<{
  readonly a: ClientHandle;
  readonly cursor: number;
}> {
  await seedTasks(
    ctx,
    ['t1', 't2', 't3'].map((id) => task(id, 'p1', id)),
  );
  await seedRows(ctx, 'docs', [
    { ...doc('d1', 'o1', 'p1'), note: null },
    { ...doc('d2', 'o1', 'p1'), note: null },
  ]);
  const a = await ctx.newClient({
    actorId: 'actor-a',
    clientId: 'client-a',
    schema: RESTRICT_V1,
    allowed: { project_id: ['p1'], org_id: ['o1'] },
  });
  await a.api.subscribe(U1);
  await syncIdle(a);
  const cursor = await a.api.replicaCursor();
  check(cursor > 0, 'U1 is live before the bump');
  await seedTasks(ctx, [task('t4', 'p1', 'after')]);
  await seedRows(ctx, 'docs', [{ ...doc('d3', 'o1', 'p1'), note: 'n' }]);
  await ctx.recreateClient(a, RESTRICT_V2);
  checkEqual(
    (await a.api.unitState(unitId(U1)))?.cursor,
    -1,
    'U1 covers a changed table and bootstraps again',
  );
  return { a, cursor };
}

/** Every RESTRICT frame A sent from request `from` on. */
function restrictsSent(a: ClientHandle, from: number): unknown[] {
  return a.sentRequests
    .slice(from)
    .flatMap((bytes) =>
      decodeMessage(bytes).frames.filter((frame) => frame.type === 'RESTRICT'),
    );
}

/** §7.4.3 0.102.0 upgrade: `tasks` declares an index and an FTS projection;
 * `docs` declares neither. Generations from 0.101.0 included both, so only
 * `tasks` carries a new generation. */
const UPGRADE: DriverSchema = {
  version: 1,
  tables: [
    {
      ...(FIXTURE_SCHEMA.tables[0] as DriverTable),
      generation: 'tasks-2',
      indexes: [{ name: 'tasks_by_title', columns: ['title'], unique: false }],
      localProjections: [
        {
          name: 'tasks_fts',
          generation: 'tasks_fts-1',
          columns: [{ name: 'title', declaredType: 'string', source: 'title' }],
          fts: { tokenize: 'unicode61', columns: ['title'] },
        },
      ],
    },
    { ...(FIXTURE_SCHEMA.tables[1] as DriverTable), generation: 'docs-1' },
  ],
};
const DOCS_UNIT = { org_id: 'o1' } as const;

/**
 * A live replica with a queued write, rewritten into the layout 0.101.0 left:
 * the contentful FTS table and its trigger, no `localIndexes` record, an
 * outbox without the send-attempt column, and the 0.101.0 generations.
 */
async function replicaOf0101(
  ctx: ScenarioContext,
): Promise<{ a: ClientHandle; tasks: unknown; docs: unknown }> {
  await seedTasks(ctx, [task('t1', 'p1', 'alpha needle')]);
  await seedRows(ctx, 'docs', [doc('d1', 'o1', 'p1')]);
  const a = await ctx.newClient({
    actorId: 'actor-a',
    clientId: 'client-a',
    schema: UPGRADE,
    allowed: { project_id: ['p1'], org_id: ['o1'] },
  });
  await a.api.subscribeMany([U1, DOCS_UNIT]);
  await syncIdle(a);
  await a.api.mutate([
    { op: 'upsert', table: 'tasks', values: task('t3', 'p1', 'gamma needle') },
  ]);
  const tasks = await unitProgress(a, U1);
  const docs = await unitProgress(a, DOCS_UNIT);
  check(
    a.api.executeStorageSql !== undefined && a.api.querySnapshot !== undefined,
    'storage fault seam',
  );
  const triggers = await a.api.querySnapshot(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB '_syncular_project_tasks_fts*'",
  );
  for (const sql of [
    ...triggers.rows.map((row) => `DROP TRIGGER "${String(row.name)}"`),
    'DROP TABLE tasks_fts',
    'DROP TABLE _syncular_projection_tasks_fts',
    'DROP TABLE _syncular_fts_tasks_fts',
    "DELETE FROM _syncular_local_projections WHERE name='tasks_fts'",
    "CREATE VIRTUAL TABLE tasks_fts USING fts5(_syncular_source_id UNINDEXED, title, tokenize='unicode61')",
    'CREATE TABLE _syncular_fts_tasks_fts(id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE)',
    'INSERT INTO tasks_fts(_syncular_source_id,title) SELECT id,title FROM tasks',
    'INSERT INTO _syncular_fts_tasks_fts(id,source_id) SELECT rowid,_syncular_source_id FROM tasks_fts',
    'CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN INSERT INTO tasks_fts(_syncular_source_id,title) VALUES (new.id,new.title); END',
    "DELETE FROM _syncular_meta WHERE key='localIndexes'",
    `UPDATE _syncular_meta SET value='{"docs":"docs-1","tasks":"tasks-1"}' WHERE key='localTableGenerations'`,
    'ALTER TABLE _syncular_outbox DROP COLUMN attempted',
  ])
    await a.api.executeStorageSql(sql);
  checkEqual(
    (
      await a.api.querySnapshot(
        "SELECT (SELECT count(*) FROM pragma_table_info('_syncular_outbox') WHERE name='attempted') AS attempted, (SELECT instr(sql, 'content=') FROM sqlite_master WHERE name='tasks_fts') AS external",
      )
    ).rows,
    [{ attempted: 0, external: 0 }],
    'the replica is in the 0.101.0 layout',
  );
  return { a, tasks, docs };
}

/** The upgraded replica's FTS answers, declared index, attempt markers and
 * stored generations. */
async function upgradedState(a: ClientHandle): Promise<unknown> {
  const read = async (sql: string) => (await a.api.querySnapshot!(sql)).rows;
  return {
    search: await read(
      "SELECT _syncular_source_id AS id FROM tasks_fts WHERE tasks_fts MATCH 'needle' ORDER BY id",
    ),
    externalContent: await read(
      "SELECT instr(sql, 'content=''_syncular_projection_tasks_fts''') > 0 AS yes FROM sqlite_master WHERE name='tasks_fts'",
    ),
    oldTrigger: await read(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='tasks_fts_ai'",
    ),
    index: await read(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_by_title'",
    ),
    attempted: await read('SELECT attempted AS a FROM _syncular_outbox'),
    generations: JSON.parse(
      String(
        (
          await read(
            "SELECT value FROM _syncular_meta WHERE key='localTableGenerations'",
          )
        )[0]?.value,
      ),
    ),
  };
}

const UPGRADED = {
  search: [{ id: 't1' }, { id: 't3' }],
  externalContent: [{ yes: 1 }],
  oldTrigger: [],
  index: [{ name: 'tasks_by_title' }],
  attempted: [{ a: 1 }],
  generations: { docs: 'docs-1', tasks: 'tasks-2' },
};

export const schemaBumpScenarios: readonly Scenario[] = [
  {
    // 0.102.0 Upgrading: the first open at an unchanged schema version resets
    // no table; it rebuilds FTS in place, creates the declared index and
    // stores the new generations. A later bump resets only what it changes.
    name: 'schema-bump/a-0.101.0-replica-upgrades-in-place-at-the-same-version',
    specRefs: ['§7.4.1', '§7.4.3'],
    requires: ['storage-fault'],
    server: { schema: UPGRADE },
    async run(ctx) {
      const { a, tasks, docs } = await replicaOf0101(ctx);
      await ctx.recreateClient(a, UPGRADE);
      checkEqual(
        [await unitProgress(a, U1), await unitProgress(a, DOCS_UNIT)],
        [tasks, docs],
        'the same-version open keeps every unit',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId).sort(),
        ['t1', 't3'],
        'the same-version open keeps the table and the queued write',
      );
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.rowId),
        ['d1'],
        'the same-version open keeps the table without an index',
      );
      checkEqual(
        await upgradedState(a),
        UPGRADED,
        'FTS, the declared index, the attempt marker and the generations are current',
      );
      // Version 2 changes only the generation of `docs`.
      const v2: DriverSchema = {
        version: 2,
        tables: [
          UPGRADE.tables[0] as DriverTable,
          { ...(UPGRADE.tables[1] as DriverTable), generation: 'docs-2' },
        ],
      };
      await ctx.server.restart(v2);
      await ctx.recreateClient(a, v2);
      checkEqual(
        await unitProgress(a, U1),
        tasks,
        'the bump keeps the unchanged table and its unit',
      );
      checkEqual(
        (await a.api.unitState(unitId(DOCS_UNIT)))?.cursor,
        -1,
        'the bump resets the changed table only',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId).sort(),
        ['t1', 't3'],
        'the kept table keeps its rows',
      );
      checkEqual(
        await a.api.readRows('docs'),
        [],
        'the changed table is recreated',
      );
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.rowId),
        ['d1'],
        'the changed table bootstraps again',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the queued write drained',
      );
    },
  },
  {
    // 0.104.1 Upgrading: typegen lists the 0.101.0 generation of each table
    // whose declaration is unchanged, so the bump keeps the table with an
    // index and FTS without a request, and rebuilds FTS and the index in place.
    name: 'schema-bump/a-0.101.0-replica-keeps-its-equivalent-tables-across-a-bump',
    specRefs: ['§7.4.3'],
    requires: ['storage-fault'],
    server: { schema: UPGRADE },
    async run(ctx) {
      const { a, tasks, docs } = await replicaOf0101(ctx);
      const v2: DriverSchema = {
        version: 2,
        tables: [
          {
            ...(UPGRADE.tables[0] as DriverTable),
            equivalentGenerations: ['tasks-1'],
          },
          UPGRADE.tables[1] as DriverTable,
        ],
      };
      await ctx.server.restart(v2);
      const sent = a.sentRequests.length;
      await ctx.recreateClient(a, v2);
      checkEqual(
        [await unitProgress(a, U1), await unitProgress(a, DOCS_UNIT)],
        [tasks, docs],
        'the bump keeps every unit',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId).sort(),
        ['t1', 't3'],
        'the bump keeps the table with an index and FTS and the queued write',
      );
      checkEqual(
        await upgradedState(a),
        UPGRADED,
        'FTS, the declared index, the attempt marker and the generations are current',
      );
      checkEqual(a.sentRequests.length, sent, 'the bump sends no request');
      await syncIdle(a);
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the queued write drained',
      );
    },
  },
  // 0.104.1 Upgrading: a real change still resets a 0.101.0 table. A NOT NULL
  // relaxation names the table, so typegen lists none of its strings. An
  // appended encrypted column carries a list built from today's manifest,
  // which holds no string a replica wrote.
  ...(
    [
      {
        change: 'relaxed-to-nullable',
        docs: {
          generation: 'docs-relaxed',
          columns: (UPGRADE.tables[1] as DriverTable).columns.map((column) =>
            column.name === 'body' ? { ...column, nullable: true } : column,
          ),
        },
      },
      {
        change: 'newly-encrypted',
        docs: {
          generation: 'docs-sealed',
          equivalentGenerations: ['docs-sealed-0101'],
          columns: [
            ...(UPGRADE.tables[1] as DriverTable).columns,
            {
              name: 'secret',
              type: 'bytes',
              nullable: true,
              encrypted: true,
              declaredType: 'string',
            },
          ],
        },
      },
    ] satisfies { change: string; docs: Partial<DriverTable> }[]
  ).map(
    ({ change, docs }): Scenario => ({
      name: `schema-bump/a-0.101.0-table-with-a-${change}-column-resets`,
      specRefs: ['§7.4.3'],
      requires: ['storage-fault'],
      server: { schema: UPGRADE },
      async run(ctx) {
        const { a, tasks } = await replicaOf0101(ctx);
        const v2: DriverSchema = {
          version: 2,
          tables: [
            {
              ...(UPGRADE.tables[0] as DriverTable),
              equivalentGenerations: ['tasks-1'],
            },
            { ...(UPGRADE.tables[1] as DriverTable), ...docs },
          ],
        };
        await ctx.server.restart(v2);
        await ctx.recreateClient(a, v2);
        checkEqual(
          await unitProgress(a, U1),
          tasks,
          'the unchanged table keeps its unit',
        );
        checkEqual(
          (await a.api.unitState(unitId(DOCS_UNIT)))?.cursor,
          -1,
          'the changed table resets',
        );
        checkEqual(
          await a.api.readRows('docs'),
          [],
          'the changed table is recreated',
        );
      },
    }),
  ),
  {
    // §7.4.3 declared indexes: an index-only change reconciles in place and
    // resets no table and no unit.
    name: 'schema-bump/an-index-only-change-keeps-the-table',
    specRefs: ['§7.4.3'],
    server: { schema: INDEX_V1 },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'one')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: INDEX_V1,
        allowed: { project_id: ['p1'] },
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      const kept = await unitProgress(a, U1);
      await ctx.server.restart(INDEX_V2);
      await ctx.recreateClient(a, INDEX_V2);
      checkEqual(
        await unitProgress(a, U1),
        kept,
        'the unit keeps its state across the index-only bump',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'the table keeps its rows',
      );
      const indexes = await a.api.querySnapshot?.(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_by_title'",
      );
      if (indexes !== undefined)
        checkEqual(
          indexes.rows,
          [{ name: 'tasks_by_title' }],
          'the declared index exists',
        );
      await ctx.server.setAllowedScopes('writer', { project_id: ['p1'] });
      const t2 = await ctx.rawSync(
        'writer',
        [
          rawPushCommit('t2', [
            rawUpsert(INDEX_V2, 'tasks', task('t2', 'p1', 'two')),
          ]),
        ],
        { clientId: 'writer', schemaVersion: INDEX_V2.version },
      );
      check(t2.ok, 't2 commits after the bump');
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1', 't2'],
        'the kept unit keeps pulling',
      );
      // Version 3 no longer declares the index: the client drops the index
      // it created, and still keeps the table.
      await ctx.server.restart({ ...INDEX_V1, version: 3 });
      await ctx.recreateClient(a, { ...INDEX_V1, version: 3 });
      checkEqual(
        (
          await a.api.querySnapshot?.(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_by_title'",
          )
        )?.rows ?? [],
        [],
        'a stale declared index is dropped',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1', 't2'],
        'dropping an index keeps the table',
      );
    },
  },
  {
    // §7.4.3, §4.7: a unit covering a kept and a changed table bootstraps the
    // changed table only and joins the scan at its kept cursor.
    name: 'schema-bump/restricted-unit-bootstraps-changed-tables-only',
    specRefs: ['§7.4.3', '§4.3', '§4.7', '§4.5'],
    requires: ['schema-window'],
    server: { schema: RESTRICT_V2, schemaWindow: [RESTRICT_V2, RESTRICT_V1] },
    async run(ctx) {
      const { a, cursor } = await restrictedBump(ctx);
      const sent = a.sentRequests.length;
      const report = await syncIdle(a);
      checkEqual(
        restrictsSent(a, sent)[0],
        { type: 'RESTRICT', cursor, tables: ['docs'] },
        'the first pull restricts U1 to docs at its kept cursor',
      );
      checkEqual(
        report.segmentRowsApplied,
        3,
        'only the three docs rows were transferred',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId).sort(),
        ['t1', 't2', 't3', 't4'],
        'the kept table kept its rows and caught up through the scan',
      );
      checkEqual(
        (await a.api.unitState(unitId(U1)))?.cursor,
        undefined,
        'U1 is live after the restricted bootstrap',
      );
      check((await a.api.upgrading?.()) !== true, 'upgrading cleared');
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      await expectConverged(ctx, 'docs', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
  {
    // §9: a server bump that appends a column re-encodes the changes it
    // logged before the bump. A restricted client at v2 and a schema-window
    // client at v1 both read a pre-bump change of the bumped table.
    name: 'schema-bump/appended-column-serves-pre-bump-changes',
    specRefs: ['§9', '§7.4.3', '§4.3', '§4.5'],
    requires: ['schema-window'],
    server: { schema: RESTRICT_V1 },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 't1')]);
      await seedRows(ctx, 'docs', [doc('d1', 'o1', 'p1')]);
      const allowed = { project_id: ['p1'], org_id: ['o1'] };
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: RESTRICT_V1,
        allowed,
      });
      const old = await ctx.newClient({
        actorId: 'actor-old',
        clientId: 'client-old',
        schema: RESTRICT_V1,
        allowed,
      });
      for (const client of [a, old]) {
        await client.api.subscribe(U1);
        await syncIdle(client);
      }
      const cursor = await a.api.replicaCursor();
      // Logged under v1, above both clients' cursors.
      await seedTasks(ctx, [task('t2', 'p1', 't2')]);
      await seedRows(ctx, 'docs', [doc('d2', 'o1', 'p1')]);

      await ctx.server.restart(RESTRICT_V2, [RESTRICT_V2, RESTRICT_V1]);
      await ctx.recreateClient(a, RESTRICT_V2);
      const sent = a.sentRequests.length;
      await syncIdle(a);
      checkEqual(
        restrictsSent(a, sent)[0],
        { type: 'RESTRICT', cursor, tables: ['docs'] },
        'the upgraded client restricts U1 to docs at its kept cursor',
      );
      await syncIdle(old);
      for (const client of [a, old]) {
        checkEqual(
          (await client.api.readRows('tasks')).map((row) => row.rowId),
          ['t1', 't2'],
          'the kept table caught up through the scan',
        );
        checkEqual(
          (await client.api.readRows('docs')).map((row) => row.rowId),
          ['d1', 'd2'],
          'the pre-bump docs change reaches the client',
        );
      }
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.values.note),
        [null, null],
        'the appended column reads NULL on pre-bump rows',
      );
    },
  },
  {
    // §4.3, §5.6: a server that predates RESTRICT skips it and serves the
    // whole bootstrap, which the client applies; the restriction ends.
    name: 'schema-bump/restrict-skipped-by-older-server-bootstraps-whole',
    specRefs: ['§4.3', '§5.6', '§9'],
    requires: ['schema-window'],
    server: { schema: RESTRICT_V2, schemaWindow: [RESTRICT_V2, RESTRICT_V1] },
    async run(ctx) {
      const { a } = await restrictedBump(ctx);
      a.faults.skipRequestFrames = ['RESTRICT'];
      const report = await syncIdle(a);
      checkEqual(
        report.segmentRowsApplied,
        7,
        'the whole unit was transferred: four tasks and three docs',
      );
      const sent = a.sentRequests.length;
      a.faults.skipRequestFrames = [];
      await syncIdle(a);
      checkEqual(
        restrictsSent(a, sent),
        [],
        'the completed whole bootstrap ended the restriction',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      await expectConverged(ctx, 'docs', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
  {
    // §4.6: a kept cursor below the horizon cannot join; the unit takes the
    // reset round trip and bootstraps whole.
    name: 'schema-bump/restricted-unit-below-horizon-resets-whole',
    specRefs: ['§4.6', '§7.4.3'],
    requires: ['schema-window'],
    server: { schema: RESTRICT_V2, schemaWindow: [RESTRICT_V2, RESTRICT_V1] },
    async run(ctx) {
      const { a } = await restrictedBump(ctx);
      await ctx.server.advanceClock(60 * 60 * 1000);
      const horizon = await ctx.server.prune({
        activeWindowMs: 0,
        ageForceMs: 0,
        minRetainedCommits: 0,
      });
      checkEqual(
        horizon,
        await ctx.server.getMaxCommitSeq(),
        'the horizon passed the kept cursor',
      );
      const first = await syncOk(a);
      check(first.resets.includes(unitId(U1)), 'U1 answered reset (§4.6)');
      checkEqual(first.segmentRowsApplied, 0, 'the reset carried no segment');
      const sent = a.sentRequests.length;
      const rest = await syncIdle(a);
      checkEqual(restrictsSent(a, sent), [], 'the reset ended the restriction');
      checkEqual(
        rest.segmentRowsApplied,
        7,
        'the unit bootstrapped whole: four tasks and three docs',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      await expectConverged(ctx, 'docs', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
  {
    // §7.4.3: a bump keeps the table whose generation is unchanged, with its
    // rows and the live unit that covers only it; the changed table is
    // recreated and its unit bootstraps again. §7.4.5: the status reports the
    // kept table beside `upgrading` until the changed unit completes.
    name: 'schema-bump/unchanged-generation-keeps-table-and-unit',
    specRefs: ['§7.4.3', '§7.4.4', '§7.4.5', '§4.5'],
    requires: ['schema-window'],
    server: { schema: KEEP_V2, schemaWindow: [KEEP_V2, KEEP_V1] },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'one'), task('t2', 'p1', 'two')]);
      await seedRows(ctx, 'docs', [{ ...doc('d1', 'o1', 'p1'), note: 'n' }]);
      const docsUnit = { org_id: 'o1' };
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: KEEP_V1,
        allowed: { project_id: ['p1'], org_id: ['o1'] },
      });
      await a.api.subscribeMany([U1, docsUnit]);
      await syncIdle(a);
      const kept = await unitProgress(a, U1);
      const replicaCursor = await a.api.replicaCursor();
      check(replicaCursor > 0, 'both units are live before the bump');
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t3', 'p1', 'offline') },
      ]);

      await ctx.recreateClient(a, KEEP_V2);
      const upgrade = async () => {
        const status = await a.api.statusSnapshot?.();
        return [status?.upgrading, status?.upgradeKeptTables];
      };
      checkEqual(
        await upgrade(),
        [true, true],
        'the reset is upgrading and reports the kept table',
      );
      checkEqual(
        await unitProgress(a, U1),
        kept,
        'the unit covering only the kept table keeps its state',
      );
      checkEqual(
        (await a.api.unitState(unitId(docsUnit)))?.cursor,
        -1,
        'the unit covering the changed table bootstraps again',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId).sort(),
        ['t1', 't2', 't3'],
        'the kept table keeps its rows and the pending write',
      );
      checkEqual(
        await a.api.readRows('docs'),
        [],
        'the changed table is recreated',
      );

      const sent = a.sentRequests.length;
      await syncIdle(a);
      const frames = decodeMessage(a.sentRequests[sent] as Uint8Array).frames;
      checkEqual(
        frames.flatMap((frame) =>
          frame.type === 'PULL_HEADER'
            ? [['cursor', frame.cursor]]
            : frame.type === 'PROGRESS'
              ? [[frame.id, frame.cursor]]
              : [],
        ),
        [
          ['cursor', replicaCursor],
          [unitId(docsUnit), -1],
        ],
        'the next pull keeps the replica cursor and bootstraps only the changed unit',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the pending write drained',
      );
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.values),
        [{ ...doc('d1', 'o1', 'p1'), note: 'n' }],
        'the changed table bootstraps under the new schema',
      );
      checkEqual(
        await upgrade(),
        [false, false],
        'the completed bootstrap clears the upgrade',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
  {
    // §2.4: the server upgrades its populated store in place, an earlier
    // client meets the floor, and the upgraded client re-downloads only the
    // relaxed table and replays the writes it queued under the old schema.
    name: 'schema-bump/required-column-relaxed-to-nullable',
    specRefs: ['§2.4', '§1.6', '§7.4.3', '§7.4.4'],
    server: { schema: KEEP_V1 },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'one')]);
      await seedRows(ctx, 'docs', [
        doc('d1', 'o1', 'p1', 'first'),
        doc('d2', 'o1', 'p1', 'second'),
        doc('d3', 'o1', 'p1', 'third'),
      ]);
      const docsUnit = { org_id: 'o1' };
      const allowed = {
        project_id: ['p1'],
        org_id: ['o1'],
        projectId: ['p1'],
      };
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: KEEP_V1,
        allowed,
      });
      await a.api.subscribeMany([U1, docsUnit]);
      await syncIdle(a);
      const kept = await unitProgress(a, U1);
      // Queued under version 1: a full upsert and a sparse patch.
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'docs',
          values: doc('d1', 'o1', 'p1', 'offline'),
        },
        { op: 'patch', table: 'docs', values: { id: 'd2', body: 'patched' } },
      ]);

      await ctx.server.restart(RELAX_V2);
      const old = await ctx.newClient({
        actorId: 'actor-old',
        clientId: 'client-old',
        schema: KEEP_V1,
        allowed,
      });
      await old.api.subscribe(docsUnit);
      checkEqual(
        (await syncOk(old)).schemaFloor?.requiredSchemaVersion,
        2,
        'a client that would refuse a NULL body meets the floor',
      );

      await ctx.recreateClient(a, RELAX_V2);
      checkEqual(
        await unitProgress(a, U1),
        kept,
        'the unit over the unchanged table keeps its state',
      );
      checkEqual(
        (await a.api.unitState(unitId(docsUnit)))?.cursor,
        -1,
        'the relaxed table bootstraps again',
      );
      await syncIdle(a);
      checkEqual(await a.api.rejections(), [], 'both queued writes apply');
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'docs',
          values: { ...doc('d4', 'o1', 'p1'), body: null },
        },
      ]);
      await syncIdle(a);
      checkEqual(
        (await ctx.server.readRows('docs')).map((row) => row.values),
        [
          doc('d1', 'o1', 'p1', 'offline'),
          doc('d2', 'o1', 'p1', 'patched'),
          doc('d3', 'o1', 'p1', 'third'),
          { ...doc('d4', 'o1', 'p1'), body: null },
        ],
        'stored values survive, queued writes land, and a NULL is stored',
      );
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        schema: RELAX_V2,
        allowed,
      });
      await b.api.subscribe(docsUnit);
      await syncIdle(b);
      checkEqual(
        (await b.api.readRows('docs')).find((row) => row.rowId === 'd4')?.values
          .body,
        null,
        'a NULL reads back as NULL',
      );
      await expectConverged(ctx, 'docs', [a, b]);
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
  {
    // §7.4.3: without generations every table and unit resets.
    name: 'schema-bump/no-generations-resets-every-table',
    specRefs: ['§7.4.3', '§7.4.5'],
    requires: ['schema-window'],
    server: {
      schema: TASKS_WITH_NOTE,
      schemaWindow: [TASKS_WITH_NOTE, FIXTURE_SCHEMA],
    },
    async run(ctx) {
      await seedRows(ctx, 'docs', [doc('d1', 'o1', 'p1')]);
      const docsUnit = { org_id: 'o1' };
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'], org_id: ['o1'] },
      });
      await a.api.subscribeMany([U1, docsUnit]);
      await syncIdle(a);
      await ctx.recreateClient(a, TASKS_WITH_NOTE);
      checkEqual(await a.api.replicaCursor(), -1, 'no unit stays live');
      const status = await a.api.statusSnapshot?.();
      checkEqual(
        [status?.upgrading, status?.upgradeKeptTables],
        [true, false],
        'a reset that kept no table reports none',
      );
      checkEqual(
        await a.api.readRows('docs'),
        [],
        'the unchanged table resets too',
      );
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.rowId),
        ['d1'],
        'the reset table bootstraps again',
      );
    },
  },
  {
    // §3.1 re-key: the server bump recomputes stored scopes from row columns,
    // so a unit of the new variable bootstraps every row with no data step;
    // §4.6: the history logged under the old variable lies at or below the
    // table horizon.
    name: 'schema-bump/scope-pattern-change-rekeys-stored-rows',
    specRefs: ['§3.1', '§4.6', '§2.2', '§7.4.3'],
    async run(ctx) {
      await ctx.server.setAllowedScopes('writer', { project_id: ['p1', 'p2'] });
      const push = (
        id: string,
        schema: DriverSchema,
        ops: Parameters<typeof rawPushCommit>[1],
      ) =>
        ctx.rawSync('writer', [rawPushCommit(id, ops)], {
          clientId: 'writer',
          schemaVersion: schema.version,
        });
      await push('seed', FIXTURE_SCHEMA, [
        rawUpsert(FIXTURE_SCHEMA, 'tasks', task('t1', 'p1', 'one')),
        rawUpsert(FIXTURE_SCHEMA, 'tasks', task('t2', 'p1', 'two')),
        rawUpsert(FIXTURE_SCHEMA, 'tasks', task('t3', 'p2', 'three')),
      ]);
      await push('drop', FIXTURE_SCHEMA, [rawDelete('tasks', 't2')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'the client of the old variable holds its rows',
      );

      await ctx.server.restart(TASKS_BY_TEAM);
      // Grants name the variables the running schema declares (§3.2).
      await ctx.server.setAllowedScopes('writer', { team_id: ['p1', 'p2'] });
      await ctx.server.setAllowedScopes('actor-a', { team_id: ['p1'] });

      await ctx.recreateClient(a, TASKS_BY_TEAM);
      await a.api.subscribe({ team_id: 'p1' });
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'the updated client bootstraps its rows under the new variable',
      );
      const b = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-b',
        schema: TASKS_BY_TEAM,
        allowed: { team_id: ['p1', 'p2'] },
      });
      await b.api.subscribeMany([{ team_id: 'p1' }, { team_id: 'p2' }]);
      await syncIdle(b);
      checkEqual(
        (await b.api.readRows('tasks')).map((row) => row.rowId).sort(),
        ['t1', 't3'],
        'a unit of the new variable bootstraps every stored row (§3.1)',
      );

      // A cursor into the history logged under `project_id` is reset. The
      // re-key took commit sequence number 3 as the table horizon (§4.6).
      const pull = (cursor: number) =>
        ctx.rawSync(
          'writer',
          [...rawPull([{ scopes: { team_id: 'p1' } }], { cursor })],
          { clientId: 'reader', schemaVersion: TASKS_BY_TEAM.version },
        );
      for (const cursor of [1, 2]) {
        const old = await pull(cursor);
        check(old.ok, 'the old-cursor pull answers');
        if (!old.ok) return;
        const expired = responseSection(old.message, { team_id: 'p1' }).start;
        checkEqual(
          {
            status: expired.status,
            reasonCode: expired.reasonCode,
            commits: responseLive(old.message).commits.length,
          },
          { status: 'reset', reasonCode: 'sync.cursor_expired', commits: 0 },
          `cursor ${cursor}, below the table horizon, resets the unit (§4.6)`,
        );
      }
      const head = await pull(3);
      check(head.ok, 'the head-cursor pull answers');
      if (!head.ok) return;
      checkEqual(
        responseLive(head.message).commits.length,
        0,
        'no change logged before the bump reaches the new variable',
      );

      // §2.2: the re-key dropped t2's tombstone, so an unversioned upsert
      // inserts the row again instead of answering sync.row_deleted.
      const again = await push('again', TASKS_BY_TEAM, [
        rawUpsert(TASKS_BY_TEAM, 'tasks', task('t2', 'p1', 'again')),
      ]);
      checkEqual(
        again.ok ? responsePushResults(again.message)[0]?.status : undefined,
        'applied',
        'an unversioned upsert of a row deleted before the bump inserts it',
      );
      await syncIdle(b);
      checkEqual(
        (await b.api.readRows('tasks')).map((row) => row.rowId).sort(),
        ['t1', 't2', 't3'],
        'the recreated row reaches the new variable',
      );
    },
  },
  {
    // §4.6 table horizon: a re-key resets the units over the re-keyed table
    // and no other; §7.4.3: a client that takes the bump downloads only the
    // re-keyed table.
    name: 'schema-bump/rekey-resets-only-units-over-the-table',
    specRefs: ['§3.1', '§4.6', '§4.5', '§4.7', '§7.4.3'],
    server: { schema: REKEY_V1 },
    async run(ctx) {
      const DOCS = { org_id: 'o1' } as const;
      const allowed = { project_id: ['p1'], org_id: ['o1'] };
      await seedTasks(ctx, [task('t1', 'p1', 'one')]);
      await seedRows(ctx, 'docs', [doc('d1', 'o1', 'p1')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: REKEY_V1,
        allowed,
      });
      await a.api.subscribeMany([U1, DOCS]);
      await syncIdle(a);
      // t2 commits above A's replica cursor before the bump.
      await seedTasks(ctx, [task('t2', 'p1', 'two')]);
      const head = await ctx.server.getMaxCommitSeq();
      const horizon = await ctx.server.getHorizonSeq();

      await ctx.server.restart(REKEY_V2);
      checkEqual(
        {
          max: await ctx.server.getMaxCommitSeq(),
          horizon: await ctx.server.getHorizonSeq(),
        },
        { max: head + 1, horizon },
        'the re-key takes a commit sequence number and leaves horizonSeq',
      );
      // The seed helpers push at the scenario's starting version.
      await ctx.server.setAllowedScopes('reader', allowed);
      const t3 = await ctx.rawSync(
        'reader',
        [
          rawPushCommit('t3', [
            rawUpsert(REKEY_V2, 'tasks', task('t3', 'p1', 'three')),
          ]),
        ],
        { clientId: 'writer', schemaVersion: REKEY_V2.version },
      );
      checkEqual(
        t3.ok ? responsePushResults(t3.message)[0]?.status : undefined,
        'applied',
        't3 commits after the bump',
      );

      // A replica live on both units at the head before the bump.
      const pull = (units: Parameters<typeof rawPull>[0], cursor: number) =>
        ctx.rawSync('reader', [...rawPull(units, { cursor })], {
          clientId: 'reader',
          schemaVersion: REKEY_V2.version,
        });
      const first = await pull([{ scopes: U1 }, { scopes: DOCS }], head);
      check(first.ok, 'the pull at the pre-bump head answers');
      if (!first.ok) return;
      const live = responseLive(first.message);
      checkEqual(
        {
          tasks: responseSection(first.message, U1).start.status,
          docs: [
            responseSection(first.message, DOCS).start.status,
            responseSection(first.message, DOCS).start.reasonCode,
          ],
          live: live.start.status,
          rows: live.commits.flatMap((commit) =>
            commit.changes.map(
              (change) => `${commit.tables[change.tableIndex]}/${change.rowId}`,
            ),
          ),
        },
        {
          tasks: 'active',
          docs: ['reset', 'sync.cursor_expired'],
          live: 'active',
          rows: ['tasks/t3'],
        },
        'only the unit over the re-keyed table resets; the other stays live',
      );
      const second = await pull(
        [{ scopes: U1 }, { scopes: DOCS, cursor: -1 }],
        live.end.throughSeq,
      );
      check(second.ok, 'the pull after the reset answers');
      if (!second.ok) return;
      const docs = responseSection(second.message, DOCS);
      checkEqual(
        {
          bootstrap: docs.start.bootstrap,
          complete: docs.end.bootstrapState === undefined,
          live: responseLive(second.message).start.status,
        },
        { bootstrap: true, complete: true, live: 'active' },
        'the reset unit bootstraps while the other stays live',
      );

      // A takes the bump: `tasks` keeps its rows and its cursor, `docs`
      // bootstraps under the new patterns.
      await ctx.recreateClient(a, REKEY_V2);
      const report = await syncIdle(a);
      checkEqual(report.resets, [], 'no unit of A resets');
      checkEqual(
        report.segmentRowsApplied,
        1,
        'A downloads the re-keyed table only',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1', 't2', 't3'],
        'the unit over tasks caught up from its kept cursor',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      await expectConverged(ctx, 'docs', [a], {
        variable: 'org_id',
        values: ['o1'],
      });
    },
  },
  {
    // §4.6, §4.7: a unit over a kept table and a re-keyed one bootstraps the
    // re-keyed table only, and the scan serves that table only above its
    // table horizon.
    name: 'schema-bump/rekey-restricts-a-unit-to-the-rekeyed-table',
    specRefs: ['§3.1', '§4.6', '§4.5', '§4.7', '§7.4.3'],
    server: { schema: REKEY_SHARED_V1 },
    async run(ctx) {
      const allowed = { project_id: ['p1'], org_id: ['o1'] };
      // The seed helpers push at the scenario's starting version.
      const push = async (
        schema: DriverSchema,
        table: string,
        row: DriverRow,
      ) => {
        // The default write set holds every declared variable (§3.1).
        await ctx.server.setAllowedScopes(
          'writer',
          schema === REKEY_SHARED_V2 ? { ...allowed, doc_id: ['*'] } : allowed,
        );
        const result = await ctx.rawSync(
          'writer',
          [
            rawPushCommit(`${table}-${row.id}`, [
              rawUpsert(schema, table, row),
            ]),
          ],
          { clientId: 'writer', schemaVersion: schema.version },
        );
        checkEqual(
          result.ok
            ? responsePushResults(result.message)[0]?.status
            : undefined,
          'applied',
          `${String(row.id)} commits`,
        );
      };
      await push(REKEY_SHARED_V1, 'tasks', task('t1', 'p1', 'one'));
      await push(REKEY_SHARED_V1, 'docs', doc('d1', 'o1', 'p1', 'p1'));
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: REKEY_SHARED_V1,
        allowed,
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      const cursor = await a.api.replicaCursor();
      await push(REKEY_SHARED_V1, 'tasks', task('t2', 'p1', 'two'));
      await push(REKEY_SHARED_V1, 'docs', doc('d2', 'o1', 'p1', 'p2'));
      await ctx.server.restart(REKEY_SHARED_V2);
      await push(REKEY_SHARED_V2, 'tasks', task('t3', 'p1', 'three'));

      // A takes the bump: U1 bootstraps docs at its kept cursor, below the
      // table horizon of docs, and keeps its tasks.
      await ctx.recreateClient(a, REKEY_SHARED_V2);
      const sent = a.sentRequests.length;
      const report = await syncIdle(a);
      checkEqual(
        restrictsSent(a, sent)[0],
        { type: 'RESTRICT', cursor, tables: ['docs'] },
        'the first pull restricts U1 to docs at its kept cursor',
      );
      checkEqual(report.resets, [], 'U1 joins at its kept cursor');
      checkEqual(
        report.segmentRowsApplied,
        2,
        'only the two docs rows were transferred',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['t1', 't2', 't3'],
        'the kept table caught up through the scan',
      );
      await expectConverged(ctx, 'docs', [a], {
        variable: 'project_id',
        values: ['p1'],
      });

      // d4 commits above a cursor K and leaves U1 at the next bump, which
      // maps project_id of docs to body. A restricted pull at K bootstraps
      // docs, and the scan from K never serves the change of d4 logged under
      // the previous mapping.
      const kept = await ctx.server.getMaxCommitSeq();
      await push(REKEY_SHARED_V2, 'docs', doc('d4', 'o1', 'p1', 'p2'));
      await ctx.server.restart(REKEY_SHARED_V3);
      await push(REKEY_SHARED_V3, 'tasks', task('t5', 'p1', 'five'));
      await ctx.server.setAllowedScopes('reader', allowed);
      const pulled = await ctx.rawSync(
        'reader',
        [
          ...rawPull([{ scopes: U1, cursor: kept }], { cursor: -1 }),
          { type: 'RESTRICT', cursor: kept, tables: ['docs'] },
        ],
        { clientId: 'reader', schemaVersion: REKEY_SHARED_V3.version },
      );
      check(pulled.ok, 'the restricted pull answers');
      if (!pulled.ok) return;
      const section = responseSection(pulled.message, U1);
      const live = responseLive(pulled.message);
      checkEqual(
        {
          status: section.start.status,
          bootstrap: section.start.bootstrap,
          complete: section.end.bootstrapState === undefined,
          live: live.start.status,
          rows: live.commits.flatMap((commit) =>
            commit.changes.map(
              (change) => `${commit.tables[change.tableIndex]}/${change.rowId}`,
            ),
          ),
        },
        {
          status: 'active',
          bootstrap: true,
          complete: true,
          live: 'active',
          rows: ['tasks/t5'],
        },
        'the scan serves docs only above its table horizon',
      );
    },
  },
  {
    name: 'schema-bump/queued-insert-survives-appended-column',
    specRefs: ['§7.1', '§7.4.4', '§6.2'],
    requires: ['schema-window'],
    server: {
      schema: TASKS_WITH_NOTE,
      schemaWindow: [TASKS_WITH_NOTE, FIXTURE_SCHEMA],
    },
    async run(ctx) {
      await seedTasks(ctx, [{ ...task('kept', 'p1', 'kept'), note: 'server' }]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      // Queued at version 1: an insert of a new row and an update of a row
      // whose appended column the server already holds.
      await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('queued', 'p1', 'new') },
        { op: 'upsert', table: 'tasks', values: task('kept', 'p1', 'edited') },
      ]);

      await ctx.recreateClient(a, TASKS_WITH_NOTE);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.values),
        [{ ...task('queued', 'p1', 'new'), note: null }],
        'the replayed insert is visible with the appended column NULL',
      );
      await syncIdle(a);

      checkEqual(await a.api.rejections(), [], 'both queued writes apply');
      checkEqual(
        (await ctx.server.readRows('tasks')).map((row) => row.values),
        [
          { ...task('kept', 'p1', 'edited'), note: 'server' },
          { ...task('queued', 'p1', 'new'), note: null },
        ],
        'the insert stores NULL and the update keeps the appended value',
      );
      await expectConverged(ctx, 'tasks', [a]);
    },
  },

  {
    name: 'schema-bump/missing-paired-marker-refuses-recreation',
    specRefs: ['§7.4.1', '§7.4.2'],
    requires: ['storage-fault'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      const commit = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('kept', 'p1', 'pending') },
      ]);
      check(a.api.executeStorageSql !== undefined, 'storage fault seam');
      await a.api.executeStorageSql(
        "DELETE FROM _syncular_meta WHERE key = 'localSchemaVersion'",
      );
      let code: unknown;
      try {
        await ctx.recreateClient(a, FIXTURE_SCHEMA_V2_DROP_META);
      } catch (error) {
        code =
          error instanceof Error && 'code' in error ? error.code : undefined;
      }
      checkEqual(
        code,
        'sync.local_corrupt',
        'an existing descriptor cannot authorize an absent marker',
      );
      // Restore the exact known fixture marker, then reopen compatibly. The
      // refused recreation must leave durable intent and table contents intact.
      await a.api.executeStorageSql(
        "INSERT INTO _syncular_meta(key,value) VALUES ('localSchemaVersion','1')",
      );
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        await a.api.pendingCommitIds(),
        [commit],
        'queued intent survives refusal',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['kept'],
        'local row survives refusal',
      );
    },
  },

  {
    name: 'schema-bump/downgrade-refuses-and-preserves-v3-outbox',
    specRefs: ['§7.4.1', '§7.4.2'],
    server: { schema: { ...FIXTURE_SCHEMA, version: 3 } },
    async run(ctx) {
      const schema = { ...FIXTURE_SCHEMA, version: 3 };
      await seedTasks(ctx, [task('accepted', 'p1', 'accepted-v3')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema,
        allowed: P1,
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      const commit = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task(
            'queued',
            'p1',
            'queued-v3',
            false,
            null,
            '{"pending":true}',
          ),
        },
      ]);
      const rows = await a.api.readRows('tasks');
      const subscription = await unitProgress(a, U1);
      check(a.api.querySnapshot !== undefined, 'local snapshot reads');
      const schemaRecords = async () =>
        (
          await a.api.querySnapshot!(
            "SELECT key, value FROM _syncular_meta WHERE key IN ('localSchemaVersion', 'localSchemaDescriptor') ORDER BY key",
          )
        ).rows;
      const records = await schemaRecords();
      let refusal: { code?: unknown; details?: unknown } = {};
      try {
        await ctx.recreateClient(a, FIXTURE_SCHEMA_V2_DROP_META);
      } catch (error) {
        if (error instanceof Error)
          refusal = {
            code: 'code' in error ? error.code : undefined,
            details: 'details' in error ? error.details : undefined,
          };
      }
      checkEqual(
        refusal,
        {
          code: 'client.schema_downgrade',
          details: {
            persistedVersion: 3,
            requestedVersion: FIXTURE_SCHEMA_V2_DROP_META.version,
          },
        },
        '§7.4.2 refuses a v3 replica with a v2 schema and names both versions',
      );
      // Reopen with the compatible build. This also checks the TS driver,
      // whose recreation releases the old core before starting the new one.
      await ctx.recreateClient(a, schema);
      checkEqual(
        await a.api.upgrading?.(),
        false,
        '§7.4.2 refusal did not reset the marker',
      );
      checkEqual(
        await schemaRecords(),
        records,
        '§7.4.2 refusal wrote neither the marker nor the descriptor',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [commit],
        '§7.4.2 preserves the queued v3 write',
      );
      checkEqual(
        await a.api.readRows('tasks'),
        rows,
        '§7.4.2 preserves accepted and optimistic rows',
      );
      checkEqual(
        await unitProgress(a, U1),
        subscription,
        '§7.4.2 preserves subscription cursors',
      );
      await syncIdle(a);
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the compatible build can deliver the retained write',
      );
      await expectConverged(ctx, 'tasks', [a]);
    },
  },
  {
    name: 'schema-bump/absent-legacy-marker-preserves-replica',
    specRefs: ['§7.4.1', '§7.4.2'],
    async run(ctx) {
      await seedTasks(ctx, [task('accepted', 'p1')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      check(
        a.api.executeStorageSql !== undefined,
        'reference clients expose storage fault injection',
      );
      await a.api.subscribe(U1);
      await syncIdle(a);
      const commit = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('queued', 'p1') },
      ]);
      const rows = await a.api.readRows('tasks');
      const subscription = await unitProgress(a, U1);
      await a.api.executeStorageSql(
        "DELETE FROM _syncular_meta WHERE key IN ('localSchemaVersion', 'localSchemaDescriptor')",
      );
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        await a.api.pendingCommitIds(),
        [commit],
        '§7.4.1 absent legacy markers preserve the outbox',
      );
      checkEqual(
        await a.api.readRows('tasks'),
        rows,
        '§7.4.1 absent legacy markers preserve accepted rows',
      );
      checkEqual(
        await unitProgress(a, U1),
        subscription,
        '§7.4.1 absent legacy markers preserve cursors',
      );
      checkEqual(
        await a.api.upgrading?.(),
        false,
        '§7.4.1 absent markers do not trigger reset',
      );
    },
  },
  {
    name: 'schema-bump/out-of-range-requested-version-refuses-before-storage',
    specRefs: ['§7.4.1', '§7.4.2'],
    async run(ctx) {
      for (const version of [0, -1, 2147483648]) {
        let code: unknown;
        try {
          await ctx.newClient({
            actorId: 'actor-a',
            clientId: `version-${version}`,
            schema: { ...FIXTURE_SCHEMA, version },
            allowed: P1,
          });
        } catch (error) {
          code =
            error instanceof Error && 'code' in error ? error.code : undefined;
        }
        checkEqual(
          code,
          'sync.invalid_request',
          `§7.4.2 a requested schema version of ${version} is refused`,
        );
      }
    },
  },
  {
    name: 'schema-bump/duplicated-marker-refuses-recreation',
    specRefs: ['§7.4.1', '§7.4.2'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      check(
        a.api.executeStorageSql !== undefined,
        'reference clients expose storage fault injection',
      );
      const commit = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('queued', 'p1') },
      ]);
      const rows = await a.api.readRows('tasks');
      // A hand-built/legacy metadata table without its primary key carries two
      // marker rows: taking one row could select an older version and reset.
      await a.api.executeStorageSql(
        'ALTER TABLE _syncular_meta RENAME TO _syncular_meta_keyed',
      );
      await a.api.executeStorageSql(
        'CREATE TABLE _syncular_meta(key TEXT, value TEXT)',
      );
      await a.api.executeStorageSql(
        'INSERT INTO _syncular_meta SELECT key, value FROM _syncular_meta_keyed',
      );
      await a.api.executeStorageSql(
        "INSERT INTO _syncular_meta(key, value) VALUES ('localSchemaVersion', '1')",
      );
      await a.api.executeStorageSql('DROP TABLE _syncular_meta_keyed');
      let code: unknown;
      try {
        await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
      } catch (error) {
        code =
          error instanceof Error && 'code' in error ? error.code : undefined;
      }
      checkEqual(
        code,
        'sync.local_corrupt',
        '§7.4.2 a duplicated marker is unreadable state, never a reset',
      );
      // Restore one canonical marker and prove the refusal reset nothing.
      await a.api.executeStorageSql(
        'ALTER TABLE _syncular_meta RENAME TO _syncular_meta_duplicated',
      );
      await a.api.executeStorageSql(
        'CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      );
      await a.api.executeStorageSql(
        "INSERT INTO _syncular_meta(key, value) SELECT key, value FROM _syncular_meta_duplicated WHERE key <> 'localSchemaVersion'",
      );
      await a.api.executeStorageSql(
        "INSERT INTO _syncular_meta(key, value) VALUES ('localSchemaVersion', '1')",
      );
      await a.api.executeStorageSql('DROP TABLE _syncular_meta_duplicated');
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        await a.api.pendingCommitIds(),
        [commit],
        'duplicated-marker refusal preserves the outbox',
      );
      checkEqual(
        await a.api.readRows('tasks'),
        rows,
        'duplicated-marker refusal preserves the replica rows',
      );
      checkEqual(
        await a.api.upgrading?.(),
        false,
        'duplicated-marker refusal preserves the schema',
      );
    },
  },
  ...(['invalid', 'unreadable'] as const).map(
    (failure): Scenario => ({
      name: `schema-bump/${failure}-marker-refuses-recreation`,
      specRefs: ['§7.4.1', '§7.4.2'],
      async run(ctx) {
        const a = await ctx.newClient({
          actorId: 'actor-a',
          clientId: 'client-a',
          allowed: P1,
        });
        check(
          a.api.executeStorageSql !== undefined,
          'reference clients expose storage fault injection',
        );
        const commit = await a.api.mutate([
          { op: 'upsert', table: 'tasks', values: task('queued', 'p1') },
        ]);
        const rows = await a.api.readRows('tasks');
        await a.api.executeStorageSql(
          failure === 'invalid'
            ? "UPDATE _syncular_meta SET value = 'invalid' WHERE key = 'localSchemaVersion'"
            : 'ALTER TABLE _syncular_meta RENAME COLUMN value TO unreadable_value',
        );
        let code: unknown;
        try {
          await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
        } catch (error) {
          code =
            error instanceof Error && 'code' in error ? error.code : undefined;
        }
        checkEqual(
          code,
          'sync.local_corrupt',
          '§7.4.2 read failures never become an absent marker',
        );
        await a.api.executeStorageSql(
          failure === 'invalid'
            ? "UPDATE _syncular_meta SET value = '1' WHERE key = 'localSchemaVersion'"
            : 'ALTER TABLE _syncular_meta RENAME COLUMN unreadable_value TO value',
        );
        await ctx.recreateClient(a, FIXTURE_SCHEMA);
        checkEqual(
          await a.api.pendingCommitIds(),
          [commit],
          'marker refusal preserves the outbox',
        );
        checkEqual(
          await a.api.readRows('tasks'),
          rows,
          'marker refusal preserves replica rows',
        );
        checkEqual(
          await a.api.upgrading?.(),
          false,
          'marker refusal preserves the schema',
        );
      },
    }),
  ),
  ...(['variable', 'prefix', 'column', 'compatible'] as const).map(
    (change): Scenario => {
      const oldSchema: DriverSchema = {
        ...FIXTURE_SCHEMA,
        version: 89,
        tables: [
          {
            ...FIXTURE_SCHEMA.tables[0]!,
            scopes: [
              {
                pattern: 'theatre:{theatre_calendar_id}',
                column: 'project_id',
              },
            ],
          },
          FIXTURE_SCHEMA.tables[1]!,
        ],
      };
      const schema: DriverSchema = {
        ...oldSchema,
        version: 90,
        tables: [
          {
            ...oldSchema.tables[0]!,
            scopes: [
              {
                pattern:
                  change === 'variable'
                    ? 'theatre:{calendar_theatre_id}'
                    : change === 'prefix'
                      ? 'calendar:{theatre_calendar_id}'
                      : 'theatre:{theatre_calendar_id}',
                column: change === 'column' ? 'title' : 'project_id',
              },
            ],
          },
          oldSchema.tables[1]!,
        ],
      };
      return {
        name: `schema-bump/subscription-scope-${change}`,
        specRefs: ['§7.4.3', '§3.1', '§4.8'],
        server: { schema },
        async run(ctx) {
          const allowed = {
            [change === 'variable'
              ? 'calendar_theatre_id'
              : 'theatre_calendar_id']: ['p1'],
            org_id: ['o1'],
            projectId: ['p1'],
          };
          const a = await ctx.newClient({
            actorId: 'actor-a',
            clientId: 'scope-client',
            schema: oldSchema,
            allowed,
          });
          const base = { variable: 'theatre_calendar_id' };
          const old = { theatre_calendar_id: 'p1' };
          const docs = { org_id: 'o1', projectId: 'p1' };
          await a.api.subscribe(old);
          await a.api.subscribe(docs);
          await a.api.setWindow?.(base, ['p1']);
          await a.api.executeStorageSql?.(
            `INSERT INTO _syncular_pending_evictions(unit_id,tbl,effective_scopes) VALUES ('removed-unit','tasks','{"theatre_calendar_id":["p1"]}')`,
          );
          await ctx.recreateClient(a, schema);
          if (a.api.querySnapshot)
            checkEqual(
              (
                await a.api.querySnapshot(
                  "SELECT count(*) AS n FROM _syncular_pending_evictions WHERE unit_id='removed-unit'",
                )
              ).rows,
              [{ n: 0 }],
              // §4.8: the reopen finishes a compatible eviction (the reset left
              // nothing to delete); the bump drops an incompatible one.
              'a reopen leaves no orphaned pending window eviction',
            );
          checkEqual(
            (await a.api.unitState(unitId(docs)))?.cursor,
            -1,
            'a compatible unit must rebootstrap wiped rows',
          );
          checkEqual(
            (await a.api.unitState(unitId(old))) !== undefined,
            change === 'compatible',
            'only units compatible with the new declarations survive',
          );
          if (a.api.windowState)
            checkEqual(
              (await a.api.windowState(base)).units,
              change === 'compatible' ? ['p1'] : [],
              'incompatible window bookkeeping is removed',
            );
          const current = await a.api.subscribe({
            [change === 'variable'
              ? 'calendar_theatre_id'
              : 'theatre_calendar_id']: 'p1',
          });
          await syncIdle(a);
          const progress = {
            unit: await a.api.unitState(current),
            replicaCursor: await a.api.replicaCursor(),
          };
          await ctx.recreateClient(a, schema);
          checkEqual(
            {
              unit: await a.api.unitState(current),
              replicaCursor: await a.api.replicaCursor(),
            },
            progress,
            'same-version reopen keeps the unit and the replica cursor',
          );
          await syncIdle(a);
        },
      };
    },
  ),

  {
    name: 'schema-window/previous-client-push-pull',
    specRefs: ['§9', '§7.4.2', '§6.7'],
    requires: ['schema-window'],
    server: {
      schema: FIXTURE_SCHEMA_V2,
      schemaWindow: [FIXTURE_SCHEMA_V2, FIXTURE_SCHEMA],
    },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'retained')]);
      const old = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-old',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
      });
      await old.api.subscribe(U1);
      await syncIdle(old);
      checkEqual(
        await old.api.schemaFloor(),
        undefined,
        'the previous client is served',
      );
      checkEqual(
        (await old.api.readRows('tasks'))[0]?.values.title,
        'retained',
        'the previous codec decodes bootstrap rows',
      );
      await old.api.mutate([
        { table: 'tasks', op: 'upsert', values: task('t2', 'p1', 'from-old') },
      ]);
      await syncIdle(old);
      checkEqual(
        (await ctx.server.readRows('tasks')).length,
        2,
        'old pushes apply through current rules',
      );
    },
  },
  {
    // §7.4.2 trigger 1 + §7.4.3/§7.4.4: a client with vN data AND a pending
    // offline outbox commit boots with the vN+1 generated schema, wipes,
    // re-bootstraps, and replays the outbox on top — converging with the
    // v2 server, versions and rows correct.
    name: 'schema-bump/local-bump-wipe-rebootstrap-replay',
    specRefs: ['§7.4.2', '§7.4.3', '§7.4.4', '§0'],
    // The server serves version 2; the client starts at version 1.
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      // Server already holds v2 data before the client upgrades.
      await seedTasks(ctx, [
        task('t1', 'p1', 'server-one'),
        task('t2', 'p1', 'server-two'),
      ]);

      // A v1 client: subscribe, bootstrap, then go offline and mutate.
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe(U1);

      // The v1 client is below the server floor: its first sync stops.
      const stopped = await syncOk(a);
      checkEqual(
        stopped.schemaFloor?.requiredSchemaVersion,
        2,
        'the v1 client is below the v2 server floor (§1.6)',
      );

      // Offline local write recorded under v1 (schema-agnostic outbox, §0).
      const offline = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t3', 'p1', 'offline-v1'),
        },
      ]);
      checkEqual(
        await a.api.pendingCommitIds(),
        [offline],
        'the offline write is queued and survives the bump (§0)',
      );

      // "App ships new code": recreate with the v2 generated schema on the
      // SAME database. The boot-time §7.4.1 marker check fires the reset.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
      check(
        (await a.api.upgrading?.()) === true,
        'the reset raised the upgrading state (§7.4.5)',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [offline],
        'the reset preserved the outbox (§7.4.3)',
      );
      checkEqual(
        await a.api.schemaFloor(),
        undefined,
        'the stop state cleared — the client now ships a servable schema',
      );

      // First post-reset sync: fresh bootstrap of the v2 server + replay.
      const upgraded = await syncIdle(a);
      checkEqual(
        upgraded.schemaFloor,
        undefined,
        'no floor after the upgrade — the client is at the served version',
      );
      check(
        (await a.api.upgrading?.()) === false,
        'upgrading cleared once the re-bootstrap reached idle (§7.4.5)',
      );

      // The offline commit drained and everything converged (t1,t2 from the
      // bootstrap; t3 from the replayed outbox commit).
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the replayed v1 commit re-encoded under v2 and drained (§7.4.4)',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      const rows = await a.api.readRows('tasks');
      checkEqual(rows.length, 3, 't1, t2 (bootstrap) + t3 (replayed) present');
    },
  },

  {
    // §7.4.2 trigger 2: a running client is left behind by a server upgrade,
    // enters the schemaFloor stop state, then the app update (recreate with
    // the new schema) converges it — the floor trigger and the boot trigger
    // meet in the same flow.
    name: 'schema-bump/floor-triggered-bump-converges',
    specRefs: ['§1.6', '§7.4.2', '§7.4.3'],
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'v2-only')]);

      // A v1 client hits the v2 floor and stops (the §1.6 stop state).
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe(U1);
      const floored = await syncOk(a);
      checkEqual(
        floored.schemaFloor?.requiredSchemaVersion,
        2,
        'the floor names the required version (§1.6)',
      );
      check(
        (await a.api.schemaFloor()) !== undefined,
        'the client is stopped pending an upgrade',
      );
      // Syncing is inert while stopped: no bootstrap happened.
      checkEqual(
        (await a.api.readRows('tasks')).length,
        0,
        'nothing was processed under the floor (§1.6)',
      );

      // App update: recreate with the v2 schema. The marker still reads v1,
      // so the boot check drives the reset; the next sync converges.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
      const upgraded = await syncIdle(a);
      checkEqual(upgraded.schemaFloor, undefined, 'no floor after the update');
      check(
        (await a.api.upgrading?.()) === false,
        'the re-bootstrap completed (§7.4.5)',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // §7.4.4: a pending UPSERT into a table the bump REMOVES cannot re-encode.
    // The reset must not fail on it: the local overlay has no mirror for the
    // removed table, so replay skips it and the send-time encoder surfaces the
    // commit as `sync.outbox_incompatible`. Pre-fix the reset replay threw
    // `sync.unknown_table` inside the reset transaction, so the marker never
    // advanced and every later open repeated the failure. The surviving
    // `tasks` commit still converges.
    name: 'schema-bump/removed-table-pending-commit-surfaces',
    specRefs: ['§7.4.4', '§7.2', '§10.3'],
    server: { schema: FIXTURE_SCHEMA_V2_DROP_DOCS },
    async run(ctx) {
      // No seed rows: the docs-dropping server schema cannot declare the
      // `docs` scope variables, and the surviving `tasks` push is the proof
      // that the queue kept moving.
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe(U1);

      // Queue an upsert and delete for removed `docs`, plus a surviving task.
      const docsCommit = await a.api.mutate([
        {
          op: 'upsert',
          table: 'docs',
          values: doc('d1', 'o1', 'p1', 'removed'),
        },
      ]);
      const docsDelete = await a.api.mutate([
        { op: 'delete', table: 'docs', rowId: 'd2' },
      ]);
      const tasksCommit = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('t1', 'p1', 'survives') },
      ]);
      checkEqual(
        await a.api.pendingCommitIds(),
        [docsCommit, docsDelete, tasksCommit],
        'all offline commits are queued',
      );

      // App update to the docs-dropping v2 schema.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2_DROP_DOCS);
      // §7.4.3/§7.4.4 parity: the reset preserves the outbox, so both cores
      // still hold the removed-table commits and raise no rejection before the
      // send-time prepass runs.
      checkEqual(
        await a.api.pendingCommitIds(),
        [docsCommit, docsDelete, tasksCommit],
        'the reset preserves the removed-table commit',
      );
      check(
        !(await a.api.rejections()).some(
          (r) => r.code === 'sync.outbox_incompatible',
        ),
        'no send-time classification before the first push encode',
      );
      check(
        !(await a.api.commitOutcomes()).some(
          (outcome) => outcome.clientCommitId === docsCommit,
        ),
        'no durable outcome exists before the send-time classification',
      );
      const upgraded = await syncIdle(a);
      checkEqual(upgraded.schemaFloor, undefined, 'converged at v2');

      const rejections = await a.api.rejections();
      const incompatible = rejections.find(
        (r) => r.code === 'sync.outbox_incompatible',
      );
      check(
        incompatible !== undefined,
        'the removed-table upsert surfaced as sync.outbox_incompatible (§7.4.4)',
      );
      checkEqual(
        incompatible?.clientCommitId,
        docsCommit,
        'the incompatible rejection names the removed-table upsert',
      );
      checkEqual(
        incompatible?.retryable,
        false,
        'a schema-incompatible commit is not retryable',
      );
      check(
        rejections.some(
          (r) =>
            r.clientCommitId === docsDelete && r.code === 'sync.unknown_table',
        ),
        'the removed-table delete receives ordinary server validation',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the incompatible commit left the outbox; the surviving one drained',
      );
      checkEqual(
        (await ctx.server.readRows('tasks')).map((row) => row.rowId),
        ['t1'],
        'the surviving upsert reached the server',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // §7.4.4: a pending UPSERT that carried a column the bump DROPS cannot
    // re-encode — it surfaces cleanly as `sync.outbox_incompatible` (a
    // client-local rejection). A later commit that DOES encode (a delete
    // carries no row values) still replays. One bad commit never wedges the
    // queue. (Every v1 full-row upsert stores the `meta` key, so dropping
    // `meta` makes any such upsert incompatible — the honest semantics.)
    name: 'schema-bump/dropped-column-pending-commit-surfaces',
    specRefs: ['§7.4.4', '§7.2', '§10.3'],
    server: { schema: FIXTURE_SCHEMA_V2_DROP_META },
    async run(ctx) {
      // Seed t2 on the (drop-meta v2) server so the client has something to
      // delete after it upgrades and bootstraps.
      await seedTasks(ctx, [task('t2', 'p1', 'server-two')]);

      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe(U1);

      // Two offline commits under v1: an upsert (full-row, carries `meta`,
      // incompatible after the drop) and a delete (no row values, always
      // encodable).
      const upsertT1 = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'has-meta', false, 1, '{"k":"v"}'),
        },
      ]);
      const deleteT2 = await a.api.mutate([
        { op: 'delete', table: 'tasks', rowId: 't2' },
      ]);
      checkEqual(
        await a.api.pendingCommitIds(),
        [upsertT1, deleteT2],
        'both offline commits are queued',
      );

      // App update to the meta-dropping v2 schema.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2_DROP_META);
      // §7.4.3/§7.4.4 parity: the reset preserves the outbox. The dropped
      // column is classified only by the send-time prepass.
      checkEqual(
        await a.api.pendingCommitIds(),
        [upsertT1, deleteT2],
        'the reset preserves the pending commits',
      );
      check(
        !(await a.api.rejections()).some(
          (r) => r.code === 'sync.outbox_incompatible',
        ),
        'the dropped-column commit is classified only at send time',
      );
      check(
        !(await a.api.commitOutcomes()).some(
          (outcome) => outcome.clientCommitId === upsertT1,
        ),
        'no durable outcome exists before the send-time classification',
      );
      const upgraded = await syncIdle(a);
      checkEqual(upgraded.schemaFloor, undefined, 'converged at v2');

      // The upsert is rejected client-side; the delete replayed and drained.
      const rejections = await a.api.rejections();
      const incompatible = rejections.find(
        (r) => r.code === 'sync.outbox_incompatible',
      );
      check(
        incompatible !== undefined,
        'the dropped-column upsert surfaced as sync.outbox_incompatible (§7.4.4)',
      );
      checkEqual(
        incompatible?.clientCommitId,
        upsertT1,
        'the incompatible rejection names the meta-carrying upsert',
      );
      checkEqual(
        incompatible?.retryable,
        false,
        'a schema-incompatible commit is not retryable',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the incompatible commit left the outbox; the delete drained',
      );

      // t2 was deleted server-side by the replayed delete; t1 never reached
      // the server (its only commit was dropped). The client converged.
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      const serverRows = await ctx.server.readRows('tasks');
      checkEqual(
        serverRows.length,
        0,
        'the delete drained; the upsert did not',
      );
    },
  },

  {
    // §7.4.3 + §5.3: the re-bootstrap after a bump is an ordinary fresh
    // bootstrap, so it rides the image lane when the client advertises
    // accept bit 2 — asserted via the sqlite mediaType on the raw pull and
    // the single-shot whole-table completion the image lane guarantees.
    name: 'schema-bump/image-lane-rebootstrap',
    specRefs: ['§7.4.3', '§5.3', '§5.6'],
    requires: ['sqlite-image'],
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      await seedTasks(ctx, [
        task('t1', 'p1', 'one'),
        task('t2', 'p1', 'two'),
        task('t3', 'p1', 'three'),
        task('t4', 'p1', 'four'),
        task('t5', 'p1', 'five'),
      ]);

      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
        // Tight paging that the rows lane could not satisfy in one pull —
        // only the whole-table image completes in a single page (§5.3).
        limits: {
          limitSnapshotRows: 2,
          maxSnapshotPages: 1,
          accept: WITH_SQLITE,
        },
      });
      await a.api.subscribe(U1);

      // Reference raw pull: the server offers the whole table as one sqlite
      // descriptor at the v2 codec — pinning the re-bootstrap lane.
      await ctx.server.setAllowedScopes('raw-actor', P1);
      const raw = await ctx.rawSync(
        'raw-actor',
        [
          ...rawPull([{ scopes: U1, cursor: -1 }], {
            accept: WITH_SQLITE,
            limitSnapshotRows: 2,
          }),
        ],
        { clientId: 'raw-client', schemaVersion: 2 },
      );
      check(raw.ok, 'raw v2 pull succeeded');
      if (raw.ok) {
        const section = responseSection(raw.message, U1);
        const ref = section.body[0];
        checkEqual(section.body.length, 1, 'one segment covers the table');
        check(
          ref?.type === 'SEGMENT_REF' && ref.mediaType === 'sqlite',
          'the re-bootstrap lane is the sqlite image (§5.3)',
        );
      }

      // Upgrade the client and re-bootstrap: the wiped table refills from a
      // single image page despite the tight paging limits.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
      const first = await syncOk(a);
      checkEqual(
        first.segmentRowsApplied,
        5,
        'the whole table re-bootstrapped as one image (§5.3)',
      );
      checkEqual(
        first.bootstrapping,
        [],
        'the image completed the table in one pull — paging limits do not apply',
      );
      check(
        (await a.api.upgrading?.()) === false,
        'upgrading cleared on the single-shot image re-bootstrap',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
];
