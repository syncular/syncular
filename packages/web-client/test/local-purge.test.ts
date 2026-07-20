import { describe, expect, test } from 'bun:test';
import {
  type ClientSchema,
  ClientSyncError,
  type LocalDataPurgeInput,
} from '@syncular/client';
import {
  makeClient,
  makeServer,
  responseGate,
  tableRows,
  taskValues,
} from './helpers';

const SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'patient_notes',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'practice_id', type: 'string', nullable: false },
        { name: 'encryption_key_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        {
          name: 'secret_key_id',
          type: 'bytes',
          declaredType: 'string',
          encrypted: true,
          nullable: false,
        },
      ],
      primaryKey: 'id',
      scopes: ['practice:{practice_id}'],
      ftsIndexes: [
        {
          name: 'patient_notes_fts',
          columns: ['title'],
          tokenize: 'unicode61 remove_diacritics 2',
        },
      ],
    },
  ],
};

const PURGE: LocalDataPurgeInput = {
  purgeId: 'purge-001',
  targets: [
    {
      table: 'patient_notes',
      selectors: { encryption_key_id: ['key-revoked'] },
    },
  ],
};

function search(
  db: Awaited<ReturnType<typeof makeClient>>['db'],
  query: string,
): string[] {
  return db
    .query(
      `SELECT n.id FROM patient_notes_fts f
       JOIN patient_notes n
         ON CAST(n.id AS TEXT) = f._syncular_source_id
       WHERE patient_notes_fts MATCH ? ORDER BY n.id`,
      [query],
    )
    .map((row) => String(row.id));
}

function insertBase(
  db: Awaited<ReturnType<typeof makeClient>>['db'],
  id: string,
  keyId: string,
  title: string,
): void {
  db.exec(
    `INSERT INTO patient_notes(
       id, practice_id, encryption_key_id, title, secret_key_id, _sync_version
     ) VALUES (?, 'practice-1', ?, ?, 'fixture-secret', 1)`,
    [id, keyId, title],
  );
}

function values(id: string, keyId: string, title: string) {
  return {
    id,
    practice_id: 'practice-1',
    encryption_key_id: keyId,
    title,
    secret_key_id: 'fixture-secret',
  };
}

describe('application-authorized local data purge', () => {
  test('atomically removes exact rows and FTS, rolls back siblings, and records whole-commit rejection', async () => {
    const local = await makeClient(makeServer(), {
      clientId: 'local-purge-client',
      schema: SCHEMA,
    });
    insertBase(local.db, 'target', 'key-revoked', 'Target original');
    insertBase(local.db, 'unrelated', 'key-held', 'Unrelated original');

    const doomedCommit = local.client.mutate([
      {
        table: 'patient_notes',
        op: 'upsert',
        values: values('target', 'key-revoked', 'Target changed'),
      },
      {
        table: 'patient_notes',
        op: 'upsert',
        values: values('unrelated', 'key-held', 'Unrelated changed'),
      },
    ]);
    const keptCommit = local.client.mutate([
      {
        table: 'patient_notes',
        op: 'upsert',
        values: values('unrelated', 'key-held', 'Unrelated kept'),
      },
      {
        table: 'patient_notes',
        op: 'upsert',
        values: values('kept', 'key-held', 'Kept optimistic'),
      },
    ]);

    const changes: string[][] = [];
    local.client.onChange((change) =>
      changes.push(change.tables.map((table) => table.table)),
    );
    const result = local.client.purgeLocalData(PURGE);
    expect(result).toEqual({
      alreadyApplied: false,
      purgedRows: 1,
      droppedCommits: 1,
    });

    expect(tableRows(local.db, 'patient_notes')).toEqual([
      expect.objectContaining({
        id: 'kept',
        encryption_key_id: 'key-held',
        title: 'Kept optimistic',
      }),
      expect.objectContaining({
        id: 'unrelated',
        encryption_key_id: 'key-held',
        title: 'Unrelated kept',
      }),
    ]);
    expect(search(local.db, 'target')).toEqual([]);
    expect(search(local.db, 'changed')).toEqual([]);
    expect(search(local.db, 'kept')).toEqual(['kept', 'unrelated']);
    expect(
      local.client.pendingCommits().map((commit) => commit.clientCommitId),
    ).toEqual([keptCommit]);
    expect(local.client.commitOutcome(doomedCommit)).toEqual(
      expect.objectContaining({
        status: 'rejected',
        results: expect.arrayContaining([
          expect.objectContaining({
            rejection: expect.objectContaining({
              code: 'client.local_data_purged',
            }),
          }),
        ]),
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain('patient_notes');

    expect(local.client.purgeLocalData(PURGE)).toEqual({
      alreadyApplied: true,
      purgedRows: 0,
      droppedCommits: 0,
    });
    expect(changes).toHaveLength(1);
    expect(() =>
      local.client.purgeLocalData({
        ...PURGE,
        targets: [
          {
            table: 'patient_notes',
            selectors: { encryption_key_id: ['key-held'] },
          },
        ],
      }),
    ).toThrow(/already used with a different plan/);

    await local.client.close();
    local.db.close();
  });

  test('reveals and deletes a target hidden by an optimistic delete', async () => {
    const local = await makeClient(makeServer(), {
      clientId: 'local-purge-delete-client',
      schema: SCHEMA,
    });
    insertBase(local.db, 'target', 'key-revoked', 'Target hidden');
    const doomedCommit = local.client.mutate([
      { table: 'patient_notes', op: 'delete', rowId: 'target' },
    ]);
    expect(tableRows(local.db, 'patient_notes')).toEqual([]);

    expect(local.client.purgeLocalData(PURGE)).toEqual({
      alreadyApplied: false,
      purgedRows: 1,
      droppedCommits: 1,
    });
    expect(tableRows(local.db, 'patient_notes')).toEqual([]);
    expect(local.client.commitOutcome(doomedCommit)?.status).toBe('rejected');
    await local.client.close();
    local.db.close();
  });

  test('dooms every stacked commit over a base-matching row and deletes the row', async () => {
    const local = await makeClient(makeServer(), {
      clientId: 'local-purge-stacked-client',
      schema: SCHEMA,
    });
    // Base row matches the purge; a pending commit moves it away from the
    // target key, and a second pending commit re-edits the moved row (its
    // values and before-image both show the moved key). The Rust core dooms
    // the whole stack because the base row matches, and deletes the row.
    insertBase(local.db, 'target', 'key-revoked', 'Target original');
    const moved = local.client.mutate([
      {
        table: 'patient_notes',
        op: 'upsert',
        values: values('target', 'key-held', 'Target original'),
      },
    ]);
    const retitled = local.client.patch('patient_notes', 'target', {
      title: 'Target renamed',
    });

    expect(local.client.purgeLocalData(PURGE)).toEqual({
      alreadyApplied: false,
      purgedRows: 1,
      droppedCommits: 2,
    });
    expect(tableRows(local.db, 'patient_notes')).toEqual([]);
    expect(local.client.pendingCommits()).toEqual([]);
    for (const clientCommitId of [moved, retitled]) {
      expect(local.client.commitOutcome(clientCommitId)).toEqual(
        expect.objectContaining({
          status: 'rejected',
          results: expect.arrayContaining([
            expect.objectContaining({
              rejection: expect.objectContaining({
                code: 'client.local_data_purged',
              }),
            }),
          ]),
        }),
      );
    }
    await local.client.close();
    local.db.close();
  });

  test('a purge landing between push and response keeps the purge outcome and an exact outbox count', async () => {
    const server = makeServer();
    const local = await makeClient(server, {
      clientId: 'local-purge-race-client',
    });
    local.client.subscribe({
      id: 'purge-race-tasks',
      table: 'tasks',
      scopes: { project_id: ['p1'] },
    });
    await local.client.syncUntilIdle();
    const inFlight = local.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('race-row', 'p1', 'racing'),
      },
    ]);
    const outboxCounts: number[] = [];
    local.client.onChange((change) => {
      if (change.status !== undefined) outboxCounts.push(change.status.outbox);
    });

    // Park the round after the server applied the push, then purge the
    // in-flight commit inside that window.
    const gate = responseGate();
    local.faults.holdResponseOnce = gate.fault;
    const round = local.client.sync();
    await gate.held;
    expect(
      local.client.purgeLocalData({
        purgeId: 'purge-race-001',
        targets: [{ table: 'tasks', selectors: { project_id: ['p1'] } }],
      }),
    ).toEqual({ alreadyApplied: false, purgedRows: 0, droppedCommits: 1 });
    expect(local.client.pendingCommits()).toEqual([]);
    expect(local.client.commitOutcome(inFlight)?.status).toBe('rejected');
    gate.release();
    const summary = await round;

    // The response's PUSH_RESULT for the purged commit is skipped: the
    // purge outcome stands and the outbox count stays at zero.
    expect(summary.applied).toEqual([]);
    expect(local.client.commitOutcome(inFlight)?.status).toBe('rejected');
    expect(local.client.statusSnapshot().outbox).toBe(0);
    expect(outboxCounts.every((count) => count >= 0)).toBe(true);
    await local.client.close();
    local.db.close();
  });

  test('fails closed for unsafe selectors and never offers a full-table mode', async () => {
    const local = await makeClient(makeServer(), {
      clientId: 'local-purge-validation-client',
      schema: SCHEMA,
    });
    const invalid = (input: LocalDataPurgeInput, message: RegExp) => {
      try {
        local.client.purgeLocalData(input);
        throw new Error('expected purge to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(ClientSyncError);
        expect((error as ClientSyncError).code).toBe('sync.invalid_request');
        expect((error as Error).message).toMatch(message);
      }
    };
    invalid({ purgeId: 'empty', targets: [] }, /between 1 and 64 targets/);
    invalid(
      {
        purgeId: 'no-selectors',
        targets: [{ table: 'patient_notes', selectors: {} }],
      },
      /between 1 and 8 selectors/,
    );
    invalid(
      {
        purgeId: 'encrypted',
        targets: [
          {
            table: 'patient_notes',
            selectors: { secret_key_id: ['key-revoked'] },
          },
        ],
      },
      /plaintext string column/,
    );
    invalid(
      {
        purgeId: 'not-code-like',
        targets: [
          {
            table: 'patient_notes',
            selectors: { encryption_key_id: ['not a routing id'] },
          },
        ],
      },
      /code-like identifiers/,
    );
    await local.client.close();
    local.db.close();
  });
});
