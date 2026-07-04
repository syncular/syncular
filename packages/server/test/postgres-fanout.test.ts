/**
 * Hermetic unit tests for the LISTEN/NOTIFY fanout primitive: payload
 * encode/parse (round-trip, malformed rejection, adversarial partitions)
 * and the wake wiring against a fake notification connection. The
 * cross-connection Postgres integration is env-gated (SYNCULAR_PG_URL) in
 * `postgres-fanout.integration.test.ts` — pglite cannot exercise it.
 */
import { expect, test } from 'bun:test';
import type { WakeReason } from '@syncular-v2/core';
import {
  encodeFanoutPayload,
  FANOUT_CHANNEL,
  type FanoutWakeTarget,
  type PgNotificationConnection,
  PostgresFanout,
  parseFanoutPayload,
} from '@syncular-v2/server';

test('payload round-trips partition + commitSeq', () => {
  const encoded = encodeFanoutPayload({ partition: 'part-1', commitSeq: 42 });
  expect(parseFanoutPayload(encoded)).toEqual({
    partition: 'part-1',
    commitSeq: 42,
  });
});

test('payload survives a partition containing the separator and unicode', () => {
  const partition = 'tenant:a:b/😀';
  const encoded = encodeFanoutPayload({ partition, commitSeq: 7 });
  // Encoded frame has exactly one ':' separator despite the partition's.
  expect(encoded.split(':').length).toBe(2);
  expect(parseFanoutPayload(encoded)).toEqual({ partition, commitSeq: 7 });
});

test('malformed payloads parse to undefined', () => {
  expect(parseFanoutPayload('')).toBeUndefined();
  expect(parseFanoutPayload('no-separator')).toBeUndefined();
  expect(parseFanoutPayload(':5')).toBeUndefined(); // empty partition
  expect(parseFanoutPayload('cGFydA:notanumber')).toBeUndefined();
  expect(parseFanoutPayload('cGFydA:-1')).toBeUndefined();
  expect(parseFanoutPayload('cGFydA:1.5')).toBeUndefined();
});

test('install wakes the hub on a received notification', async () => {
  const wakes: Array<{ partition: string; reason: WakeReason }> = [];
  const hub: FanoutWakeTarget = {
    wake(partition, reason) {
      wakes.push({ partition, reason });
    },
  };
  let registered: ((payload: string) => void) | undefined;
  const notified: Array<{ channel: string; payload: string }> = [];
  const conn: PgNotificationConnection = {
    listen(channel, handler) {
      expect(channel).toBe(FANOUT_CHANNEL);
      registered = handler;
    },
    async notify(channel, payload) {
      notified.push({ channel, payload });
      // Simulate cross-instance delivery: the DB echoes to every listener.
      registered?.(payload);
    },
  };
  const fanout = new PostgresFanout(conn);
  await fanout.install(hub);

  await fanout.notifyCommit('part-9', 123);
  expect(notified).toEqual([
    {
      channel: FANOUT_CHANNEL,
      payload: encodeFanoutPayload({ partition: 'part-9', commitSeq: 123 }),
    },
  ]);
  expect(wakes).toEqual([{ partition: 'part-9', reason: 'catchup-required' }]);
});

test('a malformed notification is ignored (no wake)', async () => {
  const wakes: string[] = [];
  const hub: FanoutWakeTarget = {
    wake(partition) {
      wakes.push(partition);
    },
  };
  let registered: ((payload: string) => void) | undefined;
  const conn: PgNotificationConnection = {
    listen(_channel, handler) {
      registered = handler;
    },
    async notify() {},
  };
  await new PostgresFanout(conn).install(hub);
  registered?.('garbage-frame');
  expect(wakes).toEqual([]);
});

test('install twice throws', async () => {
  const conn: PgNotificationConnection = {
    listen() {},
    async notify() {},
  };
  const fanout = new PostgresFanout(conn);
  await fanout.install({ wake() {} });
  await expect(fanout.install({ wake() {} })).rejects.toThrow(
    'already installed',
  );
});
