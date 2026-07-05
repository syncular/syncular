/**
 * A virtual clock the whole test sync shares — server, every client, and
 * the realtime hub read the same `now()`. Time only moves when the test
 * moves it, so §5.1 TTLs, §5.4 signed-URL expiry, and §7.3 lease windows
 * are exercised deterministically with no wall-clock flake.
 *
 * This is deliberately NOT a fake-timers shim: it does not intercept
 * `setTimeout`. It is the single epoch-ms source that Syncular's clock seam
 * (`SyncServerConfig.clock`, `SyncClientConfig.now`) reads. Presence rate
 * caps and heartbeats, which use real `setTimeout`, are out of scope — the
 * kit targets sync/offline/fault behaviour, not wall-clock scheduling.
 */

/** The default epoch (ms) a fresh clock starts at — a fixed, readable point
 * so golden values and TTL maths are stable across runs. */
export const DEFAULT_EPOCH_MS = 1_750_000_000_000;

export interface VirtualClock {
  /** Current time in epoch ms — the value the clock seam returns. */
  now(): number;
  /** Move time forward by `ms` (must be ≥ 0). Returns the new `now()`. */
  advance(ms: number): number;
  /** Jump to an absolute epoch-ms instant. Returns the new `now()`. */
  set(ms: number): number;
}

export function createVirtualClock(startMs = DEFAULT_EPOCH_MS): VirtualClock {
  let ms = startMs;
  return {
    now: () => ms,
    advance: (delta) => {
      if (delta < 0) {
        throw new Error(
          `clock.advance: time cannot move backwards (${delta}ms)`,
        );
      }
      ms += delta;
      return ms;
    },
    set: (next) => {
      ms = next;
      return ms;
    },
  };
}
