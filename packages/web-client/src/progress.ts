/** Ephemeral sync work, independent of committed change notifications (SPEC §7.6). */
export interface SyncProgress {
  readonly attempt: number;
  readonly state: 'running' | 'complete' | 'failed';
  readonly phase: 'request' | 'download' | 'import';
  readonly subscriptionId?: string;
  readonly table?: string;
  readonly segmentId?: string | undefined;
  readonly bytesReceived: number;
  readonly bytesTotal?: number;
  readonly rowsProcessed: number;
  readonly rowsTotal?: number;
  readonly errorCode?: string;
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
    if (this.#snapshot?.state === 'running')
      this.emit({ ...this.#snapshot, ...update });
  }
}
