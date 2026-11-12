import type { SecurityLifecycle } from './client';
import type {
  ClientDiagnosticsConnectivity,
  ClientDiagnosticsListener,
  ClientDiagnosticsSnapshot,
} from './diagnostics';
import { ClientSyncError } from './errors';

type CancelTimer = () => void;

export interface RealtimeSupervisorClient {
  connectRealtime(): Promise<void>;
  disconnectRealtime(): void | Promise<void>;
  syncUntilIdle(maxRounds?: number): unknown | Promise<unknown>;
  diagnosticsSnapshot():
    | ClientDiagnosticsSnapshot
    | Promise<ClientDiagnosticsSnapshot>;
  onDiagnostics(listener: ClientDiagnosticsListener): () => void;
  close(): void | Promise<void>;
}

export interface RealtimeSupervisorSignal<State> {
  current(): State;
  subscribe(listener: (state: State) => void): () => void;
}

export type RealtimeSupervisorLifecycleState =
  | 'active'
  | 'background'
  | 'unknown';
export type RealtimeSupervisorProtectionState = SecurityLifecycle | 'unknown';
type RealtimeSuspendedPhase = 'offline' | 'background' | 'protected';

export type RealtimeSupervisorPhase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | RealtimeSuspendedPhase
  | 'unsupported'
  | 'stopped';

export interface RealtimeSupervisorSnapshot {
  readonly phase: RealtimeSupervisorPhase;
  /** One-based for retries; zero for the initial connection. */
  readonly attempt: number;
  /** Bounded host-policy delay, never server or transport prose. */
  readonly retryDelayMs?: number;
  /** The latched failure of phase `unsupported` (or `stopped`). */
  readonly failureCode?: RealtimeSupervisorFailureCode;
}

/** SPEC §10.3: client-local supervisor failures, never on the wire. */
export type RealtimeSupervisorFailureCode =
  | 'realtime.diagnostics_unavailable'
  | 'realtime.disconnect_failed'
  | 'realtime.cleanup_failed';

export interface RealtimeSupervisorOptions {
  /**
   * Host online/offline evidence, the only connectivity the supervisor
   * trusts: a failed round does not suspend it. Unknown remains connectable
   * and observable. Each `online` report drives `syncUntilIdle` while no
   * socket is connected, so work a failed round left behind resumes without
   * realtime.
   */
  readonly connectivity?: RealtimeSupervisorSignal<ClientDiagnosticsConnectivity>;
  /** Browser/native foreground evidence. Background suspends a tab-owned
   * socket; with `sharedTransport` it only serves as a resume nudge. */
  readonly lifecycle?: RealtimeSupervisorSignal<RealtimeSupervisorLifecycleState>;
  /**
   * The client's realtime transport is shared with sibling tabs or webviews
   * (multi-tab handles proxying to one leader socket, native cores behind
   * several views). Backgrounding THIS view then keeps the socket open,
   * because a sibling may still be visible and a follower's disconnect would
   * tear down realtime for everyone. Offline and protection evidence still
   * suspend.
   */
  readonly sharedTransport?: boolean;
  /** Publish preflight before draining keys so reconnect stops in the same turn. */
  readonly protection?: RealtimeSupervisorSignal<RealtimeSupervisorProtectionState>;
  /** Deterministic test/host timer seam. */
  readonly schedule?: (callback: () => void, delayMs: number) => CancelTimer;
  readonly random?: () => number;
  readonly initialDelayMs?: number;
  readonly maximumDelayMs?: number;
}

export interface RealtimeSupervisorEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface BrowserConnectivitySignalOptions {
  readonly events?: RealtimeSupervisorEventTarget;
  readonly network?: { readonly onLine?: boolean };
}

export interface DocumentLifecycleSignalOptions {
  readonly events?: RealtimeSupervisorEventTarget;
  readonly document?: { readonly visibilityState?: string };
}

const REALTIME_SUPERVISOR_KEY = Symbol.for('syncular.realtime-supervisor.v1');
const CLEANUP_FAILED = 'realtime.cleanup_failed';
const DIAGNOSTICS_UNAVAILABLE = 'realtime.diagnostics_unavailable';
const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAXIMUM_DELAY_MS = 30_000;
const MAXIMUM_CONFIGURED_DELAY_MS = 300_000;
const UNSUPPORTED_SNAPSHOT: RealtimeSupervisorSnapshot = Object.freeze({
  phase: 'unsupported',
  attempt: 0,
});

interface RealtimeSupervisorAttachment {
  readonly version: 1;
  readonly supervisor: RealtimeSupervisor;
}

function attachment(client: object): RealtimeSupervisorAttachment | undefined {
  const candidate = Reflect.get(client, REALTIME_SUPERVISOR_KEY) as
    | Partial<RealtimeSupervisorAttachment>
    | undefined;
  if (candidate?.version === 1 && candidate.supervisor) {
    return candidate as RealtimeSupervisorAttachment;
  }
  return undefined;
}

function scheduleTimer(callback: () => void, delayMs: number): CancelTimer {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}

function boundedDelay(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      'realtime supervisor delays must be positive safe integers',
    );
  }
  return Math.min(value, MAXIMUM_CONFIGURED_DELAY_MS);
}

function eventTarget(
  value: unknown,
): RealtimeSupervisorEventTarget | undefined {
  const candidate = value as Partial<RealtimeSupervisorEventTarget> | undefined;
  return typeof candidate?.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
    ? (candidate as RealtimeSupervisorEventTarget)
    : undefined;
}

/** Browser/Tauri-webview connectivity evidence without importing DOM types. */
export function browserConnectivitySignal(
  options: BrowserConnectivitySignalOptions = {},
): RealtimeSupervisorSignal<ClientDiagnosticsConnectivity> {
  const root = globalThis as { navigator?: { readonly onLine?: boolean } };
  const events = options.events ?? eventTarget(globalThis);
  const network = options.network ?? root.navigator;
  const current = (): ClientDiagnosticsConnectivity => {
    if (network?.onLine === true) return 'online';
    if (network?.onLine === false) return 'offline';
    return 'unknown';
  };
  return {
    current,
    subscribe(listener) {
      if (events === undefined) return () => undefined;
      const notify = () => listener(current());
      events.addEventListener('online', notify);
      events.addEventListener('offline', notify);
      return () => {
        events.removeEventListener('online', notify);
        events.removeEventListener('offline', notify);
      };
    },
  };
}

/** Browser/Tauri-webview visibility evidence without importing DOM types. */
export function documentLifecycleSignal(
  options: DocumentLifecycleSignalOptions = {},
): RealtimeSupervisorSignal<RealtimeSupervisorLifecycleState> {
  const root = globalThis as {
    document?: { readonly visibilityState?: string };
  };
  const document = options.document ?? root.document;
  const events = options.events ?? eventTarget(document);
  const classify = (): RealtimeSupervisorLifecycleState => {
    if (document?.visibilityState === 'visible') return 'active';
    if (document?.visibilityState === 'hidden') return 'background';
    return 'unknown';
  };
  let state = classify();
  return {
    current: () => state,
    subscribe(listener) {
      if (events === undefined) return () => undefined;
      const visibility = () => {
        state = classify();
        listener(state);
      };
      const background = () => {
        state = 'background';
        listener(state);
      };
      const active = () => {
        state = classify() === 'background' ? 'background' : 'active';
        listener(state);
      };
      events.addEventListener('visibilitychange', visibility);
      events.addEventListener('pagehide', background);
      events.addEventListener('pageshow', active);
      return () => {
        events.removeEventListener('visibilitychange', visibility);
        events.removeEventListener('pagehide', background);
        events.removeEventListener('pageshow', active);
      };
    },
  };
}

/** A Syncular code (§10.3 families) on an own data property, else `unknown`. */
function causeCode(error: unknown): string {
  try {
    const value =
      typeof error === 'object' && error !== null
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value
        : undefined;
    return typeof value === 'string' &&
      /^(?:sync|client|transport|realtime)\.[a-z0-9_]+$/.test(value)
      ? value
      : 'unknown';
  } catch {
    // A hostile value (a throwing proxy) carries no code.
    return 'unknown';
  }
}

/** SPEC §8.4: a stable-coded error the client marked `retryable`, read without getters. */
function retryable(error: unknown): boolean {
  try {
    return (
      causeCode(error) !== 'unknown' &&
      Object.getOwnPropertyDescriptor(error, 'retryable')?.value === true
    );
  } catch {
    return false;
  }
}

/**
 * SPEC §8.4: a supervisor failure. `code` is the latest latched failure, or
 * `realtime.cleanup_failed` when only a cancel threw. Every failure of the
 * lifetime is also named in its own field. Cause codes are Syncular codes or
 * `unknown`; no message or original error is retained.
 */
export class RealtimeSupervisorError extends ClientSyncError {
  override readonly name = 'RealtimeSupervisorError';
  declare readonly code: RealtimeSupervisorFailureCode;
  declare readonly cleanupFailureCode?: 'realtime.cleanup_failed';
  declare readonly diagnosticsFailureCode?: 'realtime.diagnostics_unavailable';
  /** The code the client's `disconnectRealtime` rejected with. */
  declare readonly disconnectCauseCode?: string;
  /** Set by the installed `close()` when the client close failed as well. */
  declare readonly stopFailureCode?: RealtimeSupervisorFailureCode;
  declare readonly closeFailureCode?: string;

  constructor(
    code: RealtimeSupervisorFailureCode,
    fields: Omit<Partial<RealtimeSupervisorError>, 'code'> = {},
  ) {
    super(code, code);
    Object.assign(this, fields);
  }
}

/**
 * Supported host policy for Syncular's explicit realtime transport (§8.4). It
 * owns one attempt at a time: a connect, then an explicit catch-up round
 * before it claims connected. A successor never starts before the previous
 * attempt and its disconnect settle. Transient loss retries with bounded
 * exponential jitter, and the backoff survives offline, background and
 * protected suspensions. While no socket is connected, each failed connect,
 * each host `online` report and each foreground return drives one HTTP round
 * (§1.8). A disconnect, diagnostics or cleanup failure latches phase
 * `unsupported` with its `failureCode`, and `stop()` rejects with it.
 */
export class RealtimeSupervisor {
  readonly #client: RealtimeSupervisorClient;
  readonly #connectivity?: RealtimeSupervisorOptions['connectivity'];
  readonly #lifecycle?: RealtimeSupervisorOptions['lifecycle'];
  readonly #protection?: RealtimeSupervisorOptions['protection'];
  readonly #sharedTransport: boolean;
  readonly #scheduleTimer: NonNullable<RealtimeSupervisorOptions['schedule']>;
  readonly #random: () => number;
  readonly #initialDelayMs: number;
  readonly #maximumDelayMs: number;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribers: (() => void)[] = [];

  #started = false;
  #initialized = false;
  #stopped = false;
  #stopping: Promise<void> | undefined;
  #supported = true;
  /** The client refused a connect with `sync.offline`: its transport gate is closed. */
  #gateClosed = false;
  #diagnosticSecurity: RealtimeSupervisorProtectionState = 'unknown';
  #diagnosticRevision = 0;
  /** A socket is open, whether this supervisor or the host opened it. */
  #transport = false;
  /** The open socket completed its catch-up round. */
  #connected = false;
  #attempt = 0;
  /** The delay of the counted retry; zero schedules an immediate attempt. */
  #delayMs = 0;
  /** Bumped by every suspension, failure and stop; a stale attempt only cleans up. */
  #generation = 0;
  #disconnectedGeneration = -1;
  #cancelTimer: CancelTimer | undefined;
  #attemptJob: Promise<void> | undefined;
  #disconnecting: Promise<void> | undefined;
  #round: Promise<void> | undefined;
  #roundAgain = false;
  #failure: RealtimeSupervisorFailureCode | undefined;
  /** Every failure of the lifetime, named for the stop rejection. */
  readonly #failures: {
    cleanupFailureCode?: 'realtime.cleanup_failed';
    diagnosticsFailureCode?: 'realtime.diagnostics_unavailable';
    disconnectCauseCode?: string;
  } = {};
  #snapshot: RealtimeSupervisorSnapshot = { phase: 'idle', attempt: 0 };

  constructor(
    client: RealtimeSupervisorClient,
    options: RealtimeSupervisorOptions = {},
  ) {
    this.#client = client;
    this.#connectivity = options.connectivity;
    this.#lifecycle = options.lifecycle;
    this.#protection = options.protection;
    this.#sharedTransport = options.sharedTransport === true;
    this.#scheduleTimer = options.schedule ?? scheduleTimer;
    this.#random = options.random ?? Math.random;
    this.#initialDelayMs = boundedDelay(
      options.initialDelayMs,
      DEFAULT_INITIAL_DELAY_MS,
    );
    this.#maximumDelayMs = Math.max(
      this.#initialDelayMs,
      boundedDelay(options.maximumDelayMs, DEFAULT_MAXIMUM_DELAY_MS),
    );
  }

  snapshot(): RealtimeSupervisorSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#unsubscribers.push(
      this.#client.onDiagnostics((snapshot) => {
        this.#diagnosticRevision += 1;
        this.#observe(snapshot);
      }),
    );
    const connectivity = this.#connectivity?.subscribe((state) => {
      this.#reconcile();
      if (state === 'online') this.#drive();
    });
    const lifecycle = this.#lifecycle?.subscribe((state) => {
      this.#reconcile();
      if (state === 'active') this.#drive();
    });
    const protection = this.#protection?.subscribe(() => this.#reconcile());
    for (const unsubscribe of [connectivity, lifecycle, protection]) {
      if (unsubscribe) this.#unsubscribers.push(unsubscribe);
    }
    this.#reconcile();
    const revision = this.#diagnosticRevision;
    void Promise.resolve()
      .then(() => this.#client.diagnosticsSnapshot())
      .then((snapshot) => {
        if (this.#stopped) return;
        // Initialization belongs to the lifetime; host flaps cannot void it.
        this.#initialized = true;
        // A live report that arrived meanwhile is newer than this read.
        if (revision === this.#diagnosticRevision) {
          this.#observe(snapshot, true);
        }
        this.#reconcile();
      })
      .catch((error: unknown) => {
        if (this.#stopped) return;
        if (!retryable(error)) return this.#fail(DIAGNOSTICS_UNAVAILABLE);
        // A leader handover or follower timeout: start on the retry schedule
        // and let the live reports and the connect result stand in.
        this.#initialized = true;
        this.#retry();
        this.#reconcile();
      });
  }

  /**
   * Cancel the timer and every subscription, release the socket, and settle
   * once the in-flight attempt, its disconnect and any driven round have
   * settled. Rejects with a {@link RealtimeSupervisorError} when a failure
   * latched during the lifetime or a cancel threw; every caller shares it.
   */
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = Promise.resolve().then(async () => {
      await this.#disconnecting;
      await this.#attemptJob;
      await this.#round;
      this.#listeners.clear();
      if (this.#failure) {
        throw new RealtimeSupervisorError(this.#failure, this.#failures);
      }
    });
    this.#stopped = true;
    this.#generation += 1;
    this.#clearTimer();
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        this.#cleanupFailed();
      }
    }
    this.#publish({ phase: 'stopped', attempt: 0 });
    void this.#disconnect();
    return this.#stopping;
  }

  #block(): RealtimeSuspendedPhase | undefined {
    const protection = this.#protection?.current();
    if (
      this.#diagnosticSecurity === 'preflight' ||
      protection === 'preflight' ||
      (this.#protection !== undefined && protection !== 'active')
    ) {
      return 'protected';
    }
    // Host evidence only: a failed round is not connectivity evidence, and
    // treating it as such would hold the supervisor offline after recovery.
    if (this.#gateClosed || this.#connectivity?.current() === 'offline') {
      return 'offline';
    }
    if (!this.#sharedTransport && this.#lifecycle?.current() === 'background') {
      return 'background';
    }
    return undefined;
  }

  /**
   * §1.8: one HTTP round while no socket carries the rounds. A request during
   * a round adds one round after it. The round's failure is the client's
   * round failure, which its progress and status already report.
   */
  #drive(): void {
    if (this.#stopped || this.#connected || this.#block()) return;
    if (this.#round) {
      this.#roundAgain = true;
      return;
    }
    this.#round = Promise.resolve()
      .then(() => this.#client.syncUntilIdle())
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#round = undefined;
        if (!this.#roundAgain) return;
        this.#roundAgain = false;
        this.#drive();
      });
  }

  #publish(snapshot: RealtimeSupervisorSnapshot): void {
    if (JSON.stringify(this.#snapshot) === JSON.stringify(snapshot)) return;
    this.#snapshot = Object.freeze(snapshot);
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Observers cannot alter transport ownership or retry policy.
      }
    }
  }

  /** A cancel threw: name it, and latch it unless a failure already did. */
  #cleanupFailed(): void {
    this.#failures.cleanupFailureCode = CLEANUP_FAILED;
    if (!this.#failure) this.#fail(CLEANUP_FAILED);
  }

  /** False when the host's cancel threw; the timer may still fire. */
  #clearTimer(): boolean {
    const cancel = this.#cancelTimer;
    this.#cancelTimer = undefined;
    try {
      cancel?.();
      return true;
    } catch {
      this.#cleanupFailed();
      return false;
    }
  }

  /** Count one failed attempt and back off with bounded jitter, once per retry. */
  #retry(): void {
    if (this.#delayMs > 0) return;
    const exponential = Math.min(
      this.#maximumDelayMs,
      this.#initialDelayMs * 2 ** this.#attempt,
    );
    const random = this.#random();
    const boundedRandom = Number.isFinite(random)
      ? Math.max(0, Math.min(1, random))
      : 0;
    this.#delayMs = Math.min(
      this.#maximumDelayMs,
      exponential + Math.floor(exponential * 0.25 * boundedRandom),
    );
    this.#attempt = Math.min(32, this.#attempt + 1);
  }

  /** Latch a failure: no further attempt, and the socket is released. */
  #fail(code: RealtimeSupervisorFailureCode): void {
    if (code === DIAGNOSTICS_UNAVAILABLE) {
      this.#failures.diagnosticsFailureCode = code;
    }
    this.#failure = code;
    this.#generation += 1;
    this.#connected = false;
    this.#clearTimer();
    this.#publish({
      phase: this.#stopped ? 'stopped' : 'unsupported',
      attempt: this.#attempt,
      failureCode: code,
    });
    void this.#disconnect();
  }

  /** Converge timer, attempt and socket on the current host evidence. */
  #reconcile(): void {
    if (this.#stopped || this.#failure) return;
    const block = this.#block();
    if (block) {
      if (this.#snapshot.phase !== block) {
        this.#generation += 1;
        // An interrupted attempt counts, so flaps keep the backoff. A gate
        // refusal is the attempt's own result, not an interruption.
        if (this.#attemptJob && !this.#connected && !this.#gateClosed) {
          this.#retry();
        }
      }
      if (!this.#clearTimer()) return;
      this.#connected = false;
      this.#publish({ phase: block, attempt: this.#attempt });
      void this.#disconnect();
      return;
    }
    if (!this.#supported) {
      return this.#publish({ phase: 'unsupported', attempt: 0 });
    }
    if (!this.#initialized) {
      return this.#publish({ phase: 'idle', attempt: this.#attempt });
    }
    if (this.#connected) {
      return this.#publish({ phase: 'connected', attempt: 0 });
    }
    if (this.#attemptJob || this.#disconnecting) return;
    if (this.#transport) {
      // A socket the host opened is adopted after the same catch-up round.
      if (!this.#clearTimer()) return;
      return this.#run();
    }
    if (this.#cancelTimer) return;
    this.#publish(
      this.#delayMs > 0
        ? {
            phase: 'retrying',
            attempt: this.#attempt,
            retryDelayMs: this.#delayMs,
          }
        : { phase: 'connecting', attempt: this.#attempt },
    );
    this.#cancelTimer = this.#scheduleTimer(() => {
      this.#cancelTimer = undefined;
      if (this.#stopped || this.#failure || this.#attemptJob || this.#block()) {
        return;
      }
      this.#run();
    }, this.#delayMs);
  }

  /** Start the one attempt; it opens a microtask later, so a flap can void it. */
  #run(): void {
    const generation = this.#generation;
    this.#delayMs = 0;
    this.#attemptJob = Promise.resolve().then(() => this.#connect(generation));
  }

  async #connect(generation: number): Promise<void> {
    try {
      if (generation !== this.#generation) return;
      this.#publish({ phase: 'connecting', attempt: this.#attempt });
      let caughtUp = false;
      try {
        if (!this.#transport) {
          await new Promise<void>((resolve) =>
            resolve(this.#client.connectRealtime()),
          ).catch((error: unknown) => {
            if (causeCode(error) === 'sync.offline') this.#gateClosed = true;
            // §1.8: a refused socket still brings one round over HTTP.
            else this.#drive();
            throw error;
          });
          this.#transport = true;
        }
        if (generation === this.#generation) await this.#client.syncUntilIdle();
        caughtUp = generation === this.#generation && this.#transport;
      } catch {
        // A refused socket or a failed catch-up round fails the attempt.
      }
      if (caughtUp) {
        this.#connected = true;
        this.#attempt = 0;
        this.#delayMs = 0;
        this.#publish({ phase: 'connected', attempt: 0 });
        return;
      }
      if (generation === this.#generation && !this.#gateClosed) this.#retry();
      // A stale attempt releases the late socket before a successor may open.
      await this.#disconnect();
    } finally {
      // Settled in the same turn, so a report right after `connected`
      // meets no attempt in flight.
      this.#attemptJob = undefined;
      this.#reconcile();
    }
  }

  /**
   * Release the socket, or void an attempt in flight, once per generation.
   * `#disconnecting` is set before the call, so diagnostics the call emits
   * synchronously see the teardown and schedule no retry.
   */
  #disconnect(): Promise<void> {
    if (this.#disconnecting) return this.#disconnecting;
    if (
      !this.#transport &&
      (!this.#attemptJob || this.#disconnectedGeneration === this.#generation)
    ) {
      return Promise.resolve();
    }
    this.#disconnectedGeneration = this.#generation;
    this.#transport = false;
    this.#connected = false;
    this.#disconnecting = Promise.resolve();
    this.#disconnecting = new Promise<void>((resolve) =>
      resolve(this.#client.disconnectRealtime()),
    )
      .catch((error: unknown) => {
        if (retryable(error)) return this.#retry();
        this.#failures.disconnectCauseCode = causeCode(error);
        this.#fail('realtime.disconnect_failed');
      })
      .finally(() => {
        this.#disconnecting = undefined;
        this.#reconcile();
      });
    return this.#disconnecting;
  }

  #observe(snapshot: ClientDiagnosticsSnapshot, initial = false): void {
    if (this.#stopped) return;
    this.#diagnosticSecurity = snapshot.securityLifecycle;
    // A closed transport gate always reports offline, so any other report
    // means the app reopened it.
    if (this.#gateClosed && snapshot.host.connectivity !== 'offline') {
      this.#gateClosed = false;
    }
    const realtime = snapshot.host.realtime;
    if (realtime === 'unsupported' || realtime === 'disabled') {
      this.#supported = false;
      this.#generation += 1;
      if (!this.#clearTimer()) return;
      this.#connected = false;
      void this.#disconnect();
    } else if (realtime === 'connected') {
      // A live socket is positive evidence that an earlier 'unsupported'
      // report was transient (a mid-restart capability probe).
      if (this.#failure) return;
      this.#supported = true;
      this.#transport = true;
    } else if (
      realtime === 'disconnected' ||
      realtime === 'lost' ||
      realtime === 'refused'
    ) {
      const held = this.#transport || this.#connected;
      this.#transport = false;
      this.#connected = false;
      if (this.#supported && !this.#disconnecting && !initial) {
        // The attempt in flight owns a loss during its catch-up; a report
        // beside a pending retry keeps that retry's count.
        if (!this.#attemptJob && (held || !this.#cancelTimer)) this.#retry();
      }
    }
    this.#reconcile();
  }
}

/**
 * Install one supervisor and make client disposal stop it before close.
 * Repeated and reentrant `close()` calls share one operation. A client accepts
 * exactly one supervisor for its lifetime; installing a second throws
 * `realtime.supervisor_already_installed`, because silently keeping the first
 * would discard the second call's options.
 */
export function installRealtimeSupervisor<T extends RealtimeSupervisorClient>(
  client: T,
  options?: RealtimeSupervisorOptions,
): T {
  if (attachment(client)) {
    throw new ClientSyncError(
      'realtime.supervisor_already_installed',
      'realtime.supervisor_already_installed',
    );
  }
  const supervisor = new RealtimeSupervisor(client, options);
  // Non-writable, non-enumerable and non-configurable by default.
  Object.defineProperty(client, REALTIME_SUPERVISOR_KEY, {
    value: { version: 1, supervisor } satisfies RealtimeSupervisorAttachment,
  });
  const close = client.close.bind(client);
  let closing: Promise<void> | undefined;
  Object.defineProperty(client, 'close', {
    configurable: true,
    writable: true,
    value: () => {
      if (closing) return closing;
      let stopped: Promise<RealtimeSupervisorError | undefined> | undefined;
      closing = Promise.resolve().then(async () => {
        const stopFailure = await stopped;
        try {
          await close();
        } catch (error) {
          if (stopFailure === undefined) throw error;
          throw new RealtimeSupervisorError(stopFailure.code, {
            ...stopFailure,
            stopFailureCode: stopFailure.code,
            closeFailureCode: causeCode(error),
          });
        }
        if (stopFailure) throw stopFailure;
      });
      // Reentrant closes during the synchronous stop share `closing`.
      stopped = supervisor.stop().then(
        () => undefined,
        (error: RealtimeSupervisorError) => error,
      );
      return closing;
    },
  });
  supervisor.start();
  return client;
}

export function realtimeSupervisorSnapshot(
  client: object,
): RealtimeSupervisorSnapshot {
  return attachment(client)?.supervisor.snapshot() ?? UNSUPPORTED_SNAPSHOT;
}

export function subscribeRealtimeSupervisor(
  client: object,
  listener: () => void,
): () => void {
  return (
    attachment(client)?.supervisor.subscribe(listener) ?? (() => undefined)
  );
}
