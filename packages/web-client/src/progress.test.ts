import { expect, test } from 'bun:test';
import { ProgressEmitter, type SyncProgress } from './progress';

test('progress listeners replay the snapshot, isolate errors and unsubscribe', () => {
  const emitter = new ProgressEmitter();
  expect(emitter.snapshot()).toBeUndefined();
  emitter.on(() => {
    throw new Error('observer');
  });
  emitter.emit({
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
