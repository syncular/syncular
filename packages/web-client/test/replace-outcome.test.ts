import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncClient, type ClientSchema } from '@syncular/client';
import { BunClientDatabase } from '@syncular/client/bun';
import {
  handleSyncRequest,
  MemorySegmentStore,
  SqliteServerStorage,
} from '@syncular/server';

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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

/** A server, a peer that writes ahead, and a reader that conflicts. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'syncular-replace-'));
  roots.push(root);
  const storage = new SqliteServerStorage();
  const segments = new MemorySegmentStore();
  // Runs once inside the next request, while its drive is in flight.
  let during: (() => void) | undefined;
  const open = (index: number, database: BunClientDatabase) =>
    new SyncClient({
      database,
      schema,
      clientId: `replace-${index}`,
      retainFailedCommits: true,
      transport: (bytes) => {
        const hook = during;
        during = undefined;
        hook?.();
        return handleSyncRequest(bytes, {
          partition: 'replace',
          actorId: `actor-${index}`,
          schema,
          storage,
          segments,
          resolveScopes: () => ({ list_id: ['one', 'two'] }),
        });
      },
    });
  const peer = open(0, new BunClientDatabase());
  const path = join(root, 'reader.db');
  let readerDb = new BunClientDatabase(path);
  let reader = open(1, readerDb);
  for (const client of [peer, reader]) {
    await client.start();
    client.subscribe({ list_id: 'one' });
  }
  peer.mutate([
    {
      table: 'notes',
      op: 'upsert',
      values: { id: 'n1', list_id: 'one', title: 'first', body: 'first' },
    },
  ]);
  await peer.syncUntilIdle();
  await reader.syncUntilIdle();
  const version = () =>
    Number(
      readerDb.query('SELECT _sync_version AS v FROM notes WHERE id=?', [
        'n1',
      ])[0]!.v,
    );
  const base = version();
  peer.patch('notes', 'n1', { body: 'peer' });
  await peer.syncUntilIdle();
  const id = reader.patch(
    'notes',
    'n1',
    { body: 'mine' },
    { baseVersion: base },
  );
  await reader.syncUntilIdle();
  const outcome = outcomeOf(reader.commitDelivery(id))!;
  expect(outcome.status).toBe('conflict');
  return {
    peer,
    get reader() {
      return reader;
    },
    outcome,
    version,
    during(hook: () => void) {
      during = hook;
    },
    async reopen() {
      await reader.close();
      readerDb.close();
      readerDb = new BunClientDatabase(path);
      reader = open(1, readerDb);
      await reader.start();
    },
  };
}

test('keep mine offline stays pending, then the next drive writes it', async () => {
  const s = await setup();
  s.reader.setTransportEnabled(false);
  const replacement = s.reader.replaceCommitOutcome(s.outcome);
  expect(outcomeOf(s.reader.commitDelivery(s.outcome.clientCommitId))).toMatchObject({
    resolution: 'active',
    replacementClientCommitId: replacement,
  });
  expect(s.reader.pendingCommits()[0]).toMatchObject({
    clientCommitId: replacement,
    operations: [
      {
        op: 'upsert',
        values: { id: 'n1', body: 'mine' },
        baseVersion: s.outcome.retainedRows![0]!.serverVersion,
      },
    ],
  });
  expect(() =>
    s.reader.resolveCommitOutcome({
      clientCommitId: s.outcome.clientCommitId,
      resolution: 'resolved_keep_server',
    }),
  ).toThrow(expect.objectContaining({ code: 'client.replacement_pending' }));
  expect(() => s.reader.replaceCommitOutcome(s.outcome)).toThrow(
    expect.objectContaining({ code: 'client.replacement_pending' }),
  );

  // A later write of the same row queues behind the held replacement.
  s.reader.patch('notes', 'n1', { body: 'later' });
  s.reader.setTransportEnabled(true);
  await s.reader.syncUntilIdle();
  expect(outcomeOf(s.reader.commitDelivery(s.outcome.clientCommitId))).toMatchObject({
    resolution: 'superseded',
    replacementClientCommitId: replacement,
  });
  expect(outcomeOf(s.reader.commitDelivery(replacement))?.status).toBe('applied');
  expect(s.reader.pendingCommits()).toEqual([]);
  expect(s.reader.query('SELECT title,body FROM notes')).toEqual([
    { title: 'first', body: 'later' },
  ]);
  await s.peer.syncUntilIdle();
  expect(s.peer.query('SELECT title,body FROM notes')).toEqual([
    { title: 'first', body: 'later' },
  ]);
});

test('a pending replacement payload survives a restart', async () => {
  const s = await setup();
  s.reader.setTransportEnabled(false);
  const replacement = s.reader.replaceCommitOutcome({
    ...s.outcome,
    replacement: [
      {
        table: 'notes',
        op: 'patch',
        values: { id: 'n1', body: 'edited' },
      },
    ],
  });
  expect(s.reader.query('SELECT body FROM notes')).toEqual([
    { body: 'edited' },
  ]);
  await s.reopen();
  expect(outcomeOf(s.reader.commitDelivery(s.outcome.clientCommitId))).toMatchObject({
    resolution: 'active',
    replacementClientCommitId: replacement,
  });
  expect(s.reader.query('SELECT body FROM notes')).toEqual([
    { body: 'edited' },
  ]);
  await s.reader.syncUntilIdle();
  expect(outcomeOf(s.reader.commitDelivery(replacement))?.status).toBe('applied');
  expect(s.reader.query('SELECT title,body FROM notes')).toEqual([
    { title: 'first', body: 'edited' },
  ]);
});

test('a base that moves before the proof refuses the decision', async () => {
  const s = await setup();
  s.reader.setTransportEnabled(false);
  const replacement = s.reader.replaceCommitOutcome(s.outcome);
  s.peer.patch('notes', 'n1', { title: 'newer' });
  await s.peer.syncUntilIdle();
  s.reader.setTransportEnabled(true);
  await s.reader.syncUntilIdle();
  expect(outcomeOf(s.reader.commitDelivery(s.outcome.clientCommitId))).toMatchObject({
    resolution: 'superseded',
    replacementClientCommitId: replacement,
  });
  const refused = outcomeOf(s.reader.commitDelivery(replacement))!;
  expect(refused).toMatchObject({
    status: 'rejected',
    resolution: 'active',
    results: [
      {
        status: 'error',
        rejection: {
          code: 'sync.replacement_refused',
          retryable: false,
          details: { reason: 'base_moved' },
        },
      },
    ],
  });
  expect(refused.retainedRows?.[0]).toMatchObject({
    localRow: { title: 'newer', body: 'mine' },
    serverRow: { title: 'newer', body: 'peer' },
    serverVersion: s.version(),
  });
  // The payload stays visible; the server keeps the peer's row.
  expect(s.reader.query('SELECT title,body FROM notes')).toEqual([
    { title: 'newer', body: 'mine' },
  ]);
  expect(s.reader.pendingCommits()).toEqual([]);

  // Deciding again against the fresh base writes it.
  const second = s.reader.replaceCommitOutcome(refused);
  await s.reader.syncUntilIdle();
  expect(outcomeOf(s.reader.commitDelivery(second))?.status).toBe('applied');
  await s.peer.syncUntilIdle();
  expect(s.peer.query('SELECT title,body FROM notes')).toEqual([
    { title: 'newer', body: 'mine' },
  ]);
});

test('a payload names no base version for a retained row', async () => {
  const s = await setup();
  expect(() =>
    s.reader.replaceCommitOutcome({
      ...s.outcome,
      replacement: [
        {
          table: 'notes',
          op: 'patch',
          values: { id: 'n1', body: 'x' },
          baseVersion: 1,
        },
      ],
    }),
  ).toThrow(expect.objectContaining({ code: 'sync.invalid_request' }));
  expect(() =>
    s.reader.replaceCommitOutcome({ ...s.outcome, sequence: -1 }),
  ).toThrow(expect.objectContaining({ code: 'sync.invalid_request' }));
  expect(() =>
    s.reader.replaceCommitOutcome({ clientCommitId: 'none', sequence: 1 }),
  ).toThrow(expect.objectContaining({ code: 'sync.outcome_not_found' }));
});

test('a registration change during the drive keeps the decision pending', async () => {
  const s = await setup();
  s.reader.setTransportEnabled(false);
  const replacement = s.reader.replaceCommitOutcome(s.outcome);
  s.reader.setTransportEnabled(true);
  s.during(() => s.reader.subscribe({ list_id: 'two' }));
  await s.reader.syncUntilIdle();
  expect(outcomeOf(s.reader.commitDelivery(s.outcome.clientCommitId))).toMatchObject({
    resolution: 'active',
    replacementClientCommitId: replacement,
  });
  await s.reader.syncUntilIdle();
  expect(outcomeOf(s.reader.commitDelivery(replacement))?.status).toBe('applied');
});
