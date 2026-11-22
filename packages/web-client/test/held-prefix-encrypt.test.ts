/**
 * §5.11/§8.8: the send seam encodes only the commits the transport gate lets
 * a round push. A held commit whose key is not loaded stays pending without
 * an outcome until it is due; a due commit that cannot encode still drops
 * with `client.encrypt_failed`.
 */
import { expect, test } from 'bun:test';
import { decodeMessage } from '@syncular/core';
import type { ClientSchema } from '@syncular/client';
import type { ServerSchema } from '@syncular/server';
import { defineOutboxControl } from '../src/outbox-control';
import { makeClient, makeServer, outcomeOf } from './helpers';

const TABLE = {
  name: 'notes',
  columns: [
    { name: 'id', type: 'string', nullable: false },
    { name: 'room_id', type: 'string', nullable: false },
    { name: 'key_id', type: 'string', nullable: true },
    {
      name: 'body',
      type: 'bytes',
      nullable: true,
      encrypted: true,
      declaredType: 'string',
    },
  ],
  primaryKey: 'id',
  scopes: ['room:{room_id}'],
} as const;
const SERVER_SCHEMA: ServerSchema = { version: 1, tables: [TABLE] };
const CLIENT_SCHEMA: ClientSchema = { version: 1, tables: [TABLE] };
const key = (name: string) => new Uint8Array(32).fill(name.charCodeAt(0));

test('a held commit whose key is not loaded stays pending until it is due (§8.8)', async () => {
  const server = makeServer(SERVER_SCHEMA);
  server.allowed['actor-1'] = { room_id: ['room'] };
  const a = await makeClient(server, {
    clientId: 'held-prefix',
    schema: CLIENT_SCHEMA,
    encryption: { keys: { A: key('A') }, keyIdColumns: { notes: 'key_id' } },
    outboxControl: defineOutboxControl(),
  });
  const pushed = () =>
    a.requests.flatMap((bytes) =>
      decodeMessage(bytes).frames.flatMap((frame) =>
        frame.type === 'PUSH_COMMIT' ? [frame.clientCommitId] : [],
      ),
    );
  const queue = (id: string, keyId: string) =>
    a.client.mutate([
      {
        table: 'notes',
        op: 'upsert',
        values: { id, room_id: 'room', key_id: keyId, body: 'note' },
      },
    ]);
  try {
    a.client.subscribe({ room_id: 'room' });
    a.client.setTransportGate('pull');
    await a.client.syncUntilIdle();
    const ordinary = queue('ordinary', 'A');
    const foreign = queue('foreign', 'B');
    // A pull round pushes nothing and leaves both commits untouched.
    await a.client.syncUntilIdle();
    expect(a.client.pendingCommits().map((c) => c.clientCommitId)).toEqual([
      ordinary,
      foreign,
    ]);
    expect(outcomeOf(a.client.commitDelivery(foreign))).toBeUndefined();
    expect(a.client.rejections()).toEqual([]);
    // A bounded prefix settles without touching the foreign tail.
    a.client.setTransportGate({ through: ordinary });
    await a.client.syncUntilIdle();
    expect(outcomeOf(a.client.commitDelivery(ordinary))?.status).toBe(
      'applied',
    );
    expect(a.client.pendingCommits().map((c) => c.clientCommitId)).toEqual([
      foreign,
    ]);
    expect(outcomeOf(a.client.commitDelivery(foreign))).toBeUndefined();
    expect(pushed()).toEqual([ordinary]);
    // With its key loaded and the gate open, the foreign commit settles once.
    await a.client.addEncryptionKeys({ B: key('B') });
    a.client.setTransportGate('open');
    await a.client.syncUntilIdle();
    expect(outcomeOf(a.client.commitDelivery(foreign))?.status).toBe('applied');
    expect(pushed()).toEqual([ordinary, foreign]);
    expect(a.client.rejections()).toEqual([]);
    // A due commit that cannot encode still drops with client.encrypt_failed.
    const eligible = queue('eligible', 'C');
    await a.client.syncUntilIdle();
    expect(outcomeOf(a.client.commitDelivery(eligible))).toMatchObject({
      status: 'rejected',
      results: [
        { status: 'error', rejection: { code: 'client.encrypt_failed' } },
      ],
    });
    expect(pushed()).toEqual([ordinary, foreign]);
  } finally {
    await a.client.close();
  }
});
