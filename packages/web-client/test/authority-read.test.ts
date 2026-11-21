import { defineAuthorityReads } from '@syncular/client/authority';
import { expect, test } from 'bun:test';
import {
  SyncClient,
  type AuthorityQuery,
  type ClientSchema,
  type SqlRow,
  type SqlValue,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { unitId, type FencedRecord, type UnitScopes } from '@syncular/core';
import { saveUnit, type UnitStatus } from '../src/state';
import { makeClient, makeServer, taskValues } from './helpers';

const schema: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'ops',
      primaryKey: 'id',
      scopes: ['workspace:{workspace_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'workspace_id', type: 'string', nullable: false },
      ],
    },
    {
      name: 'seals',
      primaryKey: 'id',
      scopes: ['workspace:{workspace_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'op_id', type: 'string', nullable: false },
        { name: 'workspace_id', type: 'string', nullable: false },
        { name: 'current', type: 'boolean', nullable: false },
      ],
    },
    {
      name: 'wraps',
      primaryKey: 'id',
      scopes: ['recipient:{recipient_id}', 'sealer:{sealer_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'seal_id', type: 'string', nullable: false },
        { name: 'recipient_id', type: 'string', nullable: false },
        { name: 'sealer_id', type: 'string', nullable: false },
        { name: 'expires_at', type: 'integer', nullable: true },
      ],
    },
    {
      name: 'vault',
      primaryKey: 'id',
      scopes: ['owner:{owner_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'owner_id', type: 'string', nullable: false },
        { name: 'blob', type: 'bytes', nullable: true },
        {
          name: 'secret',
          type: 'bytes',
          declaredType: 'string',
          encrypted: true,
          nullable: true,
        },
      ],
    },
  ],
};

// Hand-written in the generated shape (SYQL.md §13.3).
const centre: AuthorityQuery = {
  name: 'centreWrapCover',
  sql: 'SELECT count(*) AS qualifying, max(w.expires_at) AS latest FROM ops o JOIN seals s ON s.op_id = o.id AND s.current = 1 JOIN wraps w ON w.seal_id = s.id AND w.sealer_id = ? WHERE o.workspace_id = ? AND s.workspace_id = ? AND w.recipient_id = ?',
  bind: ['sealerId', 'workspaceId', 'workspaceId', 'recipientId'],
  params: [
    { name: 'recipientId', type: 'string', nullable: false },
    { name: 'sealerId', type: 'string', nullable: false },
    { name: 'workspaceId', type: 'string', nullable: false },
  ],
  coverage: [
    { table: 'ops', variable: 'workspace_id', units: ['workspaceId'] },
    { table: 'seals', variable: 'workspace_id', units: ['workspaceId'] },
    {
      table: 'wraps',
      variable: 'recipient_id',
      units: ['recipientId'],
      fixedScopes: { sealer_id: 'sealerId' },
    },
  ],
  reads: {
    ops: ['id', 'workspace_id'],
    seals: ['current', 'id', 'op_id', 'workspace_id'],
    wraps: ['expires_at', 'recipient_id', 'seal_id', 'sealer_id'],
  },
  resultColumns: [
    { name: 'qualifying', type: 'integer', nullable: false },
    { name: 'latest', type: 'integer', nullable: true },
  ],
};

const tasks: AuthorityQuery = {
  name: 'projectTasks',
  sql: 'SELECT id, title, done FROM tasks WHERE project_id = ? ORDER BY id',
  bind: ['projectId'],
  params: [{ name: 'projectId', type: 'string', nullable: false }],
  coverage: [{ table: 'tasks', variable: 'project_id', units: ['projectId'] }],
  reads: { tasks: ['done', 'id', 'project_id', 'title'] },
  resultColumns: [
    { name: 'id', type: 'string', nullable: false },
    { name: 'title', type: 'string', nullable: false },
    { name: 'done', type: 'boolean', nullable: false },
  ],
};

class RecordingDatabase extends BunClientDatabase {
  reads: { sql: string; params: readonly SqlValue[] }[] = [];
  override queryReadOnly(
    sql: string,
    params: readonly SqlValue[] = [],
  ): SqlRow[] {
    this.reads.push({ sql, params });
    return super.queryReadOnly(sql, params);
  }
}

const create = (db: BunClientDatabase, queries: AuthorityQuery[] = [centre]) =>
  new SyncClient({
    database: db,
    schema,
    securityPreflight: true,
    transportGate: 'closed',
    authorityReads: defineAuthorityReads(queries),
    transport: async () => {
      throw new Error('authority reads must never transport');
    },
  });

const unit = (
  db: BunClientDatabase,
  scopes: UnitScopes,
  options: {
    status?: UnitStatus;
    cursor?: number;
    echo?: FencedRecord[];
  } = {},
) =>
  saveUnit(db, {
    id: unitId(scopes),
    scopes,
    explicit: true,
    status: options.status ?? 'active',
    cursor: options.cursor ?? 7,
    seeded: [],
    echo: options.echo ?? [],
  });

const centreRequest = (recipientId = 'c1', workspaceId = 'w1') => ({
  query: 'centreWrapCover',
  params: { recipientId, sealerId: 's1', workspaceId },
});

function seed(db: BunClientDatabase): void {
  const insert = (table: string, values: Record<string, SqlValue>) =>
    db.exec(
      `INSERT INTO ${table}(${Object.keys(values).join(',')},_sync_version)VALUES(${Object.keys(
        values,
      )
        .map(() => '?')
        .join(',')},7)`,
      Object.values(values),
    );
  insert('ops', { id: 'op1', workspace_id: 'w1' });
  insert('ops', { id: 'op2', workspace_id: 'w1' });
  insert('seals', { id: 's-1', op_id: 'op1', workspace_id: 'w1', current: 1 });
  insert('seals', { id: 's-2', op_id: 'op2', workspace_id: 'w1', current: 1 });
  insert('seals', {
    id: 's-old',
    op_id: 'op1',
    workspace_id: 'w1',
    current: 0,
  });
  for (const [id, seal, sealer, expires] of [
    ['w-1', 's-1', 's1', 100],
    ['w-2', 's-2', 's1', 200],
    ['w-old', 's-old', 's1', 300],
    ['w-untrusted', 's-2', 's9', 400],
  ] as const)
    insert('wraps', {
      id,
      seal_id: seal,
      recipient_id: 'c1',
      sealer_id: sealer,
      expires_at: expires,
    });
}

test('authority declarations are refused at creation with their reason', () => {
  const db = new BunClientDatabase(':memory:');
  try {
    const refused = (
      candidate: unknown,
      details: Record<string, unknown>,
      queries?: AuthorityQuery[],
    ) => {
      try {
        // The declaration crosses as untyped data; creation must type-check it.
        create(db, queries ?? [JSON.parse(JSON.stringify(candidate))]);
      } catch (error) {
        expect(error).toMatchObject({
          code: 'client.authority_read_forbidden',
          details,
        });
        return;
      }
      throw new Error('declaration was accepted');
    };
    const shape = { query: 'centreWrapCover', reason: 'shape' };
    refused({ ...centre, extra: 1 }, shape);
    refused({ ...centre, bind: ['sealerId', 'nope', 'x', 'y'] }, shape);
    refused({ ...centre, sql: `${centre.sql} AND 1 = ?` }, shape);
    refused(
      { ...centre, coverage: [{ ...centre.coverage[0], units: ['nope'] }] },
      shape,
    );
    refused(
      { ...centre, coverage: [{ ...centre.coverage[0], table: 'nope' }] },
      { ...shape, table: 'nope' },
    );
    refused(
      {
        ...centre,
        coverage: [{ ...centre.coverage[0], variable: 'recipient_id' }],
      },
      { ...shape, table: 'ops' },
    );
    refused(null, { query: null, reason: 'shape' }, [JSON.parse('null')]);
    refused(centre, shape, [centre, centre]);
    refused(
      {
        ...centre,
        params: [
          ...centre.params.slice(1),
          { name: 'recipientId', type: 'bytes', nullable: false },
        ],
      },
      { query: 'centreWrapCover', reason: 'param' },
    );
    const column = (table: string, col?: string) => ({
      query: 'centreWrapCover',
      reason: 'column',
      table,
      ...(col === undefined ? {} : { column: col }),
    });
    refused(
      { ...centre, reads: { ...centre.reads, clinical: ['id'] } },
      column('clinical'),
    );
    refused(
      { ...centre, reads: { _syncular_meta: ['key'] } },
      column('_syncular_meta'),
    );
    refused(
      { ...centre, reads: { ops: ['id', 'nope'] } },
      column('ops', 'nope'),
    );
    refused(
      { ...centre, reads: { vault: ['id', 'secret'] } },
      column('vault', 'secret'),
    );
    refused(
      { ...centre, reads: { vault: ['blob', 'id'] } },
      column('vault', 'blob'),
    );
    refused(
      { ...centre, reads: { vault: ['_sync_sealed', 'id'] } },
      column('vault', '_sync_sealed'),
    );
    // The policy holds a frozen copy; a later edit of the input changes nothing.
    const input = structuredClone(centre);
    const policy = defineAuthorityReads([input]);
    Reflect.apply(Array.prototype.push, input.reads.ops!, ['secret']);
    expect(policy.declarations[0]!.reads.ops).toEqual(['id', 'workspace_id']);
    expect(Object.isFrozen(policy.declarations[0]!.reads.ops)).toBe(true);
    // A `?` inside a string literal is no placeholder.
    expect(() =>
      create(db, [{ ...centre, sql: `${centre.sql} AND 'a?' = 'a?'` }]),
    ).not.toThrow();
    expect(() =>
      create(db, [
        { ...centre, reads: { ...centre.reads, ops: ['_sync_version', 'id'] } },
      ]),
    ).not.toThrow();
  } finally {
    db.close();
  }
});

test('authority reads join three accepted bases with aggregates and never write', async () => {
  const db = new RecordingDatabase(':memory:');
  const client = create(db);
  await client.start();
  try {
    seed(db);
    unit(db, { workspace_id: 'w1' });
    unit(db, { recipient_id: 'c1' });
    const revision = client.localRevision;
    const before = db.query('SELECT total_changes() AS changes');
    expect(client.authorityRead([centreRequest()])).toEqual({
      revision,
      results: [
        {
          query: 'centreWrapCover',
          rows: [{ qualifying: 2, latest: 200 }],
          coverage: [
            {
              table: 'ops',
              base: { variable: 'workspace_id' },
              unit: 'w1',
              state: 'complete',
            },
            {
              table: 'seals',
              base: { variable: 'workspace_id' },
              unit: 'w1',
              state: 'complete',
            },
            {
              table: 'wraps',
              base: {
                variable: 'recipient_id',
                fixedScopes: { sealer_id: 's1' },
              },
              unit: 'c1',
              state: 'complete',
            },
          ],
          complete: true,
        },
      ],
    });
    // No intent: the authored SQL runs unchanged against the tables.
    expect(db.reads.at(-1)).toEqual({
      sql: centre.sql,
      params: ['s1', 'w1', 'w1', 'c1'],
    });
    expect(db.query('SELECT total_changes() AS changes')).toEqual(before);
    expect(client.securityLifecycle()).toBe('preflight');

    // Pending intent on two tables: the aggregate still reads accepted bases.
    await client.activateSecurity();
    client.patch('wraps', 'w-1', { expires_at: 900 });
    client.mutate([
      {
        table: 'wraps',
        op: 'upsert',
        values: {
          id: 'w-new',
          seal_id: 's-1',
          recipient_id: 'c1',
          sealer_id: 's1',
          expires_at: 999,
        },
      },
      { table: 'seals', op: 'delete', rowId: 's-2' },
    ]);
    await client.beginSecurityPreflight();
    const shadowed = client.authorityRead([
      centreRequest(),
      centreRequest('c1', 'w2'),
    ]);
    expect(shadowed.results.map((r) => r.rows)).toEqual([
      [{ qualifying: 2, latest: 200 }],
      [{ qualifying: 0, latest: null }],
    ]);
    expect(shadowed.results[1]!.complete).toBe(false);
    const seals = `"seals" AS (SELECT "id","current","op_id","workspace_id","_sync_version" FROM main."seals" WHERE CAST("id" AS TEXT) NOT IN (SELECT value FROM json_each(?)) UNION ALL SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]') FROM json_each(?))`;
    const wraps = `"wraps" AS (SELECT "id","expires_at","recipient_id","seal_id","sealer_id","_sync_version" FROM main."wraps" WHERE CAST("id" AS TEXT) NOT IN (SELECT value FROM json_each(?)) UNION ALL SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]') FROM json_each(?))`;
    expect(db.reads.at(-2)).toEqual({
      sql: `WITH ${seals},${wraps} ${centre.sql}`,
      params: [
        '["s-2"]',
        '[["s-2",1,"op2","w1",7]]',
        '["w-1","w-new"]',
        '[["w-1",100,"c1","s-1","s1",7]]',
        's1',
        'w1',
        'w1',
        'c1',
      ],
    });
  } finally {
    await client.close();
    db.close();
  }
});

test('an authored WITH takes the shadows inside its own clause', async () => {
  const db = new RecordingDatabase(':memory:');
  const query: AuthorityQuery = {
    ...centre,
    name: 'recursiveOps',
    sql: '  with recursive n(x) AS (SELECT 1) SELECT count(*) AS c FROM ops, n WHERE workspace_id = ?',
    bind: ['workspaceId'],
    params: [{ name: 'workspaceId', type: 'string', nullable: false }],
    coverage: [
      { table: 'ops', variable: 'workspace_id', units: ['workspaceId'] },
    ],
    reads: { ops: ['workspace_id'] },
    resultColumns: [{ name: 'c', type: 'integer', nullable: false }],
  };
  const client = create(db, [query]);
  await client.start();
  try {
    seed(db);
    await client.activateSecurity();
    client.mutate([{ table: 'ops', op: 'delete', rowId: 'op1' }]);
    await client.beginSecurityPreflight();
    expect(
      client.authorityRead([
        { query: 'recursiveOps', params: { workspaceId: 'w1' } },
      ]).results[0]!.rows,
    ).toEqual([{ c: 2 }]);
    expect(db.reads.at(-1)?.sql).toBe(
      `WITH RECURSIVE "ops" AS (SELECT "id","workspace_id","_sync_version" FROM main."ops" WHERE CAST("id" AS TEXT) NOT IN (SELECT value FROM json_each(?)) UNION ALL SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?)), n(x) AS (SELECT 1) SELECT count(*) AS c FROM ops, n WHERE workspace_id = ?`,
    );
  } finally {
    await client.close();
    db.close();
  }
});

test('coverage tells a complete negative from missing, pending and revoked units by the subset rule', async () => {
  const db = new BunClientDatabase(':memory:');
  const client = create(db);
  await client.start();
  const wraps = (recipientId: string) =>
    client.authorityRead([centreRequest(recipientId)]).results[0]!;
  const wrapState = (recipientId: string) =>
    wraps(recipientId).coverage.find((entry) => entry.table === 'wraps')?.state;
  try {
    unit(db, { workspace_id: 'w1' });
    // Complete negative: every unit complete, no qualifying row.
    unit(db, { recipient_id: 'c1' });
    expect(wraps('c1')).toMatchObject({
      rows: [{ qualifying: 0, latest: null }],
      complete: true,
    });
    expect(wrapState('c2')).toBe('missing');
    expect(wraps('c2')).toMatchObject({
      rows: [{ qualifying: 0, latest: null }],
      complete: false,
    });
    unit(db, { recipient_id: 'c2' }, { cursor: -1 });
    expect(wrapState('c2')).toBe('pending');
    unit(db, { recipient_id: 'c2' }, { status: 'revoked' });
    expect(wrapState('c2')).toBe('revoked');
    unit(db, { recipient_id: 'c2' }, { status: 'failed' });
    expect(wrapState('c2')).toBe('revoked');
    // A unit with every entry variable proves only its own values.
    unit(db, { recipient_id: 'c3', sealer_id: 's2' });
    expect(wrapState('c3')).toBe('missing');
    unit(db, { recipient_id: 'c3', sealer_id: 's1' });
    expect(wrapState('c3')).toBe('complete');
    // An echo restricting another entry variable leaves the entry pending.
    unit(
      db,
      { recipient_id: 'c4' },
      {
        echo: [
          { table: 'wraps', status: 'active', scopes: { sealer_id: ['s9'] } },
        ],
      },
    );
    expect(wrapState('c4')).toBe('pending');
    unit(
      db,
      { recipient_id: 'c4' },
      {
        echo: [
          { table: 'wraps', status: 'active', scopes: { sealer_id: ['*'] } },
        ],
      },
    );
    expect(wrapState('c4')).toBe('complete');
    // A pair the fence revoked is no coverage (§4.4).
    unit(
      db,
      { recipient_id: 'c4' },
      {
        echo: [{ table: 'wraps', status: 'revoked', scopes: {} }],
      },
    );
    expect(wrapState('c4')).toBe('pending');
  } finally {
    await client.close();
    db.close();
  }
});

test('authority reads refuse unknown queries, bad params and malformed requests', async () => {
  const db = new BunClientDatabase(':memory:');
  const nullable: AuthorityQuery = {
    ...tasks,
    name: 'nullable',
    params: [
      { name: 'projectId', type: 'string', nullable: true },
      { name: 'flag', type: 'boolean', nullable: false },
      { name: 'n', type: 'integer', nullable: false },
      { name: 'f', type: 'float', nullable: true },
      { name: 'doc', type: 'json', nullable: true },
    ],
    sql: 'SELECT ? AS flag, ? AS n, ? AS f, ? AS doc, ? AS p',
    bind: ['flag', 'n', 'f', 'doc', 'projectId'],
    coverage: [
      { table: 'ops', variable: 'workspace_id', units: ['projectId'] },
    ],
    reads: {},
  };
  const client = create(db, [centre, nullable]);
  await client.start();
  const read = (
    params: Parameters<typeof client.authorityRead>[0][number]['params'],
  ) => client.authorityRead([{ query: 'nullable', params }]);
  const valid = { projectId: 'w1', flag: true, n: 3n, f: 1.5, doc: '{"a":1}' };
  try {
    expect(read(valid).results[0]!.rows).toEqual([
      { flag: 1, n: 3, f: 1.5, doc: '{"a":1}', p: 'w1' },
    ]);
    expect(() => client.authorityRead([{ query: 'nope', params: {} }])).toThrow(
      expect.objectContaining({
        code: 'client.authority_query_unknown',
        details: { query: 'nope' },
      }),
    );
    const { n: _n, ...missing } = valid;
    for (const [params, param] of [
      [{ ...valid, extra: 1 }, 'extra'],
      [missing, 'n'],
      [{ ...valid, n: '3' }, 'n'],
      [{ ...valid, n: 1.5 }, 'n'],
      [{ ...valid, flag: 1 }, 'flag'],
      [{ ...valid, flag: null }, 'flag'],
      [{ ...valid, f: Number.NaN }, 'f'],
      [{ ...valid, doc: '{' }, 'doc'],
      // A nullable coverage param still needs a value to name its unit.
      [{ ...valid, projectId: null }, 'projectId'],
    ] as [Parameters<typeof read>[0], string][]) {
      expect(() => read(params)).toThrow(
        expect.objectContaining({
          code: 'sync.invalid_request',
          details: { query: 'nullable', param },
        }),
      );
    }
    for (const requests of [
      {},
      [{ query: 'nullable' }],
      [{ query: 'nullable', params: valid, extra: 1 }],
      [{ query: 'nullable', params: [] }],
    ])
      expect(() =>
        Reflect.apply(client.authorityRead, client, [requests]),
      ).toThrow(
        expect.objectContaining({ code: 'client.authority_read_forbidden' }),
      );
    expect(() =>
      Reflect.apply(client.authorityRead, client, [[], 'extra']),
    ).toThrow(
      expect.objectContaining({ code: 'client.authority_read_forbidden' }),
    );
    expect(() => client.query('SELECT id FROM ops')).toThrow(
      expect.objectContaining({ code: 'client.security_preflight_required' }),
    );
    const closing = client.close();
    expect(() => client.authorityRead([])).toThrow(
      expect.objectContaining({ code: 'client.closed' }),
    );
    await closing;
    const plain = new SyncClient({
      database: db,
      schema,
      transport: async () => {
        throw new Error('unexpected transport');
      },
    });
    await plain.start();
    expect(() => plain.authorityRead([])).toThrow(
      expect.objectContaining({ code: 'client.authority_read_forbidden' }),
    );
    await plain.close();
  } finally {
    db.close();
  }
});

test('a pending creation is absent, a pending edit reads its base, through settlement and rollback', async () => {
  const server = makeServer(undefined, {
    validators: {
      tasks: (operation) => {
        if (operation.row?.title === 'refused')
          throw new Error('refused title');
      },
    },
  });
  const db = new RecordingDatabase(':memory:');
  const a = await makeClient(server, {
    clientId: 'authority-base',
    database: db,
    authorityReads: defineAuthorityReads([tasks]),
  });
  const read = () =>
    a.client.authorityRead([
      { query: 'projectTasks', params: { projectId: 'p1' } },
    ]).results[0]!;
  try {
    a.client.subscribe({ project_id: 'p1' });
    a.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'accepted'),
      },
    ]);
    await a.client.sync();
    expect(read()).toMatchObject({
      rows: [{ id: 't1', title: 'accepted', done: 0 }],
      complete: true,
    });
    const version = Number(
      db.query("SELECT _sync_version AS v FROM tasks WHERE id='t1'")[0]!.v,
    );
    a.client.patch('tasks', 't1', { title: 'pending' });
    a.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t2', 'p1', 'new') },
    ]);
    await a.client.beginSecurityPreflight();
    expect(read().rows).toEqual([{ id: 't1', title: 'accepted', done: 0 }]);
    expect(db.reads.at(-1)).toEqual({
      sql: `WITH "tasks" AS (SELECT "id","done","project_id","title","_sync_version" FROM main."tasks" WHERE CAST("id" AS TEXT) NOT IN (SELECT value FROM json_each(?)) UNION ALL SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]') FROM json_each(?)) ${tasks.sql}`,
      params: [
        '["t1","t2"]',
        JSON.stringify([['t1', 0, 'p1', 'accepted', version]]),
        'p1',
      ],
    });
    await a.client.activateSecurity();
    await a.client.sync();
    expect(read().rows).toEqual([
      { id: 't1', title: 'pending', done: 0 },
      { id: 't2', title: 'new', done: 0 },
    ]);
    expect(db.reads.at(-1)?.sql).toBe(tasks.sql);
    a.client.patch('tasks', 't1', { title: 'refused' });
    expect(read().rows[0]).toEqual({ id: 't1', title: 'pending', done: 0 });
    expect((await a.client.sync()).rejected).toHaveLength(1);
    expect(read().rows[0]).toEqual({ id: 't1', title: 'pending', done: 0 });
  } finally {
    await a.client.close();
    db.close();
    server.storage.db.close();
  }
});

test('SQLite pins revision and rows before an interleaved writer commits', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'syncular-authority-read-'));
  class InterleavedDatabase extends BunClientDatabase {
    afterRevision: (() => void) | undefined;
    override query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
      const result = super.query(sql, params);
      if (params[0] === 'localRevision' && this.afterRevision) {
        const write = this.afterRevision;
        this.afterRevision = undefined;
        write();
      }
      return result;
    }
  }
  const path = join(root, 'replica.db');
  const db = new InterleavedDatabase(path);
  const opsQuery: AuthorityQuery = {
    ...tasks,
    name: 'ops',
    sql: 'SELECT count(*) AS n FROM ops WHERE workspace_id = ?',
    bind: ['workspaceId'],
    params: [{ name: 'workspaceId', type: 'string', nullable: false }],
    coverage: [
      { table: 'ops', variable: 'workspace_id', units: ['workspaceId'] },
    ],
    reads: { ops: ['workspace_id'] },
  };
  const client = create(db, [opsQuery]);
  await client.start();
  const writer = new BunClientDatabase(path);
  const write = (revision: number) =>
    writer.transaction(() => {
      writer.exec(
        'INSERT INTO ops(id,workspace_id,_sync_version)VALUES(?,?,?)',
        [`op${revision}`, 'w1', revision],
      );
      writer.exec(
        "UPDATE _syncular_meta SET value=? WHERE key='localRevision'",
        [String(revision)],
      );
    });
  const read = () =>
    client.authorityRead([{ query: 'ops', params: { workspaceId: 'w1' } }]);
  try {
    write(1);
    db.afterRevision = () => write(2);
    const first = read();
    expect(first.revision).toBe(1n);
    expect(first.results[0]!.rows).toEqual([{ n: 1 }]);
    const second = read();
    expect(second.revision).toBe(2n);
    expect(second.results[0]!.rows).toEqual([{ n: 2 }]);
    db.exec("DELETE FROM _syncular_meta WHERE key='localRevision'");
    expect(read).toThrow(
      expect.objectContaining({ code: 'sync.local_corrupt' }),
    );
  } finally {
    await client.close();
    writer.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('retained and acknowledged bases precede later pending edits; corrupt evidence fails', async () => {
  const db = new BunClientDatabase(':memory:');
  const opsQuery: AuthorityQuery = {
    ...tasks,
    name: 'ops',
    sql: 'SELECT id, current, _sync_version AS v FROM seals ORDER BY id',
    bind: [],
    params: [],
    coverage: [],
    reads: { seals: ['_sync_version', 'current', 'id'] },
  };
  const client = create(db, [opsQuery]);
  await client.start();
  const read = () =>
    client.authorityRead([{ query: 'ops', params: {} }]).results[0]!.rows;
  try {
    await client.activateSecurity();
    db.exec(
      'INSERT INTO seals(id,op_id,workspace_id,current,_sync_version)VALUES(?,?,?,?,?)',
      ['one', 'op1', 'w1', 1, 7],
    );
    client.patch('seals', 'one', { current: false });
    const { retainFailedRows } = await import('../src/failed-overlay');
    const { listOutbox, listOutboxBeforeImages, deleteOutboxCommit } =
      await import('../src/outbox');
    const first = listOutbox(db)[0]!;
    retainFailedRows(
      db,
      first,
      listOutboxBeforeImages(db, first.clientCommitId),
      8,
    );
    deleteOutboxCommit(db, first.clientCommitId);
    client.patch('seals', 'one', { op_id: 'later' });
    await client.beginSecurityPreflight();
    expect(read()).toEqual([{ id: 'one', current: 1, v: 7 }]);
    db.exec('UPDATE _syncular_failed_rows SET version=NULL');
    expect(read).toThrow(
      expect.objectContaining({ code: 'sync.local_corrupt' }),
    );
    db.exec('UPDATE _syncular_failed_rows SET base=?,version=7', [
      'credential-must-not-leak',
    ]);
    try {
      read();
      throw new Error('malformed evidence must fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'sync.local_corrupt' });
      expect(String(error)).not.toContain('credential-must-not-leak');
    }
    db.exec('UPDATE _syncular_failed_rows SET base=?,version=7', [
      '{"id":"one"}',
    ]);
    expect(read).toThrow(
      expect.objectContaining({ code: 'sync.local_corrupt' }),
    );
    db.exec('UPDATE _syncular_failed_rows SET base=NULL,version=NULL');
    expect(read()).toEqual([]);
  } finally {
    await client.close();
    db.close();
  }
});
