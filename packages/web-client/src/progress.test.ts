import { expect, test } from 'bun:test';
import { ProgressEmitter, type SyncProgress } from './progress';

test('progress listeners replay the snapshot, isolate errors and unsubscribe', () => {
  const emitter = new ProgressEmitter();
  expect(emitter.snapshot()).toBeUndefined();
  emitter.on(() => {
    throw new Error('observer');
  });
  emitter.emit({
    epoch: 'e1',
    attempt: 1,
    state: 'running',
    phase: 'request',
    bytesReceived: 0,
    rowsProcessed: 0,
  });
  const updates: SyncProgress[] = [];
  const off = emitter.on((snapshot) => updates.push(snapshot));
  expect(updates).toHaveLength(1);
  emitter.update({ phase: 'download', bytesReceived: 65536 });
  expect(updates[0]?.bytesReceived).toBe(0);
  expect(updates[1]?.bytesReceived).toBe(65536);
  expect(Object.isFrozen(updates[1])).toBe(true);
  off();
  emitter.update({ state: 'failed', errorCode: 'sync.transport_failed' });
  emitter.update({ bytesReceived: 999999 });
  expect(updates).toHaveLength(2);
  expect(emitter.snapshot()?.bytesReceived).toBe(65536);
  emitter.clear();
  expect(emitter.snapshot()).toBeUndefined();
});

test('an equal snapshot keeps its identity and notifies no one', () => {
  const emitter = new ProgressEmitter();
  const progress: SyncProgress = {
    epoch: 'e1',
    attempt: 1,
    state: 'running',
    phase: 'download',
    unitId: undefined,
    bytesReceived: 10,
    rowsProcessed: 0,
  };
  emitter.emit(progress);
  const updates: SyncProgress[] = [];
  emitter.on((snapshot) => updates.push(snapshot));
  const first = emitter.snapshot();
  emitter.emit({ ...progress, unitId: undefined });
  const { unitId: _absent, ...withoutUnit } = progress;
  emitter.emit(withoutUnit);
  emitter.update({ bytesReceived: 10 });
  expect(emitter.snapshot()).toBe(first);
  expect(updates).toEqual([progress]);
  emitter.update({ bytesReceived: 11 });
  expect(updates.map((snapshot) => snapshot.bytesReceived)).toEqual([10, 11]);
});
