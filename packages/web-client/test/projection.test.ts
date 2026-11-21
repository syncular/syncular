import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { type ClientSchema, SyncClient } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { compileLocalProjections } from '@syncular/client/projections';

const schema = {
  version: 1,
  tables: [
    {
      name: 'sources',
      primaryKey: 'id',
      scopes: ['space:{space_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'space_id', type: 'string', nullable: false },
      ],
      indexes: [
        { name: 'sources_by_space', columns: ['space_id'], unique: false },
      ],
      localProjections: [
        {
          name: 'local_names',
          generation: '1',
          columns: [{ name: 'display_name', declaredType: 'string' }],
          fts: { tokenize: 'unicode61', columns: ['display_name'] },
          dependencies: [
            { table: 'grants', column: 'space_id', sourceColumn: 'space_id' },
          ],
        },
        {
          name: 'local_fields',
          generation: '1',
          columns: [
            { name: 'readable', declaredType: 'boolean' },
            { name: 'score', declaredType: 'real' },
            { name: 'data', declaredType: 'json' },
          ],
        },
      ],
    },
    {
      name: 'grants',
      primaryKey: 'id',
      scopes: ['space:{space_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'space_id', type: 'string', nullable: false },
      ],
    },
  ],
} satisfies ClientSchema;

test('app-filled projections require the TypeScript implementation when creating a client', () => {
  const database = new BunClientDatabase();
  try {
    expect(
      () =>
        new SyncClient({
          schema,
          database,
          transport: async () => new Uint8Array(),
        }),
    ).toThrow(
      expect.objectContaining({
        code: 'client.schema_invalid',
        details: { reason: 'projections_unavailable' },
      }),
    );
  } finally {
    database.close();
  }
});

test('a dependency write clears 300 derived rows in its SQLite transaction', async () => {
  const database = new BunClientDatabase();
  const client = new SyncClient({
    schema,
    database,
    createProjections: compileLocalProjections,
    transport: async () => new Uint8Array(),
  });
  try {
    await client.start();
    database.exec(
      "WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<300) INSERT INTO sources(id,space_id) SELECT CAST(n AS TEXT),'p1' FROM seq",
    );
    const batch = client.projectionPending('local_names', 300);
    expect(batch.entries).toHaveLength(300);
    client.writeProjection(
      'local_names',
      batch.epoch,
      batch.entries.map((entry) => ({
        ...entry,
        values: { display_name: 'derived name' },
      })),
    );
    database.exec("INSERT INTO grants(id,space_id) VALUES ('grant','p2')");
    const elapsed = database.transaction(() => {
      const start = performance.now();
      database.exec("UPDATE grants SET space_id='p1' WHERE id='grant'");
      const ms = performance.now() - start;
      expect(
        database.query(
          "SELECT display_name FROM local_names WHERE local_names MATCH 'derived'",
        ),
      ).toEqual([]);
      expect(
        database.query(
          'SELECT display_name FROM _syncular_projection_local_names',
        ),
      ).toEqual([]);
      return ms;
    });
    if (process.env.SYNCULAR_PROJECTION_TIMING === '1')
      console.info(
        `TypeScript SQLite dependency statement with 300 filled FTS rows: ${elapsed.toFixed(2)} ms`,
      );
    expect(
      client.query(
        "SELECT display_name FROM local_names WHERE local_names MATCH 'derived'",
      ),
    ).toEqual([]);
    expect(client.projectionPending('local_names', 300).entries).toHaveLength(
      300,
    );

    const two = client.projectionPending('local_names', 2);
    client.writeProjection(
      'local_names',
      two.epoch,
      two.entries.map((entry, index) => ({
        ...entry,
        values: { display_name: index ? 'second' : 'first' },
      })),
    );
    client.invalidateProjection('local_names', [two.entries[0]!.sourceId]);
    expect(
      client.query(
        "SELECT display_name FROM local_names WHERE local_names MATCH 'first'",
      ),
    ).toEqual([]);
    expect(
      client.query(
        "SELECT display_name FROM local_names WHERE local_names MATCH 'second'",
      ),
    ).toEqual([{ display_name: 'second' }]);
    client.invalidateProjection('local_names');
    expect(
      client.query(
        "SELECT display_name FROM local_names WHERE local_names MATCH 'second'",
      ),
    ).toEqual([]);
    expect(database.query('SELECT id FROM local_names_docsize')).toEqual([]);

    const plain = client.projectionPending('local_fields', 1);
    const entry = plain.entries[0]!;
    const data = '{"b": 1, "a": []}';
    expect(
      client.writeProjection('local_fields', plain.epoch, [
        { ...entry, values: { readable: true, score: 1.25, data } },
      ]),
    ).toEqual({ written: ['1'], stale: [] });
    expect(
      client.query('SELECT readable,score,data FROM local_fields'),
    ).toEqual([{ readable: 1, score: 1.25, data }]);
  } finally {
    await client.close();
    database.close();
  }
});

test('projection purge repeats file erasure after restart in security preflight', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'syncular-projection-purge-'));
  const path = join(directory, 'replica.db');
  const needle = Buffer.from('PrivateProjectionPlaintextSentinel');
  const presentOnDisk = () =>
    [path, `${path}-wal`].some(
      (file) => existsSync(file) && readFileSync(file).includes(needle),
    );
  const input = {
    purgeId: 'erase-local-names',
    targets: [{ projection: 'local_names' }],
  };
  let database = new BunClientDatabase(path);
  let client = new SyncClient({
    database,
    schema,
    createProjections: compileLocalProjections,
    transport: async () => new Uint8Array(),
  });
  try {
    await client.start();
    database.exec("INSERT INTO sources(id,space_id) VALUES ('one','p1')");
    const before = client.projectionPending('local_names', 1);
    client.writeProjection('local_names', before.epoch, [
      { ...before.entries[0]!, values: { display_name: needle.toString() } },
    ]);
    expect(presentOnDisk()).toBe(true);
    await client.beginSecurityPreflight();
    const exec = database.exec.bind(database);
    database.exec = (sql, params) => {
      if (sql === 'VACUUM') throw new Error('interrupted before file erasure');
      exec(sql, params);
    };
    expect(() => client.purgeLocalData(input)).toThrow(
      'interrupted before file erasure',
    );
    await client.close();
    database.close();

    database = new BunClientDatabase(path);
    client = new SyncClient({
      database,
      schema,
      createProjections: compileLocalProjections,
      securityPreflight: true,
      transport: async () => new Uint8Array(),
    });
    await client.start();
    expect(client.purgeLocalData(input)).toEqual({
      alreadyApplied: true,
      purgedRows: 0,
      droppedCommits: 0,
    });
    expect(presentOnDisk()).toBe(false);
    await client.activateSecurity();
    expect(client.query('SELECT id FROM sources')).toEqual([{ id: 'one' }]);
    expect(
      client.query(
        "SELECT display_name FROM local_names WHERE local_names MATCH 'PrivateProjectionPlaintextSentinel'",
      ),
    ).toEqual([]);
    const after = client.projectionPending('local_names', 1);
    expect(after.epoch).toBe(before.epoch + 1);
    expect(after.entries[0]?.sourceId).toBe('one');
  } finally {
    await client.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
