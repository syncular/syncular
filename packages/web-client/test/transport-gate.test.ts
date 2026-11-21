import { expect, test } from 'bun:test';
import { decodeMessage } from '@syncular/core';
import { makeClient, makeServer, tableRows, taskValues } from './helpers';

const pushFrames = (requests: readonly Uint8Array[]) =>
  requests.flatMap((bytes) => {
    const message = decodeMessage(bytes);
    return message.msgKind === 'request'
      ? message.frames.filter((frame) => frame.type === 'PUSH_COMMIT')
      : [];
  });

test('a pull gate pulls, sends no commit and owes no push; open pushes it (§8.8)', async () => {
  const server = makeServer();
  const writer = await makeClient(server, { clientId: 'gate-writer' });
  const reader = await makeClient(server, { clientId: 'gate-reader' });
  try {
    writer.client.subscribe({ project_id: 'p1' });
    reader.client.subscribe({ project_id: 'p1' });
    await reader.client.syncUntilIdle();

    reader.client.setTransportGate('pull');
    expect(reader.client.transportGate()).toBe('pull');
    reader.intents.length = 0;
    const queued = reader.client.mutateCommand([
      { table: 'tasks', op: 'upsert', values: taskValues('t2', 'p1', 'held') },
    ]);
    expect(queued.effects.sync).toEqual({ kind: 'none' });
    writer.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'peer') },
    ]);
    await writer.client.syncUntilIdle();

    reader.requests.length = 0;
    const pulled = await reader.client.syncUntilIdle();
    expect(pulled.pushed).toBe(0);
    expect(pushFrames(reader.requests)).toEqual([]);
    expect(reader.client.pendingCommits().map((c) => c.clientCommitId)).toEqual(
      [queued.value],
    );
    expect(
      tableRows(reader.db, 'tasks')
        .map((row) => row['id'])
        .sort(),
    ).toEqual(['t1', 't2']);
    await writer.client.syncUntilIdle();
    expect(tableRows(writer.db, 'tasks').map((row) => row['id'])).toEqual([
      't1',
    ]);

    // Leaving `pull` for `open` wakes; the round pushes the held commit.
    reader.intents.length = 0;
    reader.client.setTransportGate('open');
    expect(reader.intents).toEqual([{ kind: 'interactive' }]);
    await reader.client.syncUntilIdle();
    expect(reader.client.pendingCommits()).toEqual([]);
    await writer.client.syncUntilIdle();
    expect(
      tableRows(writer.db, 'tasks')
        .map((row) => row['id'])
        .sort(),
    ).toEqual(['t1', 't2']);

    // open → pull owes nothing; closed → pull owes one pull.
    reader.intents.length = 0;
    reader.client.setTransportGate('pull');
    expect(reader.intents).toEqual([{ kind: 'none' }]);
    reader.client.setTransportGate('closed');
    reader.intents.length = 0;
    reader.client.setTransportGate('pull');
    expect(reader.intents).toEqual([{ kind: 'interactive' }]);
    reader.intents.length = 0;
    reader.client.setTransportGate('pull');
    expect(reader.intents).toEqual([]);
  } finally {
    await writer.client.close();
    await reader.client.close();
    writer.db.close();
    reader.db.close();
    server.storage.db.close();
  }
});
