/**
 * Main-thread side of the worker mode (Direction decision 2): a thin,
 * fully async proxy over the `worker-protocol` RPC. The handle owns the
 * cross-tab leader election — it acquires the Web Locks leader lock
 * BEFORE spawning the worker, so exactly one core runs per origin. A
 * second tab resolves to a clear not-leader handle (`isLeader === false`,
 * every call throws `client.not_leader`) instead of a broken client;
 * follower fanout is post-gate (TODO 3.2).
 */
import type { WakeReason } from '@syncular-v2/core';
import type { BlobRef, CachedBlob } from './blob';
import type {
  ConflictRecord,
  MutationInput,
  RejectionRecord,
  SchemaFloor,
  SubscribeInput,
  SyncClientLimits,
  SyncSummary,
} from './client';
import type { SqlRow, SqlValue } from './database';
import { ClientSyncError } from './errors';
import {
  type LeaderLease,
  type LeaderLock,
  singleOwnerLock,
  webLocksLeaderLock,
} from './leader-lock';
import type { OutboxCommit } from './outbox';
import type { ClientSchema } from './schema';
import type { SubscriptionRecord } from './state';
import {
  type MainToWorkerMessage,
  NOT_LEADER_CODE,
  type SyncWorkerEvent,
  WORKER_FAILED_CODE,
  type WorkerApi,
  type WorkerDatabaseInit,
  type WorkerEndpoints,
  type WorkerErrorShape,
  type WorkerInitConfig,
  type WorkerInitResult,
  type WorkerMethod,
  type WorkerToMainMessage,
} from './worker-protocol';

export interface SyncClientHandleConfig {
  /**
   * Spawns the worker running `startSyncWorker()` (a factory so bundlers
   * see `new Worker(new URL(...))` at the call site, and so no worker is
   * spawned when this tab loses the leader election).
   */
  readonly worker: () => Worker;
  readonly schema: ClientSchema;
  readonly database: WorkerDatabaseInit;
  readonly endpoints: WorkerEndpoints;
  readonly clientId?: string;
  readonly limits?: SyncClientLimits;
  /** Worker-side host loop (§8.4); default true. */
  readonly autoSync?: boolean;
  readonly wakeJitterMs?: number;
  /** Default: Web Locks when available, else single-owner. */
  readonly leaderLock?: LeaderLock;
  readonly lockName?: string;
  readonly onSyncNeeded?: (reason: 'hello' | WakeReason) => void;
  readonly onConflict?: (conflict: ConflictRecord) => void;
  /** A worker-side autoSync round finished (or failed). */
  readonly onSynced?: (result: {
    readonly summary?: SyncSummary;
    readonly error?: WorkerErrorShape;
  }) => void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function defaultLeaderLock(): LeaderLock {
  const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
  return nav?.locks !== undefined
    ? webLocksLeaderLock(nav.locks)
    : singleOwnerLock();
}

/**
 * The main-thread proxy: the same logical API as `SyncClient`, every
 * method a promise because it crosses the RPC boundary. Constructed via
 * `createSyncClientHandle`.
 */
export class SyncClientHandle {
  readonly isLeader: boolean;
  /** Resolved (possibly persisted) client id; '' on a not-leader handle. */
  readonly clientId: string;
  readonly #worker: Worker | undefined;
  readonly #lease: LeaderLease | undefined;
  readonly #pending: Map<number, Pending>;
  readonly #nextId: { value: number };
  #closed = false;

  /** @internal — use {@link createSyncClientHandle}. */
  constructor(internals: {
    isLeader: boolean;
    clientId: string;
    worker?: Worker;
    lease?: LeaderLease;
    pending: Map<number, Pending>;
    nextId: { value: number };
  }) {
    this.isLeader = internals.isLeader;
    this.clientId = internals.clientId;
    this.#worker = internals.worker;
    this.#lease = internals.lease;
    this.#pending = internals.pending;
    this.#nextId = internals.nextId;
  }

  #call<M extends WorkerMethod>(
    method: M,
    args: Parameters<WorkerApi[M]>,
  ): Promise<Awaited<ReturnType<WorkerApi[M]>>> {
    if (!this.isLeader) {
      return Promise.reject(
        new ClientSyncError(
          NOT_LEADER_CODE,
          'this tab is not the leader — another tab owns the syncular ' +
            'core for this origin (multi-tab followers are TODO 3.2)',
        ),
      );
    }
    if (this.#closed || this.#worker === undefined) {
      return Promise.reject(
        new ClientSyncError(WORKER_FAILED_CODE, 'the handle is closed'),
      );
    }
    const id = this.#nextId.value++;
    const message = { t: 'call', id, method, args } as MainToWorkerMessage;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as Pending['resolve'], reject });
      this.#worker?.postMessage(message);
    });
  }

  subscribe(input: SubscribeInput): Promise<void> {
    return this.#call('subscribe', [input]);
  }

  unsubscribe(id: string): Promise<void> {
    return this.#call('unsubscribe', [id]);
  }

  mutate(mutations: readonly MutationInput[]): Promise<string> {
    return this.#call('mutate', [mutations]);
  }

  sync(): Promise<SyncSummary> {
    return this.#call('sync', []);
  }

  syncUntilIdle(maxRounds?: number): Promise<SyncSummary> {
    return this.#call('syncUntilIdle', [maxRounds]);
  }

  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]> {
    return this.#call('query', [sql, params]);
  }

  conflicts(): Promise<readonly ConflictRecord[]> {
    return this.#call('conflicts', []);
  }

  rejections(): Promise<readonly RejectionRecord[]> {
    return this.#call('rejections', []);
  }

  schemaFloor(): Promise<SchemaFloor | undefined> {
    return this.#call('schemaFloor', []);
  }

  syncNeeded(): Promise<boolean> {
    return this.#call('syncNeeded', []);
  }

  pendingCommits(): Promise<OutboxCommit[]> {
    return this.#call('pendingCommits', []);
  }

  subscriptions(): Promise<SubscriptionRecord[]> {
    return this.#call('subscriptions', []);
  }

  subscription(id: string): Promise<SubscriptionRecord | undefined> {
    return this.#call('subscription', [id]);
  }

  connectRealtime(): Promise<void> {
    return this.#call('connectRealtime', []);
  }

  disconnectRealtime(): Promise<void> {
    return this.#call('disconnectRealtime', []);
  }

  uploadBlob(
    bytes: Uint8Array,
    options?: { readonly mediaType?: string; readonly name?: string },
  ): Promise<BlobRef> {
    return this.#call('uploadBlob', [bytes, options]);
  }

  fetchBlob(blobIdOrRef: string): Promise<CachedBlob> {
    return this.#call('fetchBlob', [blobIdOrRef]);
  }

  /** Sever/restore transport + realtime inside the worker (demos). */
  setOffline(offline: boolean): Promise<void> {
    return this.#call('setOffline', [offline]);
  }

  /** Close the worker core, terminate the worker, release leadership. */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (!this.isLeader) {
      this.#closed = true;
      return;
    }
    try {
      await this.#call('close', []);
    } catch {
      // Closing a wedged worker still terminates it below.
    }
    this.#closed = true;
    this.#worker?.terminate();
    this.#failPending(
      new ClientSyncError(WORKER_FAILED_CODE, 'the handle was closed'),
    );
    await this.#lease?.release();
  }

  #failPending(error: ClientSyncError): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

/**
 * Acquire leadership, spawn the worker, initialize the core inside it.
 * Resolves to a not-leader handle (no worker spawned) when another tab
 * already owns the lock.
 */
export async function createSyncClientHandle(
  config: SyncClientHandleConfig,
): Promise<SyncClientHandle> {
  const lock = config.leaderLock ?? defaultLeaderLock();
  const lockName = config.lockName ?? 'syncular-leader';
  // Leadership BEFORE the worker exists: one core per origin, and a
  // losing tab never boots a database it must not own.
  const lease =
    lock.tryAcquire !== undefined
      ? await lock.tryAcquire(lockName)
      : await lock.acquire(lockName);
  const pending = new Map<number, Pending>();
  const nextId = { value: 1 };
  if (lease === undefined) {
    return new SyncClientHandle({
      isLeader: false,
      clientId: '',
      pending,
      nextId,
    });
  }

  const worker = config.worker();
  const events = {
    onSyncNeeded: config.onSyncNeeded,
    onConflict: config.onConflict,
    onSynced: config.onSynced,
  };

  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as WorkerToMainMessage;
      switch (message.t) {
        case 'ready':
          resolve();
          break;
        case 'result': {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          entry?.resolve(message.value);
          break;
        }
        case 'error': {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          entry?.reject(
            new ClientSyncError(
              message.error.code,
              message.error.message,
              message.error.retryable,
            ),
          );
          break;
        }
        case 'event':
          dispatchEvent(message.event);
          break;
      }
    };
    const onError = (event: ErrorEvent) => {
      const error = new ClientSyncError(
        WORKER_FAILED_CODE,
        `the sync worker failed: ${event.message ?? 'unknown error'}`,
      );
      reject(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError as EventListener);
  });

  function dispatchEvent(event: SyncWorkerEvent): void {
    if (event.kind === 'sync-needed') {
      events.onSyncNeeded?.(event.reason);
    } else if (event.kind === 'conflict') {
      events.onConflict?.(event.conflict);
    } else {
      events.onSynced?.({
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      });
    }
  }

  const initConfig: WorkerInitConfig = {
    schema: config.schema,
    database: config.database,
    endpoints: config.endpoints,
    ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
    ...(config.limits !== undefined ? { limits: config.limits } : {}),
    ...(config.autoSync !== undefined ? { autoSync: config.autoSync } : {}),
    ...(config.wakeJitterMs !== undefined
      ? { wakeJitterMs: config.wakeJitterMs }
      : {}),
  };

  try {
    await ready;
    const initResult = await new Promise<WorkerInitResult>(
      (resolve, reject) => {
        const id = nextId.value++;
        pending.set(id, {
          resolve: (value) => resolve(value as WorkerInitResult),
          reject,
        });
        const message: MainToWorkerMessage = {
          t: 'init',
          id,
          config: initConfig,
        };
        worker.postMessage(message);
      },
    );
    return new SyncClientHandle({
      isLeader: true,
      clientId: initResult.clientId,
      worker,
      lease,
      pending,
      nextId,
    });
  } catch (error) {
    worker.terminate();
    await lease.release();
    throw error;
  }
}
