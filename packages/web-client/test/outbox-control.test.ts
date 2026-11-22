import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClientSchema,
  SyncClient,
  type SyncClientConfig,
} from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import { defineOutboxControl } from '@syncular/client/outbox-control';
import {
  decodeFenceRequest,
  decodeMessage,
  encodeFenceResponse,
  type FenceAnswer,
  type PushResultFrame,
} from '@syncular/core';
import {
  handleSyncRequest,
  MemorySegmentStore,
  SqliteServerStorage,
} from '@syncular/server';
import { outcomeOf } from './helpers';

const schema: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'notes',
      primaryKey: 'id',
      scopes: ['list:{list_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
    },
  ],
};

const note = (id: string, title: string, body = title) => ({
  table: 'notes',
  op: 'upsert' as const,
  values: { id, list_id: 'one', title, body },
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

/**
 * One client over the real server library. A fence request is answered here
 * as §6.12 specifies: a stored receipt is the server's idempotent replay of
 * the push that carried the commit, otherwise `COMMIT_FENCED`.
 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'syncular-pending-replace-'));
  roots.push(root);
  const path = join(root, 'client.db');
  const storage = new SqliteServerStorage();
  const segments = new MemorySegmentStore();
  const serve = (bytes: Uint8Array) =>
    handleSyncRequest(bytes, {
      partition: 'replace',
      actorId: 'actor',
      schema,
      storage,
      segments,
      resolveScopes: () => ({ list_id: ['one'] }),
    });
  const requests: ('fence' | 'sync')[] = [];
  /** Requests whose push the server stored, by client commit id. */
  const pushed = new Map<string, Uint8Array>();
  const fenced = new Set<string>();
  const faults: {
    /** Runs before a sync request is served. */
    beforeSync?: (bytes: Uint8Array) => void;
    /** Fail the request before the server sees it. */
    dropRequest?: boolean;
    /** Serve the request, then lose the reply. */
    loseReply?: boolean;
    /** Answer a fence with this stored result instead of the replay. */
    receipt?: PushResultFrame;
  } = {};
  let db = new BunClientDatabase(path);
  const open = (overrides: Partial<SyncClientConfig> = {}, replaces = true) =>
    new SyncClient({
      database: db,
      schema,
      clientId: 'replacing',
      ...(replaces ? { outboxControl: defineOutboxControl() } : {}),
      transport: async (bytes) => {
        if (faults.dropRequest) throw new Error('request lost');
        const fence = decodeFenceRequest(bytes);
        let response: Uint8Array;
        if (fence) {
          requests.push('fence');
          const answers: FenceAnswer[] = [];
          for (const id of fence.clientCommitIds) {
            const stored = pushed.get(id);
            if (faults.receipt) {
              answers.push({ type: 'PUSH_RESULT', result: faults.receipt });
            } else if (stored && !fenced.has(id)) {
              const result = decodeMessage(await serve(stored)).frames.find(
                (frame) =>
                  frame.type === 'PUSH_RESULT' && frame.clientCommitId === id,
              );
              if (result?.type !== 'PUSH_RESULT') throw new Error('no replay');
              answers.push({ type: 'PUSH_RESULT', result });
            } else {
              fenced.add(id);
              answers.push({ type: 'COMMIT_FENCED', clientCommitId: id });
            }
          }
          response = encodeFenceResponse(
            {
              type: 'RESP_HEADER',
              logEpoch: fence.header.logEpoch ?? 'unsynced',
              resetRequired: false,
            },
            answers,
          );
        } else {
          requests.push('sync');
          faults.beforeSync?.(bytes);
          const message = decodeMessage(bytes);
          for (const frame of message.frames)
            if (frame.type === 'PUSH_COMMIT') {
              // The server refuses a fenced commit (§6.12).
              if (fenced.has(frame.clientCommitId))
                throw new Error('a fenced commit was pushed');
              pushed.set(frame.clientCommitId, bytes);
            }
          response = await serve(bytes);
        }
        if (faults.loseReply) throw new Error('reply lost');
        return response;
      },
      ...overrides,
    });
  return {
    db: () => db,
    requests,
    faults,
    open,
    storage,
    async reopen(
      client: SyncClient,
      overrides?: Partial<SyncClientConfig>,
      replaces?: boolean,
    ) {
      await client.close();
      db.close();
      db = new BunClientDatabase(path);
      const next = open(overrides, replaces);
      await next.start();
      return next;
    },
    attempted: (id: string) =>
      db.query(
        'SELECT attempted FROM _syncular_outbox WHERE client_commit_id=?',
        [id],
      )[0]?.attempted,
    row: (id: string) =>
      db.query('SELECT title,body FROM notes WHERE id=?', [id])[0],
  };
}

/** A started client holding one pending commit whose reply was lost. */
async function attemptedCommit(s: ReturnType<typeof setup>) {
  const client = s.open();
  await client.start();
  client.subscribe({ list_id: 'one' });
  await client.syncUntilIdle();
  const id = client.mutate([note('n1', 'first')]);
  s.faults.dropRequest = true;
  await expect(client.sync()).rejects.toThrow();
  s.faults.dropRequest = false;
  expect(s.attempted(id)).toBe(1);
  return { client, id };
}

test('a never-attempted commit is replaced without transport', async () => {
  const s = setup();
  const client = s.open({ transportGate: 'closed' });
  await client.start();
  const id = client.mutate([note('n1', 'first')]);
  const later = client.patch('notes', 'n1', { body: 'later' });
  expect(s.attempted(id)).toBe(0);
  const seq = client.pendingCommits()[0]!.seq;
  const changes: unknown[] = [];
  client.onChange((event) => changes.push(event));
  const revision = client.localRevision;

  const replacement = await client.replacePendingCommit(id, [
    note('n1', 'second'),
  ]);

  expect(s.requests).toEqual([]);
  expect(client.localRevision).toBe(revision + 1n);
  expect(changes).toHaveLength(1);
  expect(client.pendingCommits().map((c) => [c.seq, c.clientCommitId])).toEqual(
    [
      [seq, replacement],
      [seq + 1, later],
    ],
  );
  expect(s.attempted(replacement)).toBe(0);
  // The later patch re-derives over the replacement.
  expect(s.row('n1')).toEqual({ title: 'second', body: 'later' });
  expect(outcomeOf(client.commitDelivery(id))).toMatchObject({
    status: 'replaced',
    resolution: 'superseded',
    replacementClientCommitId: replacement,
  });
  expect(client.commitDelivery(replacement).status).toBe('pending');
  // A retry after a lost reply returns the same replacement.
  expect(
    await client.replacePendingCommit(id, [note('n1', 'second')], replacement),
  ).toBe(replacement);
  expect(client.pendingCommits()).toHaveLength(2);
  await client.close();
});

test('an attempted commit is fenced, then replaced and pushed', async () => {
  const s = setup();
  const { client, id } = await attemptedCommit(s);
  s.requests.length = 0;
  const replacement = await client.replacePendingCommit(
    id,
    [note('n1', 'second')],
    'replacement-1',
  );
  expect(replacement).toBe('replacement-1');
  expect(s.requests).toEqual(['fence']);
  expect(s.row('n1')).toEqual({ title: 'second', body: 'second' });
  await client.syncUntilIdle();
  expect(client.pendingCommits()).toEqual([]);
  expect(outcomeOf(client.commitDelivery(replacement))?.status).toBe('applied');
  expect(outcomeOf(client.commitDelivery(id))?.status).toBe('replaced');
  await client.close();
});

test('a fence answered with the receipt acknowledges the original', async () => {
  const s = setup();
  const client = s.open();
  await client.start();
  client.subscribe({ list_id: 'one' });
  await client.syncUntilIdle();
  const id = client.mutate([note('n1', 'first')]);
  // The server applies the push and the reply is lost.
  s.faults.loseReply = true;
  await expect(client.sync()).rejects.toThrow();
  s.faults.loseReply = false;

  const error = await client
    .replacePendingCommit(id, [note('n1', 'second')])
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    code: 'client.commit_settled',
    details: { clientCommitId: id, status: 'applied' },
  });
  expect(client.pendingCommits()).toEqual([]);
  expect(outcomeOf(client.commitDelivery(id))?.status).toBe('cached');
  expect(s.row('n1')).toEqual({ title: 'first', body: 'first' });
  await client.close();
});

test('a stored rejection settles the original as rejected', async () => {
  const s = setup();
  const client = s.open();
  await client.start();
  client.subscribe({ list_id: 'one' });
  await client.syncUntilIdle();
  // A base version the server never issued is refused.
  const id = client.mutate([{ ...note('n1', 'first'), baseVersion: 5 }]);
  s.faults.loseReply = true;
  await expect(client.sync()).rejects.toThrow();
  s.faults.loseReply = false;
  await expect(
    client.replacePendingCommit(id, [note('n1', 'second')]),
  ).rejects.toMatchObject({
    code: 'client.commit_settled',
    details: { clientCommitId: id, status: 'rejected' },
  });
  expect(client.pendingCommits()).toEqual([]);
  expect(['conflict', 'rejected']).toContain(
    outcomeOf(client.commitDelivery(id))!.status,
  );
  expect(s.row('n1')).toBeUndefined();
  await client.close();
});

test('a closed gate refuses the fence with sync.offline', async () => {
  const s = setup();
  const { client, id } = await attemptedCommit(s);
  client.setTransportGate('closed');
  s.requests.length = 0;
  await expect(
    client.replacePendingCommit(id, [note('n1', 'second')]),
  ).rejects.toMatchObject({ code: 'sync.offline' });
  expect(s.requests).toEqual([]);
  expect(client.pendingCommits().map((c) => c.clientCommitId)).toEqual([id]);
  // A `pull` gate admits the fence round (§8.8).
  client.setTransportGate('pull');
  await client.replacePendingCommit(id, [note('n1', 'second')]);
  expect(s.requests).toEqual(['fence']);
  await client.close();
});

test('a crash between fence and replace fences again, then replaces', async () => {
  const s = setup();
  const attempted = await attemptedCommit(s);
  s.faults.loseReply = true;
  await expect(
    attempted.client.replacePendingCommit(
      attempted.id,
      [note('n1', 'second')],
      'replacement-1',
    ),
  ).rejects.toThrow();
  s.faults.loseReply = false;
  const client = await s.reopen(attempted.client);
  expect(client.pendingCommits().map((c) => c.clientCommitId)).toEqual([
    attempted.id,
  ]);
  expect(s.attempted(attempted.id)).toBe(1);
  s.requests.length = 0;
  expect(
    await client.replacePendingCommit(
      attempted.id,
      [note('n1', 'second')],
      'replacement-1',
    ),
  ).toBe('replacement-1');
  expect(s.requests).toEqual(['fence']);
  await client.close();
});

test('base versions stay with the rows the original touched', async () => {
  const s = setup();
  const client = s.open({ transportGate: 'closed' });
  await client.start();
  const id = client.mutate([{ ...note('n1', 'first'), baseVersion: 3 }]);
  await client.replacePendingCommit(id, [
    note('n1', 'second'),
    { ...note('n2', 'other'), baseVersion: 7 },
  ]);
  expect(
    client
      .pendingCommits()[0]!
      .operations.map((operation) => [operation.rowId, operation.baseVersion]),
  ).toEqual([
    ['n1', 3],
    ['n2', 7],
  ]);
  await client.close();
});

test('a row only the replacement writes re-derives later commits', async () => {
  const s = setup();
  const client = s.open();
  await client.start();
  client.subscribe({ list_id: 'one' });
  client.mutate([note('n2', 'server')]);
  await client.syncUntilIdle();
  client.setTransportGate('closed');
  const id = client.mutate([note('n1', 'first')]);
  client.patch('notes', 'n2', { body: 'later' });
  await client.replacePendingCommit(id, [note('n2', 'mine', 'mine')]);
  expect(s.row('n1')).toBeUndefined();
  expect(s.row('n2')).toEqual({ title: 'mine', body: 'later' });
  // Rolling the replacement back restores the server row under the later patch.
  const [replacement] = client.pendingCommits();
  await client.replacePendingCommit(replacement!.clientCommitId, [
    note('n1', 'third'),
  ]);
  expect(s.row('n2')).toEqual({ title: 'server', body: 'later' });
  expect(s.row('n1')).toEqual({ title: 'third', body: 'third' });
  await client.close();
});

test('the marker is committed before the request leaves; a pull sets none', async () => {
  const s = setup();
  const client = s.open({ transportGate: 'pull' });
  await client.start();
  client.subscribe({ list_id: 'one' });
  const id = client.mutate([note('n1', 'first')]);
  const seen: unknown[] = [];
  s.faults.beforeSync = () => seen.push(s.attempted(id));
  await client.syncUntilIdle();
  expect(s.attempted(id)).toBe(0);
  client.setTransportGate('open');
  await client.syncUntilIdle();
  expect(seen[0]).toBe(0);
  expect(seen.at(-1)).toBeUndefined();
  // The pushing request saw its commit marked.
  expect(seen).toContain(1);
  await client.close();
});

test('a client without the entry reads a replaced outcome and refuses the call', async () => {
  const s = setup();
  const writer = s.open({ transportGate: 'closed' });
  await writer.start();
  const id = writer.mutate([note('n1', 'first')]);
  const replacement = await writer.replacePendingCommit(id, [
    note('n1', 'second'),
  ]);
  const reader = await s.reopen(writer, { transportGate: 'closed' }, false);
  expect(outcomeOf(reader.commitDelivery(id))).toMatchObject({
    status: 'replaced',
    replacementClientCommitId: replacement,
  });
  expect(
    reader.commitOutcomes().some((outcome) => outcome.clientCommitId === id),
  ).toBe(true);
  expect(() =>
    reader.replacePendingCommit(replacement, [note('n1', 'third')]),
  ).toThrow(
    expect.objectContaining({
      code: 'client.outbox_control_unconfigured',
    }),
  );
  // §8.8: `through` lives in the same entry.
  expect(() => reader.setTransportGate({ through: replacement })).toThrow(
    expect.objectContaining({ code: 'client.outbox_control_unconfigured' }),
  );
  expect(reader.transportGate()).toBe('closed');
  await reader.close();
});

test('an unknown or acknowledged commit fails with sync.outcome_not_found', async () => {
  const s = setup();
  const client = s.open({ transportGate: 'closed' });
  await client.start();
  await expect(
    client.replacePendingCommit('missing', [note('n1', 'x')]),
  ).rejects.toMatchObject({ code: 'sync.outcome_not_found' });
  await client.close();
});

test('a pre-upgrade replica keeps its journal and counts pending commits attempted', async () => {
  const s = setup();
  const db = s.db();
  db.exec(
    'CREATE TABLE _syncular_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,client_commit_id TEXT NOT NULL UNIQUE,created_at_ms INTEGER NOT NULL,operations TEXT NOT NULL)',
  );
  db.exec(
    "CREATE TABLE _syncular_commit_outcomes(seq INTEGER PRIMARY KEY AUTOINCREMENT,client_commit_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('applied','cached','conflict','rejected')),recorded_at_ms INTEGER NOT NULL,results TEXT NOT NULL,resolution TEXT NOT NULL DEFAULT 'active' CHECK(resolution IN ('active','resolved_keep_server','superseded','dismissed')),resolved_at_ms INTEGER,replacement_client_commit_id TEXT)",
  );
  db.exec('ALTER TABLE _syncular_commit_outcomes ADD COLUMN operations TEXT');
  for (const status of ['applied', 'cached', 'conflict', 'rejected'])
    db.exec(
      "INSERT INTO _syncular_commit_outcomes(client_commit_id,status,recorded_at_ms,results,operations)VALUES(?,?,1,'[]','[]')",
      [status, status],
    );
  for (const id of ['old-1', 'old-2'])
    db.exec(
      'INSERT INTO _syncular_outbox(client_commit_id,created_at_ms,operations)VALUES(?,1,?)',
      [
        id,
        JSON.stringify([
          { ...note(id, id), rowId: id, values: note(id, id).values },
        ]),
      ],
    );
  const client = s.open({ transportGate: 'closed' });
  await client.start();
  expect(
    s
      .db()
      .query(
        'SELECT client_commit_id AS id,status,operations FROM _syncular_commit_outcomes ORDER BY seq',
      ),
  ).toEqual(
    ['applied', 'cached', 'conflict', 'rejected'].map((status) => ({
      id: status,
      status,
      operations: '[]',
    })),
  );
  expect(s.attempted('old-1')).toBe(1);
  expect(s.attempted('old-2')).toBe(1);
  // Attempted, so a closed gate refuses the fence; then `replaced` is admitted.
  await expect(
    client.replacePendingCommit('old-1', [note('old-1', 'new')]),
  ).rejects.toMatchObject({ code: 'sync.offline' });
  const fresh = client.mutate([note('n9', 'fresh')]);
  expect(s.attempted(fresh)).toBe(0);
  const replacement = await client.replacePendingCommit(fresh, [
    note('n9', 'fresher'),
  ]);
  expect(outcomeOf(client.commitDelivery(fresh))).toMatchObject({
    status: 'replaced',
    replacementClientCommitId: replacement,
  });
  await client.close();
});

test('a fence answered with a retryable cache miss keeps the commit pending', async () => {
  const s = setup();
  const { client, id } = await attemptedCommit(s);
  s.faults.receipt = {
    type: 'PUSH_RESULT',
    clientCommitId: id,
    status: 'rejected',
    results: [
      {
        opIndex: 0,
        status: 'error',
        code: 'sync.idempotency_cache_miss',
        message: 'the stored result cannot be served',
        retryable: true,
      },
    ],
  };
  await expect(
    client.replacePendingCommit(id, [note('n1', 'second')]),
  ).rejects.toMatchObject({
    code: 'sync.idempotency_cache_miss',
    retryable: true,
  });
  expect(client.pendingCommits().map((c) => c.clientCommitId)).toEqual([id]);
  expect(client.commitDelivery(id).status).toBe('pending');
  await client.close();
});

test('the held replacement of a pending decision is refused', async () => {
  const s = setup();
  const client = s.open({ transportGate: 'closed' });
  await client.start();
  const held = client.mutate([note('n1', 'held')]);
  // A pending §7.2.2 decision: an active failure naming the replacement.
  s.db().exec(
    "INSERT INTO _syncular_commit_outcomes(client_commit_id,status,recorded_at_ms,results,replacement_client_commit_id)VALUES('failed','rejected',1,'[]',?)",
    [held],
  );
  await expect(
    client.replacePendingCommit(held, [note('n1', 'other')]),
  ).rejects.toMatchObject({ code: 'client.replacement_pending' });
  expect(client.pendingCommits().map((c) => c.clientCommitId)).toEqual([held]);
  await client.close();
});

test('the replaced outcome is recorded on the client clock', async () => {
  const s = setup();
  const client = s.open({ transportGate: 'closed', now: () => 4242 });
  await client.start();
  const id = client.mutate([note('n1', 'first')]);
  await client.replacePendingCommit(id, [note('n1', 'second')]);
  expect(outcomeOf(client.commitDelivery(id))).toMatchObject({
    status: 'replaced',
    recordedAtMs: 4242,
    resolvedAtMs: 4242,
  });
  await client.close();
});

test('a replaced outcome reads as replaced and is pruned as a decided rejection', async () => {
  const s = setup();
  let client = s.open({ limits: { outcomeRetentionMaxEntries: 1 } });
  await client.start();
  client.subscribe({ list_id: 'one' });
  await client.syncUntilIdle();
  client.setTransportGate('closed');
  const id = client.mutate([note('n1', 'first'), note('n2', 'first')]);
  const replacement = await client.replacePendingCommit(id, [
    note('n1', 'second'),
  ]);
  // Stored as a decided rejection, one result per original operation.
  expect(
    s
      .db()
      .query(
        'SELECT status,resolution,replacement_client_commit_id AS r,results FROM _syncular_commit_outcomes WHERE client_commit_id=?',
        [id],
      )
      .map((row) => ({
        status: row.status,
        resolution: row.resolution,
        r: row.r,
        results: JSON.parse(String(row.results)).map(
          (result: { rejection: { code: string; opIndex: number } }) => [
            result.rejection.opIndex,
            result.rejection.code,
          ],
        ),
      })),
  ).toEqual([
    {
      status: 'rejected',
      resolution: 'superseded',
      r: replacement,
      results: [
        [0, 'client.commit_replaced'],
        [1, 'client.commit_replaced'],
      ],
    },
  ]);
  const listed = () =>
    client.commitOutcomes().find((outcome) => outcome.clientCommitId === id);
  expect(listed()?.status).toBe('replaced');
  expect(outcomeOf(client.commitDelivery(id))?.status).toBe('replaced');
  client = await s.reopen(client, {
    transportGate: 'closed',
    limits: { outcomeRetentionMaxEntries: 1 },
  });
  expect(listed()?.status).toBe('replaced');
  expect(client.commitOutcomes({ activeOnly: true })).toEqual([]);
  expect(client.conflicts()).toEqual([]);
  expect(client.rejections()).toEqual([]);
  // The replacement's acknowledgement prunes the journal to one entry.
  client.setTransportGate('open');
  await client.syncUntilIdle();
  expect(client.commitDelivery(id).status).toBe('unknown');
  expect(outcomeOf(client.commitDelivery(replacement))?.status).toBe('applied');
  await client.close();
});

test('a refused payload fails before the fence and changes nothing', async () => {
  const s = setup();
  const { client, id } = await attemptedCommit(s);
  s.requests.length = 0;
  const revision = client.localRevision;
  const error = await client
    .replacePendingCommit(id, [
      { table: 'notes', op: 'patch', values: { id: 'absent', title: 'x' } },
    ])
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'sync.row_missing' });
  expect(s.requests).toEqual([]);
  expect(client.localRevision).toBe(revision);
  expect(client.pendingCommits().map((c) => c.clientCommitId)).toEqual([id]);
  expect(s.row('n1')).toEqual({ title: 'first', body: 'first' });
  await client.close();
});
