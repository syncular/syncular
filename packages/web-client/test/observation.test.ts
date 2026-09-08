import { describe, expect, test } from 'bun:test';
import {
  type ClientChangeBatch,
  SyncClient,
  type WindowBase,
} from '@syncular/client';
import {
  encodeMessage,
  encodeRow,
  type ResponseFrame,
  type PushResultFrame,
} from '@syncular/core';
import { BunClientDatabase } from '@syncular/client/bun';
import {
  CLIENT_SCHEMA,
  TASK_COLUMNS,
  makeClient,
  makeServer,
  taskValues,
} from './helpers';

const BASE: WindowBase = { table: 'tasks', variable: 'project_id' };
const DOC_BASE: WindowBase = {
  table: 'docs',
  variable: 'projectId',
  fixedScopes: { org_id: ['o1'] },
};

describe('revisioned local observation (SPEC §7.5)', () => {
  test('a frame boundary preserves writes made by acknowledgement observers', async () => {
    const db = new BunClientDatabase();
    let ids: string[] = [];
    let appended: string | undefined;
    const outbox: number[] = [];
    const client = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      clientId: 'observer-append',
      transport: async () =>
        encodeMessage({
          wireVersion: 2,
          msgKind: 'response',
          frames: [
            { type: 'RESP_HEADER', logEpoch: 'epoch-1', resetRequired: false },
            {
              type: 'PUSH_RESULT',
              clientCommitId: ids[0] ?? '',
              status: 'applied',
              commitSeq: 1,
              results: [{ status: 'applied', opIndex: 0 }],
            },
            { type: 'UNKNOWN', frameType: 0x17, payload: new Uint8Array() },
            {
              type: 'PUSH_RESULT',
              clientCommitId: ids[1] ?? '',
              status: 'applied',
              commitSeq: 2,
              results: [{ status: 'applied', opIndex: 0 }],
            },
          ],
        }),
    });
    try {
      await client.start();
      db.exec(
        "INSERT OR REPLACE INTO _syncular_meta(key, value) VALUES ('logEpoch', 'epoch-1')",
      );
      ids = ['first', 'second'].map((id) =>
        client.mutate([
          { table: 'tasks', op: 'upsert', values: taskValues(id, 'p1', id) },
        ]),
      );
      client.onChange((batch) => {
        if (!batch.outcomesChanged) return;
        outbox.push(batch.status?.outbox ?? -1);
        if (appended === undefined)
          appended = client.mutate([
            {
              table: 'tasks',
              op: 'upsert',
              values: taskValues('unsent', 'p1', 'unsent'),
            },
          ]);
      });
      await client.sync();
      expect(outbox).toEqual([1, 1]);
      if (appended === undefined) throw new Error('observer did not append');
      expect(
        client.pendingCommits().map((commit) => commit.clientCommitId),
      ).toEqual([appended]);
    } finally {
      await client.close();
      db.close();
    }
  });

  test('successful acknowledgement runs roll back together and stop at later errors', async () => {
    for (const failure of ['journal', 'revision', 'commit', 'later-frame']) {
      const db = new BunClientDatabase();
      const changes: ClientChangeBatch[] = [];
      let ids: string[] = [];
      let first = true;
      let revision = 0n;
      const client = new SyncClient({
        database: db,
        schema: CLIENT_SCHEMA,
        clientId: `run-${failure}`,
        transport: async () => {
          const inject = first;
          first = false;
          if (inject) {
            revision = client.localRevision;
            changes.length = 0;
            if (failure === 'commit') {
              db.exec('PRAGMA foreign_keys = ON');
              db.exec('CREATE TABLE ack_parent(id INTEGER PRIMARY KEY)');
              db.exec(
                'CREATE TABLE ack_child(id INTEGER REFERENCES ack_parent(id) DEFERRABLE INITIALLY DEFERRED)',
              );
            }
            // The second journal insert must fail after the first result was staged.
            if (failure !== 'later-frame')
              db.exec(
                failure === 'journal'
                  ? "CREATE TRIGGER fail_run BEFORE INSERT ON _syncular_commit_outcomes WHEN (SELECT count(*) FROM _syncular_commit_outcomes) = 1 BEGIN SELECT RAISE(FAIL, 'injected second journal failure'); END"
                  : failure === 'revision'
                    ? "CREATE TRIGGER fail_run BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' AND (SELECT count(*) FROM _syncular_commit_outcomes) = 2 BEGIN SELECT RAISE(FAIL, 'injected run revision failure'); END"
                    : 'CREATE TRIGGER fail_run AFTER INSERT ON _syncular_commit_outcomes WHEN (SELECT count(*) FROM _syncular_commit_outcomes) = 2 BEGIN INSERT INTO ack_child VALUES (1); END',
              );
          }
          const frames: ResponseFrame[] = [
            { type: 'RESP_HEADER', logEpoch: 'epoch-1', resetRequired: false },
            ...[ids[0], ids[0], 'unknown', ids[1]].map(
              (id): PushResultFrame => ({
                type: 'PUSH_RESULT',
                clientCommitId: id ?? '',
                status: inject ? 'applied' : 'cached',
                commitSeq: 1,
                results: [{ status: 'applied', opIndex: 0 }],
              }),
            ),
          ];
          if (inject && failure === 'later-frame')
            frames.push({
              type: 'ERROR',
              code: 'sync.invalid_request',
              message: 'later error',
              category: 'protocol',
              retryable: false,
              recommendedAction: 'retry',
            });
          return encodeMessage({ wireVersion: 2, msgKind: 'response', frames });
        },
      });
      try {
        await client.start();
        db.exec(
          "INSERT OR REPLACE INTO _syncular_meta(key, value) VALUES ('logEpoch', 'epoch-1')",
        );
        client.onChange((change) => changes.push(change));
        ids = ['first', 'second', 'later'].map((id) =>
          client.mutate([
            { table: 'tasks', op: 'upsert', values: taskValues(id, 'p1', id) },
          ]),
        );
        const rows = client.query('SELECT * FROM tasks ORDER BY id');
        await expect(client.sync()).rejects.toMatchObject({
          code:
            failure === 'later-frame'
              ? 'sync.invalid_request'
              : 'client.outcome_persistence_failed',
        });
        const outcomes = changes.filter((change) => change.outcomesChanged);
        if (failure === 'later-frame') {
          expect(
            client.pendingCommits().map((commit) => commit.clientCommitId),
          ).toEqual(ids.slice(2));
          expect(outcomes).toHaveLength(1);
          expect(outcomes[0]?.status?.outbox).toBe(1);
          expect(outcomes[0]?.revision).toBe(revision + 1n);
          expect(client.commitOutcomes()).toHaveLength(2);
        } else {
          expect(
            client.pendingCommits().map((commit) => commit.clientCommitId),
          ).toEqual(ids);
          expect(client.commitOutcomes()).toEqual([]);
          expect(outcomes).toEqual([]);
          expect(client.localRevision).toBe(revision + 1n); // Response-finally row replay only.
          expect(client.query('SELECT * FROM tasks ORDER BY id')).toEqual(rows);
          db.exec('DROP TRIGGER fail_run');
        }
        changes.length = 0;
        const retry = await client.sync();
        expect(retry.applied).toEqual(
          failure === 'later-frame' ? [] : ids.slice(0, 2),
        );
        expect(
          client.pendingCommits().map((commit) => commit.clientCommitId),
        ).toEqual(ids.slice(2));
        expect(changes.filter((change) => change.outcomesChanged)).toHaveLength(
          failure === 'later-frame' ? 0 : 1,
        );
        expect(client.commitOutcomes()).toHaveLength(2);
      } finally {
        await client.close();
        db.close();
      }
    }
  });

  test('failed acknowledgement preserves outcomes, callbacks, and original retry IDs', async () => {
    for (const failure of ['journal', 'revision', 'commit']) {
      for (const status of [
        'applied',
        'cached',
        'rejected',
        'conflict',
      ] as const) {
        const db = new BunClientDatabase();
        const changes: ClientChangeBatch[] = [];
        const callbacks: Array<{
          id: string;
          outbox: number;
          durable: boolean;
        }> = [];
        let inject = true;
        let revision = 0n;
        let id = '';
        const frame: PushResultFrame = {
          type: 'PUSH_RESULT',
          clientCommitId: '',
          status: status === 'conflict' ? 'rejected' : status,
          ...(status === 'applied' || status === 'cached'
            ? { commitSeq: 1 }
            : {}),
          results:
            status === 'conflict'
              ? [
                  {
                    status: 'conflict',
                    opIndex: 0,
                    code: 'sync.version_conflict',
                    message: 'conflict',
                    serverVersion: 1,
                    serverRow: encodeRow(TASK_COLUMNS, [
                      'first',
                      'p1',
                      'server',
                      false,
                      null,
                      null,
                    ]),
                  },
                ]
              : status === 'rejected'
                ? [
                    {
                      status: 'error',
                      opIndex: 0,
                      code: 'sync.validation_failed',
                      message: 'rejected',
                      retryable: false,
                    },
                  ]
                : [{ status: 'applied', opIndex: 0 }],
        };
        const client = new SyncClient({
          database: db,
          schema: CLIENT_SCHEMA,
          clientId: `ack-${failure}-${status}`,
          transport: async () => {
            if (inject) {
              inject = false;
              revision = client.localRevision;
              changes.length = 0;
              if (failure === 'commit') {
                db.exec('PRAGMA foreign_keys = ON');
                db.exec('CREATE TABLE ack_parent(id INTEGER PRIMARY KEY)');
                db.exec(
                  'CREATE TABLE ack_child(id INTEGER REFERENCES ack_parent(id) DEFERRABLE INITIALLY DEFERRED)',
                );
              }
              db.exec(
                failure === 'journal'
                  ? "CREATE TRIGGER fail_ack BEFORE INSERT ON _syncular_commit_outcomes BEGIN SELECT RAISE(FAIL, 'injected journal failure'); END"
                  : failure === 'revision'
                    ? "CREATE TRIGGER fail_ack BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' AND EXISTS(SELECT 1 FROM _syncular_commit_outcomes) BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END"
                    : 'CREATE TRIGGER fail_ack AFTER INSERT ON _syncular_commit_outcomes BEGIN INSERT INTO ack_child VALUES (1); END',
              );
            }
            return encodeMessage({
              wireVersion: 2,
              msgKind: 'response',
              frames: [
                {
                  type: 'RESP_HEADER',
                  logEpoch: 'epoch-1',
                  resetRequired: false,
                },
                { ...frame, clientCommitId: id },
              ],
            });
          },
          onConflict: (conflict) => {
            callbacks.push({
              id: conflict.clientCommitId,
              outbox: client.statusSnapshot().outbox,
              durable:
                !db.db.inTransaction &&
                client.commitOutcome(conflict.clientCommitId) !== undefined,
            });
            throw new Error('injected callback failure');
          },
        });
        try {
          await client.start();
          db.exec(
            "INSERT OR REPLACE INTO _syncular_meta(key, value) VALUES ('logEpoch', 'epoch-1')",
          );
          client.onChange((change) => changes.push(change));
          id = client.mutate([
            {
              table: 'tasks',
              op: 'upsert',
              values: taskValues('first', 'p1', 'first'),
            },
          ]);
          const later = client.mutate([
            {
              table: 'tasks',
              op: 'upsert',
              values: taskValues('later', 'p1', 'later'),
            },
          ]);
          const rows = client.query('SELECT * FROM tasks ORDER BY id');
          await expect(client.sync()).rejects.toMatchObject({
            code: 'client.outcome_persistence_failed',
          });
          expect(
            client.pendingCommits().map((commit) => commit.clientCommitId),
          ).toEqual([id, later]);
          expect(client.localRevision).toBe(revision + 1n);
          expect(client.commitOutcome(id)).toBeUndefined();
          expect(client.conflicts()).toEqual([]);
          expect(client.rejections()).toEqual([]);
          expect(callbacks).toEqual([]);
          expect(changes).toHaveLength(1);
          expect(changes[0]?.outcomesChanged).toBe(false);
          expect(changes[0]?.status).toBeUndefined();
          expect(client.query('SELECT * FROM tasks ORDER BY id')).toEqual(rows);
          db.exec('DROP TRIGGER fail_ack');
          if (status === 'conflict') {
            await expect(client.sync()).rejects.toThrow(
              'injected callback failure',
            );
          } else {
            await client.sync();
          }
          expect(
            client.pendingCommits().map((commit) => commit.clientCommitId),
          ).toEqual([later]);
          expect(client.commitOutcome(id)?.status).toBe(status);
          expect(
            changes.filter((change) => change.outcomesChanged),
          ).toHaveLength(1);
          expect(callbacks).toEqual(
            status === 'conflict' ? [{ id, outbox: 1, durable: true }] : [],
          );
        } finally {
          await client.close();
          db.close();
        }
      }
    }
  });

  test('failed outbox or revision writes roll back the entire local append', async () => {
    for (const failure of ['outbox', 'revision']) {
      const { client, db } = await makeClient(makeServer(), {
        clientId: `failed-${failure}`,
      });
      try {
        const changes: ClientChangeBatch[] = [];
        client.onChange((change) => changes.push(change));
        const initialRevision = client.localRevision;
        db.exec(
          failure === 'outbox'
            ? "CREATE TRIGGER fail_append BEFORE INSERT ON _syncular_outbox BEGIN SELECT RAISE(FAIL, 'injected outbox failure'); END"
            : "CREATE TRIGGER fail_append BEFORE INSERT ON _syncular_meta WHEN NEW.key = 'localRevision' BEGIN SELECT RAISE(FAIL, 'injected revision failure'); END",
        );
        const mutations = [
          {
            table: 'tasks',
            op: 'upsert' as const,
            values: taskValues('t1', 'p1', 'one'),
          },
        ];
        expect(() => client.mutate(mutations)).toThrow();
        expect(client.localRevision).toBe(initialRevision);
        expect(client.statusSnapshot().outbox).toBe(0);
        expect(client.query('SELECT * FROM tasks')).toEqual([]);
        expect(
          db.query('SELECT * FROM _syncular_outbox_before_images'),
        ).toEqual([]);
        expect(changes).toEqual([]);
        db.exec('DROP TRIGGER fail_append');
        client.mutate(mutations);
        expect(client.statusSnapshot().outbox).toBe(1);
        expect(client.query('SELECT * FROM tasks')).toHaveLength(1);
      } finally {
        await client.close();
        db.close();
      }
    }
  });

  test('mutation revision is atomic with rows/status and scope moves include before + after', async () => {
    const client = await makeClient(makeServer(), { clientId: 'observer' });
    const batches: ClientChangeBatch[] = [];
    client.client.onChange((batch) => batches.push(batch));

    client.client.mutate([
      {
        table: 'tasks',
        op: 'upsert',
        values: taskValues('t1', 'p1', 'one'),
      },
    ]);
    const first = client.client.querySnapshot({
      sql: 'SELECT * FROM tasks WHERE id = ?',
      params: ['t1'],
    });
    expect(first.revision).toBe(1n);
    expect(first.rows).toHaveLength(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.revision).toBe(first.revision);
    expect(batches[0]?.status?.outbox).toBe(1);
    expect([...(batches[0]?.tables[0]?.scopeKeys ?? [])]).toEqual([
      'project:p1',
    ]);

    client.client.patch('tasks', 't1', { project_id: 'p2' });
    const moved = batches.at(-1);
    expect(moved?.revision).toBe(2n);
    expect(new Set(moved?.tables[0]?.scopeKeys)).toEqual(
      new Set(['project:p1', 'project:p2']),
    );
  });

  test('window registration and zero-row completion are window-only changes', async () => {
    const client = await makeClient(makeServer(), { clientId: 'windowed' });
    const batches: ClientChangeBatch[] = [];
    client.client.onChange((batch) => batches.push(batch));

    const command = await client.client.setWindowCommand(BASE, ['empty']);
    expect(command.effects.sync).toEqual({ kind: 'interactive' });
    const pending = client.client.querySnapshot({
      sql: 'SELECT * FROM tasks WHERE project_id = ?',
      params: ['empty'],
      coverage: [{ base: BASE, units: ['empty'] }],
    });
    expect(pending.coverage.complete).toBe(false);
    expect(pending.coverage.pending).toHaveLength(1);
    expect(batches.at(-1)?.tables).toEqual([]);
    expect(batches.at(-1)?.windows[0]?.units.has('empty')).toBe(true);

    batches.length = 0;
    await client.client.syncUntilIdle();
    const ready = client.client.querySnapshot({
      sql: 'SELECT * FROM tasks WHERE project_id = ?',
      params: ['empty'],
      coverage: [{ base: BASE, units: ['empty'] }],
    });
    expect(ready.coverage.complete).toBe(true);
    expect(ready.rows).toEqual([]);
    expect(batches.some((batch) => batch.tables.length > 0)).toBe(false);
    expect(
      batches.some((batch) =>
        batch.windows.some((window) => window.units.has('empty')),
      ),
    ).toBe(true);
  });

  test('aggregate coverage stays incomplete until every table window is complete', async () => {
    const client = await makeClient(makeServer(), {
      clientId: 'aggregate-windowed',
    });
    await client.client.setWindowCommand(BASE, ['p1']);
    await client.client.syncUntilIdle();
    await client.client.setWindowCommand(DOC_BASE, ['p1']);

    const spec = {
      sql: 'SELECT * FROM tasks WHERE project_id = ?',
      params: ['p1'],
      coverage: [
        { base: BASE, units: ['p1'] },
        { base: DOC_BASE, units: ['p1'] },
      ],
    } as const;
    const partial = client.client.querySnapshot(spec);
    expect(partial.coverage.complete).toBe(false);
    expect(partial.coverage.pending).toEqual([
      { baseKey: 'docs\0projectId\0{"org_id":["o1"]}', unit: 'p1' },
    ]);
    expect(partial.coverage.missing).toEqual([]);

    await client.client.syncUntilIdle();
    expect(client.client.querySnapshot(spec).coverage).toEqual({
      complete: true,
      pending: [],
      missing: [],
    });

    await client.client.setWindowCommand(DOC_BASE, []);
    const missing = client.client.querySnapshot(spec).coverage;
    expect(missing.complete).toBe(false);
    expect(missing.pending).toEqual([]);
    expect(missing.missing).toEqual([
      { baseKey: 'docs\0projectId\0{"org_id":["o1"]}', unit: 'p1' },
    ]);
  });

  test('persisted identity cannot be silently rebound', async () => {
    const db = new BunClientDatabase();
    const transport = async () => new Uint8Array();
    const first = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      transport,
      clientId: 'device-a',
    });
    await first.start();
    await first.close();

    const rebound = new SyncClient({
      database: db,
      schema: CLIENT_SCHEMA,
      transport,
      clientId: 'device-b',
    });
    await expect(rebound.start()).rejects.toMatchObject({
      code: 'client.identity_mismatch',
    });
    db.close();
  });

  test('retryable transport failures produce explicit exponential background deadlines', async () => {
    const client = await makeClient(makeServer(), { clientId: 'retrying' });
    client.faults.dropResponseOnce = true;
    await expect(client.client.sync()).rejects.toThrow(
      'simulated response loss',
    );
    expect(client.intents).toEqual([{ kind: 'background', delayMs: 250 }]);

    client.faults.dropResponseOnce = true;
    await expect(client.client.sync()).rejects.toThrow(
      'simulated response loss',
    );
    expect(client.intents.at(-1)).toEqual({
      kind: 'background',
      delayMs: 500,
    });

    await client.client.sync();
    client.faults.dropResponseOnce = true;
    await expect(client.client.sync()).rejects.toThrow(
      'simulated response loss',
    );
    expect(client.intents.at(-1)).toEqual({
      kind: 'background',
      delayMs: 250,
    });
  });
});
