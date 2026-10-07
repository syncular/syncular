/**
 * §7.1 authoring value validation: declared types are validated before the
 * call records anything, a malformed byte envelope is never coerced, and a
 * legacy outbox commit an earlier version persisted with a value the current
 * codec refuses leaves through the incompatible-outbox path instead of
 * wedging every later round.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ClientChangeBatch, type ClientSchema } from '@syncular/client';
import { makeClient, makeServer, PARTITION, tableRows } from './helpers';

const COLUMNS = [
  { name: 'id', type: 'string', nullable: false },
  { name: 'project_id', type: 'string', nullable: false },
  { name: 'title', type: 'string', nullable: false },
  { name: 'priority', type: 'integer', nullable: false },
  { name: 'ratio', type: 'float', nullable: false },
  { name: 'score', type: 'float', nullable: true },
  { name: 'done', type: 'boolean', nullable: false },
  { name: 'meta', type: 'json', nullable: true },
  { name: 'ref', type: 'blob_ref', nullable: true },
  { name: 'payload', type: 'bytes', nullable: true },
  {
    name: 'doc',
    type: 'crdt',
    nullable: true,
    crdtType: 'yjs-doc',
  },
] as const;

const SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'tasks',
      columns: COLUMNS,
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{projectId}', column: 'project_id' }],
    },
  ],
};

const valid = {
  id: 't1',
  project_id: 'p1',
  title: 'ok',
  priority: 1,
  ratio: 0.5,
  score: null,
  done: false,
  meta: null,
  ref: null,
  payload: { $bytes: '0a' },
  doc: null,
};

function server() {
  const created = makeServer(SCHEMA as never);
  created.allowed['a'] = { projectId: ['p1'] };
  return created;
}

test('mutate refuses every value the declared column type rejects', async () => {
  const { client, db } = await makeClient(server(), {
    clientId: 'values',
    actorId: 'a',
    schema: SCHEMA,
  });
  const first = client.mutate([
    { op: 'upsert', table: 'tasks', values: { ...valid } } as never,
  ]);
  const rows = tableRows(db, 'tasks');
  const revision = client.localRevision;
  const changes: ClientChangeBatch[] = [];
  client.onChange((batch) => changes.push(batch));

  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['string column, number', { ...valid, title: 7 }],
    ['integer column, string', { ...valid, priority: 'high' }],
    [
      'integer column, unsafe number',
      { ...valid, priority: Number.MAX_SAFE_INTEGER + 1 },
    ],
    ['float column, string', { ...valid, ratio: 'half' }],
    ['nullable float, NaN', { ...valid, score: Number.NaN }],
    ['nullable float, Infinity', { ...valid, score: Number.POSITIVE_INFINITY }],
    [
      'nullable float, -Infinity',
      { ...valid, score: Number.NEGATIVE_INFINITY },
    ],
    ['boolean column, number 2', { ...valid, done: 2 }],
    ['json column, object', { ...valid, meta: { a: 1 } }],
    ['blob_ref column, number', { ...valid, ref: 7 }],
    ['bytes, non-hex envelope', { ...valid, payload: { $bytes: 'zz' } }],
    ['bytes, odd-length envelope', { ...valid, payload: { $bytes: 'abc' } }],
    ['bytes, plus-sign envelope', { ...valid, payload: { $bytes: '+a' } }],
    ['bytes, no envelope', { ...valid, payload: { nested: true } }],
    ['bytes, bare number', { ...valid, payload: 7 }],
    ['crdt, malformed envelope', { ...valid, doc: { $bytes: 'zz' } }],
  ];
  for (const [label, values] of cases) {
    expect(
      () => client.mutate([{ op: 'upsert', table: 'tasks', values } as never]),
      label,
    ).toThrow(expect.objectContaining({ code: 'sync.invalid_request' }));
    expect(client.pendingCommits().length, label).toBe(1);
    expect(client.localRevision, label).toBe(revision);
    expect(tableRows(db, 'tasks'), label).toEqual(rows);
  }
  // The preflight uses the native structured shape: a static message with the
  // dynamic cause in `details.legacyCause`.
  expect(() =>
    client.mutate([
      {
        op: 'upsert',
        table: 'tasks',
        values: { ...valid, payload: { $bytes: 'zz' } },
      } as never,
    ]),
  ).toThrow(
    expect.objectContaining({
      code: 'sync.invalid_request',
      message: 'the authoring request is invalid',
      retryable: false,
      details: {
        legacyCause: expect.stringContaining('table tasks: column payload'),
      },
    }),
  );
  expect(client.pendingCommits()[0]?.clientCommitId).toBe(first);
  expect(changes.flatMap((batch) => batch.tables)).toEqual([]);
  await client.close();
});

test('patch refuses a malformed envelope and a wrong type before recording', async () => {
  const { client, db } = await makeClient(server(), {
    clientId: 'patch-values',
    actorId: 'a',
    schema: SCHEMA,
  });
  const commitId = client.mutate([
    { op: 'upsert', table: 'tasks', values: { ...valid } } as never,
  ]);
  for (const partial of [
    { payload: { $bytes: 'zz' } },
    { priority: 'high' },
    { meta: { a: 1 } },
  ]) {
    expect(
      () => client.patch('tasks', 't1', partial as never),
      JSON.stringify(partial),
    ).toThrow(expect.objectContaining({ code: 'sync.invalid_request' }));
    expect(
      client.pendingCommits().map((commit) => commit.clientCommitId),
    ).toEqual([commitId]);
    expect(tableRows(db, 'tasks')).toHaveLength(1);
  }
  await client.close();
});

test('one refused operation rejects the whole batch atomically', async () => {
  const { client, db } = await makeClient(server(), {
    clientId: 'batch-atomicity',
    actorId: 'a',
    schema: SCHEMA,
  });
  expect(() =>
    client.mutate([
      { op: 'upsert', table: 'tasks', values: { ...valid, id: 'good' } },
      {
        op: 'upsert',
        table: 'tasks',
        values: { ...valid, id: 'bad', payload: { $bytes: 'zz' } },
      },
    ] as never),
  ).toThrow(expect.objectContaining({ code: 'sync.invalid_request' }));
  expect(client.pendingCommits()).toEqual([]);
  expect(client.localRevision).toBe(0n);
  expect(tableRows(db, 'tasks')).toEqual([]);
  await client.close();
});

test('documented host normalization stays in force', async () => {
  const { client, db } = await makeClient(server(), {
    clientId: 'normalization',
    actorId: 'a',
    schema: SCHEMA,
  });
  client.mutate([
    {
      op: 'upsert',
      table: 'tasks',
      values: {
        ...valid,
        done: 1,
        priority: 7n,
        payload: new Uint8Array([0x0a, 0xff]),
      },
    } as never,
  ]);
  const [row] = tableRows(db, 'tasks');
  expect(row?.done).toBe(1);
  expect(row?.priority).toBe(7);
  expect([...(row?.payload as Uint8Array)]).toEqual([10, 255]);
  expect(client.pendingCommits()[0]?.operations[0]?.values?.payload).toEqual({
    $bytes: '0aff',
  });
  await client.close();
});

test('nullable bytes accept null, an empty envelope, and uppercase digits', async () => {
  const { client, db } = await makeClient(server(), {
    clientId: 'bytes-positives',
    actorId: 'a',
    schema: SCHEMA,
  });
  for (const [id, payload] of [
    ['t1', null],
    ['t2', { $bytes: '' }],
    ['t3', { $bytes: '0AFF' }],
  ] as const) {
    client.mutate([
      {
        op: 'upsert',
        table: 'tasks',
        values: { ...valid, id, payload },
      } as never,
    ]);
  }
  const rows = tableRows(db, 'tasks');
  expect(rows.map((row) => row.id)).toEqual(['t1', 't2', 't3']);
  expect(rows[0]?.payload).toBeNull();
  expect([...(rows[1]?.payload as Uint8Array)]).toEqual([]);
  expect([...(rows[2]?.payload as Uint8Array)]).toEqual([10, 255]);
  await client.close();
});

test('recovery restores the synced authoritative row and keeps successor before-images', async () => {
  for (const withSuccessor of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'syncular-shared-synced-'));
    const path = join(directory, 'replica.sqlite');
    try {
      const backend = server();
      const open = () =>
        makeClient(backend, {
          clientId: 'shared-synced',
          actorId: 'a',
          schema: SCHEMA,
          databasePath: path,
        });
      // One authoritative server row, synced into the replica.
      const seeder = await open();
      await seeder.client.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: { ...valid, id: 't1', title: 'authoritative' },
        } as never,
      ]);
      await seeder.client.subscribe({
        id: 'tasks',
        table: 'tasks',
        scopes: { projectId: ['p1'] },
      });
      await seeder.client.syncUntilIdle();
      const authoritative = tableRows(seeder.db, 'tasks').find(
        (row) => row.id === 't1',
      )!;
      expect(Number(authoritative._sync_version)).toBeGreaterThan(0);
      await seeder.client.close();
      seeder.db.close();

      const client = await open();
      const older = client.client.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: { ...valid, title: 'older' },
        } as never,
      ]);
      const newer = client.client.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: { ...valid, title: 'newer' },
        } as never,
      ]);
      const successor = withSuccessor
        ? client.client.mutate([
            {
              op: 'upsert',
              table: 'tasks',
              values: { ...valid, title: 'successor' },
            } as never,
          ])
        : undefined;
      await client.client.close();
      for (const commitId of [older, newer]) {
        client.db.exec(
          'UPDATE _syncular_outbox SET operations=? WHERE client_commit_id=?',
          [
            JSON.stringify([
              {
                table: 'tasks',
                rowId: 't1',
                op: 'upsert',
                values: {
                  ...valid,
                  title: 'legacy',
                  payload: { $bytes: 'zz' },
                },
              },
            ]),
            commitId,
          ],
        );
      }
      client.db.close();

      const reopened = await open();
      expect(
        reopened.client.pendingCommits().map((commit) => commit.clientCommitId),
      ).toEqual(successor === undefined ? [] : [successor]);
      expect(
        reopened.client
          .rejections()
          .map((rejection) => rejection.clientCommitId),
      ).toEqual([older, newer]);
      // Without a surviving same-row successor, the recovered row is the
      // authoritative row again, version included. With one, the pending
      // successor legitimately overlays the restored base, so the authoritative
      // state lives in that successor's before-image.
      if (successor === undefined) {
        expect(
          tableRows(reopened.db, 'tasks').find((row) => row.id === 't1'),
        ).toEqual(authoritative);
        await reopened.client.close();
        reopened.db.close();
        continue;
      }
      // The pending overlay keeps the authoritative row version.
      expect(
        Number(
          tableRows(reopened.db, 'tasks').find((row) => row.id === 't1')
            ?._sync_version,
        ),
      ).toBe(Number(authoritative._sync_version));
      const images = reopened.db.query(
        'SELECT op_index,existed,sync_version,values_json FROM _syncular_outbox_before_images WHERE client_commit_id=?',
        [successor],
      );
      expect(images).toHaveLength(1);
      expect(images[0]?.existed).toBe(1);
      expect(Number(images[0]?.sync_version)).toBe(
        Number(authoritative._sync_version),
      );
      expect(JSON.parse(String(images[0]?.values_json))).toMatchObject({
        id: 't1',
        project_id: 'p1',
        title: 'authoritative',
      });

      // A later rejection of the surviving successor must still restore the
      // authoritative row rather than legacy-undoing it.
      await reopened.client.close();
      reopened.db.exec(
        'UPDATE _syncular_outbox SET operations=? WHERE client_commit_id=?',
        [
          JSON.stringify([
            {
              table: 'tasks',
              rowId: 't1',
              op: 'upsert',
              values: { ...valid, title: 'legacy', payload: { $bytes: 'zz' } },
            },
          ]),
          successor,
        ],
      );
      reopened.db.close();
      const late = await open();
      expect(late.client.pendingCommits()).toEqual([]);
      // The journal list reads newest-first, so assert membership rather than
      // the drop pass's FIFO order here.
      expect(
        new Set(
          late.client.rejections().map((rejection) => rejection.clientCommitId),
        ),
      ).toEqual(new Set([older, newer, successor]));
      expect(
        late.client
          .rejections()
          .every((rejection) => rejection.code === 'sync.outbox_incompatible'),
      ).toBe(true);
      expect(
        tableRows(late.db, 'tasks').find((row) => row.id === 't1'),
      ).toEqual(authoritative);
      await late.client.close();
      late.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

for (const shared of [
  {
    label: 'malformed byte envelope',
    intent: { payload: { $bytes: 'zz' } },
  },
  { label: 'wrong declared type', intent: { priority: 'high' } },
  {
    label: 'stored null for a non-nullable column',
    intent: { project_id: null },
  },
] as const) {
  test(`two legacy commits with a ${shared.label} on the same row recover in order`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'syncular-shared-row-'));
    const path = join(directory, 'replica.sqlite');
    try {
      const backend = server();
      const open = () =>
        makeClient(backend, {
          clientId: 'shared-row',
          actorId: 'a',
          schema: SCHEMA,
          databasePath: path,
        });
      const first = await open();
      const older = first.client.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: { ...valid, title: 'older' },
        } as never,
      ]);
      const newer = first.client.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: { ...valid, title: 'newer' },
        } as never,
      ]);
      const successor = first.client.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: { ...valid, id: 't2', title: 'kept' },
        } as never,
      ]);
      await first.client.close();
      // Both queued updates on the same row carry the legacy shape.
      for (const commitId of [older, newer]) {
        first.db.exec(
          'UPDATE _syncular_outbox SET operations=? WHERE client_commit_id=?',
          [
            JSON.stringify([
              {
                table: 'tasks',
                rowId: 't1',
                op: 'upsert',
                values: { ...valid, ...shared.intent },
              },
            ]),
            commitId,
          ],
        );
      }
      first.db.close();

      const reopened = await open();
      expect(
        reopened.client.pendingCommits().map((commit) => commit.clientCommitId),
      ).toEqual([successor]);
      // FIFO: the older commit's rejection is recorded first.
      expect(
        reopened.client
          .rejections()
          .map((rejection) => rejection.clientCommitId),
      ).toEqual([older, newer]);
      expect(
        reopened.client.rejections().map((rejection) => rejection.code),
      ).toEqual(['sync.outbox_incompatible', 'sync.outbox_incompatible']);
      expect(reopened.client.rejections()[0]?.details).toEqual({
        reason: 'invalid_stored_values',
      });
      expect(reopened.client.query('SELECT id FROM tasks ORDER BY id')).toEqual(
        [{ id: 't2' }],
      );
      for (const commitId of [older, newer]) {
        const delivery = reopened.client.commitDelivery(commitId);
        expect(delivery.status).toBe('known');
        expect(
          delivery.status === 'known' ? delivery.outcome.status : '?',
        ).toBe('rejected');
      }
      // The surviving commit still drains and lands on the server.
      expect((await reopened.client.sync()).applied).toEqual([successor]);
      expect(
        await backend.storage.getRow(PARTITION, 'tasks', 't2'),
      ).toBeDefined();
      expect(
        await backend.storage.getRow(PARTITION, 'tasks', 't1'),
      ).toBeUndefined();
      await reopened.client.close();
      reopened.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const legacy of [
  {
    label: 'malformed byte envelope',
    values: { ...valid, payload: { $bytes: 'zz' } },
  },
  {
    label: 'odd-length byte envelope',
    values: { ...valid, payload: { $bytes: 'abc' } },
  },
  {
    label: 'plus-sign byte envelope',
    values: { ...valid, payload: { $bytes: '+a' } },
  },
  { label: 'wrong declared type', values: { ...valid, priority: 'high' } },
  { label: 'null for a required column', values: { ...valid, priority: null } },
] as const) {
  test(`a legacy outbox commit with a ${legacy.label} is dropped and later commits drain`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'syncular-legacy-'));
    const path = join(directory, 'replica.sqlite');
    try {
      const backend = server();
      const open = () =>
        makeClient(backend, {
          clientId: 'legacy',
          actorId: 'a',
          schema: SCHEMA,
          databasePath: path,
        });

      // An earlier client records both commits; the first one's persisted
      // intent then carries the shape that client accepted.
      const first = await open();
      // A valid commit for the same row, so the mirror and its before-images
      // exist; the stored intent is then rewritten to the legacy shape below.
      const stale = first.client.mutate([
        { op: 'upsert', table: 'tasks', values: { ...valid } } as never,
      ]);
      const successor = first.client.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: { ...valid, id: 't2', title: 'behind' },
        } as never,
      ]);
      await first.client.close();
      first.db.exec(
        'UPDATE _syncular_outbox SET operations=? WHERE client_commit_id=?',
        [
          JSON.stringify([
            {
              table: 'tasks',
              rowId: 't1',
              op: 'upsert',
              values: legacy.values,
            },
          ]),
          stale,
        ],
      );
      first.db.close();

      // Close/reopen: the replay must drop the legacy intent, never fail.
      const reopened = await open();
      expect(
        reopened.client.pendingCommits().map((c) => c.clientCommitId),
      ).toEqual([successor]);
      // The journal keeps the operation envelope only when its stored shape is
      // representable; a malformed envelope is omitted with a bounded reason.
      const representable =
        legacy.label === 'wrong declared type' ||
        legacy.label === 'null for a required column';
      const rejection = reopened.client.rejections()[0];
      expect(rejection?.code).toBe('sync.outbox_incompatible');
      expect(rejection?.message).toBe(
        'the persisted commit carries values the current codec refuses',
      );
      expect(rejection?.details).toEqual({ reason: 'invalid_stored_values' });
      expect(rejection?.operation === undefined).toBe(!representable);
      const delivery = reopened.client.commitDelivery(stale);
      expect(delivery.status).toBe('known');
      expect(delivery.status === 'known' ? delivery.outcome.status : '?').toBe(
        'rejected',
      );
      expect(
        delivery.status === 'known' ? delivery.outcome.operations : undefined,
      ).toEqual(representable ? expect.anything() : undefined);
      expect(reopened.client.query('SELECT id FROM tasks ORDER BY id')).toEqual(
        [{ id: 't2' }],
      );

      // The valid commit behind it survives, drains, and later writes sync.
      expect((await reopened.client.sync()).applied).toEqual([successor]);
      expect(
        await backend.storage.getRow(PARTITION, 'tasks', 't2'),
      ).toBeDefined();
      expect(
        await backend.storage.getRow(PARTITION, 'tasks', 't1'),
      ).toBeUndefined();
      expect(reopened.client.pendingCommits()).toEqual([]);
      const next = reopened.client.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: { ...valid, id: 't3', title: 'after' },
        } as never,
      ]);
      expect((await reopened.client.sync()).applied).toEqual([next]);
      await reopened.client.close();
      reopened.db.close();

      // The rejection stays readable across a further reopen.
      const journal = await open();
      expect(journal.client.rejections().map((entry) => entry.code)).toEqual([
        'sync.outbox_incompatible',
      ]);
      expect(journal.client.rejections()[0]?.details).toEqual({
        reason: 'invalid_stored_values',
      });
      const reread = journal.client.commitDelivery(stale);
      expect(reread.status).toBe('known');
      expect(reread.status === 'known' ? reread.outcome.status : '?').toBe(
        'rejected',
      );
      expect(
        reread.status === 'known' ? reread.outcome.operations : 'kept',
      ).toEqual(representable ? expect.anything() : undefined);
      await journal.client.close();
      journal.db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
