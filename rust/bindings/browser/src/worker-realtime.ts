import type {
  SyncularV2ClientConfig,
  SyncularV2DiagnosticEvent,
  SyncularV2LiveQueryEvent,
  SyncularV2RealtimeConnectionState,
  SyncularV2SyncResult,
} from './types';
import type {
  SyncularV2WorkerEvent,
  SyncularV2WorkerRealtimeOptions,
} from './worker-protocol';
import { SYNCULAR_V2_WORKER_PROTOCOL_VERSION } from './worker-protocol';

export interface SyncularV2WorkerRealtimeClient {
  syncPull(): Promise<SyncularV2SyncResult>;
  applyRealtimeChanges?(
    request: SyncularV2RealtimeChangesRequest
  ): Promise<SyncularV2SyncResult>;
  applyRealtimeSyncPack?(bytes: Uint8Array): Promise<SyncularV2SyncResult>;
  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Array<SyncularV2LiveQueryEvent<Row>>;
}

export interface SyncularV2RealtimeChangesRequest {
  cursor: number;
  changes: unknown[];
  actorId?: string | null;
  createdAt?: string | null;
}

interface SyncularV2RealtimeSyncMessage {
  cursor?: number;
  changes?: unknown[];
  actorId?: string | null;
  createdAt?: string | null;
  syncPackBytes?: Uint8Array;
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
    const bytes = await readRealtimeMessageBytes(data);
    if (socket !== this.#socket) return;
    if (bytes && isSyncPackBytes(bytes)) {
      this.#diagnostic({
        level: 'debug',
        code: 'realtime.sync_wakeup',
        message: 'Syncular v2 realtime binary sync-pack received',
        details: {
          bytes: bytes.byteLength,
        },
      });
      this.#scheduleSync({ syncPackBytes: bytes });
      return;
    }

    const text = bytes ? new TextDecoder().decode(bytes) : data;
    if (text == null) return;
    if (typeof text !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const syncMessage = readSyncularV2RealtimeSyncMessage(message);
    if (syncMessage) {
      this.#diagnostic({
        level: 'debug',
        code: 'realtime.sync_wakeup',
        message: 'Syncular v2 realtime sync wakeup received',
        details: {
          inlineChanges: syncMessage.changes?.length ?? 0,
        },
      });
      this.#scheduleSync(syncMessage);
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

  #scheduleSync(message?: SyncularV2RealtimeSyncMessage): void {
    if (this.#stopped) return;
    if (this.#syncInFlight) {
      this.#syncAgain = true;
      return;
    }
    this.#syncInFlight = this.#runSync(message);
  }

  async #runSync(message?: SyncularV2RealtimeSyncMessage): Promise<void> {
    try {
      const result = await this.#syncForMessage(message);
      if (this.#stopped) return;
      if (result.changedTables.length > 0 || result.changedRows.length > 0) {
        this.controllerOptions.postEvent({
          protocolVersion: SYNCULAR_V2_WORKER_PROTOCOL_VERSION,
          type: 'rowsChanged',
          source: 'remotePull',
          changedTables: result.changedTables,
          changedRows: result.changedRows,
        });
      }
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
        this.#scheduleSync();
      }
    }
  }

  async #syncForMessage(
    message: SyncularV2RealtimeSyncMessage | undefined
  ): Promise<SyncularV2SyncResult> {
    const client = this.controllerOptions.getClient();
    if (
      message?.syncPackBytes &&
      typeof client.applyRealtimeSyncPack === 'function'
    ) {
      try {
        const result = await client.applyRealtimeSyncPack(
          message.syncPackBytes
        );
        this.#diagnostic({
          level: 'debug',
          code: 'realtime.binary_applied',
          message: 'Syncular v2 realtime binary sync-pack applied',
          details: {
            bytes: message.syncPackBytes.byteLength,
          },
        });
        return result;
      } catch {
        this.#diagnostic({
          level: 'warn',
          code: 'realtime.binary_fallback',
          message:
            'Syncular v2 realtime binary sync-pack apply failed; falling back to pull',
          details: {
            bytes: message.syncPackBytes.byteLength,
          },
        });
      }
    }
    if (
      message?.changes &&
      message.changes.length > 0 &&
      Number.isFinite(message.cursor) &&
      typeof client.applyRealtimeChanges === 'function'
    ) {
      try {
        const result = await client.applyRealtimeChanges({
          cursor: message.cursor!,
          changes: message.changes,
          actorId: message.actorId ?? null,
          createdAt: message.createdAt ?? null,
        });
        this.#diagnostic({
          level: 'debug',
          code: 'realtime.inline_applied',
          message: 'Syncular v2 realtime inline changes applied',
          details: {
            cursor: message.cursor,
            changes: message.changes.length,
          },
        });
        return result;
      } catch {
        this.#diagnostic({
          level: 'warn',
          code: 'realtime.inline_fallback',
          message:
            'Syncular v2 realtime inline apply failed; falling back to pull',
          details: {
            cursor: message.cursor,
            changes: message.changes.length,
          },
        });
      }
    }
    return client.syncPull();
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
  url.searchParams.set('syncPackEncoding', 'binary-sync-pack-v1');
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function isSyncularV2RealtimeSyncMessage(value: unknown): boolean {
  return readSyncularV2RealtimeSyncMessage(value) !== null;
}

function readSyncularV2RealtimeSyncMessage(
  value: unknown
): SyncularV2RealtimeSyncMessage | null {
  if (!value || typeof value !== 'object') return null;
  if ((value as { event?: unknown }).event !== 'sync') return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return {};
  const record = data as Record<string, unknown>;
  const cursor = typeof record.cursor === 'number' ? record.cursor : undefined;
  const changes = Array.isArray(record.changes) ? record.changes : undefined;
  const actorId = typeof record.actorId === 'string' ? record.actorId : null;
  const createdAt =
    typeof record.createdAt === 'string' ? record.createdAt : null;
  return { cursor, changes, actorId, createdAt };
}

async function readRealtimeMessageBytes(
  data: MessageEvent['data']
): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  return null;
}

function isSyncPackBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x53 &&
    bytes[1] === 0x53 &&
    bytes[2] === 0x50 &&
    bytes[3] === 0x31
  );
}
