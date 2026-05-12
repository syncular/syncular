import type {
  SyncularV2ClientConfig,
  SyncularV2DiagnosticEvent,
  SyncularV2LiveQueryEvent,
  SyncularV2RealtimeConnectionState,
} from './types';
import type {
  SyncularV2WorkerEvent,
  SyncularV2WorkerRealtimeOptions,
} from './worker-protocol';
import { SYNCULAR_V2_WORKER_PROTOCOL_VERSION } from './worker-protocol';

export interface SyncularV2WorkerRealtimeClient {
  syncPull(): Promise<unknown>;
  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Array<SyncularV2LiveQueryEvent<Row>>;
}

export interface SyncularV2WorkerRealtimeSocket {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(): void;
}

export interface SyncularV2WorkerRealtimeControllerOptions {
  getClient(): SyncularV2WorkerRealtimeClient;
  getConfig(): SyncularV2ClientConfig | undefined;
  getLocationOrigin(): string;
  createWebSocket(url: string): SyncularV2WorkerRealtimeSocket;
  postEvent(event: SyncularV2WorkerEvent): void;
  postDiagnostic?: (
    event: Omit<SyncularV2DiagnosticEvent, 'at'> & { at?: number }
  ) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export class SyncularV2WorkerRealtimeController {
  #socket: SyncularV2WorkerRealtimeSocket | undefined;
  #state: SyncularV2RealtimeConnectionState = 'disconnected';
  #options: SyncularV2WorkerRealtimeOptions | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempts = 0;
  #stopped = true;
  #syncInFlight: Promise<void> | undefined;
  #syncAgain = false;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;

  constructor(
    private readonly controllerOptions: SyncularV2WorkerRealtimeControllerOptions
  ) {
    this.#setTimeout = controllerOptions.setTimeout ?? setTimeout;
    this.#clearTimeout = controllerOptions.clearTimeout ?? clearTimeout;
  }

  start(options: SyncularV2WorkerRealtimeOptions): void {
    if (!this.controllerOptions.getConfig()) {
      throw {
        code: 'not_open',
        message: 'Syncular v2 worker client is not open',
      };
    }
    this.stop();
    this.#options = options;
    this.#stopped = false;
    this.#reconnectAttempts = 0;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#syncAgain = false;
    this.#syncInFlight = undefined;
    this.#clearReconnectTimer();
    this.#clearHeartbeatTimer();
    this.#closeSocket();
    this.#setState('disconnected');
  }

  #connect(): void {
    const config = this.controllerOptions.getConfig();
    const options = this.#options;
    if (!config || !options || this.#stopped) return;

    this.#clearReconnectTimer();
    this.#clearHeartbeatTimer();
    this.#setState('connecting');

    let socket: SyncularV2WorkerRealtimeSocket;
    try {
      socket = this.controllerOptions.createWebSocket(
        resolveSyncularV2RealtimeUrl(
          config,
          options,
          this.controllerOptions.getLocationOrigin()
        )
      );
    } catch {
      this.#diagnostic({
        level: 'warn',
        code: 'realtime.connect_failed',
        message: 'Syncular v2 realtime websocket creation failed',
        details: { attempt: this.#reconnectAttempts + 1 },
      });
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      if (socket !== this.#socket) return;
      this.#reconnectAttempts = 0;
      this.#setState('connected');
      this.#resetHeartbeatTimer();
    };
    socket.onmessage = (event) => {
      if (socket !== this.#socket) return;
      this.#resetHeartbeatTimer();
      void this.#handleMessage(socket, event.data);
    };
    socket.onerror = () => {
      if (socket !== this.#socket) return;
      this.#diagnostic({
        level: 'warn',
        code: 'realtime.socket_error',
        message: 'Syncular v2 realtime websocket reported an error',
      });
      this.#reconnect();
    };
    socket.onclose = () => {
      if (socket !== this.#socket) return;
      this.#reconnect();
    };
  }

  async #handleMessage(
    socket: SyncularV2WorkerRealtimeSocket,
    data: MessageEvent['data']
  ): Promise<void> {
    const text = await readRealtimeMessageText(data);
    if (socket !== this.#socket || text == null) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (isSyncularV2RealtimeSyncMessage(message)) {
      this.#diagnostic({
        level: 'debug',
        code: 'realtime.sync_wakeup',
        message: 'Syncular v2 realtime sync wakeup received',
      });
      this.#scheduleSyncPull();
    }
  }

  #reconnect(): void {
    this.#clearHeartbeatTimer();
    this.#closeSocket();
    this.#setState('disconnected');
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    this.#clearReconnectTimer();
    const initial = this.#options?.initialReconnectDelayMs ?? 1_000;
    const max = this.#options?.maxReconnectDelayMs ?? 30_000;
    const factor = this.#options?.reconnectBackoffFactor ?? 2;
    const delay = Math.min(initial * factor ** this.#reconnectAttempts, max);
    this.#diagnostic({
      level: 'info',
      code: 'realtime.reconnect_scheduled',
      message: 'Syncular v2 realtime reconnect scheduled',
      details: {
        attempt: this.#reconnectAttempts + 1,
        delayMs: delay,
      },
    });
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = this.#setTimeout(() => this.#connect(), delay);
  }

  #scheduleSyncPull(): void {
    if (this.#stopped) return;
    if (this.#syncInFlight) {
      this.#syncAgain = true;
      return;
    }
    this.#syncInFlight = this.#runSyncPull();
  }

  async #runSyncPull(): Promise<void> {
    try {
      await this.controllerOptions.getClient().syncPull();
      if (this.#stopped) return;
      const events = this.controllerOptions
        .getClient()
        .drainLiveQueryEvents<Record<string, unknown>>();
      if (events.length > 0) {
        this.controllerOptions.postEvent({
          protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
          type: 'liveQueryEvents',
          events,
        });
      }
    } catch {
      this.#diagnostic({
        level: 'warn',
        code: 'realtime.sync_pull_failed',
        message: 'Syncular v2 realtime-triggered pull failed',
      });
      // Realtime is best-effort. Explicit sync methods still surface errors.
    } finally {
      this.#syncInFlight = undefined;
      if (this.#syncAgain && !this.#stopped) {
        this.#syncAgain = false;
        this.#scheduleSyncPull();
      }
    }
  }

  #clearReconnectTimer(): void {
    if (!this.#reconnectTimer) return;
    this.#clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #clearHeartbeatTimer(): void {
    if (!this.#heartbeatTimer) return;
    this.#clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }

  #resetHeartbeatTimer(): void {
    this.#clearHeartbeatTimer();
    const heartbeatTimeoutMs = this.#options?.heartbeatTimeoutMs ?? 60_000;
    if (heartbeatTimeoutMs <= 0) return;
    this.#heartbeatTimer = this.#setTimeout(
      () => this.#reconnect(),
      heartbeatTimeoutMs
    );
  }

  #closeSocket(): void {
    if (!this.#socket) return;
    const socket = this.#socket;
    this.#socket = undefined;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // best effort
    }
  }

  #setState(state: SyncularV2RealtimeConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.controllerOptions.postEvent({
      protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
      type: 'realtimeState',
      state,
    });
  }

  #diagnostic(
    event: Omit<SyncularV2DiagnosticEvent, 'at' | 'source'> & { at?: number }
  ): void {
    this.controllerOptions.postDiagnostic?.({
      ...event,
      source: 'realtime',
    });
  }
}

export function resolveSyncularV2RealtimeUrl(
  config: SyncularV2ClientConfig,
  options: SyncularV2WorkerRealtimeOptions,
  locationOrigin: string
): string {
  const url = new URL(options.wsUrl ?? config.baseUrl, locationOrigin);
  if (!options.wsUrl) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/realtime`;
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  url.searchParams.set('clientId', config.clientId);
  url.searchParams.set('transportPath', 'direct');
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function isSyncularV2RealtimeSyncMessage(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'event' in value &&
      (value as { event?: unknown }).event === 'sync'
  );
}

async function readRealtimeMessageText(
  data: MessageEvent['data']
): Promise<string | null> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  return null;
}
