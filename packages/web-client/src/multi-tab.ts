/**
 * Multi-tab followers (TODO 3.2, REVISE B3): one core per origin, N tabs.
 *
 * The leader tab holds the Web Locks lease and runs the worker core (the
 * existing worker-host path, unchanged). Every OTHER tab is a FOLLOWER: it
 * loses the lock election and, instead of a dead not-leader handle, opens a
 * BroadcastChannel to the leader and proxies the whole logical API over it —
 * one sync loop, one WebSocket, one DB, N tabs.
 *
 * Wire (all messages structured-clone-safe; `Set`/`Uint8Array`/`ArrayBuffer`
 * survive `postMessage` on a BroadcastChannel):
 *
 *   follower → leader
 *     hello  {t,epoch?,fromId}                — "who's the leader?" on join
 *     req    {t,epoch,fromId,reqId,method,args}
 *     bye    {t,fromId}                        — follower leaving (best effort)
 *   leader → all
 *     announce {t,epoch,clientId}             — "I am the leader, this epoch"
 *     res      {t,epoch,reqId,ok,value|error} — reply to one req
 *     event    {t,epoch,event}                — fan-out (invalidate/presence/…)
 *
 * Epoch (leader generation token): a monotonic counter carried in a shared
 * BroadcastChannel and bumped by every promotion. Followers stamp requests
 * with the epoch they last heard in an `announce`; a leader ignores requests
 * from a stale epoch, and a follower discards any `res`/`event` that does not
 * match its current epoch — so a late reply from a tab that has since died
 * (or a duplicate from a previous leader) can never be mistaken for a live
 * one. Epoch is derived deterministically from a per-origin clock: each
 * promoter reads the highest epoch it has seen and adds one, so successive
 * leaders always strictly increase it even across the lock-handover gap.
 *
 * Presence identity: all tabs share the leader's one connection, so a device
 * is exactly ONE presence peer collectively — `(actorId, leaderClientId)`.
 * A follower's `setPresence` forwards to the leader's single publisher; there
 * is no per-tab presence peer (documented in the web-client README).
 */
import { ClientSyncError } from './errors';
import type { SyncWorkerEvent } from './worker-protocol';
import { WORKER_FAILED_CODE } from './worker-protocol';

/** Client-local: a follower call could not reach a leader before its deadline. */
export const FOLLOWER_TIMEOUT_CODE = 'client.follower_timeout';

/** Default deadline for a follower request (covers a leader-handover gap). */
export const DEFAULT_FOLLOWER_CALL_TIMEOUT_MS = 10_000;
/** Max follower calls queued across a handover before we fail loudly. */
export const DEFAULT_FOLLOWER_QUEUE_LIMIT = 256;

export type LeadershipState =
  | { readonly state: 'leader'; readonly clientId: string }
  | {
      readonly state: 'follower';
      readonly leaderClientId: string;
      readonly epoch: number;
    }
  | {
      readonly state: 'waiting';
      readonly reason: 'handover' | 'leader-announcement';
    }
  | {
      readonly state: 'blocked';
      readonly reason: 'leader-unreachable';
      readonly code: typeof FOLLOWER_TIMEOUT_CODE;
      readonly retryable: true;
    };

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

interface HelloMessage {
  readonly t: 'hello';
  readonly fromId: string;
  /** Highest epoch the sender has observed (helps a promoter monotonically
   * advance even if it never saw the previous leader's announce). */
  readonly epoch?: number;
}

interface ByeMessage {
  readonly t: 'bye';
  readonly fromId: string;
}

interface BoundMessage {
  readonly t: 'bound';
  readonly fromId: string;
}

interface ReqMessage {
  readonly t: 'req';
  readonly epoch: number;
  readonly fromId: string;
  readonly reqId: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

interface AnnounceMessage {
  readonly t: 'announce';
  readonly epoch: number;
  readonly clientId: string;
}

interface ResMessage {
  readonly t: 'res';
  readonly epoch: number;
  readonly reqId: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { code: string; message: string; retryable: boolean };
}

interface EventMessage {
  readonly t: 'event';
  readonly epoch: number;
  readonly event: SyncWorkerEvent;
}

export type MultiTabMessage =
  | HelloMessage
  | ByeMessage
  | BoundMessage
  | ReqMessage
  | AnnounceMessage
  | ResMessage
  | EventMessage;

/**
 * The tiny cross-tab channel surface we depend on — the DOM `BroadcastChannel`
 * satisfies it. Injectable so bun tests can pair two instances by name.
 */
export interface CrossTabChannel {
  postMessage(message: MultiTabMessage): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: MultiTabMessage }) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: { data: MultiTabMessage }) => void,
  ): void;
  close(): void;
}

/** Default channel factory: a real `BroadcastChannel` named per lock. */
export function broadcastChannelFactory(): (name: string) => CrossTabChannel {
  return (name) => new BroadcastChannel(name) as unknown as CrossTabChannel;
}

/** The channel name a leader and its followers rendezvous on. */
export function multiTabChannelName(lockName: string): string {
  return `syncular-mt:${lockName}`;
}

let uniqueCounter = 0;
/** A per-tab identity for addressing (not a presence identity). */
export function newTabId(): string {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID !== undefined
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `tab-${rand}-${(uniqueCounter++).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Leader side: bridge follower requests into the worker, fan-out events
// ---------------------------------------------------------------------------

/**
 * Runs on the leader tab. Announces leadership, answers follower `req`s by
 * invoking the (already-running) worker via `invoke`, and rebroadcasts every
 * worker event to followers. Owns nothing about the worker lifecycle — the
 * worker-host stays the single core owner; this is a relay.
 */
export class LeaderBridge {
  readonly #channel: CrossTabChannel;
  readonly #epoch: number;
  readonly #clientId: string;
  readonly #invoke: (
    method: string,
    args: readonly unknown[],
  ) => Promise<unknown>;
  readonly #onMessage: (event: { data: MultiTabMessage }) => void;
  readonly #heartbeatMs: number;
  readonly #followers = new Set<string>();
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(options: {
    channel: CrossTabChannel;
    epoch: number;
    clientId: string;
    invoke: (method: string, args: readonly unknown[]) => Promise<unknown>;
    heartbeatMs?: number;
  }) {
    this.#channel = options.channel;
    this.#epoch = options.epoch;
    this.#clientId = options.clientId;
    this.#invoke = options.invoke;
    this.#heartbeatMs =
      options.heartbeatMs ??
      Math.max(50, Math.floor(DEFAULT_FOLLOWER_CALL_TIMEOUT_MS / 3));
    this.#onMessage = (event) => this.#handle(event.data);
    this.#channel.addEventListener('message', this.#onMessage);
    this.announce();
  }

  /** Re-announce leadership (on promotion and on a follower `hello`). */
  announce(): void {
    if (this.#closed) return;
    this.#channel.postMessage({
      t: 'announce',
      epoch: this.#epoch,
      clientId: this.#clientId,
    });
  }

  /** Fan a worker event out to all followers on the current epoch. */
  broadcastEvent(event: SyncWorkerEvent): void {
    if (this.#closed) return;
    this.#channel.postMessage({ t: 'event', epoch: this.#epoch, event });
  }

  #handle(message: MultiTabMessage): void {
    if (this.#closed) return;
    if (message.t === 'hello') {
      // A follower joined (or is contesting) — tell it who leads.
      this.#trackFollower(message.fromId);
      this.announce();
      return;
    }
    if (message.t === 'bound') {
      this.#trackFollower(message.fromId);
      return;
    }
    if (message.t === 'bye') {
      this.#followers.delete(message.fromId);
      if (this.#followers.size === 0 && this.#heartbeat !== undefined) {
        clearInterval(this.#heartbeat);
        this.#heartbeat = undefined;
      }
      return;
    }
    if (message.t !== 'req') return;
    // Ignore requests stamped for a different (dead/older) leader; that
    // follower will re-stamp once it sees our announce.
    if (message.epoch !== this.#epoch) return;
    const { reqId, method, args } = message;
    this.#invoke(method, args).then(
      (value) => {
        this.#channel.postMessage({
          t: 'res',
          epoch: this.#epoch,
          reqId,
          ok: true,
          value,
        });
      },
      (error: unknown) => {
        const shape =
          error instanceof ClientSyncError
            ? {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
              }
            : {
                code: WORKER_FAILED_CODE,
                message:
                  error instanceof Error ? error.message : 'unknown error',
                retryable: false,
              };
        this.#channel.postMessage({
          t: 'res',
          epoch: this.#epoch,
          reqId,
          ok: false,
          error: shape,
        });
      },
    );
  }

  #trackFollower(fromId: string): void {
    this.#followers.add(fromId);
    if (this.#heartbeat !== undefined) return;
    this.#heartbeat = setInterval(() => this.announce(), this.#heartbeatMs);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#channel.removeEventListener('message', this.#onMessage);
    this.#channel.close();
  }
}

// ---------------------------------------------------------------------------
// Follower side: proxy the logical API to the leader over the channel
// ---------------------------------------------------------------------------

interface QueuedCall {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface InFlight {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Runs on a follower tab. Sends `req`s to the leader and settles them on the
 * matching `res`; queues calls (bounded, timed) while no leader is bound (the
 * handover gap) and flushes them once an `announce` binds a new leader.
 * Feeds fanned-out events to `onEvent`. Learns leadership changes and hands
 * the resolved leader `clientId` back through `onLeaderChange`.
 */
export class FollowerLink {
  readonly #channel: CrossTabChannel;
  readonly #fromId: string;
  readonly #onEvent: (event: SyncWorkerEvent) => void;
  readonly #onLeaderChange: (clientId: string) => void;
  readonly #onStateChange: (state: LeadershipState) => void;
  readonly #callTimeoutMs: number;
  readonly #queueLimit: number;
  readonly #onMessage: (event: { data: MultiTabMessage }) => void;

  /** -1 until the first `announce` binds us to a leader. */
  #epoch = -1;
  /** Highest epoch ever seen (survives a leader gap for monotonic promotion). */
  #maxEpochSeen = -1;
  #leaderClientId = '';
  #nextReqId = 1;
  readonly #inFlight = new Map<number, InFlight>();
  #queue: QueuedCall[] = [];
  #closed = false;
  #state: LeadershipState = {
    state: 'waiting',
    reason: 'leader-announcement',
  };
  #waitingTimer: ReturnType<typeof setTimeout> | undefined;
  #blockedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Resolvers waiting for the first `announce` to bind a leader. */
  #bindWaiters: Array<() => void> = [];

  constructor(options: {
    channel: CrossTabChannel;
    fromId: string;
    onEvent: (event: SyncWorkerEvent) => void;
    onLeaderChange: (clientId: string) => void;
    onStateChange?: (state: LeadershipState) => void;
    callTimeoutMs?: number;
    queueLimit?: number;
  }) {
    this.#channel = options.channel;
    this.#fromId = options.fromId;
    this.#onEvent = options.onEvent;
    this.#onLeaderChange = options.onLeaderChange;
    this.#onStateChange = options.onStateChange ?? (() => {});
    this.#callTimeoutMs =
      options.callTimeoutMs ?? DEFAULT_FOLLOWER_CALL_TIMEOUT_MS;
    this.#queueLimit = options.queueLimit ?? DEFAULT_FOLLOWER_QUEUE_LIMIT;
    this.#onMessage = (event) => this.#handle(event.data);
    this.#channel.addEventListener('message', this.#onMessage);
    // Ask the current leader to announce itself.
    this.#channel.postMessage({ t: 'hello', fromId: this.#fromId });
    this.#armUnboundDeadline();
  }

  get epoch(): number {
    return this.#epoch;
  }

  get maxEpochSeen(): number {
    return this.#maxEpochSeen;
  }

  get leaderClientId(): string {
    return this.#leaderClientId;
  }

  get leadershipState(): LeadershipState {
    return this.#state;
  }

  /** Whether a leader is currently bound (an announce has been heard). */
  get bound(): boolean {
    return this.#epoch >= 0;
  }

  /**
   * Resolve once the link is bound to a leader (the first `announce` arrived),
   * or reject if `timeoutMs` elapses first. A caller awaits this before
   * treating the follower as ready: until an announce is processed the link's
   * epoch is -1, so any fanned-out `event` in that window is dropped (an
   * unbound follower cannot match the leader's epoch). Awaiting binding closes
   * that gap — a just-opened follower tab never misses an invalidation emitted
   * between its `hello` and the leader's `announce`. Resolves synchronously
   * when already bound.
   */
  waitUntilBound(timeoutMs = this.#callTimeoutMs): Promise<void> {
    if (this.#epoch >= 0) return Promise.resolve();
    if (this.#closed) {
      return Promise.reject(
        new ClientSyncError(WORKER_FAILED_CODE, 'the follower link is closed'),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#dropBindWaiter(settle);
        this.#setBlocked();
        reject(
          new ClientSyncError(
            FOLLOWER_TIMEOUT_CODE,
            'no leader announced within the follower bind timeout',
            true,
          ),
        );
      }, timeoutMs);
      const settle = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.#bindWaiters.push(settle);
    });
  }

  #dropBindWaiter(waiter: () => void): void {
    const index = this.#bindWaiters.indexOf(waiter);
    if (index >= 0) this.#bindWaiters.splice(index, 1);
  }

  #resolveBindWaiters(): void {
    if (this.#bindWaiters.length === 0) return;
    const waiters = this.#bindWaiters;
    this.#bindWaiters = [];
    for (const settle of waiters) settle();
  }

  /** Forward one logical API call to the leader (queued if unbound). */
  call(method: string, args: readonly unknown[]): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(
        new ClientSyncError(WORKER_FAILED_CODE, 'the follower link is closed'),
      );
    }
    if (this.#state.state === 'blocked') {
      return Promise.reject(
        new ClientSyncError(
          FOLLOWER_TIMEOUT_CODE,
          'the follower cannot reach the tab that owns the database',
          true,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const queued: QueuedCall = {
        method,
        args,
        resolve,
        reject,
        timer: undefined,
      };
      if (this.#epoch < 0) {
        // No leader bound yet — queue with a deadline so we never hang.
        if (this.#queue.length >= this.#queueLimit) {
          this.#setBlocked();
          reject(
            new ClientSyncError(
              FOLLOWER_TIMEOUT_CODE,
              'follower call queue overflow while awaiting a leader',
              true,
            ),
          );
          return;
        }
        queued.timer = setTimeout(() => {
          this.#dropQueued(queued);
          this.#setBlocked();
          reject(
            new ClientSyncError(
              FOLLOWER_TIMEOUT_CODE,
              'no leader answered within the follower call timeout',
              true,
            ),
          );
        }, this.#callTimeoutMs);
        this.#queue.push(queued);
        return;
      }
      this.#send(queued);
    });
  }

  #send(queued: QueuedCall): void {
    const reqId = this.#nextReqId++;
    const inflight: InFlight = {
      resolve: queued.resolve,
      reject: queued.reject,
      timer: setTimeout(() => {
        this.#inFlight.delete(reqId);
        this.#setBlocked();
        queued.reject(
          new ClientSyncError(
            FOLLOWER_TIMEOUT_CODE,
            'the leader did not answer within the follower call timeout',
            true,
          ),
        );
      }, this.#callTimeoutMs),
    };
    this.#inFlight.set(reqId, inflight);
    this.#channel.postMessage({
      t: 'req',
      epoch: this.#epoch,
      fromId: this.#fromId,
      reqId,
      method: queued.method,
      args: queued.args,
    });
  }

  #dropQueued(queued: QueuedCall): void {
    const index = this.#queue.indexOf(queued);
    if (index >= 0) this.#queue.splice(index, 1);
  }

  #handle(message: MultiTabMessage): void {
    if (this.#closed) return;
    if (message.t === 'announce') {
      if (message.epoch > this.#maxEpochSeen) {
        this.#maxEpochSeen = message.epoch;
      }
      // Ignore a stale announce (older than the leader we already track).
      if (message.epoch < this.#epoch) return;
      const changed =
        message.epoch !== this.#epoch ||
        message.clientId !== this.#leaderClientId;
      this.#epoch = message.epoch;
      this.#leaderClientId = message.clientId;
      if (changed) this.#onLeaderChange(message.clientId);
      this.#setState({
        state: 'follower',
        leaderClientId: message.clientId,
        epoch: message.epoch,
      });
      this.#armBoundDeadline();
      if (changed) {
        this.#channel.postMessage({ t: 'bound', fromId: this.#fromId });
      }
      this.#resolveBindWaiters();
      this.#flushQueue();
      return;
    }
    if (message.t === 'res') {
      // Discard a reply for a stale epoch — the leader that produced it is
      // gone; the request (if still pending) is being retried elsewhere.
      if (message.epoch !== this.#epoch) return;
      const inflight = this.#inFlight.get(message.reqId);
      if (inflight === undefined) return;
      this.#inFlight.delete(message.reqId);
      if (inflight.timer !== undefined) clearTimeout(inflight.timer);
      if (message.ok) {
        inflight.resolve(message.value);
      } else {
        const err = message.error;
        inflight.reject(
          new ClientSyncError(
            err?.code ?? WORKER_FAILED_CODE,
            err?.message ?? 'follower request failed',
            err?.retryable ?? false,
          ),
        );
      }
      return;
    }
    if (message.t === 'event') {
      if (message.epoch !== this.#epoch) return;
      this.#onEvent(message.event);
      return;
    }
  }

  /** A new leader bound: re-send everything that was waiting for one. */
  #flushQueue(): void {
    const pending = this.#queue;
    this.#queue = [];
    for (const queued of pending) {
      if (queued.timer !== undefined) clearTimeout(queued.timer);
      queued.timer = undefined;
      this.#send(queued);
    }
  }

  /**
   * The leader we were bound to went away (its lock released). Un-bind so new
   * calls queue again; re-request an announce so the next leader finds us.
   * In-flight calls stay pending — their per-call timeout is the backstop,
   * and the winner's announce will flush any that were queued.
   */
  unbind(): void {
    if (this.#closed) return;
    this.#epoch = -1;
    this.#leaderClientId = '';
    this.#setState({ state: 'waiting', reason: 'handover' });
    this.#armUnboundDeadline();
    this.#channel.postMessage({
      t: 'hello',
      fromId: this.#fromId,
      epoch: this.#maxEpochSeen,
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearReachabilityTimers();
    this.#channel.removeEventListener('message', this.#onMessage);
    this.#channel.postMessage({ t: 'bye', fromId: this.#fromId });
    const closedError = new ClientSyncError(
      WORKER_FAILED_CODE,
      'the follower link was closed',
    );
    for (const inflight of this.#inFlight.values()) {
      if (inflight.timer !== undefined) clearTimeout(inflight.timer);
      inflight.reject(closedError);
    }
    this.#inFlight.clear();
    for (const queued of this.#queue) {
      if (queued.timer !== undefined) clearTimeout(queued.timer);
      queued.reject(closedError);
    }
    this.#queue = [];
    // Bind waiters carry their own timeout timers; resolving them here lets an
    // awaiting boot path settle promptly instead of hanging until that timeout.
    this.#resolveBindWaiters();
    this.#channel.close();
  }

  #setState(state: LeadershipState): void {
    const previous = this.#state;
    if (
      previous.state === state.state &&
      (state.state === 'blocked' ||
        (state.state === 'waiting' &&
          previous.state === 'waiting' &&
          previous.reason === state.reason) ||
        (state.state === 'follower' &&
          previous.state === 'follower' &&
          previous.epoch === state.epoch &&
          previous.leaderClientId === state.leaderClientId))
    ) {
      return;
    }
    this.#state = state;
    try {
      this.#onStateChange(state);
    } catch {
      // A status listener must never break cross-tab coordination.
    }
  }

  #setBlocked(): void {
    this.#clearReachabilityTimers();
    this.#setState({
      state: 'blocked',
      reason: 'leader-unreachable',
      code: FOLLOWER_TIMEOUT_CODE,
      retryable: true,
    });
  }

  #armUnboundDeadline(): void {
    this.#clearReachabilityTimers();
    this.#blockedTimer = setTimeout(
      () => this.#setBlocked(),
      this.#callTimeoutMs,
    );
  }

  #armBoundDeadline(): void {
    this.#clearReachabilityTimers();
    this.#waitingTimer = setTimeout(
      () => {
        this.#setState({ state: 'waiting', reason: 'leader-announcement' });
      },
      Math.max(1, Math.floor((this.#callTimeoutMs * 2) / 3)),
    );
    this.#blockedTimer = setTimeout(
      () => this.#setBlocked(),
      this.#callTimeoutMs,
    );
  }

  #clearReachabilityTimers(): void {
    if (this.#waitingTimer !== undefined) clearTimeout(this.#waitingTimer);
    if (this.#blockedTimer !== undefined) clearTimeout(this.#blockedTimer);
    this.#waitingTimer = undefined;
    this.#blockedTimer = undefined;
  }
}
