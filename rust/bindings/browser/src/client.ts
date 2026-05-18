import {
  createSyncularV2Database,
  type SyncularV2Database,
} from './database';
import type {
  CreateSyncularV2DatabaseOptions,
  SyncularV2Client,
  SyncularV2DiagnosticEvent,
  SyncularV2RealtimeConnectionState,
  SyncularV2RealtimeOptions,
  SyncularV2SubscriptionSpec,
  SyncularV2SyncResult,
} from './types';

export interface SyncularV2ClientLifecycleOptions {
  autoStart?: boolean;
  initialSync?: boolean;
  realtime?: boolean | SyncularV2RealtimeOptions;
  syncOnRealtimeConnect?: boolean;
  pollIntervalMs?: number | false;
}

export interface CreateSyncularV2ClientOptions
  extends Omit<CreateSyncularV2DatabaseOptions, 'realtime'> {
  subscriptions?: readonly SyncularV2SubscriptionSpec[];
  lifecycle?: SyncularV2ClientLifecycleOptions;
  realtime?: boolean | SyncularV2RealtimeOptions;
}

export interface SyncularV2ManagedClient<DB> extends SyncularV2Database<DB> {
  start(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
  sync(): Promise<SyncularV2SyncResult>;
}

type LifecycleClient = Pick<
  SyncularV2Client,
  | 'addDiagnosticListener'
  | 'connectionState'
  | 'setSubscriptions'
  | 'startRealtime'
  | 'stopRealtime'
  | 'syncOnce'
>;

export async function createSyncularV2Client<DB>(
  options: CreateSyncularV2ClientOptions
): Promise<SyncularV2ManagedClient<DB>> {
  const { lifecycle, realtime, subscriptions, ...databaseOptions } = options;
  const database = await createSyncularV2Database<DB>({
    ...databaseOptions,
    realtime: false,
  });
  const controller = new SyncularV2ClientLifecycle(database.client, {
    subscriptions,
    realtime: lifecycle?.realtime ?? realtime ?? true,
    initialSync: lifecycle?.initialSync,
    syncOnRealtimeConnect: lifecycle?.syncOnRealtimeConnect,
    pollIntervalMs: lifecycle?.pollIntervalMs,
  });
  const closeDatabase = database.close.bind(database);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await controller.stop();
    } finally {
      await closeDatabase();
    }
  };

  const managed = {
    ...database,
    start: () => controller.start(),
    stop: () => controller.stop(),
    sync: () => controller.sync(),
    close,
    destroy: close,
  } satisfies SyncularV2ManagedClient<DB>;

  if (lifecycle?.autoStart !== false) {
    await managed.start();
  }

  return managed;
}

export class SyncularV2ClientLifecycle {
  #started = false;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #unsubscribeDiagnostics: (() => void) | undefined;
  #syncInFlight: Promise<SyncularV2SyncResult> | undefined;
  #syncAgain = false;
  #hasConnectedRealtime = false;

  constructor(
    private readonly client: LifecycleClient,
    private readonly options: {
      subscriptions?: readonly SyncularV2SubscriptionSpec[];
      realtime?: boolean | SyncularV2RealtimeOptions;
      initialSync?: boolean;
      syncOnRealtimeConnect?: boolean;
      pollIntervalMs?: number | false;
    } = {}
  ) {}

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#hasConnectedRealtime =
      this.client.connectionState().realtime === 'connected';
    this.#unsubscribeDiagnostics = this.client.addDiagnosticListener((event) =>
      this.#handleDiagnostic(event)
    );
    try {
      if (this.options.subscriptions) {
        await this.client.setSubscriptions(this.options.subscriptions);
      }
      if (this.options.initialSync !== false) {
        await this.sync();
      }
      if (this.options.realtime !== false) {
        await this.client.startRealtime(this.options.realtime);
      }
      this.#startPolling();
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.#stopPolling();
    this.#unsubscribeDiagnostics?.();
    this.#unsubscribeDiagnostics = undefined;
    this.#syncAgain = false;
    if (this.options.realtime !== false) {
      await this.client.stopRealtime();
    }
  }

  async sync(): Promise<SyncularV2SyncResult> {
    if (this.#syncInFlight) {
      this.#syncAgain = true;
      return this.#syncInFlight;
    }
    this.#syncInFlight = this.client.syncOnce().finally(() => {
      this.#syncInFlight = undefined;
      if (this.#syncAgain && this.#started) {
        this.#syncAgain = false;
        void this.sync().catch(() => undefined);
      }
    });
    return this.#syncInFlight;
  }

  #handleDiagnostic(event: SyncularV2DiagnosticEvent): void {
    if (
      event.source !== 'realtime' ||
      event.code !== 'realtime.state' ||
      event.details?.state == null
    ) {
      return;
    }
    const state = event.details.state as SyncularV2RealtimeConnectionState;
    if (state !== 'connected') return;
    const wasReconnect = this.#hasConnectedRealtime;
    this.#hasConnectedRealtime = true;
    const shouldSync =
      this.options.syncOnRealtimeConnect !== false &&
      (wasReconnect || this.options.initialSync === false);
    if (!shouldSync) return;
    void this.sync().catch(() => undefined);
  }

  #startPolling(): void {
    const interval = this.options.pollIntervalMs;
    if (interval === false || interval === undefined || interval <= 0) return;
    this.#pollTimer = setInterval(() => {
      void this.sync().catch(() => undefined);
    }, interval);
  }

  #stopPolling(): void {
    if (!this.#pollTimer) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }
}
