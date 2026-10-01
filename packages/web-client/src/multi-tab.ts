/**
 * Multi-tab followers: one core per origin, N tabs.
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
 *     hello  {t,epoch?,fromId,protocol,schemaVersion}
 *                                              — "who's the leader?" on join,
 *                                                and the follower's liveness probe
 *     req    {t,epoch,fromId,reqId,method,args,protocol,schemaVersion}
 *   leader → all
 *     announce {t,epoch,clientId,protocol,schemaVersion}
 *                                              — "I am the leader, this epoch";
 *                                                the answer to every hello
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
 * Identity: every hello, req, and announce carries the sender's
 * {@link MULTI_TAB_PROTOCOL_VERSION} and application schema version. A leader
 * serves only requests with its own identity. A follower whose leader has a
 * different identity goes `blocked` with `leader-incompatible` and sends it
 * nothing. A leader that hears a hello from a newer tab closes its core and
 * releases the lock, so the newer tab takes over. Tabs from before protocol 1
 * send no identity and count as older.
 *
 * Liveness is follower-driven: the leader runs no timer. Browsers throttle
 * the timers of a hidden tab (Chrome's intensive throttling wakes them about
 * once a minute) but still dispatch its BroadcastChannel messages, so a leader
 * heartbeat misses its schedule in a background leader tab while that tab is
 * alive. Instead, a bound follower that has heard no `announce` for a third of
 * its call timeout posts a `hello`, and goes `blocked` only when that probe
 * stays unanswered for the rest of the timeout. A leader tab whose main thread
 * processes no messages (hung or frozen) therefore still blocks its followers
 * within `callTimeoutMs`, and a closed leader hands over through the lock.
 * A forwarded call has no deadline of its own: a live leader may run it behind
 * a long sync round, exactly as it runs its own tab's calls. It rejects when
 * the link blocks, when another leader announces, or when the link closes.
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

/** Client-local: the leader runs a different protocol or schema version. */
export const LEADER_INCOMPATIBLE_CODE = 'client.leader_incompatible';

/** Client-local: the leader that received a call stopped leading before it answered. */
export const LEADER_HANDOVER_CODE = 'client.leader_handover';

/**
 * Version of the leader/follower wire and the forwarded handle API. Bump it
 * with every change to a message shape or to a forwarded method's arguments
 * or result, so tabs of different builds never serve each other.
 */
export const MULTI_TAB_PROTOCOL_VERSION = 1;

/** What a tab must share with its leader to be served by it. */
export interface TabIdentity {
  readonly protocol: number;
  readonly schemaVersion: number;
}

/**
 * Order a peer's identity against our own: -1 older, 0 same, 1 newer. A peer
 * from before protocol 1 sends no identity and is older.
 */
export function compareTabIdentity(
  peer: { readonly protocol?: number; readonly schemaVersion?: number },
  own: TabIdentity,
): -1 | 0 | 1 {
  if (peer.protocol === undefined || peer.schemaVersion === undefined)
    return -1;
  if (peer.protocol !== own.protocol)
    return peer.protocol < own.protocol ? -1 : 1;
  if (peer.schemaVersion !== own.schemaVersion)
    return peer.schemaVersion < own.schemaVersion ? -1 : 1;
  return 0;
}

/** Default deadline for a call queued while no leader is bound (the handover gap). */
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
    }
  | {
      readonly state: 'blocked';
      readonly reason: 'leader-incompatible';
      readonly code: typeof LEADER_INCOMPATIBLE_CODE;
      /** Whether the tab holding the database runs an older or a newer build. */
      readonly leader: 'older' | 'newer';
      readonly retryable: true;
    };

// ---------------------------------------------------------------------------
// Wire messages
// ---------------------------------------------------------------------------

/** Identity fields; absent in messages from tabs before protocol 1. */
interface IdentityFields {
  readonly protocol?: number;
  readonly schemaVersion?: number;
}

interface HelloMessage extends IdentityFields {
  readonly t: 'hello';
  readonly fromId: string;
  /** Highest epoch the sender has observed (helps a promoter monotonically
   * advance even if it never saw the previous leader's announce). */
  readonly epoch?: number;
}

interface ReqMessage extends IdentityFields {
  readonly t: 'req';
  readonly epoch: number;
  readonly fromId: string;
  readonly reqId: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

interface AnnounceMessage extends IdentityFields {
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
 * worker-host stays the single core owner; this is a relay. A hello from a
 * newer tab calls `onNewerTab`, whose owner closes the core and releases the
 * lock.
 */
export class LeaderBridge {
  readonly #channel: CrossTabChannel;
  readonly #epoch: number;
  readonly #clientId: string;
  readonly #identity: TabIdentity;
  readonly #invoke: (
    method: string,
    args: readonly unknown[],
  ) => Promise<unknown>;
  readonly #onNewerTab: () => void;
  readonly #onMessage: (event: { data: MultiTabMessage }) => void;
  #closed = false;

  constructor(options: {
    channel: CrossTabChannel;
    epoch: number;
    clientId: string;
    identity: TabIdentity;
    invoke: (method: string, args: readonly unknown[]) => Promise<unknown>;
    onNewerTab: () => void;
  }) {
    this.#channel = options.channel;
    this.#epoch = options.epoch;
    this.#clientId = options.clientId;
    this.#identity = options.identity;
    this.#invoke = options.invoke;
    this.#onNewerTab = options.onNewerTab;
    this.#onMessage = (event) => this.#handle(event.data);
    this.#channel.addEventListener('message', this.#onMessage);
    this.announce();
  }

  /** Announce leadership (on promotion and in answer to every `hello`). */
  announce(): void {
    if (this.#closed) return;
    this.#channel.postMessage({
      t: 'announce',
      epoch: this.#epoch,
      clientId: this.#clientId,
      ...this.#identity,
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
      // A newer tab takes over; any other follower learns who leads.
      if (compareTabIdentity(message, this.#identity) > 0) {
        this.close();
        this.#onNewerTab();
        return;
      }
      this.announce();
      return;
    }
    if (message.t !== 'req') return;
    // Ignore requests stamped for a different (dead/older) leader; that
    // follower will re-stamp once it sees our announce.
    if (message.epoch !== this.#epoch) return;
    const { reqId, method, args } = message;
    if (compareTabIdentity(message, this.#identity) !== 0) {
      this.#channel.postMessage({
        t: 'res',
        epoch: this.#epoch,
        reqId,
        ok: false,
        error: {
          code: LEADER_INCOMPATIBLE_CODE,
          message: 'the leader runs a different protocol or schema version',
          retryable: true,
        },
      });
      return;
    }
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

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel.removeEventListener('message', this.#onMessage);
    this.#channel.close();
  }
}

// ---------------------------------------------------------------------------
// Follower side: proxy the logical API to the leader over the channel
// ---------------------------------------------------------------------------

/**
 * Timer seam for {@link FollowerLink}: run `callback` after `delayMs` and
 * return a function that cancels it. Tests inject a manual clock.
 */
type FollowerSchedule = (callback: () => void, delayMs: number) => () => void;

interface QueuedCall {
  readonly method: string;
  readonly args: readonly unknown[];
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  cancelTimer: (() => void) | undefined;
}

interface InFlight {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Runs on a follower tab. Sends `req`s to the leader and settles them on the
 * matching `res`; queues calls (bounded, timed) while no leader is bound (the
 * handover gap) and flushes them once an `announce` binds a new leader.
 * Feeds fanned-out events to `onEvent`. Learns leadership changes and hands
 * the resolved leader `clientId` back through `onLeaderChange`. Probes the
 * bound leader with `hello` after a quiet period and reports `blocked` only
 * when a probe goes unanswered, or when the leader's identity differs from
 * this tab's (see the module comment).
 */
export class FollowerLink {
  readonly #channel: CrossTabChannel;
  readonly #fromId: string;
  readonly #identity: TabIdentity;
  readonly #onEvent: (event: SyncWorkerEvent) => void;
  readonly #onLeaderChange: (clientId: string) => void;
  readonly #onStateChange: (state: LeadershipState) => void;
  readonly #callTimeoutMs: number;
  /** Quiet period before a bound follower probes; also the blocked re-probe interval. */
  readonly #probeAfterMs: number;
  readonly #queueLimit: number;
  readonly #schedule: FollowerSchedule;
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
  #cancelProbe: (() => void) | undefined;
  #cancelBlocked: (() => void) | undefined;
  /** Resolvers waiting for the first `announce` to bind a leader. */
  #bindWaiters: Array<() => void> = [];

  constructor(options: {
    channel: CrossTabChannel;
    fromId: string;
    identity: TabIdentity;
    onEvent: (event: SyncWorkerEvent) => void;
    onLeaderChange: (clientId: string) => void;
    onStateChange?: (state: LeadershipState) => void;
    callTimeoutMs?: number;
    queueLimit?: number;
    schedule?: FollowerSchedule;
  }) {
    this.#channel = options.channel;
    this.#fromId = options.fromId;
    this.#identity = options.identity;
    this.#onEvent = options.onEvent;
    this.#onLeaderChange = options.onLeaderChange;
    this.#onStateChange = options.onStateChange ?? (() => {});
    this.#callTimeoutMs =
      options.callTimeoutMs ?? DEFAULT_FOLLOWER_CALL_TIMEOUT_MS;
    this.#probeAfterMs = Math.max(1, Math.floor(this.#callTimeoutMs / 3));
    this.#queueLimit = options.queueLimit ?? DEFAULT_FOLLOWER_QUEUE_LIMIT;
    this.#schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
    this.#onMessage = (event) => this.#handle(event.data);
    this.#channel.addEventListener('message', this.#onMessage);
    this.#armUnboundDeadline();
    // Ask the current leader to announce itself.
    this.#probe();
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
      const cancelTimer = this.#schedule(() => {
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
        cancelTimer();
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
      return Promise.reject(this.#blockedError());
    }
    return new Promise((resolve, reject) => {
      const queued: QueuedCall = {
        method,
        args,
        resolve,
        reject,
        cancelTimer: undefined,
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
        queued.cancelTimer = this.#schedule(() => {
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
    // No deadline: a live leader may queue the call behind a long sync round.
    // The liveness probe, a leader change, or close settles it otherwise.
    this.#inFlight.set(reqId, {
      resolve: queued.resolve,
      reject: queued.reject,
    });
    this.#channel.postMessage({
      t: 'req',
      epoch: this.#epoch,
      fromId: this.#fromId,
      reqId,
      method: queued.method,
      args: queued.args,
      ...this.#identity,
    });
  }

  /** The rejection for a call made while the link is blocked. */
  #blockedError(): ClientSyncError {
    return this.#state.state === 'blocked' &&
      this.#state.reason === 'leader-incompatible'
      ? new ClientSyncError(
          LEADER_INCOMPATIBLE_CODE,
          'the tab that owns the database runs a different protocol or schema version',
          true,
        )
      : new ClientSyncError(
          FOLLOWER_TIMEOUT_CODE,
          'the follower cannot reach the tab that owns the database',
          true,
        );
  }

  /** Reject every forwarded call; their leader will not answer them. */
  #rejectInFlight(error: ClientSyncError): void {
    const pending = [...this.#inFlight.values()];
    this.#inFlight.clear();
    for (const inflight of pending) inflight.reject(error);
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
      const relation = compareTabIdentity(message, this.#identity);
      if (relation !== 0) {
        this.#setIncompatible(relation < 0 ? 'older' : 'newer');
        return;
      }
      const changed =
        message.epoch !== this.#epoch ||
        message.clientId !== this.#leaderClientId;
      // Calls sent to the previous leader get no answer from this one.
      if (changed && this.#epoch >= 0) {
        this.#rejectInFlight(
          new ClientSyncError(
            LEADER_HANDOVER_CODE,
            'the leader changed before it answered the call',
            true,
          ),
        );
      }
      this.#epoch = message.epoch;
      this.#leaderClientId = message.clientId;
      if (changed) this.#onLeaderChange(message.clientId);
      this.#setState({
        state: 'follower',
        leaderClientId: message.clientId,
        epoch: message.epoch,
      });
      this.#armLivenessProbe();
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
      queued.cancelTimer?.();
      queued.cancelTimer = undefined;
      this.#send(queued);
    }
  }

  /**
   * The leader we were bound to went away (its lock released). Un-bind so new
   * calls queue again; re-request an announce so the next leader finds us.
   * Calls in flight to the departed leader reject; the winner's announce
   * flushes the queued ones.
   */
  unbind(): void {
    if (this.#closed) return;
    this.#rejectInFlight(
      new ClientSyncError(
        LEADER_HANDOVER_CODE,
        'the leader released the database before it answered the call',
        true,
      ),
    );
    this.#epoch = -1;
    this.#leaderClientId = '';
    this.#setState({ state: 'waiting', reason: 'handover' });
    this.#armUnboundDeadline();
    this.#probe();
  }

  /**
   * This tab won the lock and runs its own core: calls queued for the next
   * leader run on `invoke` instead of failing, then the link closes.
   */
  handOver(
    invoke: (method: string, args: readonly unknown[]) => Promise<unknown>,
  ): void {
    const queued = this.#queue;
    this.#queue = [];
    for (const call of queued) {
      call.cancelTimer?.();
      invoke(call.method, call.args).then(call.resolve, call.reject);
    }
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearReachabilityTimers();
    this.#channel.removeEventListener('message', this.#onMessage);
    const closedError = new ClientSyncError(
      WORKER_FAILED_CODE,
      'the follower link was closed',
    );
    this.#rejectInFlight(closedError);
    for (const queued of this.#queue) {
      queued.cancelTimer?.();
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
      ((state.state === 'blocked' &&
        previous.state === 'blocked' &&
        previous.reason === state.reason &&
        (state.reason !== 'leader-incompatible' ||
          (previous.reason === 'leader-incompatible' &&
            previous.leader === state.leader))) ||
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

  /** Ask the leader to announce itself; every live leader answers a `hello`. */
  #probe(): void {
    this.#channel.postMessage({
      t: 'hello',
      fromId: this.#fromId,
      epoch: this.#maxEpochSeen,
      ...this.#identity,
    });
  }

  /**
   * The leader runs another build. Send it nothing and stay unbound until a
   * leader with this tab's identity announces (a newer leader's own hello
   * already asked an older one to step down; see the module comment).
   */
  #setIncompatible(leader: 'older' | 'newer'): void {
    this.#clearReachabilityTimers();
    this.#epoch = -1;
    this.#leaderClientId = '';
    this.#setState({
      state: 'blocked',
      reason: 'leader-incompatible',
      code: LEADER_INCOMPATIBLE_CODE,
      leader,
      retryable: true,
    });
    const error = this.#blockedError();
    this.#rejectInFlight(error);
    const queued = this.#queue;
    this.#queue = [];
    for (const call of queued) {
      call.cancelTimer?.();
      call.reject(error);
    }
    this.#resolveBindWaiters();
  }

  /**
   * No leader answered in time. Calls reject immediately from here on; keep
   * probing so a leader that answers again rebinds this link.
   */
  #setBlocked(): void {
    this.#clearReachabilityTimers();
    this.#setState({
      state: 'blocked',
      reason: 'leader-unreachable',
      code: FOLLOWER_TIMEOUT_CODE,
      retryable: true,
    });
    this.#rejectInFlight(this.#blockedError());
    const reprobe = (): void => {
      this.#cancelProbe = this.#schedule(() => {
        reprobe();
        this.#probe();
      }, this.#probeAfterMs);
    };
    reprobe();
  }

  #armUnboundDeadline(): void {
    this.#clearReachabilityTimers();
    this.#cancelBlocked = this.#schedule(
      () => this.#setBlocked(),
      this.#callTimeoutMs,
    );
  }

  /**
   * An announce just proved the leader alive. After a quiet period, probe it;
   * block only if that probe stays unanswered for the rest of the call
   * timeout. The deadline is armed before the probe is posted so a reply that
   * arrives synchronously clears it.
   */
  #armLivenessProbe(): void {
    this.#clearReachabilityTimers();
    this.#cancelProbe = this.#schedule(() => {
      this.#cancelProbe = undefined;
      this.#cancelBlocked = this.#schedule(
        () => this.#setBlocked(),
        this.#callTimeoutMs - this.#probeAfterMs,
      );
      this.#probe();
    }, this.#probeAfterMs);
  }

  #clearReachabilityTimers(): void {
    this.#cancelProbe?.();
    this.#cancelBlocked?.();
    this.#cancelProbe = undefined;
    this.#cancelBlocked = undefined;
  }
}
