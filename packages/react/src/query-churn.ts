/**
 * Live-query churn hardening — the three cheap levers the query hooks share
 * (block 4 "live-query churn" item). Under constant sync churn a naive live
 * query re-renders and re-queries once per invalidation event; these levers
 * cap both without reaching for IVM:
 *
 * 1. {@link reconcileRows} — result stability. After a re-run, compare the new
 *    result to the previous one. Whole-result equal → the caller skips
 *    `setRows` entirely (zero re-render). Otherwise build the new array but
 *    REUSE the previous row object for every row whose content is unchanged,
 *    so `React.memo`'d row components keyed by row identity skip re-render.
 * 2. {@link FrameScheduler} — frame-coalesced re-query scheduling. Many
 *    invalidation events between paints collapse to ONE re-run per query.
 * 3. scope-key filtering lives in {@link ../use-raw-sql} `eventMatches`
 *    (it needs the event + the hook's options), documented there.
 *
 * Row identity mechanism (the honest key): the hook knows no primary key —
 * rows are plain JSON-able objects out of SQLite — so per-row content equality
 * IS the identity. We hash each row once with a stable JSON serialization
 * (sorted keys, so column order can't spuriously differ) and match by index:
 * a live query's ORDER BY makes index the stable position, and an unchanged
 * row at position i keeps its object so memoized components skip. This is O(n)
 * in the row count with one string hash per row — bounded and measured (~0.2ms
 * for 1k narrow rows in bun; see query-churn.test.ts).
 */

/**
 * A stable content hash for one row: JSON with keys sorted, so two rows with
 * the same columns in a different order hash equal (SQLite projection order is
 * stable per query, but sorting removes any dependence on it and is cheap for
 * the narrow rows a row-component renders). Uint8Array values (rare in a
 * projection) serialize by byte view so a fresh copy of equal bytes hashes
 * equal rather than to `{}`.
 */
export function hashRow(row: unknown): string {
  return JSON.stringify(row, replacer);
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { __u8: [...value] };
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    // Sort keys so column/field order never spuriously changes the hash.
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/** The precomputed hash carrier for the previous result, so we hash once. */
export interface HashedRows<Row> {
  readonly rows: readonly Row[];
  readonly hashes: readonly string[];
}

export function hashRows<Row>(rows: readonly Row[]): HashedRows<Row> {
  const hashes = new Array<string>(rows.length);
  for (let i = 0; i < rows.length; i++) hashes[i] = hashRow(rows[i]);
  return { rows, hashes };
}

export interface ReconcileResult<Row> {
  /**
   * `undefined` → the whole result is unchanged; the caller MUST NOT call
   * setRows (zero re-render, lever 1a). Otherwise the reconciled array to set,
   * with previous row objects reused wherever a row's content was unchanged
   * (lever 1b).
   */
  readonly next: HashedRows<Row> | undefined;
}

/**
 * Reconcile a freshly-queried result against the previous hashed result.
 * Returns `next: undefined` when nothing changed at all; otherwise a new
 * hashed result whose row objects are the PREVIOUS objects wherever content is
 * unchanged (matched by index), so identity-keyed memo components skip.
 */
export function reconcileRows<Row>(
  prev: HashedRows<Row> | undefined,
  fresh: readonly Row[],
): ReconcileResult<Row> {
  const freshHashes = new Array<string>(fresh.length);
  for (let i = 0; i < fresh.length; i++) freshHashes[i] = hashRow(fresh[i]);

  if (prev !== undefined && prev.rows.length === fresh.length) {
    let identical = true;
    for (let i = 0; i < fresh.length; i++) {
      if (prev.hashes[i] !== freshHashes[i]) {
        identical = false;
        break;
      }
    }
    if (identical) return { next: undefined };
  }

  // Changed: reuse the previous row object at each index whose hash matches,
  // so unchanged rows keep their identity for memoized row components.
  const rows = new Array<Row>(fresh.length);
  for (let i = 0; i < fresh.length; i++) {
    const reuse =
      prev !== undefined &&
      i < prev.rows.length &&
      prev.hashes[i] === freshHashes[i];
    // `i < fresh.length` bounds this loop, so `fresh[i]` is defined; the reuse
    // branch is additionally guarded by `i < prev.rows.length`.
    rows[i] = reuse ? (prev.rows[i] as Row) : (fresh[i] as Row);
  }
  return { next: { rows, hashes: freshHashes } };
}

/**
 * A per-query re-run scheduler that coalesces bursts of invalidation events
 * into ONE run per paint. Multiple `schedule()` calls before the next flush
 * run the callback once. A `schedule()` that arrives WHILE the callback is
 * running (re-entrant, or an event during an async re-query) marks dirty and
 * runs the callback exactly once more after — never lost, never concurrent.
 *
 * Timing source: `requestAnimationFrame` when the host has it AND the document
 * is visible (a real browser paints one frame; the coalescing window is a
 * frame), else a microtask via a resolved promise (bun tests have no rAF —
 * this keeps them deterministic and timer-free, honoring the no-timers
 * doctrine: it's a readiness turn, not a wall-clock sleep). {@link flush} runs
 * any pending callback synchronously for tests, so no arbitrary sleeps are
 * needed to observe coalescing.
 *
 * Hidden documents: browsers SUSPEND rAF while a page is hidden (background
 * tab, occluded webview, headless embed), so a frame parked there fires only
 * when the page becomes visible again — and a page that is never visible would
 * freeze its live queries forever while invalidations keep arriving. Two
 * guards keep the schedule honest: a `schedule()` issued while hidden goes to
 * the microtask boundary (there is no paint to coalesce against anyway), and a
 * visible → hidden transition re-dispatches any frame already parked in rAF to
 * a microtask (the stale rAF callback later no-ops via the `#scheduled` guard
 * in {@link #fire}).
 */
export class FrameScheduler {
  #scheduled = false;
  #running = false;
  #dirty = false;
  #callback: (() => void | Promise<void>) | undefined;

  constructor(callback: () => void | Promise<void>) {
    this.#callback = callback;
    liveSchedulers.add(this);
    hookVisibility();
  }

  /** Request a run. Coalesces until the next frame/microtask boundary. */
  schedule(): void {
    if (this.#running) {
      // An event arrived during a run — remember it and re-run once after.
      this.#dirty = true;
      return;
    }
    if (this.#scheduled) return;
    this.#scheduled = true;
    scheduleFrame(() => this.#fire());
  }

  #fire(): void {
    // A stale dispatch must be a no-op: an rAF parked before the page went
    // hidden fires again on the visible transition, AFTER the microtask
    // fallback already ran the callback and cleared `#scheduled`.
    if (!this.#scheduled) return;
    this.#run();
  }

  /**
   * @internal — the visible → hidden transition hands a frame parked in the
   * (now suspended) rAF to the microtask boundary, so live queries keep
   * converging off-screen. A no-op when nothing is pending.
   */
  redispatchPending(): void {
    if (!this.#scheduled) return;
    queueMicrotask(() => this.#fire());
  }

  /**
   * Run the callback once, honoring the running/dirty contract: a `schedule()`
   * during the run marks `#dirty`, and on completion we re-schedule exactly
   * one more run — never lost, never concurrent. Returns the callback's result
   * (a Promise for the async host path) so `flush` can hand it to a test.
   */
  #run(): void | Promise<void> {
    this.#scheduled = false;
    if (this.#callback === undefined) return;
    this.#running = true;
    this.#dirty = false;
    const done = () => {
      this.#running = false;
      if (this.#dirty && this.#callback !== undefined) {
        this.#dirty = false;
        // An invalidation landed mid-run: re-run once more, coalesced.
        this.schedule();
      }
    };
    let result: void | Promise<void>;
    try {
      result = this.#callback();
    } catch {
      done();
      return;
    }
    if (result && typeof (result as Promise<void>).then === 'function') {
      return (result as Promise<void>).then(done, done);
    }
    done();
    return;
  }

  /**
   * Synchronously run any pending scheduled callback NOW (test determinism).
   * Returns whatever the callback returned (a Promise for the async host path)
   * so a test can await the re-query settling without a sleep. A no-op when
   * nothing is pending.
   */
  flush(): void | Promise<void> {
    if (!this.#scheduled || this.#callback === undefined) return;
    return this.#run();
  }

  /** Drop the callback so a torn-down hook's pending frame is a no-op. */
  dispose(): void {
    this.#callback = undefined;
    liveSchedulers.delete(this);
  }
}

/**
 * Live schedulers, weakly tracked for the test-only flush below. A Set (not
 * WeakSet) so we can iterate; entries are removed on `dispose()`, so a mounted
 * hook holds at most one entry and unmount clears it.
 */
const liveSchedulers = new Set<FrameScheduler>();

/**
 * TEST-ONLY: synchronously flush every live scheduler's pending frame, so a
 * test can observe the coalesced re-query without a wall-clock sleep (the
 * no-timers doctrine — a readiness flush, injected, not a timer). Returns a
 * Promise that settles when every flushed async re-query has settled.
 */
export function flushQuerySchedulers(): Promise<void> {
  const pending: Array<Promise<void>> = [];
  for (const s of liveSchedulers) {
    const r = s.flush();
    if (r && typeof (r as Promise<void>).then === 'function') {
      pending.push(r as Promise<void>);
    }
  }
  return Promise.all(pending).then(() => undefined);
}

/** The document surface this module reads — kept structural so the package
 *  needs no DOM lib types and tests can inject a double. */
interface DocumentLike {
  readonly visibilityState?: string;
  addEventListener?: (type: string, listener: () => void) => void;
}

function currentDocument(): DocumentLike | undefined {
  return (globalThis as { document?: DocumentLike }).document;
}

function documentHidden(): boolean {
  return currentDocument()?.visibilityState === 'hidden';
}

function scheduleFrame(cb: () => void): void {
  // Read rAF per call (not cached at module load) so a test can install a
  // double around one scenario.
  const raf =
    typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : undefined;
  if (raf !== undefined && !documentHidden()) {
    raf(cb);
    return;
  }
  // No rAF (bun test / worker) or a hidden document (rAF suspended): a
  // microtask is the deterministic, timer-free coalescing boundary.
  // Everything queued in the current synchronous run (a burst of emits) has
  // already called schedule() before this drains.
  queueMicrotask(cb);
}

/**
 * The document whose `visibilitychange` is currently hooked. Re-hooked when
 * the document identity changes (never in a browser — one document per page —
 * but each test double gets its own listener; stale listeners die with their
 * document). Registration is lazy (first scheduler construction) so importing
 * the module has no side effect.
 */
let hookedDocument: DocumentLike | undefined;

function hookVisibility(): void {
  const doc = currentDocument();
  if (
    doc === undefined ||
    doc === hookedDocument ||
    typeof doc.addEventListener !== 'function'
  ) {
    return;
  }
  hookedDocument = doc;
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'hidden') return;
    // rAF is suspended from here on; hand every parked frame to a microtask.
    for (const s of liveSchedulers) s.redispatchPending();
  });
}
