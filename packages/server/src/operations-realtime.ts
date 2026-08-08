import {
  decodeRemoteOperationRealtimeMessage,
  encodeRemoteOperationRealtimeMessage,
  type RemoteOperationRealtimeMessage,
} from '@syncular/core';
import type { RealtimeNotifier, SyncRequestContext } from './context';
import { REMOTE_COMMAND_CLIENT_ID_PREFIX } from './context';
import { SyncError, syncError } from './errors';
import type {
  RegisteredRemoteQuery,
  RemoteOperationRegistry,
} from './operations';
import type { StoredCommit } from './storage';

export interface RemoteOperationWatchSession {
  receive(bytes: Uint8Array): Promise<void>;
  close(): void;
}

interface WatchState {
  readonly watchId: string;
  readonly clientId: string;
  readonly operation: RegisteredRemoteQuery;
  readonly params: unknown;
  running: boolean;
  dirty: boolean;
}

class WatchSession implements RemoteOperationWatchSession {
  readonly #ctx: SyncRequestContext;
  readonly #registry: RemoteOperationRegistry;
  readonly #send: (bytes: Uint8Array) => void;
  readonly #closed: () => void;
  readonly #watches = new Map<string, WatchState>();
  #isClosed = false;

  get partition(): string {
    return this.#ctx.partition;
  }

  constructor(
    ctx: SyncRequestContext,
    registry: RemoteOperationRegistry,
    send: (bytes: Uint8Array) => void,
    closed: () => void,
  ) {
    this.#ctx = ctx;
    this.#registry = registry;
    this.#send = send;
    this.#closed = closed;
  }

  async receive(bytes: Uint8Array): Promise<void> {
    if (this.#isClosed) return;
    let message: RemoteOperationRealtimeMessage;
    try {
      message = decodeRemoteOperationRealtimeMessage(bytes);
      if (
        typeof message !== 'object' ||
        message === null ||
        message.revision !== 1 ||
        (message.kind !== 'watch' && message.kind !== 'unwatch') ||
        typeof message.watchId !== 'string' ||
        message.watchId.length === 0
      ) {
        throw syncError('operation.invalid_request');
      }
      if (message.kind === 'watch') {
        if (
          typeof message.clientId !== 'string' ||
          message.clientId.length === 0 ||
          typeof message.operationId !== 'string' ||
          message.operationId.length === 0
        ) {
          throw syncError('operation.invalid_request');
        }
      }
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw syncError('operation.invalid_request');
    }
    if (message.kind === 'unwatch') {
      this.#watches.delete(message.watchId);
      return;
    }
    if (this.#watches.has(message.watchId)) {
      this.#sendError(
        message.watchId,
        syncError('operation.invalid_request', 'watchId is already active'),
      );
      return;
    }
    if (message.clientId.startsWith(REMOTE_COMMAND_CLIENT_ID_PREFIX)) {
      this.#sendError(
        message.watchId,
        syncError(
          'sync.invalid_client_id',
          'clientId uses a reserved server-command namespace (§1.5)',
        ),
      );
      return;
    }
    const clientRecord = await this.#ctx.storage.getClientRecord(
      this.#ctx.partition,
      message.clientId,
    );
    if (
      clientRecord !== undefined &&
      clientRecord.actorId !== this.#ctx.actorId
    ) {
      this.#sendError(
        message.watchId,
        syncError(
          'sync.invalid_client_id',
          'clientId is bound to a different actor in this partition (§1.5)',
        ),
      );
      return;
    }
    const operation = this.#registry.get(message.operationId);
    if (operation === undefined || operation.kind !== 'query') {
      this.#sendError(message.watchId, syncError('operation.unknown'));
      return;
    }
    const state: WatchState = {
      watchId: message.watchId,
      clientId: message.clientId,
      operation,
      params: message.params,
      running: false,
      dirty: false,
    };
    this.#watches.set(message.watchId, state);
    await this.#refresh(state);
  }

  notify(tables: ReadonlySet<string>): void {
    for (const state of this.#watches.values()) {
      if (!state.operation.tables.some((table) => tables.has(table))) continue;
      if (state.running) state.dirty = true;
      else void this.#refresh(state);
    }
  }

  async #refresh(state: WatchState): Promise<void> {
    if (this.#isClosed || this.#watches.get(state.watchId) !== state) return;
    if (state.running) {
      state.dirty = true;
      return;
    }
    state.running = true;
    try {
      do {
        state.dirty = false;
        try {
          const response = await state.operation.run(
            this.#ctx,
            state.clientId,
            state.params,
          );
          if (this.#isClosed || this.#watches.get(state.watchId) !== state) {
            return;
          }
          if (response.kind !== 'query') {
            throw syncError('operation.query_failed');
          }
          if (
            !this.#emit(
              encodeRemoteOperationRealtimeMessage({
                revision: 1,
                kind: 'snapshot',
                watchId: state.watchId,
                operationId: response.operationId,
                rows: response.rows,
                maxCommitSeq: response.maxCommitSeq,
              }),
            )
          )
            return;
        } catch (error) {
          if (this.#isClosed || this.#watches.get(state.watchId) !== state) {
            return;
          }
          this.#sendError(
            state.watchId,
            error instanceof SyncError
              ? error
              : syncError('operation.query_failed'),
          );
        }
      } while (
        state.dirty &&
        !this.#isClosed &&
        this.#watches.get(state.watchId) === state
      );
    } finally {
      state.running = false;
    }
  }

  #sendError(watchId: string, error: SyncError): void {
    this.#emit(
      encodeRemoteOperationRealtimeMessage({
        revision: 1,
        kind: 'watch_error',
        watchId,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      }),
    );
  }

  #emit(bytes: Uint8Array): boolean {
    if (this.#isClosed) return false;
    try {
      this.#send(bytes);
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  close(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#watches.clear();
    this.#closed();
  }
}

/** In-memory invalidation hub. Every notification reruns affected watches. */
export class RemoteOperationWatchHub implements RealtimeNotifier {
  readonly #registry: RemoteOperationRegistry;
  readonly #sessions = new Set<WatchSession>();

  constructor(registry: RemoteOperationRegistry) {
    this.#registry = registry;
  }

  connect(
    ctx: SyncRequestContext,
    send: (bytes: Uint8Array) => void,
  ): RemoteOperationWatchSession {
    const session = new WatchSession(ctx, this.#registry, send, () => {
      this.#sessions.delete(session);
    });
    this.#sessions.add(session);
    return session;
  }

  notifyCommit(partition: string, commit: StoredCommit): void {
    const tables = new Set(commit.changes.map((change) => change.table));
    for (const session of this.#sessions) {
      if (session.partition === partition) session.notify(tables);
    }
  }
}

/** Fan one applied commit into sync deltas and registered query watches. */
export function composeRealtimeNotifiers(
  ...notifiers: readonly RealtimeNotifier[]
): RealtimeNotifier {
  return {
    notifyCommit: async (partition, commit) => {
      await Promise.all(
        notifiers.map((notifier) => notifier.notifyCommit(partition, commit)),
      );
    },
  };
}
