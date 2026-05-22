import {
  createSyncularSyncAttempt,
  syncularDiagnosticAttemptFields,
} from './diagnostics';
import type {
  SyncularClientConfig,
  SyncularDiagnosticEvent,
  SyncularLiveQueryEvent,
  SyncularRealtimeConnectionState,
  SyncularSyncRequestOptions,
  SyncularSyncResult,
} from './types';
import type {
  SyncularWorkerEvent,
  SyncularWorkerRealtimeOptions,
} from './worker-protocol';
import {
  createSyncularWorkerErrorPayload,
  SYNCULAR_WORKER_PROTOCOL_VERSION,
} from './worker-protocol';

export interface SyncularWorkerRealtimeClient {
  syncPull(options?: SyncularSyncRequestOptions): Promise<SyncularSyncResult>;
  applyRealtimeSyncPack?(bytes: Uint8Array): Promise<SyncularSyncResult>;
  drainLiveQueryEvents<
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(): Array<SyncularLiveQueryEvent<Row>>;
}

interface SyncularRealtimeSyncMessage {
  cursor?: number;
  reason?: string | null;
  requiresPull?: boolean;
  droppedCount?: number;
  payloadBytes?: number;
  syncPackBytes?: Uint8Array;
}

interface SyncularRealtimeHelloMessage {
  protocolVersion?: number;
  sessionId?: string;
  shardKey?: string;
  cursor?: number;
  latestCursor?: number;
  scopeCount?: number;
  requiresSync?: boolean;
  syncPackEncoding?: string | null;
}

interface SyncularRealtimePresenceMessage {
  action: 'join' | 'leave' | 'update' | 'snapshot';
  scopeKey: string;
  clientId?: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
  entries?: Array<{
    clientId: string;
    actorId: string;
    joinedAt: number;
    metadata?: Record<string, unknown>;
  }>;
}

export interface SyncularWorkerRealtimeSocket {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface SyncularWorkerRealtimeControllerOptions {
  getClient(): SyncularWorkerRealtimeClient;
  getConfig(): SyncularClientConfig | undefined;
  getLocationOrigin(): string;
  createWebSocket(url: string): SyncularWorkerRealtimeSocket;
  postEvent(event: SyncularWorkerEvent): void;
  postDiagnostic?: (
    event: Omit<SyncularDiagnosticEvent, 'at'> & { at?: number }
  ) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export class SyncularWorkerRealtimeController {
  #socket: SyncularWorkerRealtimeSocket | undefined;
  #state: SyncularRealtimeConnectionState = 'disconnected';
  #options: SyncularWorkerRealtimeOptions | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempts = 0;
  #stopped = true;
  #syncInFlight: Promise<void> | undefined;
  #syncAgain = false;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;

  constructor(
    private readonly controllerOptions: SyncularWorkerRealtimeControllerOptions
  ) {
    this.#setTimeout =
      controllerOptions.setTimeout ??
      (globalThis.setTimeout.bind(globalThis) as typeof setTimeout);
    this.#clearTimeout =
      controllerOptions.clearTimeout ??
      (globalThis.clearTimeout.bind(globalThis) as typeof clearTimeout);
  }

  start(options: SyncularWorkerRealtimeOptions): void {
    if (!this.controllerOptions.getConfig()) {
      throw createSyncularWorkerErrorPayload(
        'worker.not_open',
        'Syncular worker client is not open'
      );
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

  sendPresence(
    action: 'join' | 'leave' | 'update',
    scopeKey: string,
    metadata?: Record<string, unknown>
  ): void {
    const socket = this.#socket;
    if (!socket || this.#state !== 'connected') {
      this.#diagnostic({
        level: 'warn',
        code: 'realtime.presence_not_connected',
        message: 'Syncular realtime presence send skipped while disconnected',
        details: { action, scopeKey },
      });
      return;
    }
    socket.send(
      JSON.stringify({
        type: 'presence',
        action,
        scopeKey,
        ...(metadata === undefined ? {} : { metadata }),
      })
    );
  }

  #connect(): void {
    const config = this.controllerOptions.getConfig();
    const options = this.#options;
    if (!config || !options || this.#stopped) return;

    this.#clearReconnectTimer();
    this.#clearHeartbeatTimer();
    this.#setState('connecting');

    let socket: SyncularWorkerRealtimeSocket;
    try {
      socket = this.controllerOptions.createWebSocket(
        resolveSyncularRealtimeUrl(
          config,
          options,
          this.controllerOptions.getLocationOrigin()
        )
      );
    } catch {
      this.#diagnostic({
        level: 'warn',
        code: 'realtime.connect_failed',
        message: 'Syncular realtime websocket creation failed',
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
        message: 'Syncular realtime websocket reported an error',
      });
      this.#reconnect();
    };
    socket.onclose = () => {
      if (socket !== this.#socket) return;
      this.#reconnect();
    };
  }

  async #handleMessage(
    socket: SyncularWorkerRealtimeSocket,
    data: MessageEvent['data']
  ): Promise<void> {
    const bytes = await readRealtimeMessageBytes(data);
    if (socket !== this.#socket) return;
    if (bytes && isSyncPackBytes(bytes)) {
      this.#diagnostic({
        level: 'debug',
        code: 'realtime.sync_wakeup',
        message: 'Syncular realtime binary sync-pack received',
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
    const helloMessage = readSyncularRealtimeHelloMessage(message);
    if (helloMessage) {
      this.#diagnostic({
        level: 'debug',
        code: 'realtime.hello',
        message: 'Syncular realtime session accepted',
        details: { ...helloMessage },
      });
      return;
    }
    const presenceMessage = readSyncularRealtimePresenceMessage(message);
    if (presenceMessage) {
      this.controllerOptions.postEvent({
        protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
        type: 'presenceEvent',
        ...presenceMessage,
      });
      return;
    }
    const syncMessage = readSyncularRealtimeSyncMessage(message);
    if (syncMessage) {
      this.#diagnostic({
        level: 'debug',
        code: 'realtime.sync_wakeup',
        message: 'Syncular realtime sync wakeup received',
        details: {
          reason: syncMessage.reason ?? null,
          requiresPull: syncMessage.requiresPull === true,
          droppedCount: syncMessage.droppedCount ?? 0,
          payloadBytes: syncMessage.payloadBytes ?? null,
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
      message: 'Syncular realtime reconnect scheduled',
      details: {
        attempt: this.#reconnectAttempts + 1,
        delayMs: delay,
      },
    });
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = this.#setTimeout(() => this.#connect(), delay);
  }

  #scheduleSync(message?: SyncularRealtimeSyncMessage): void {
    if (this.#stopped) return;
    if (this.#syncInFlight) {
      this.#syncAgain = true;
      return;
    }
    this.#syncInFlight = this.#runSync(message);
  }

  async #runSync(message?: SyncularRealtimeSyncMessage): Promise<void> {
    const socket = this.#socket;
    try {
      const result = await this.#syncForMessage(message);
      if (this.#stopped) return;
      this.#ackRealtimeCursor(socket, message, result);
      this.controllerOptions.postEvent({
        protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
        type: 'bootstrapChanged',
        bootstrap: result.bootstrap,
      });
      if (result.changedTables.length > 0 || result.changedRows.length > 0) {
        this.controllerOptions.postEvent({
          protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
          type: 'rowsChanged',
          source: 'remotePull',
          changedTables: result.changedTables,
          changedRows: result.changedRows,
          changedRowsTruncated: result.changedRowsTruncated,
        });
      }
      const events = this.controllerOptions
        .getClient()
        .drainLiveQueryEvents<Record<string, unknown>>();
      if (events.length > 0) {
        this.controllerOptions.postEvent({
          protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
          type: 'liveQueryEvents',
          events,
        });
      }
    } catch {
      this.#diagnostic({
        level: 'warn',
        code: 'realtime.sync_pull_failed',
        message: 'Syncular realtime-triggered pull failed',
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

  #ackRealtimeCursor(
    socket: SyncularWorkerRealtimeSocket | undefined,
    message: SyncularRealtimeSyncMessage | undefined,
    result: SyncularSyncResult
  ): void {
    if (!socket || socket !== this.#socket) return;
    const subscriptionCursor = result.subscriptions.reduce(
      (cursor, subscription) =>
        Number.isFinite(subscription.nextCursor)
          ? Math.max(cursor, subscription.nextCursor)
          : cursor,
      -1
    );
    const messageCursor = Number.isFinite(message?.cursor)
      ? message!.cursor!
      : -1;
    const cursor = Math.max(subscriptionCursor, messageCursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return;
    try {
      socket.send(JSON.stringify({ type: 'ack', cursor }));
      this.#diagnostic({
        level: 'debug',
        code: 'realtime.ack_sent',
        message: 'Syncular realtime cursor ack sent',
        details: { cursor },
      });
    } catch {
      this.#diagnostic({
        level: 'warn',
        code: 'realtime.ack_failed',
        message: 'Syncular realtime cursor ack failed',
        details: { cursor },
      });
    }
  }

  async #syncForMessage(
    message: SyncularRealtimeSyncMessage | undefined
  ): Promise<SyncularSyncResult> {
    const client = this.controllerOptions.getClient();
    if (message && realtimeMessageRequiresPull(message)) {
      const syncAttempt = createSyncularSyncAttempt();
      this.#diagnostic({
        level: 'debug',
        code: 'realtime.pull_required',
        message: 'Syncular realtime event requires HTTP pull recovery',
        ...syncularDiagnosticAttemptFields(syncAttempt),
        details: {
          cursor: message.cursor ?? null,
          reason: message.reason ?? null,
          droppedCount: message.droppedCount ?? 0,
          payloadBytes: message.payloadBytes ?? null,
        },
      });
      return client.syncPull({ syncAttempt });
    }
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
          message: 'Syncular realtime binary sync-pack applied',
          details: {
            bytes: message.syncPackBytes.byteLength,
            totalMs: result.timings.totalMs,
            syncPackDecodeMs: result.timings.syncPackDecodeMs,
            pullTransformMs: result.timings.pullTransformMs,
            integrityVerifyMs: result.timings.integrityVerifyMs,
            pullApplyMs: result.timings.pullApplyMs,
            commitApplyMs: result.timings.commitApplyMs,
            subscriptionStateMs: result.timings.subscriptionStateMs,
            notifyMs: result.timings.notifyMs,
            changedRows: result.changedRows.length,
            changedRowsTruncated: result.changedRowsTruncated,
          },
        });
        return result;
      } catch {
        this.#diagnostic({
          level: 'warn',
          code: 'realtime.binary_apply_failed',
          message:
            'Syncular realtime binary sync-pack apply failed; using HTTP pull recovery',
          details: {
            bytes: message.syncPackBytes.byteLength,
          },
        });
      }
    }
    const syncAttempt = createSyncularSyncAttempt();
    this.#diagnostic({
      level: 'debug',
      code: 'realtime.pull_required',
      message: 'Syncular realtime event requires HTTP pull recovery',
      ...syncularDiagnosticAttemptFields(syncAttempt),
      details: {
        cursor: message?.cursor ?? null,
        reason: message?.syncPackBytes ? 'binary-apply-failed' : null,
        droppedCount: message?.droppedCount ?? 0,
        payloadBytes: message?.payloadBytes ?? null,
      },
    });
    return client.syncPull({ syncAttempt });
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

  #setState(state: SyncularRealtimeConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.controllerOptions.postEvent({
      protocolVersion: SYNCULAR_WORKER_PROTOCOL_VERSION,
      type: 'realtimeState',
      state,
    });
  }

  #diagnostic(
    event: Omit<SyncularDiagnosticEvent, 'at' | 'source'> & { at?: number }
  ): void {
    this.controllerOptions.postDiagnostic?.({
      ...event,
      source: 'realtime',
    });
  }
}

function realtimeMessageRequiresPull(
  message: SyncularRealtimeSyncMessage
): boolean {
  return message.requiresPull === true || (message.droppedCount ?? 0) > 0;
}

export function resolveSyncularRealtimeUrl(
  config: SyncularClientConfig,
  options: SyncularWorkerRealtimeOptions,
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

export function isSyncularRealtimeSyncMessage(value: unknown): boolean {
  return readSyncularRealtimeSyncMessage(value) !== null;
}

function readSyncularRealtimeHelloMessage(
  value: unknown
): SyncularRealtimeHelloMessage | null {
  if (!value || typeof value !== 'object') return null;
  if ((value as { event?: unknown }).event !== 'hello') return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return {};
  const record = data as Record<string, unknown>;
  return {
    protocolVersion:
      typeof record.protocolVersion === 'number'
        ? record.protocolVersion
        : undefined,
    sessionId:
      typeof record.sessionId === 'string' ? record.sessionId : undefined,
    shardKey: typeof record.shardKey === 'string' ? record.shardKey : undefined,
    cursor: typeof record.cursor === 'number' ? record.cursor : undefined,
    latestCursor:
      typeof record.latestCursor === 'number' ? record.latestCursor : undefined,
    scopeCount:
      typeof record.scopeCount === 'number' ? record.scopeCount : undefined,
    requiresSync:
      typeof record.requiresSync === 'boolean'
        ? record.requiresSync
        : undefined,
    syncPackEncoding:
      typeof record.syncPackEncoding === 'string'
        ? record.syncPackEncoding
        : record.syncPackEncoding === null
          ? null
          : undefined,
  };
}

function readSyncularRealtimeSyncMessage(
  value: unknown
): SyncularRealtimeSyncMessage | null {
  if (!value || typeof value !== 'object') return null;
  if ((value as { event?: unknown }).event !== 'sync') return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return {};
  const record = data as Record<string, unknown>;
  const cursor = typeof record.cursor === 'number' ? record.cursor : undefined;
  const reason = typeof record.reason === 'string' ? record.reason : null;
  const requiresPull =
    typeof record.requiresPull === 'boolean' ? record.requiresPull : undefined;
  const droppedCount =
    typeof record.droppedCount === 'number' &&
    Number.isSafeInteger(record.droppedCount)
      ? record.droppedCount
      : undefined;
  const payloadBytes =
    typeof record.payloadBytes === 'number' &&
    Number.isSafeInteger(record.payloadBytes)
      ? record.payloadBytes
      : undefined;
  return {
    cursor,
    reason,
    requiresPull,
    droppedCount,
    payloadBytes,
  };
}

function readSyncularRealtimePresenceMessage(
  value: unknown
): SyncularRealtimePresenceMessage | null {
  if (!value || typeof value !== 'object') return null;
  if ((value as { event?: unknown }).event !== 'presence') return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const presence = (data as { presence?: unknown }).presence;
  if (!presence || typeof presence !== 'object') return null;
  const record = presence as Record<string, unknown>;
  const action = record.action;
  if (
    action !== 'join' &&
    action !== 'leave' &&
    action !== 'update' &&
    action !== 'snapshot'
  ) {
    return null;
  }
  if (typeof record.scopeKey !== 'string' || !record.scopeKey) return null;
  return {
    action,
    scopeKey: record.scopeKey,
    clientId: typeof record.clientId === 'string' ? record.clientId : undefined,
    actorId: typeof record.actorId === 'string' ? record.actorId : undefined,
    metadata: objectRecordOrUndefined(record.metadata),
    entries: Array.isArray(record.entries)
      ? record.entries.flatMap(readPresenceEntry)
      : undefined,
  };
}

function readPresenceEntry(value: unknown): Array<{
  clientId: string;
  actorId: string;
  joinedAt: number;
  metadata?: Record<string, unknown>;
}> {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (typeof record.clientId !== 'string') return [];
  if (typeof record.actorId !== 'string') return [];
  return [
    {
      clientId: record.clientId,
      actorId: record.actorId,
      joinedAt:
        typeof record.joinedAt === 'number' ? record.joinedAt : Date.now(),
      metadata: objectRecordOrUndefined(record.metadata),
    },
  ];
}

function objectRecordOrUndefined(
  value: unknown
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return { ...(value as Record<string, unknown>) };
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
