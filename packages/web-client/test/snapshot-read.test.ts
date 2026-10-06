import { describe, expect, test } from 'bun:test';
import { SyncClient } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { CLIENT_SCHEMA, taskValues } from './helpers';

function makeLocalClient(): { db: BunClientDatabase; client: SyncClient } {
  const db = new BunClientDatabase();
  const client = new SyncClient({
    database: db,
    schema: CLIENT_SCHEMA,
    transport: async () => {
      throw new Error('local-only test client');
    },
  });
  return { db, client };
}

describe('§7.5 snapshot read surface', () => {
  test('reads statements, catch-up, and delivery under one revision', async () => {
    const { db, client } = makeLocalClient();
    await client.start();
    const commitId = client.mutate([
      { op: 'upsert', table: 'tasks', values: taskValues('t1', 'p1') },
    ]);
    const read = client.snapshotRead({
      statements: [
        { sql: 'SELECT id FROM tasks ORDER BY id' },
        { sql: 'SELECT count(*) AS n FROM tasks' },
      ],
      subscriptions: ['tasks', 'missing'],
      commitIds: [commitId, 'missing'],
    });
    expect(read.queries).toEqual([[{ id: 't1' }], [{ n: 1 }]]);
    expect(read.revision).toBe(client.localRevision);
    expect(read.subscriptions[0]).toEqual({ state: 'unknown', id: 'tasks' });
    expect(read.subscriptions[1]).toEqual({ state: 'unknown', id: 'missing' });
    expect(read.deliveries[0]).toEqual({
      status: 'pending',
      clientCommitId: commitId,
    });
    expect(read.deliveries[1]).toEqual({
      status: 'unknown',
      clientCommitId: 'missing',
    });
    db.close();
  });

  test('ergonomic catch-up and delivery reads share the atomic primitive', async () => {
    const { db, client } = makeLocalClient();
    await client.start();
    expect(client.subscriptionCatchup('nope')).toEqual({
      state: 'unknown',
      id: 'nope',
    });
    const commitId = client.mutate([
      { op: 'upsert', table: 'tasks', values: taskValues('t1', 'p1') },
    ]);
    expect(client.commitDelivery(commitId)).toEqual({
      status: 'pending',
      clientCommitId: commitId,
    });
    db.close();
  });

  test('a corrupt revision marker fails typed for the public read', async () => {
    const { db, client } = makeLocalClient();
    await client.start();
    db.exec("UPDATE _syncular_meta SET value='+1' WHERE key='localRevision'");
    expect(() => client.localRevision).toThrow(
      expect.objectContaining({ code: 'sync.local_corrupt' }),
    );
    expect(() => client.snapshotRead({ statements: [] })).toThrow(
      expect.objectContaining({ code: 'sync.local_corrupt' }),
    );
    db.close();
  });

  test('the read-only guard rejects a write in any statement position', async () => {
    const { db, client } = makeLocalClient();
    await client.start();
    expect(() =>
      client.snapshotRead({
        statements: [{ sql: 'SELECT 1' }, { sql: 'DELETE FROM tasks' }],
      }),
    ).toThrow();
    expect(db.query('SELECT count(*) AS n FROM tasks')[0]?.n).toBe(0);
    db.close();
  });

  test('a corrupt persisted subscription record is static sync.local_corrupt', async () => {
    const { db, client } = makeLocalClient();
    await client.start();
    client.subscribe({
      id: 's1',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    const mutations: readonly [string, string | number][] = [
      ['status', 'bogus'],
      ['cursor', 'not-a-number'],
      ['bootstrap_state', 7],
      ['effective_scopes', 'not json'],
      ['reason_code', 7],
    ];
    for (const [column, value] of mutations) {
      db.exec(`UPDATE _syncular_subscriptions SET ${column}=? WHERE id='s1'`, [
        value,
      ]);
      expect(() => client.subscriptionCatchup('s1')).toThrow(
        expect.objectContaining({ code: 'sync.local_corrupt' }),
      );
    }
    db.close();
  });

  test('a malformed persisted outcome is static sync.local_corrupt', async () => {
    const { db, client } = makeLocalClient();
    await client.start();
    const insert = (
      id: string,
      results: string,
      operations: string | null,
      status = 'applied',
    ): void =>
      db.exec(
        `INSERT INTO _syncular_commit_outcomes(client_commit_id,status,recorded_at_ms,results,operations,resolution)VALUES(?,?,1,?,?, 'active')`,
        [id, status, results, operations],
      );
    const cases: readonly [string, string, string | null, string?][] = [
      ['bad-ops', '[]', '{}'],
      ['bad-applied', '[{"status":"applied"}]', null],
      ['bad-error', '[{"status":"error"}]', null],
      ['bad-op', '[]', '[{}]'],
      ['bad-status', '[{"status":"bogus"}]', null],
      [
        'bad-error-shallow',
        '[{"status":"error","rejection":{"code":"x"}}]',
        null,
      ],
      ['bad-conflict-array', '[{"status":"conflict","conflict":[]}]', null],
      [
        'bad-conflict-row-array',
        '[{"status":"conflict","conflict":{"clientCommitId":"c","opIndex":0,"table":"t","rowId":"r","code":"c","message":"m","serverVersion":1,"serverRow":[]}}]',
        null,
      ],
      ['bad-op-shallow', '[]', '[{"op":"upsert"}]'],
      [
        'bad-op-version',
        '[]',
        '[{"op":"upsert","table":"t","rowId":"r","baseVersion":"bad"}]',
      ],
      [
        'bad-op-values',
        '[]',
        '[{"op":"upsert","table":"t","rowId":"r","values":[]}]',
      ],
      [
        'bad-op-bytes',
        '[]',
        '[{"op":"upsert","table":"t","rowId":"r","values":{"b":{"$bytes":"zz"}}}]',
      ],
      [
        'bad-op-odd-bytes',
        '[]',
        '[{"op":"upsert","table":"t","rowId":"r","values":{"b":{"$bytes":"a"}}}]',
      ],
      [
        'bad-conflict-bytes',
        '[{"status":"conflict","conflict":{"clientCommitId":"c","opIndex":0,"table":"t","rowId":"r","code":"c","message":"m","serverVersion":1,"serverRow":{"b":{"$bytes":"zz"}}}}]',
        null,
      ],
      ['bad-json', 'not json', null],
    ];
    for (const [id, results, operations, status] of cases) {
      insert(id, results, operations, status);
      expect(() => client.commitDelivery(id)).toThrow(
        expect.objectContaining({ code: 'sync.local_corrupt' }),
      );
    }
    db.close();
  });

  test('persisted outcome metadata is validated before public delivery', async () => {
    const { db, client } = makeLocalClient();
    await client.start();
    // An unconstrained journal models a damaged or externally rewritten file.
    db.exec('DROP TABLE _syncular_commit_outcomes');
    db.exec(
      `CREATE TABLE _syncular_commit_outcomes(seq,client_commit_id,status,recorded_at_ms,results,operations,resolution,resolved_at_ms,replacement_client_commit_id)`,
    );
    db.exec(
      `INSERT INTO _syncular_commit_outcomes VALUES(1,'c','applied',1,'[]',NULL,'active',NULL,NULL)`,
    );
    const conflict = {
      clientCommitId: 'c',
      opIndex: 0,
      table: 'tasks',
      rowId: 'r',
      code: 'sync.conflict',
      message: 'conflict',
      serverVersion: 1,
      serverRow: {},
    };
    const rejection = {
      clientCommitId: 'c',
      opIndex: 0,
      code: 'validation.denied',
      message: 'denied',
      retryable: false,
    };
    const invalidResults = [
      ...[0.5, 2147483648, -2147483649, 9007199254740992].map((opIndex) => [
        { status: 'applied', opIndex },
      ]),
      ...[0.5, 9007199254740992].map((serverVersion) => [
        { status: 'conflict', conflict: { ...conflict, serverVersion } },
      ]),
      ...['title', [7], null].map((conflictColumns) => [
        { status: 'conflict', conflict: { ...conflict, conflictColumns } },
      ]),
      ...[
        [],
        {},
        { secret: 'hidden' },
        { reason: 'Not Valid' },
        { fieldPaths: [] },
        { references: { safe: 'x'.repeat(257) } },
      ].map((details) => [
        { status: 'error', rejection: { ...rejection, details } },
      ]),
      [{ status: 'error', rejection: { ...rejection, opIndex: 0.5 } }],
      [{ status: 'conflict', conflict: { ...conflict, opIndex: 0.5 } }],
    ];
    for (const result of invalidResults) {
      db.exec(
        "UPDATE _syncular_commit_outcomes SET results=? WHERE client_commit_id='c'",
        [JSON.stringify(result)],
      );
      expect(() => client.commitDelivery('c')).toThrow(
        expect.objectContaining({ code: 'sync.local_corrupt' }),
      );
    }
    db.exec("UPDATE _syncular_commit_outcomes SET results='[]'");
    for (const [column, invalid, restored] of [
      ['seq', 'bad', 1],
      ['seq', 9007199254740992, 1],
      ['recorded_at_ms', 'bad', 1],
      ['recorded_at_ms', 0.5, 1],
      ['resolved_at_ms', 'bad', null],
      ['replacement_client_commit_id', 7, null],
      ['operations', 7, null],
    ] as const) {
      db.exec(`UPDATE _syncular_commit_outcomes SET ${column}=?`, [invalid]);
      expect(() => client.commitDelivery('c')).toThrow(
        expect.objectContaining({ code: 'sync.local_corrupt' }),
      );
      db.exec(`UPDATE _syncular_commit_outcomes SET ${column}=?`, [restored]);
    }
    for (const result of [
      { status: 'conflict', conflict },
      {
        status: 'error',
        rejection: { ...rejection, details: { reason: 'policy_denied' } },
      },
      { status: 'error', rejection: { ...rejection, details: null } },
    ]) {
      db.exec('UPDATE _syncular_commit_outcomes SET results=?', [
        JSON.stringify([result]),
      ]);
      expect(client.commitDelivery('c').status).toBe('known');
    }
    const legacy = client.commitDelivery('c');
    expect(legacy.status).toBe('known');
    db.close();
  });
});
