/**
 * `ROUND_FAILURE` (SPEC.md §1.5): a client that ends a round without a
 * complete, decodable response keeps that round's code and reports it on
 * every following request until a round completes. The server records the
 * report on the client's record (§4.5), so a client that keeps losing
 * responses stops looking healthy.
 */
import { expect, test } from 'bun:test';
import { decodeMessage, type RequestMessage } from '@syncular/core';
import { makeClient, makeServer, PARTITION, taskValues } from './helpers';

function requestOf(bytes: Uint8Array | undefined): RequestMessage {
  if (bytes === undefined) throw new Error('no request captured');
  const message = decodeMessage(bytes);
  if (message.msgKind !== 'request') throw new Error('expected a request');
  return message;
}

/** The frame type names of one captured request, in wire order. */
function frameTypes(bytes: Uint8Array | undefined): string[] {
  return requestOf(bytes).frames.map((frame) => frame.type);
}

test('a lost response is reported on the next round and forgotten after it completes', async () => {
  const server = makeServer();
  const c = await makeClient(server, { clientId: 'client-rf' });
  await c.client.sync();

  c.faults.dropResponseOnce = true;
  await expect(c.client.sync()).rejects.toThrow();

  // §1.5: the reporting round carries the kept code directly after the
  // header, and the server records it before the round runs.
  await c.client.sync();
  const report = requestOf(c.requests[2]);
  expect(report.frames.map((frame) => frame.type)).toEqual([
    'REQ_HEADER',
    'ROUND_FAILURE',
    'PULL_HEADER',
  ]);
  expect(report.frames[1]).toEqual({
    type: 'ROUND_FAILURE',
    code: 'sync.transport_failed',
  });
  expect(
    await server.storage.getClientRecord(PARTITION, 'client-rf'),
  ).toMatchObject({
    lastErrorCode: 'sync.transport_failed',
    consecutiveFailures: 1,
  });

  // §4.5: the round that carried the report completes without clearing it;
  // the next request without the frame clears it as a completed round does.
  await c.client.sync();
  expect(frameTypes(c.requests[3])).toEqual(['REQ_HEADER', 'PULL_HEADER']);
  const recovered = await server.storage.getClientRecord(
    PARTITION,
    'client-rf',
  );
  expect(recovered?.lastErrorCode).toBeUndefined();
  expect(recovered?.consecutiveFailures).toBeUndefined();
});

test('a newer failure replaces the kept code', async () => {
  const server = makeServer();
  const c = await makeClient(server, { clientId: 'client-rf' });
  await c.client.sync();

  c.faults.dropResponseOnce = true;
  await expect(c.client.sync()).rejects.toThrow();
  // The reporting round now fails to decode; its code replaces the kept one.
  c.faults.truncateResponseOnce = true;
  await expect(c.client.sync()).rejects.toThrow();

  await c.client.sync();
  expect(requestOf(c.requests[3]).frames[1]).toEqual({
    type: 'ROUND_FAILURE',
    code: 'sync.invalid_request',
  });
  // Both reporting rounds counted as failed rounds on the record.
  expect(
    await server.storage.getClientRecord(PARTITION, 'client-rf'),
  ).toMatchObject({
    lastErrorCode: 'sync.invalid_request',
    consecutiveFailures: 2,
  });
});

test('an in-band ERROR round clears the kept code and is never reported', async () => {
  const server = makeServer();
  const c = await makeClient(server, { clientId: 'client-rf' });
  await c.client.sync();

  c.faults.dropResponseOnce = true;
  await expect(c.client.sync()).rejects.toThrow();
  c.faults.errorFrameOnce = true;
  await expect(c.client.sync()).rejects.toMatchObject({
    code: 'sync.rate_limited',
  });
  // The failed round arrived complete, so the client owes no report.
  await c.client.sync();
  expect(frameTypes(c.requests[3])).toEqual(['REQ_HEADER', 'PULL_HEADER']);
});

test('a request-level rejection was recorded by the server and is not reported', async () => {
  const server = makeServer();
  const c = await makeClient(server, { clientId: 'client-rf' });
  await c.client.sync();

  await server.storage.declareCheckpoint(
    PARTITION,
    'tasks-projection',
    server.ctxFor('actor-1').schema.version,
    server.now.ms,
  );
  await expect(c.client.sync()).rejects.toMatchObject({
    code: 'sync.schema_not_ready',
  });
  await expect(c.client.sync()).rejects.toMatchObject({
    code: 'sync.schema_not_ready',
  });
  expect(frameTypes(c.requests[2])).toEqual(['REQ_HEADER', 'PULL_HEADER']);
});

test('a segment fetch that went silent is retryable and reported on the next round', async () => {
  const server = makeServer();
  server.limits.inlineSegmentMaxBytes = 0;
  const seeder = await makeClient(server, { clientId: 'seeder' });
  seeder.client.mutate([
    { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1', 'task') },
  ]);
  await seeder.client.sync();

  const c = await makeClient(server, { clientId: 'client-rf' });
  c.client.subscribe({
    id: 's1',
    table: 'tasks',
    scopes: { project_id: ['p1'] },
  });
  c.intents.length = 0;
  c.faults.stallSegmentDownloadOnce = true;
  await expect(c.client.sync()).rejects.toMatchObject({
    code: 'sync.transport_failed',
    retryable: true,
  });
  expect(c.intents).toEqual([{ kind: 'background', delayMs: 250 }]);

  // The round's own response arrived whole, so only the report tells the
  // server; the next request carries it and a complete round ends it.
  await c.client.sync();
  expect(requestOf(c.requests[1]).frames[1]).toEqual({
    type: 'ROUND_FAILURE',
    code: 'sync.transport_failed',
  });
  expect(
    (await server.storage.getClientRecord(PARTITION, 'client-rf'))
      ?.lastErrorCode,
  ).toBe('sync.transport_failed');
  await c.client.sync();
  expect(frameTypes(c.requests[2])).not.toContain('ROUND_FAILURE');
});
