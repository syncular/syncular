import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SyncClient,
  type ClientSchema,
  type ClientChangeBatch,
  type SqlRow,
  type SqlValue,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { CLIENT_SCHEMA, makeClient, makeServer, taskValues } from './helpers';

class ReplayDatabase extends BunClientDatabase {
  failRead = false;
  override query(sql: string, params: readonly SqlValue[] = []): SqlRow[] {
    if (
      this.failRead &&
      sql.startsWith('SELECT * FROM "tasks" WHERE') &&
      params[0] === 'bad'
    ) {
      // Fail a real SQL read after the first operation has replayed.
      this.db.query('SELECT missing_column FROM tasks').all();
    }
    return super.query(sql, params);
  }
}

for (const failure of [
  'trigger',
  'read',
  'decode',
  'fts',
  'upgrade-read',
  'upgrade-decode',
] as const) {
  test(`reopen replay fails atomically on ${failure} and retains durable intent`, async () => {
    const fault = failure.replace('upgrade-', '');
    const dir = mkdtempSync(join(tmpdir(), 'syncular-overlay-replay-'));
    const path = join(dir, 'replica.sqlite');
    let db = new ReplayDatabase(path);
    const schema: ClientSchema = {
      ...CLIENT_SCHEMA,
      tables: CLIENT_SCHEMA.tables
        .filter((table) => table.name === 'tasks')
        .map((table) => ({
          ...table,
          ftsIndexes: [
            { name: 'tasks_fts', columns: ['title'], tokenize: 'unicode61' },
          ],
        })),
    };
    let held = false;
    const leaderLock = {
      acquire: async () => {
        if (held) throw new Error('leadership was not released');
        held = true;
        return {
          release: () => {
            held = false;
          },
        };
      },
    };
    const config = {
      schema,
      clientId: 'replay',
      leaderLock,
      transport: async (): Promise<Uint8Array> => {
        throw new Error('offline');
      },
    };
    try {
      const first = new SyncClient({ ...config, database: db });
      await first.start();
      const ids = ['early', 'bad'].map((id) =>
        first.mutate([
          { op: 'upsert', table: 'tasks', values: taskValues(id, 'p1', id) },
        ]),
      );
      await first.close();
      if (fault === 'trigger')
        db.exec(
          "CREATE TRIGGER fail_replay BEFORE INSERT ON tasks WHEN new.id='bad' BEGIN SELECT RAISE(ABORT,'replay failed'); END",
        );
      if (fault === 'fts')
        db.exec(
          "CREATE TRIGGER fail_fts BEFORE INSERT ON _syncular_fts_tasks_fts WHEN new.source_id='bad' BEGIN SELECT RAISE(ABORT,'fts failed'); END",
        );
      if (fault === 'decode')
        db.exec(
          "UPDATE _syncular_outbox SET operations=json_set(operations, '$[0].values.done', 'invalid') WHERE client_commit_id=?",
          [ids[1]!],
        );
      const rows = db.query('SELECT * FROM tasks ORDER BY id');
      const fts = db.query(
        'SELECT _syncular_source_id,title FROM tasks_fts ORDER BY _syncular_source_id',
      );
      const outbox = db.query('SELECT * FROM _syncular_outbox ORDER BY seq');
      const marker = db.query(
        "SELECT value FROM _syncular_meta WHERE key='localSchemaVersion'",
      );
      const revision = db.query(
        "SELECT value FROM _syncular_meta WHERE key='localRevision'",
      );
      db.close();
      db = new ReplayDatabase(path);
      db.failRead = fault === 'read';
      const refused = new SyncClient({
        ...config,
        database: db,
        schema: failure.startsWith('upgrade-')
          ? { ...schema, version: schema.version + 1 }
          : schema,
      });
      const changes: ClientChangeBatch[] = [];
      refused.onChange((batch) => changes.push(batch));
      await expect(refused.start()).rejects.toThrow();
      expect(
        changes.every(
          (batch) => batch.tables.length === 0 && !batch.outcomesChanged,
        ),
      ).toBe(true);
      expect(held).toBe(false);
      db.failRead = false;
      expect(db.query('SELECT * FROM tasks ORDER BY id')).toEqual(rows);
      expect(
        db.query(
          'SELECT _syncular_source_id,title FROM tasks_fts ORDER BY _syncular_source_id',
        ),
      ).toEqual(fts);
      expect(db.query('SELECT * FROM _syncular_outbox ORDER BY seq')).toEqual(
        outbox,
      );
      // The startup marker guard, the upgrade-readiness observation, and the
      // reset it precedes are one transaction: a failing reset publishes no
      // revision (and no readiness) at all, for upgrades and same-version
      // replays alike.
      expect(
        db.query("SELECT value FROM _syncular_meta WHERE key='localRevision'"),
      ).toEqual(revision);
      expect(
        db.query(
          "SELECT value FROM _syncular_meta WHERE key='localSchemaVersion'",
        ),
      ).toEqual(marker);
      if (fault === 'trigger') db.exec('DROP TRIGGER fail_replay');
      if (fault === 'fts') db.exec('DROP TRIGGER fail_fts');
      if (fault === 'decode')
        db.exec(
          "UPDATE _syncular_outbox SET operations=json_set(operations, '$[0].values.done', json('false')) WHERE client_commit_id=?",
          [ids[1]!],
        );
      const reopened = new SyncClient({ ...config, database: db });
      await reopened.start();
      expect(
        reopened.pendingCommits().map((commit) => commit.clientCommitId),
      ).toEqual(ids);
      expect(db.query('SELECT * FROM tasks ORDER BY id')).toEqual(rows);
      await reopened.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a bump that removes a table keeps the queued intent for the send-time drop', async () => {
  // §7.4.4: the outbox is schema-agnostic, so an operation for a table the new
  // schema removed has no local mirror to replay into. Pre-fix the reset replay
  // threw sync.unknown_table inside the reset transaction, rolled the marker
  // back, and failed identically on every later open.
  const dir = mkdtempSync(join(tmpdir(), 'syncular-overlay-removed-table-'));
  const path = join(dir, 'replica.sqlite');
  const config = (schema: ClientSchema) => ({
    database: new BunClientDatabase(path),
    clientId: 'removed-table',
    schema,
    transport: async (): Promise<Uint8Array> => {
      throw new Error('offline');
    },
  });
  try {
    const v1 = new SyncClient(config(CLIENT_SCHEMA));
    await v1.start();
    const docs = v1.mutate([
      {
        op: 'upsert',
        table: 'docs',
        values: { id: 'd1', org_id: 'o1', project_id: 'p1', body: 'removed' },
      },
    ]);
    const tasks = v1.mutate([
      { op: 'upsert', table: 'tasks', values: taskValues('t1', 'p1', 'kept') },
    ]);
    await v1.close();

    const v2: ClientSchema = {
      version: 2,
      tables: CLIENT_SCHEMA.tables.filter((table) => table.name !== 'docs'),
    };
    const upgraded = new SyncClient(config(v2));
    await upgraded.start();
    expect(
      upgraded.pendingCommits().map((commit) => commit.clientCommitId),
    ).toEqual([docs, tasks]);
    expect(upgraded.query('SELECT id FROM tasks')).toEqual([{ id: 't1' }]);
    await upgraded.close();

    // The marker advanced, so the next open is an ordinary same-version start.
    const reopened = new SyncClient(config(v2));
    await reopened.start();
    expect(
      reopened.pendingCommits().map((commit) => commit.clientCommitId),
    ).toEqual([docs, tasks]);
    await reopened.close();

    const probe = new BunClientDatabase(path);
    expect(
      probe.query(
        "SELECT value FROM _syncular_meta WHERE key='localSchemaVersion'",
      ),
    ).toEqual([{ value: '2' }]);
    probe.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a retained rejection for a removed table does not wedge the boot reset', async () => {
  // `retainFailedCommits` keeps the failed-intent journal. With the table later
  // removed by a bump, the reset replay must skip those retained rows: pre-fix
  // the base restore threw sync.unknown_table inside the reset transaction and
  // the marker never advanced.
  const dir = mkdtempSync(join(tmpdir(), 'syncular-overlay-retained-removed-'));
  const path = join(dir, 'replica.sqlite');
  const source = makeServer();
  try {
    const first = await makeClient(source, {
      clientId: 'retained-removed',
      database: new BunClientDatabase(path),
      retainFailedCommits: true,
    });
    // The server does not hold docs/d1, so the optimistic baseVersion is
    // rejected (sync.row_missing) and, with retainFailedCommits, the
    // failed-intent rows are retained without a commit sequence, which is what
    // keeps them past the reset's acknowledged-row discard.
    first.client.mutate([
      {
        table: 'docs',
        op: 'upsert',
        values: {
          id: 'd1',
          org_id: 'org-1',
          project_id: 'project-1',
          body: 'retained',
        },
        baseVersion: 1,
      },
    ]);
    await first.client.syncUntilIdle();
    const retained = first.db.query(
      "SELECT count(*) AS n FROM _syncular_failed_rows WHERE tbl='docs' AND commit_seq IS NULL",
    )[0]?.n as number;
    expect(retained).toBeGreaterThan(0);
    await first.client.close();

    const v2: ClientSchema = {
      version: 2,
      tables: CLIENT_SCHEMA.tables.filter((table) => table.name !== 'docs'),
    };
    const upgraded = new SyncClient({
      database: new BunClientDatabase(path),
      clientId: 'retained-removed',
      schema: v2,
      transport: async (): Promise<Uint8Array> => {
        throw new Error('offline');
      },
    });
    await upgraded.start();
    await upgraded.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
