/**
 * Ring buffer semantics (cap, filter, ordering, clear) and sink composition
 * (fan-out + throwing-member isolation) — TODO §2.5.
 */
import { describe, expect, test } from 'bun:test';
import {
  composeEvents,
  RingBufferEvents,
  type SyncularServerEvent,
  type SyncularServerEvents,
} from '@syncular-v2/server';

function pruneEvent(atMs: number, seq: number): SyncularServerEvent {
  return {
    type: 'prune.completed',
    atMs,
    partition: 'p',
    previousHorizonSeq: 0,
    horizonSeq: seq,
    advanced: true,
    removedCommits: seq,
  };
}

function blobEvent(atMs: number): SyncularServerEvent {
  return {
    type: 'blob.uploaded',
    atMs,
    partition: 'p',
    actorId: 'a',
    blobId: 'sha256:x',
    bytes: 10,
  };
}

describe('RingBufferEvents', () => {
  test('retains up to capacity, newest first', () => {
    const ring = new RingBufferEvents({ capacity: 3 });
    ring.emit(pruneEvent(1, 1));
    ring.emit(pruneEvent(2, 2));
    ring.emit(pruneEvent(3, 3));
    expect(ring.size).toBe(3);
    const all = ring.query();
    expect(all.map((e) => e.atMs)).toEqual([3, 2, 1]);
  });

  test('drops the oldest when full (bounded memory)', () => {
    const ring = new RingBufferEvents({ capacity: 2 });
    ring.emit(pruneEvent(1, 1));
    ring.emit(pruneEvent(2, 2));
    ring.emit(pruneEvent(3, 3));
    expect(ring.size).toBe(2);
    expect(ring.query().map((e) => e.atMs)).toEqual([3, 2]);
  });

  test('filters by type', () => {
    const ring = new RingBufferEvents();
    ring.emit(pruneEvent(1, 1));
    ring.emit(blobEvent(2));
    ring.emit(pruneEvent(3, 3));
    const prunes = ring.query({ type: 'prune.completed' });
    expect(prunes).toHaveLength(2);
    expect(prunes.every((e) => e.type === 'prune.completed')).toBe(true);
  });

  test('filters by sinceMs', () => {
    const ring = new RingBufferEvents();
    ring.emit(pruneEvent(10, 1));
    ring.emit(pruneEvent(20, 2));
    ring.emit(pruneEvent(30, 3));
    expect(ring.query({ sinceMs: 20 }).map((e) => e.atMs)).toEqual([30, 20]);
  });

  test('caps to limit', () => {
    const ring = new RingBufferEvents();
    for (let i = 1; i <= 10; i += 1) ring.emit(pruneEvent(i, i));
    expect(ring.query({ limit: 3 }).map((e) => e.atMs)).toEqual([10, 9, 8]);
  });

  test('clear empties the buffer', () => {
    const ring = new RingBufferEvents();
    ring.emit(pruneEvent(1, 1));
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.query()).toEqual([]);
  });

  test('wrap-around keeps order correct across many overwrites', () => {
    const ring = new RingBufferEvents({ capacity: 3 });
    for (let i = 1; i <= 100; i += 1) ring.emit(pruneEvent(i, i));
    expect(ring.query().map((e) => e.atMs)).toEqual([100, 99, 98]);
    expect(ring.size).toBe(3);
  });

  test('rejects a non-positive capacity', () => {
    expect(() => new RingBufferEvents({ capacity: 0 })).toThrow();
    expect(() => new RingBufferEvents({ capacity: -1 })).toThrow();
  });
});

describe('composeEvents', () => {
  test('fans one emission to every sink', () => {
    const a: SyncularServerEvent[] = [];
    const b: SyncularServerEvent[] = [];
    const sink = composeEvents(
      { emit: (e) => a.push(e) },
      { emit: (e) => b.push(e) },
    );
    sink.emit(pruneEvent(1, 1));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  test('a throwing member never blocks the others', () => {
    const seen: SyncularServerEvent[] = [];
    const exploding: SyncularServerEvents = {
      emit() {
        throw new Error('boom');
      },
    };
    const sink = composeEvents(exploding, { emit: (e) => seen.push(e) });
    expect(() => sink.emit(pruneEvent(1, 1))).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  test('composing zero sinks is a silent no-op', () => {
    const sink = composeEvents();
    expect(() => sink.emit(pruneEvent(1, 1))).not.toThrow();
  });

  test('a RingBufferEvents composes as a member sink', () => {
    const ring = new RingBufferEvents({ capacity: 5 });
    const logged: string[] = [];
    const sink = composeEvents(ring, {
      emit: (e) => logged.push(e.type),
    });
    sink.emit(pruneEvent(1, 1));
    sink.emit(blobEvent(2));
    expect(ring.size).toBe(2);
    expect(logged).toEqual(['prune.completed', 'blob.uploaded']);
  });
});
