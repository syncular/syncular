/**
 * Unit coverage for the churn-hardening primitives (query-churn.ts), separate
 * from the RTL hook wiring in churn.test.tsx:
 * - reconcileRows: whole-result-equal → `next: undefined` (setRows skipped);
 *   one-row-change → new array reusing the unchanged row OBJECTS by identity;
 * - hashRow: key-order-insensitive, Uint8Array-stable;
 * - FrameScheduler: burst coalesces to one run, mid-run event re-runs once,
 *   flush() is synchronous & deterministic;
 * - a measured O(n) reconcile cost at 1k rows (the documented bound).
 */
import { describe, expect, test } from 'bun:test';
import {
  FrameScheduler,
  flushQuerySchedulers,
  hashRow,
  hashRows,
  reconcileRows,
} from '../src/query-churn';

describe('hashRow', () => {
  test('is insensitive to key order', () => {
    expect(hashRow({ a: 1, b: 2 })).toBe(hashRow({ b: 2, a: 1 }));
  });
  test('distinguishes different values', () => {
    expect(hashRow({ a: 1 })).not.toBe(hashRow({ a: 2 }));
  });
  test('hashes equal Uint8Array bytes equal', () => {
    expect(hashRow({ b: new Uint8Array([1, 2, 3]) })).toBe(
      hashRow({ b: new Uint8Array([1, 2, 3]) }),
    );
  });
});

describe('reconcileRows', () => {
  test('whole-result-equal → next undefined (setRows skipped)', () => {
    const prev = hashRows([
      { id: 't1', title: 'a' },
      { id: 't2', title: 'b' },
    ]);
    const fresh = [
      { id: 't1', title: 'a' },
      { id: 't2', title: 'b' },
    ];
    expect(reconcileRows(prev, fresh).next).toBeUndefined();
  });

  test('one-row-change reuses the unchanged row OBJECT by identity', () => {
    const r1 = { id: 't1', title: 'a' };
    const r2 = { id: 't2', title: 'b' };
    const prev = hashRows([r1, r2]);
    // t2's title changed; t1 unchanged.
    const fresh = [
      { id: 't1', title: 'a' },
      { id: 't2', title: 'B!' },
    ];
    const { next } = reconcileRows(prev, fresh);
    expect(next).toBeDefined();
    // Row 0 reuses the previous object (memo skips); row 1 is the fresh one.
    expect(next?.rows[0]).toBe(r1);
    expect(next?.rows[1]).not.toBe(r2);
    expect(next?.rows[1]).toEqual({ id: 't2', title: 'B!' });
  });

  test('length change never claims unchanged; reuses surviving prefix objects', () => {
    const r1 = { id: 't1' };
    const prev = hashRows([r1]);
    const fresh = [{ id: 't1' }, { id: 't2' }];
    const { next } = reconcileRows(prev, fresh);
    expect(next).toBeDefined();
    expect(next?.rows[0]).toBe(r1);
    expect(next?.rows).toHaveLength(2);
  });

  test('no previous baseline → all fresh objects', () => {
    const fresh = [{ id: 't1' }];
    const { next } = reconcileRows(undefined, fresh);
    expect(next?.rows[0]).toBe(fresh[0]);
  });

  test('measured O(n) reconcile cost at 1k rows', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: `t${i}`,
      title: `title ${i}`,
      done: i % 2 === 0,
    }));
    const prev = hashRows(rows);
    const fresh = rows.map((r) => ({ ...r })); // fresh objects, equal content
    const start = performance.now();
    const { next } = reconcileRows(prev, fresh);
    const ms = performance.now() - start;
    // Whole result unchanged despite fresh objects.
    expect(next).toBeUndefined();
    // Bounded: well under a frame. Generous ceiling to avoid CI flake; the
    // typical observed cost is ~0.2ms.
    expect(ms).toBeLessThan(20);
  });
});

describe('FrameScheduler', () => {
  test('a burst of schedule() collapses to one run (flush is deterministic)', () => {
    let runs = 0;
    const s = new FrameScheduler(() => {
      runs += 1;
    });
    s.schedule();
    s.schedule();
    s.schedule();
    expect(runs).toBe(0); // coalesced, not yet fired
    s.flush();
    expect(runs).toBe(1);
    s.dispose();
  });

  test('an event during a run re-runs exactly once after (never lost/concurrent)', async () => {
    let runs = 0;
    let s!: FrameScheduler;
    s = new FrameScheduler(async () => {
      runs += 1;
      if (runs === 1) {
        // Simulate an invalidation arriving mid-run.
        s.schedule();
      }
      await Promise.resolve();
    });
    s.schedule();
    await s.flush();
    // The mid-run schedule queued a follow-up microtask; drain it.
    await flushQuerySchedulers();
    await Promise.resolve();
    expect(runs).toBe(2);
    s.dispose();
  });

  test('dispose() makes a pending frame a no-op', () => {
    let runs = 0;
    const s = new FrameScheduler(() => {
      runs += 1;
    });
    s.schedule();
    s.dispose();
    s.flush();
    expect(runs).toBe(0);
  });

  test('a hidden document schedules on the microtask boundary, not the suspended rAF', async () => {
    const g = globalThis as {
      requestAnimationFrame?: unknown;
      document?: unknown;
    };
    const prevRaf = g.requestAnimationFrame;
    const prevDoc = g.document;
    // An rAF that parks forever — the browser's behavior on a hidden page.
    const parked: Array<() => void> = [];
    g.requestAnimationFrame = (cb: () => void) => {
      parked.push(cb);
      return 0;
    };
    g.document = { visibilityState: 'hidden' };
    try {
      let runs = 0;
      const s = new FrameScheduler(() => {
        runs += 1;
      });
      s.schedule();
      expect(parked).toHaveLength(0); // never handed to the suspended rAF
      await Promise.resolve(); // drain the microtask fallback
      expect(runs).toBe(1);
      s.dispose();
    } finally {
      g.requestAnimationFrame = prevRaf;
      g.document = prevDoc;
    }
  });

  test('a frame parked in rAF before the page hides re-dispatches on visibilitychange; the stale rAF no-ops', async () => {
    const g = globalThis as {
      requestAnimationFrame?: unknown;
      document?: unknown;
    };
    const prevRaf = g.requestAnimationFrame;
    const prevDoc = g.document;
    const parked: Array<() => void> = [];
    let onVisibility: (() => void) | undefined;
    const doc = {
      visibilityState: 'visible',
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'visibilitychange') onVisibility = listener;
      },
    };
    g.requestAnimationFrame = (cb: () => void) => {
      parked.push(cb);
      return 0;
    };
    g.document = doc;
    try {
      let runs = 0;
      const s = new FrameScheduler(() => {
        runs += 1;
      });
      expect(onVisibility).toBeDefined(); // construction hooked visibilitychange
      s.schedule(); // visible → parked in rAF
      expect(parked).toHaveLength(1);
      expect(runs).toBe(0);

      // The page hides: rAF suspends, the transition hands the frame to a
      // microtask, and the query still converges off-screen.
      doc.visibilityState = 'hidden';
      onVisibility?.();
      await Promise.resolve();
      expect(runs).toBe(1);

      // The page becomes visible again and the stale parked rAF finally
      // fires — it must be a no-op, not a duplicate run.
      doc.visibilityState = 'visible';
      for (const cb of parked) cb();
      expect(runs).toBe(1);
      s.dispose();
    } finally {
      g.requestAnimationFrame = prevRaf;
      g.document = prevDoc;
    }
  });
});
