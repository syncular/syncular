import { defineAuthorityReads } from '@syncular/client/authority';
import { expect, test } from 'bun:test';
import {
  SyncClient,
  type AuthorityReadDeclaration,
  type ClientSchema,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { saveSubscription } from '../src/state';

const schema: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'authority',
      primaryKey: 'id',
      scopes: ['actor:{actor_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'actor_id', type: 'string', nullable: false },
        { name: 'role', type: 'string', nullable: false },
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
const read: AuthorityReadDeclaration = {
  table: 'authority',
  columns: ['id', 'actor_id', 'role'],
  scopes: { actor_id: ['a', 'b'] },
};
const create = (db: BunClientDatabase, declarations = [read]) =>
  new SyncClient({
    database: db,
    schema,
    securityPreflight: true,
    transportEnabled: false,
    authorityReads: defineAuthorityReads(declarations),
    transport: async () => {
      throw new Error('authority reads must never transport');
    },
  });

test('authority declarations reject encrypted, clinical, internal, SQL and malformed reads with typed errors', async () => {
  const db = new BunClientDatabase(':memory:');
  try {
    for (const candidate of [
      { ...read, table: 'clinical' },
      { ...read, table: '_syncular_meta' },
      { ...read, columns: ['id', 'actor_id', 'secret'] },
      {
        ...read,
        columns: [
          'id',
          'actor_id',
          'role FROM authority; DELETE FROM authority',
        ],
      },
      { ...read, columns: ['id', 'actor_id', '*'] },
      { ...read, columns: ['id', 'actor_id', '_sync_version'] },
      { ...read, scopes: { actor_id: ['*'] } },
      { ...read, columns: ['id', 'role'] },
      { ...read, scopes: { secret: ['key'] } },
    ]) {
      expect(() => create(db, [candidate])).toThrow(
        expect.objectContaining({ code: 'client.authority_read_forbidden' }),
      );
    }
    const client = create(db);
    await client.start();
    expect(() =>
      Reflect.apply(client.authoritySnapshot, client, [
        { sql: 'SELECT secret FROM authority' },
      ]),
    ).toThrow(
      expect.objectContaining({ code: 'client.authority_read_forbidden' }),
    );
    expect(() => client.query('SELECT id FROM authority')).toThrow(
      expect.objectContaining({ code: 'client.security_preflight_required' }),
    );
    expect(() =>
      client.querySnapshot({ sql: 'SELECT id FROM authority' }),
    ).toThrow(
      expect.objectContaining({ code: 'client.security_preflight_required' }),
    );
    expect(() => client.mutate([])).toThrow(
      expect.objectContaining({ code: 'client.security_preflight_required' }),
    );
    await client.close();
  } finally {
    db.close();
  }
});

test('authority snapshot merges complete persisted scope rectangles, distinguishes empty from absent, freezes policy, and never writes', async () => {
  const db = new BunClientDatabase(':memory:');
  const declaration = structuredClone(read);
  const policy = defineAuthorityReads([declaration]);
  const client = new SyncClient({
    database: db,
    schema,
    authorityReads: policy,
    securityPreflight: true,
    transportEnabled: false,
    transport: async () => {
      throw new Error('unexpected transport');
    },
  });
  Reflect.apply(Array.prototype.push, declaration.columns, ['secret']);
  await client.start();
  try {
    db.exec(
      'INSERT INTO authority(id,actor_id,role,secret,_sync_version)VALUES(?,?,?,?,?)',
      ['one', 'a', 'reader', 'clinical plaintext', 7],
    );
    for (const actor of ['a', 'b'])
      saveSubscription(db, {
        id: actor,
        table: 'authority',
        scopes: { actor_id: [actor] },
        effectiveScopes: { actor_id: [actor] },
        cursor: 7,
        status: 'active',
      });
    const revision = client.localRevision;
    const before = db.query('SELECT total_changes() AS changes');
    const snapshot = client.authoritySnapshot();
    expect(snapshot).toMatchObject({
      complete: true,
      revision,
      tables: [
        {
          rows: [
            {
              values: { id: 'one', actor_id: 'a', role: 'reader' },
              version: 7,
              hasLocalIntent: false,
            },
          ],
          coverage: 'complete',
        },
      ],
    });
    expect(db.query('SELECT total_changes() AS changes')).toEqual(before);
    expect(client.securityLifecycle()).toBe('preflight');
    expect(() =>
      Reflect.apply(
        Array.prototype.push,
        snapshot.tables[0]!.scopes.actor_id!,
        ['outside'],
      ),
    ).toThrow();
    saveSubscription(db, {
      id: 'b',
      table: 'authority',
      scopes: { actor_id: ['b'] },
      effectiveScopes: { actor_id: ['b'] },
      cursor: 7,
      status: 'active',
      bootstrapState: 'credential-must-not-leak',
    });
    const partial = client.authoritySnapshot();
    expect(partial.complete).toBe(false);
    expect(
      JSON.stringify({ ...partial, revision: String(partial.revision) }),
    ).not.toContain('credential-must-not-leak');
    saveSubscription(db, {
      id: 'b',
      table: 'authority',
      scopes: { actor_id: ['b'] },
      effectiveScopes: { actor_id: ['b'] },
      cursor: 7,
      status: 'active',
      params: '{}',
    });
    expect(client.authoritySnapshot().complete).toBe(false);
    db.exec("DELETE FROM _syncular_subscriptions WHERE id='b'");
    expect(client.authoritySnapshot().complete).toBe(false);
    const closing = client.close();
    expect(() => client.authoritySnapshot()).toThrow(
      expect.objectContaining({ code: 'sync.invalid_request' }),
    );
    await closing;
  } finally {
    await client.close();
    db.close();
  }
});

test('SQLite pins revision, authority rows and persisted scope coverage before an interleaved writer commits', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'syncular-authority-snapshot-'));
  class InterleavedDatabase extends BunClientDatabase {
    afterRevision: (() => void) | undefined;
    override query(
      sql: string,
      params: readonly import('@syncular/client').SqlValue[] = [],
    ): import('@syncular/client').SqlRow[] {
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
  const client = create(db, [{ ...read, scopes: { actor_id: ['a'] } }]);
  await client.start();
  const writer = new BunClientDatabase(path);
  const write = (revision: number) =>
    writer.transaction(() => {
      writer.exec(
        'INSERT OR REPLACE INTO authority(id,actor_id,role,_sync_version)VALUES(?,?,?,?)',
        ['one', 'a', String(revision), revision],
      );
      writer.exec(
        "UPDATE _syncular_meta SET value=? WHERE key='localRevision'",
        [String(revision)],
      );
      saveSubscription(writer, {
        id: 'a',
        table: 'authority',
        scopes: { actor_id: ['a'] },
        effectiveScopes: { actor_id: ['a'] },
        cursor: revision,
        status: 'active',
      });
    });
  try {
    write(1);
    db.afterRevision = () => write(2);
    const first = client.authoritySnapshot();
    expect(first.revision).toBe(1n);
    expect(first.tables[0]?.rows[0]?.values.role).toBe('1');
    expect(first.tables[0]?.persisted[0]?.cursor).toBe(1);
    const second = client.authoritySnapshot();
    expect(second.revision).toBe(2n);
    expect(second.tables[0]?.rows[0]?.values.role).toBe('2');
    expect(second.tables[0]?.persisted[0]?.cursor).toBe(2);
    db.exec("DELETE FROM _syncular_meta WHERE key='localRevision'");
    expect(() => client.authoritySnapshot()).toThrow(
      expect.objectContaining({ code: 'sync.local_corrupt' }),
    );
  } finally {
    await client.close();
    writer.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('authority protected ACK and retained failures expose delivered bases before later pending edits', async () => {
  const db = new BunClientDatabase(':memory:');
  const client = create(db, [{ ...read, scopes: { actor_id: ['a'] } }]);
  await client.start();
  try {
    await client.activateSecurity();
    db.exec(
      'INSERT INTO authority(id,actor_id,role,_sync_version)VALUES(?,?,?,?)',
      ['one', 'a', 'delivered', 7],
    );
    client.patch('authority', 'one', { role: 'pending' });
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
    client.patch('authority', 'one', { role: 'later' });
    await client.beginSecurityPreflight();
    expect(client.authoritySnapshot().tables[0]?.rows).toEqual([
      {
        values: { id: 'one', actor_id: 'a', role: 'delivered' },
        version: 7,
        hasLocalIntent: true,
      },
    ]);
    db.exec('UPDATE _syncular_failed_rows SET commit_seq=NULL');
    expect(client.authoritySnapshot().tables[0]?.rows[0]?.values.role).toBe(
      'delivered',
    );
    db.exec('UPDATE _syncular_failed_rows SET version=NULL');
    expect(() => client.authoritySnapshot()).toThrow(
      expect.objectContaining({ code: 'sync.local_corrupt' }),
    );
    db.exec('UPDATE _syncular_failed_rows SET base=?,version=7', [
      'credential-must-not-leak',
    ]);
    try {
      client.authoritySnapshot();
      throw new Error('malformed evidence must fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'sync.local_corrupt' });
      expect(String(error)).not.toContain('credential-must-not-leak');
    }
    db.exec('UPDATE _syncular_failed_rows SET base=NULL,version=NULL');
    expect(client.authoritySnapshot().tables[0]?.rows).toEqual([]);
  } finally {
    await client.close();
    db.close();
  }
});
