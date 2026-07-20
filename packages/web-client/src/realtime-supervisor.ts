import type { SecurityLifecycle } from './client';
import type {
  ClientDiagnosticsConnectivity,
  ClientDiagnosticsListener,
  ClientDiagnosticsSnapshot,
} from './diagnostics';

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
}

export interface RealtimeSupervisorOptions {
  /** Host online/offline evidence. Unknown remains connectable and observable. */
  readonly connectivity?: RealtimeSupervisorSignal<ClientDiagnosticsConnectivity>;
  /** Browser/native foreground evidence. Background always suspends the socket. */
  readonly lifecycle?: RealtimeSupervisorSignal<RealtimeSupervisorLifecycleState>;
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

const observationSources = new WeakMap<object, object>();

function attachment(
  client: object,
  visited: Set<object> = new Set(),
): RealtimeSupervisorAttachment | undefined {
  if (visited.has(client)) return undefined;
  visited.add(client);
  const candidate = Reflect.get(client, REALTIME_SUPERVISOR_KEY) as
    | Partial<RealtimeSupervisorAttachment>
    | undefined;
  if (candidate?.version === 1 && candidate.supervisor) {
    return candidate as RealtimeSupervisorAttachment;
  }
  const source = observationSources.get(client);
  return source === undefined ? undefined : attachment(source, visited);
}

/**
 * Preserve supervisor observation across a facade without transferring
 * transport ownership or exposing the source client. Binding packages use
 * this when they normalize a client into another object identity.
 */
export function linkRealtimeSupervisorObservation<Target extends object>(
  target: Target,
  source: object,
): Target {
  if (target !== source) observationSources.set(target, source);
  return target;
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

/**
 * Supported host policy for Syncular's explicit realtime transport. It owns
 * exactly one connect attempt, runs an explicit catch-up round before claiming
 * connected, retries transient loss with bounded exponential jitter, and
 * suspends across offline, background, or protected-preflight state.
 */
export class RealtimeSupervisor {
  readonly #client: RealtimeSupervisorClient;
  readonly #connectivity?: RealtimeSupervisorOptions['connectivity'];
  readonly #lifecycle?: RealtimeSupervisorOptions['lifecycle'];
  readonly #protection?: RealtimeSupervisorOptions['protection'];
  readonly #scheduleTimer: NonNullable<RealtimeSupervisorOptions['schedule']>;
  readonly #random: () => number;
  readonly #initialDelayMs: number;
  readonly #maximumDelayMs: number;
  readonly #listeners = new Set<() => void>();

  #started = false;
  #initialized = false;
  #stopped = false;
  #connected = false;
  #transportConnected = false;
  #connecting = false;
  #realtimeSupported = true;
  #diagnosticConnectivity: ClientDiagnosticsConnectivity = 'unknown';
  #diagnosticSecurity: RealtimeSupervisorProtectionState = 'unknown';
  #attempt = 0;
  #generation = 0;
  #snapshot: RealtimeSupervisorSnapshot = { phase: 'idle', attempt: 0 };
  #cancelRetry: CancelTimer | undefined;
  #unsubscribeDiagnostics: (() => void) | undefined;
  #unsubscribeConnectivity: (() => void) | undefined;
  #unsubscribeLifecycle: (() => void) | undefined;
  #unsubscribeProtection: (() => void) | undefined;

  constructor(
    client: RealtimeSupervisorClient,
    options: RealtimeSupervisorOptions = {},
  ) {
    this.#client = client;
    this.#connectivity = options.connectivity;
    this.#lifecycle = options.lifecycle;
    this.#protection = options.protection;
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
    this.#unsubscribeDiagnostics = this.#client.onDiagnostics((snapshot) =>
      this.#observeDiagnostics(snapshot),
    );
    this.#unsubscribeConnectivity = this.#connectivity?.subscribe(() =>
      this.#reconcileHostState(),
    );
    this.#unsubscribeLifecycle = this.#lifecycle?.subscribe(() =>
      this.#reconcileHostState(),
    );
    this.#unsubscribeProtection = this.#protection?.subscribe(() =>
      this.#reconcileHostState(),
    );
    this.#reconcileHostState();
    const generation = this.#generation;
    void this.#initialize(generation);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#generation += 1;
    const disconnect =
      this.#connected || this.#transportConnected || this.#connecting;
    this.#connected = false;
    this.#transportConnected = false;
    this.#connecting = false;
    this.#attempt = 0;
    this.#clearRetry();
    this.#unsubscribeDiagnostics?.();
    this.#unsubscribeConnectivity?.();
    this.#unsubscribeLifecycle?.();
    this.#unsubscribeProtection?.();
    this.#publish({ phase: 'stopped', attempt: 0 });
    if (disconnect) this.#disconnect();
  }

  async #initialize(generation: number): Promise<void> {
    let snapshot: ClientDiagnosticsSnapshot | undefined;
    try {
      snapshot = await this.#client.diagnosticsSnapshot();
    } catch {
      // Protected or temporarily unavailable diagnostics must not become a
      // startup dependency. Explicit host gates and the connect result remain.
    }
    if (generation !== this.#generation || this.#stopped) return;
    this.#initialized = true;
    if (snapshot !== undefined) this.#observeDiagnostics(snapshot, true);
    this.#reconcileHostState();
  }

  #hostBlock(): RealtimeSuspendedPhase | undefined {
    const protection = this.#protection?.current();
    if (
      this.#diagnosticSecurity === 'preflight' ||
      protection === 'preflight' ||
      (this.#protection !== undefined && protection !== 'active')
    ) {
      return 'protected';
    }
    if (
      this.#diagnosticConnectivity === 'offline' ||
      this.#connectivity?.current() === 'offline'
    ) {
      return 'offline';
    }
    if (this.#lifecycle?.current() === 'background') return 'background';
    return undefined;
  }

  #canConnect(): boolean {
    return (
      this.#initialized &&
      !this.#stopped &&
      this.#realtimeSupported &&
      !this.#hostBlock()
    );
  }

  #publish(snapshot: RealtimeSupervisorSnapshot): void {
    if (
      this.#snapshot.phase === snapshot.phase &&
      this.#snapshot.attempt === snapshot.attempt &&
      this.#snapshot.retryDelayMs === snapshot.retryDelayMs
    ) {
      return;
    }
    this.#snapshot = Object.freeze(snapshot);
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // Observers cannot alter transport ownership or retry policy.
      }
    }
  }

  #clearRetry(): void {
    this.#cancelRetry?.();
    this.#cancelRetry = undefined;
  }

  #schedule(delayMs: number): void {
    if (
      !this.#canConnect() ||
      this.#connected ||
      this.#connecting ||
      this.#cancelRetry
    ) {
      return;
    }
    this.#publish(
      delayMs > 0
        ? { phase: 'retrying', attempt: this.#attempt, retryDelayMs: delayMs }
        : { phase: 'connecting', attempt: this.#attempt },
    );
    this.#cancelRetry = this.#scheduleTimer(() => {
      this.#cancelRetry = undefined;
      void this.#connect();
    }, delayMs);
  }

  #retryDelay(): number {
    const exponential = Math.min(
      this.#maximumDelayMs,
      this.#initialDelayMs * 2 ** this.#attempt,
    );
    const random = this.#random();
    const boundedRandom = Number.isFinite(random)
      ? Math.max(0, Math.min(1, random))
      : 0;
    const jitter = Math.floor(exponential * 0.25 * boundedRandom);
    return Math.min(this.#maximumDelayMs, exponential + jitter);
  }

  #scheduleRetry(): void {
    if (!this.#canConnect()) {
      this.#reconcileHostState();
      return;
    }
    const delay = this.#retryDelay();
    this.#attempt = Math.min(32, this.#attempt + 1);
    this.#schedule(delay);
  }

  async #connect(): Promise<void> {
    if (!this.#canConnect() || this.#connected || this.#connecting) return;
    this.#connecting = true;
    this.#publish({ phase: 'connecting', attempt: this.#attempt });
    const generation = this.#generation;
    let failed = false;
    try {
      await this.#client.connectRealtime();
      this.#transportConnected = true;
      if (generation !== this.#generation || !this.#canConnect()) {
        this.#disconnect();
        return;
      }
      await this.#catchUpConnectedTransport(generation);
    } catch {
      failed = true;
      this.#connected = false;
      this.#transportConnected = false;
      this.#disconnect();
    } finally {
      this.#connecting = false;
    }
    if (failed && generation === this.#generation) this.#scheduleRetry();
  }

  async #catchUpConnectedTransport(generation: number): Promise<void> {
    await this.#client.syncUntilIdle();
    if (
      generation !== this.#generation ||
      !this.#canConnect() ||
      !this.#transportConnected
    ) {
      this.#disconnect();
      return;
    }
    this.#connected = true;
    this.#attempt = 0;
    this.#publish({ phase: 'connected', attempt: 0 });
  }

  async #adoptConnectedTransport(): Promise<void> {
    if (!this.#canConnect() || this.#connecting || !this.#transportConnected) {
      return;
    }
    this.#connecting = true;
    this.#clearRetry();
    this.#publish({ phase: 'connecting', attempt: this.#attempt });
    const generation = this.#generation;
    let failed = false;
    try {
      await this.#catchUpConnectedTransport(generation);
    } catch {
      failed = true;
      this.#connected = false;
      this.#transportConnected = false;
      this.#disconnect();
    } finally {
      this.#connecting = false;
    }
    if (failed && generation === this.#generation) this.#scheduleRetry();
  }

  #observeDiagnostics(
    snapshot: ClientDiagnosticsSnapshot,
    initial = false,
  ): void {
    if (this.#stopped) return;
    this.#diagnosticConnectivity = snapshot.host.connectivity;
    this.#diagnosticSecurity = snapshot.securityLifecycle;
    if (snapshot.host.realtime === 'unsupported') {
      const disconnect =
        this.#connected || this.#transportConnected || this.#connecting;
      this.#realtimeSupported = false;
      this.#generation += 1;
      this.#connected = false;
      this.#transportConnected = false;
      this.#attempt = 0;
      this.#clearRetry();
      this.#publish({ phase: 'unsupported', attempt: 0 });
      if (disconnect) this.#disconnect();
      return;
    }
    if (!this.#realtimeSupported) return;
    this.#realtimeSupported = true;
    const block = this.#hostBlock();
    if (block) {
      this.#suspend(block);
      return;
    }
    if (snapshot.host.realtime === 'connected') {
      this.#transportConnected = true;
      if (this.#connecting) return;
      this.#connected = false;
      void this.#adoptConnectedTransport();
      return;
    }
    if (snapshot.host.realtime === 'disconnected') {
      this.#transportConnected = false;
      this.#connected = false;
      if (this.#connecting) return;
      if (this.#initialized && !initial) this.#scheduleRetry();
      return;
    }
    this.#reconcileHostState();
  }

  #reconcileHostState(): void {
    if (this.#stopped) return;
    const block = this.#hostBlock();
    if (block) {
      this.#suspend(block);
      return;
    }
    if (!this.#initialized) {
      this.#publish({ phase: 'idle', attempt: 0 });
      return;
    }
    if (!this.#realtimeSupported) {
      this.#publish({ phase: 'unsupported', attempt: 0 });
      return;
    }
    if (this.#connected) {
      this.#publish({ phase: 'connected', attempt: 0 });
      return;
    }
    this.#schedule(0);
  }

  #suspend(phase: RealtimeSuspendedPhase): void {
    const disconnect =
      this.#connected || this.#transportConnected || this.#connecting;
    const hadScheduledWork = this.#cancelRetry !== undefined;
    const phaseChanged = this.#snapshot.phase !== phase;
    if (!disconnect && !hadScheduledWork && !phaseChanged) return;
    this.#generation += 1;
    this.#connected = false;
    this.#transportConnected = false;
    this.#connecting = false;
    this.#attempt = 0;
    this.#clearRetry();
    this.#publish({ phase, attempt: 0 });
    if (disconnect) this.#disconnect();
  }

  #disconnect(): void {
    void Promise.resolve(this.#client.disconnectRealtime()).catch(
      () => undefined,
    );
  }
}

/** Install one supervisor and make client disposal cancel it before close. */
export function installRealtimeSupervisor<T extends RealtimeSupervisorClient>(
  client: T,
  options?: RealtimeSupervisorOptions,
): T {
  if (attachment(client)) return client;
  const supervisor = new RealtimeSupervisor(client, options);
  Object.defineProperty(client, REALTIME_SUPERVISOR_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { version: 1, supervisor } satisfies RealtimeSupervisorAttachment,
  });
  const close = client.close.bind(client);
  Object.defineProperty(client, 'close', {
    configurable: true,
    writable: true,
    value: async () => {
      supervisor.stop();
      await close();
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
