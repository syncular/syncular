/**
 * The kit's own suite: proves the app-facing surface does what the README
 * promises. Every test drives the SHIPPED `SyncClient` + `@syncular/server`
 * core through the loopback — a green suite here means an app dev's tests
 * built on this kit are exercising real sync, not a mock.
 */
import { describe, expect, test } from 'bun:test';
import type { ClientSchema } from '@syncular/client';
import { ValidationRejection } from '@syncular/server';
import { createTestSync, TransportFault } from '../src/index';

/** A minimal one-table app schema: notes scoped by list. */
const SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'notes',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['list:{list_id}'],
    },
  ],
};

function note(
  id: string,
  listId: string,
  body: string,
): Record<string, unknown> {
  return { id, list_id: listId, body };
}

const SUB = { id: 's', table: 'notes', scopes: { list_id: ['welcome'] } };

describe('createTestSync — convergence', () => {
  test('two clients converge through the in-memory server', async () => {
    const sync = await createTestSync({ schema: SCHEMA });
    try {
      const a = await sync.client('a');
      const b = await sync.client('b');
      a.api.subscribe(SUB);
      b.api.subscribe(SUB);

      a.api.mutate([
        { table: 'notes', op: 'upsert', values: note('n1', 'welcome', 'hi') },
      ]);
      await sync.syncAll();

      const rows = b.api.query('SELECT id, body FROM notes ORDER BY id');
      expect(rows).toEqual([{ id: 'n1', body: 'hi' }]);
    } finally {
      await sync.dispose();
    }
  });

  test('client() auto-ids when no id is given', async () => {
    const sync = await createTestSync({ schema: SCHEMA });
    try {
      const a = await sync.client();
      const b = await sync.client();
      expect(a.id).not.toBe(b.id);
      expect(sync.clients).toHaveLength(2);
    } finally {
      await sync.dispose();
    }
  });
});

describe('createTestSync — offline queue / drain', () => {
  test('an offline client queues mutations, then drains on reconnect', async () => {
    const sync = await createTestSync({ schema: SCHEMA });
    try {
      const a = await sync.client('a');
      const b = await sync.client('b');
      a.api.subscribe(SUB);
      b.api.subscribe(SUB);
      await sync.syncAll();

      a.goOffline();
      a.api.mutate([
        {
          table: 'notes',
          op: 'upsert',
          values: note('n1', 'welcome', 'offline'),
        },
      ]);

      // Optimistically visible locally, but the push cannot leave.
      expect(a.api.query('SELECT body FROM notes')).toEqual([
        { body: 'offline' },
      ]);
      expect(a.api.pendingCommits()).toHaveLength(1);
      await expect(a.api.sync()).rejects.toThrow();

      // B has not seen it — nothing left A.
      await b.sync();
      expect(b.api.query('SELECT id FROM notes')).toHaveLength(0);

      // Back online: the queue drains and B converges.
      a.goOnline();
      await sync.syncAll();
      expect(a.api.pendingCommits()).toHaveLength(0);
      expect(b.api.query('SELECT id, body FROM notes')).toEqual([
        { id: 'n1', body: 'offline' },
      ]);
    } finally {
      await sync.dispose();
    }
  });
});

describe('createTestSync — fault injection', () => {
  test('a dropped request rejects the sync and keeps the outbox intact', async () => {
    const sync = await createTestSync({ schema: SCHEMA });
    try {
      const a = await sync.client('a');
      a.api.subscribe(SUB);
      await a.sync();

      a.api.mutate([
        { table: 'notes', op: 'upsert', values: note('n1', 'welcome', 'x') },
      ]);
      a.faults.dropNextRequests = 1;
      await expect(a.api.sync()).rejects.toThrow(TransportFault);
      // The commit survives the lost request — retried on the next round.
      expect(a.api.pendingCommits()).toHaveLength(1);

      await a.sync();
      expect(a.api.pendingCommits()).toHaveLength(0);
    } finally {
      await sync.dispose();
    }
  });

  test('a duplicated request is absorbed by the idempotency cache (converges once)', async () => {
    const sync = await createTestSync({ schema: SCHEMA });
    try {
      const a = await sync.client('a');
      const b = await sync.client('b');
      a.api.subscribe(SUB);
      b.api.subscribe(SUB);
      await sync.syncAll();

      a.api.mutate([
        { table: 'notes', op: 'upsert', values: note('n1', 'welcome', 'once') },
      ]);
      a.faults.duplicateNextRequest = true;
      await sync.syncAll();

      // Exactly one row despite the double delivery.
      expect(b.api.query('SELECT id FROM notes')).toHaveLength(1);
    } finally {
      await sync.dispose();
    }
  });

  test('a corrupted byte-stream flips the content address (corrupt helper)', async () => {
    const sync = await createTestSync({ schema: SCHEMA });
    try {
      const a = await sync.client('a');
      const original = new Uint8Array([1, 2, 3, 4, 5]);
      const corrupted = a.faults.corrupt(original);
      expect(corrupted).toHaveLength(original.length);
      expect([...corrupted]).not.toEqual([...original]);
    } finally {
      await sync.dispose();
    }
  });
});

describe('createTestSync — virtual clock', () => {
  test('server and every client read the shared clock', async () => {
    const sync = await createTestSync({ schema: SCHEMA, startMs: 1_000 });
    try {
      const a = await sync.client('a');
      expect(sync.clock.now()).toBe(1_000);

      sync.clock.advance(5_000);
      expect(sync.clock.now()).toBe(6_000);

      // The client's own clock seam moved with it — a mutate stamps at 6_000
      // (the client's `now` is the shared clock).
      a.api.subscribe(SUB);
      await a.sync();
      expect(sync.clock.now()).toBe(6_000);

      sync.clock.set(10_000);
      expect(sync.clock.now()).toBe(10_000);
      expect(() => sync.clock.advance(-1)).toThrow();
    } finally {
      await sync.dispose();
    }
  });
});

describe('createTestSync — realtime deltas', () => {
  test('a connected client receives a delta without an explicit pull', async () => {
    const sync = await createTestSync({ schema: SCHEMA });
    try {
      const a = await sync.client('a');
      const b = await sync.client('b');
      a.api.subscribe(SUB);
      b.api.subscribe(SUB);
      await sync.syncAll();

      // B goes live; A writes and pushes. The hub fans the commit to B.
      await b.connectRealtime();
      a.api.mutate([
        { table: 'notes', op: 'upsert', values: note('n1', 'welcome', 'live') },
      ]);
      await a.sync();

      // Give the delta a microtask turn to apply, then assert.
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(b.api.query('SELECT id, body FROM notes ORDER BY id')).toEqual([
        { id: 'n1', body: 'live' },
      ]);
    } finally {
      await sync.dispose();
    }
  });
});

describe('createTestSync — write validation', () => {
  test('validators and structured recovery details also apply to socket sync rounds', async () => {
    const sync = await createTestSync({
      schema: SCHEMA,
      validators: {
        notes: ({ row }) => {
          if (row?.body === 'blocked') {
            throw new ValidationRejection(
              'app.body_blocked',
              'diagnostic only',
              {
                fieldPaths: ['body'],
                reason: 'reserved_term',
                requiredAction: 'edit_fields',
              },
            );
          }
        },
      },
    });
    try {
      const a = await sync.client('a');
      a.api.subscribe(SUB);
      await a.sync();
      a.api.mutate([
        {
          table: 'notes',
          op: 'upsert',
          values: note('n1', 'welcome', 'allowed'),
        },
      ]);
      await a.sync();
      await a.connectRealtime();

      a.api.patch('notes', 'n1', {
        body: 'blocked',
      });
      await a.sync();

      expect(a.api.rejections).toHaveLength(1);
      expect(a.api.rejections[0]?.details).toEqual({
        fieldPaths: ['body'],
        reason: 'reserved_term',
        requiredAction: 'edit_fields',
      });
      expect(a.api.rejections[0]?.operation?.changedFields).toEqual(['body']);
    } finally {
      await sync.dispose();
    }
  });
});

describe('createTestSync — scopes', () => {
  test('a custom resolveScopes revokes an out-of-scope subscription', async () => {
    const sync = await createTestSync({
      schema: SCHEMA,
      resolveScopes: () => ({ list_id: ['welcome'] }),
    });
    try {
      const a = await sync.client('a');
      const b = await sync.client('b');
      a.api.subscribe(SUB);
      // B subscribes to BOTH a granted list ('welcome') and one it is not
      // granted ('secret'); the round keeps the first, revokes the second.
      b.api.subscribe(SUB);
      b.api.subscribe({
        id: 'secret',
        table: 'notes',
        scopes: { list_id: ['secret'] },
      });
      await sync.syncAll();

      // Separate commits: A holds 'welcome' but not 'secret', so the second
      // (forbidden) commit is rejected while the first lands (§6.3). One
      // atomic mutate spanning both scopes would be rejected wholesale.
      a.api.mutate([
        { table: 'notes', op: 'upsert', values: note('n1', 'welcome', 'ok') },
      ]);
      a.api.mutate([
        { table: 'notes', op: 'upsert', values: note('n2', 'secret', 'nope') },
      ]);
      await sync.syncAll();

      // B holds only 'welcome' → sees n1 (its granted sub); the 'secret'
      // subscription is revoked, so n2 never reaches B even though A wrote it.
      expect(b.api.query('SELECT id FROM notes ORDER BY id')).toEqual([
        { id: 'n1' },
      ]);
      expect(b.api.subscription('secret')?.status).toBe('revoked');
    } finally {
      await sync.dispose();
    }
  });
});
