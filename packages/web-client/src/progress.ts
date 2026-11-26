import type { TransportCauseKind } from './diagnostics';

/** Ephemeral sync work, independent of committed change notifications (SPEC §7.7). */
export interface SyncProgress {
  /** Random per client core; `(epoch, attempt)` identifies the attempt (SPEC §7.6). */
  readonly epoch: string;
  readonly attempt: number;
  readonly state: 'running' | 'complete' | 'failed';
  readonly phase: 'request' | 'download' | 'import';
  readonly unitId?: string | undefined;
  readonly table?: string | undefined;
  readonly segmentId?: string | undefined;
  readonly bytesReceived: number;
  readonly bytesTotal?: number | undefined;
  readonly rowsProcessed: number;
  readonly rowsTotal?: number | undefined;
  /** The unit's bootstrap rows as the server counted them (SPEC §4.4, §7.7). */
  readonly unitRowsTotal?: number | undefined;
  /** Rows of the unit's bootstrap imported so far, across its sections. */
  readonly unitRowsProcessed?: number | undefined;
  /** Time in this payload's import transactions before COMMIT, in ms. */
  readonly importWriteMs?: number | undefined;
  /** Time committing them and publishing their changes, in ms. */
  readonly importCommitMs?: number | undefined;
  /** Time from this payload's segment request to its last byte, in ms. */
  readonly downloadMs?: number | undefined;
  readonly errorCode?: string;
  readonly causeKind?: TransportCauseKind;
  readonly httpStatus?: number;
  /** Present on `failed` when the core scheduled a background retry. */
  readonly retryDelayMs?: number;
}

export type SyncProgressListener = (progress: SyncProgress) => void;

/** Shared by the direct client and event-forwarding handles. */
export class ProgressEmitter {
  #snapshot: SyncProgress | undefined;
  readonly #listeners = new Set<SyncProgressListener>();

  clear(): void {
    this.#listeners.clear();
    this.#snapshot = undefined;
  }

  snapshot(): SyncProgress | undefined {
    return this.#snapshot;
  }

  on(listener: SyncProgressListener): () => void {
    this.#listeners.add(listener);
    if (this.#snapshot !== undefined) {
      try {
        listener(this.#snapshot);
      } catch {
        /* Observers cannot interrupt sync. */
      }
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(progress: SyncProgress): void {
    const before = this.#snapshot;
    // §7.7: an equal snapshot is no change; it keeps its identity and
    // notifies no one.
    if (
      before !== undefined &&
      (
        Object.keys({ ...before, ...progress }) as Array<keyof SyncProgress>
      ).every((key) => before[key] === progress[key])
    )
      return;
    const snapshot = Object.freeze({ ...progress });
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        /* Observers cannot interrupt sync. */
      }
    }
  }

  update(update: Partial<SyncProgress>): void {
    const before = this.#snapshot;
    if (before?.state !== 'running') return;
    const next = { ...before, ...update };
    // §7.7: each rise of the payload counter raises the unit's, and the unit
    // total never falls below what was imported.
    if (next.unitRowsProcessed !== undefined) {
      const processed =
        next.unitRowsProcessed +
        Math.max(0, next.rowsProcessed - before.rowsProcessed);
      next.unitRowsProcessed = processed;
      if (next.unitRowsTotal !== undefined)
        next.unitRowsTotal = Math.max(next.unitRowsTotal, processed);
    }
    this.emit(next);
  }
}
