import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  outcomeOf,
} from './helpers';
import { recordCommitOutcome } from '../src/outcomes';

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
      localProjections: [
        {
          name: 'patient_notes_fts',
          generation: '1',
          columns: [{ name: 'title', declaredType: 'string', source: 'title' }],
          fts: {
            tokenize: 'unicode61 remove_diacritics 2',
            columns: ['title'],
          },
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
  test('the first open repairs a replica purged before the index merge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-purge-repair-'));
    const databasePath = join(dir, 'client.db');
    const seeded = await makeClient(makeServer(), {
      clientId: 'purge-repair-client',
      schema: SCHEMA,
      databasePath,
    });
    for (let i = 0; i < 20; i++)
      insertBase(seeded.db, `t${i}`, 'key-revoked', `legacymarker ${i}`);
    insertBase(seeded.db, 'kept', 'key-held', 'Kept original');
    // A 0.105.4 purge: the rows go, VACUUM runs without an index merge, and
    // the plan is recorded with no erasure record.
    seeded.db.exec(
      "DELETE FROM patient_notes WHERE encryption_key_id = 'key-revoked'",
    );
    seeded.db.exec('VACUUM');
    seeded.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    seeded.db.exec(
      "INSERT INTO _syncular_meta(key, value) VALUES('localPurge:legacy-001', '{}')",
    );
    seeded.db.exec(
      "DELETE FROM _syncular_meta WHERE key = 'localPurgeRepair:erased'",
    );
    seeded.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(readFileSync(databasePath).includes('legacymarker')).toBe(true);
    await seeded.client.close();
    seeded.db.close();

    const reopened = await makeClient(makeServer(), {
      clientId: 'purge-repair-client',
      schema: SCHEMA,
      databasePath,
    });
    expect(search(reopened.db, 'kept')).toEqual(['kept']);
    expect(search(reopened.db, 'legacymarker')).toEqual([]);
    expect(
      reopened.db.query(
        "SELECT key FROM _syncular_meta WHERE key = 'localPurgeRepair:erased'",
      ),
    ).toHaveLength(1);
    await reopened.client.close();
    reopened.db.close();
    for (const file of readdirSync(dir))
      expect(readFileSync(join(dir, file)).includes('legacymarker')).toBe(
        false,
      );
  });

  test('a previous-version container that survives fails the purge erasure', async () => {
    const local = await makeClient(makeServer(), {
      clientId: 'purge-container-client',
      schema: SCHEMA,
    });
    insertBase(local.db, 't1', 'key-revoked', 'Target');
    // A container file whose removal failed stays visible as a sibling.
    local.db.siblingExists = () => true;
    let refusal: unknown;
    try {
      local.client.purgeLocalData(PURGE);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ClientSyncError);
    expect(refusal).toMatchObject({ code: 'client.storage_failure' });
    expect(
      local.db.query(
        "SELECT key FROM _syncular_meta WHERE key = 'localPurge:purge-001:erased'",
      ),
    ).toEqual([]);
    // Once the container is gone, a retry of the applied plan finishes it.
    local.db.siblingExists = () => false;
    expect(local.client.purgeLocalData(PURGE).alreadyApplied).toBe(true);
    expect(
      local.db.query(
        "SELECT key FROM _syncular_meta WHERE key = 'localPurge:purge-001:erased'",
      ),
    ).toHaveLength(1);
    await local.client.close();
  });

  test('a prior conflict of a purged row keeps its ids and codes only', async () => {
    const local = await makeClient(makeServer(), {
      clientId: 'purge-conflict-client',
      schema: SCHEMA,
    });
    insertBase(local.db, 'target', 'key-revoked', 'Target original');
    const operation = {
      table: 'patient_notes',
      rowId: 'target',
      op: 'upsert' as const,
      values: values('target', 'key-revoked', 'Local secret'),
    };
    recordCommitOutcome(local.db, {
      clientCommitId: 'prior-conflict',
      status: 'conflict',
      recordedAtMs: 1,
      results: [
        {
          status: 'conflict',
          conflict: {
            clientCommitId: 'prior-conflict',
            opIndex: 0,
            table: 'patient_notes',
            rowId: 'target',
            code: 'sync.version_conflict',
            message: 'conflict',
            serverVersion: 2,
            serverRow: { title: 'Server secret' },
            conflictColumns: ['title'],
            operation,
          },
        },
      ],
      operations: [operation],
    });
    local.client.purgeLocalData(PURGE);
    const outcome = outcomeOf(local.client.commitDelivery('prior-conflict'));
    expect(outcome?.operations).toBeUndefined();
    expect(outcome?.results).toEqual([
      {
        status: 'conflict',
        conflict: {
          clientCommitId: 'prior-conflict',
          opIndex: 0,
          table: 'patient_notes',
          rowId: 'target',
          code: 'sync.version_conflict',
          message: 'conflict',
          serverVersion: 2,
          serverRow: {},
          conflictColumns: [],
        },
      },
    ]);
  });

  test('leaves no purged value in any file of the replica', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncular-purge-'));
    const local = await makeClient(makeServer(), {
      clientId: 'purge-file-client',
      schema: SCHEMA,
      databasePath: join(dir, 'client.db'),
    });
    const marker = 'PURGEMARKER-7f3a';
    for (let i = 0; i < 200; i++) {
      insertBase(local.db, `t${i}`, 'key-revoked', `${marker} ${i}`);
    }
    insertBase(local.db, 'kept', 'key-held', 'Kept original');
    // An earlier server rejection of a purged row journals its operations.
    const rejected = local.client.mutate([
      {
        table: 'patient_notes',
        op: 'upsert',
        values: values('t1', 'key-revoked', `${marker} rejected`),
      },
    ]);
    await local.client.sync();
    expect(
      outcomeOf(local.client.commitDelivery(rejected))?.operations,
    ).toHaveLength(1);
    // A pending edit of a purged row is dropped; its outcome keeps no value.
    local.client.mutate([
      {
        table: 'patient_notes',
        op: 'upsert',
        values: values('t0', 'key-revoked', `${marker} pending`),
      },
    ]);
    // The full-text index stores the marker as lowercase tokens; the scan
    // finds them before the purge.
    const token = 'purgemarker';
    local.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(readFileSync(join(dir, 'client.db')).includes(token)).toBe(true);
    expect(local.client.purgeLocalData(PURGE).purgedRows).toBe(200);
    expect(tableRows(local.db, 'patient_notes').map((row) => row.id)).toEqual([
      'kept',
    ]);
    // A retry of the applied plan skips the finished rewrite; with the
    // completion marker gone (a rewrite the process did not finish) it
    // rewrites again.
    const statements: string[] = [];
    const exec = local.db.exec.bind(local.db);
    local.db.exec = (sql, params) => {
      statements.push(sql);
      return exec(sql, params);
    };
    expect(local.client.purgeLocalData(PURGE).alreadyApplied).toBe(true);
    expect(statements).not.toContain('VACUUM');
    exec(
      "DELETE FROM _syncular_meta WHERE key = 'localPurge:purge-001:erased'",
    );
    expect(local.client.purgeLocalData(PURGE).alreadyApplied).toBe(true);
    expect(statements).toContain('VACUUM');
    local.db.exec = exec;
    const scrubbed = outcomeOf(local.client.commitDelivery(rejected));
    expect(scrubbed?.status).toBe('rejected');
    expect(scrubbed?.operations).toBeUndefined();
    expect(
      scrubbed?.results.every(
        (result) =>
          result.status === 'error' && result.rejection.operation === undefined,
      ),
    ).toBe(true);
    await local.client.close();
    local.db.close();
    const files = readdirSync(dir);
    expect(files).toContain('client.db');
    for (const file of files) {
      const bytes = readFileSync(join(dir, file));
      expect(bytes.includes(marker)).toBe(false);
      expect(bytes.includes(token)).toBe(false);
    }
  });

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
    expect(outcomeOf(local.client.commitDelivery(doomedCommit))).toEqual(
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
    expect(outcomeOf(local.client.commitDelivery(doomedCommit))?.status).toBe(
      'rejected',
    );
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
      expect(outcomeOf(local.client.commitDelivery(clientCommitId))).toEqual(
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
    local.client.subscribe({ project_id: 'p1' });
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
    expect(outcomeOf(local.client.commitDelivery(inFlight))?.status).toBe(
      'rejected',
    );
    gate.release();
    const summary = await round;

    // The response's PUSH_RESULT for the purged commit is skipped: the
    // purge outcome stands and the outbox count stays at zero.
    expect(summary.applied).toEqual([]);
    expect(outcomeOf(local.client.commitDelivery(inFlight))?.status).toBe(
      'rejected',
    );
    expect(local.client.statusSnapshot().outbox).toBe(0);
    expect(outboxCounts.every((count) => count >= 0)).toBe(true);
    await local.client.close();
    local.db.close();
  });

  test('a failed purge keeps the captured response applicable', async () => {
    const local = await makeClient(makeServer(), {
      clientId: 'failed-purge-round',
    });
    await local.client.syncUntilIdle();
    const commit = local.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('kept', 'p1', 'kept'),
      },
    ]);
    const gate = responseGate();
    local.faults.holdResponseOnce = gate.fault;
    const round = local.client.sync();
    await gate.held;
    local.db.exec(`CREATE TRIGGER fail_purge BEFORE INSERT ON _syncular_meta
      WHEN NEW.key = 'localPurge:failed-round' BEGIN SELECT RAISE(ABORT, 'purge fault'); END`);
    const revision = local.client.localRevision;
    expect(() =>
      local.client.purgeLocalData({
        purgeId: 'failed-round',
        targets: [{ table: 'tasks', selectors: { project_id: ['p1'] } }],
      }),
    ).toThrow();
    expect(
      local.client.pendingCommits().map((entry) => entry.clientCommitId),
    ).toEqual([commit]);
    expect(local.client.localRevision).toBe(revision);
    local.db.exec('DROP TRIGGER fail_purge');
    gate.release();
    expect((await round).applied).toEqual([commit]);
    expect(local.client.pendingCommits()).toEqual([]);
    expect(outcomeOf(local.client.commitDelivery(commit))?.status).toBe(
      'applied',
    );
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
