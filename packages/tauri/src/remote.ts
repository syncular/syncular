/**
 * @syncular/tauri: the JS bridge to the native syncular client running inside
 * the Tauri process (see `tauri-plugin-syncular`).
 *
 * The Tauri host runs a REAL Rust syncular client (file DB + native HTTP+WS
 * transport). This module is the webview-side proxy over the shared native
 * command bridge (`@syncular/client/native-bridge`), so the React hooks
 * (`useRawSql`, `useMutation`, `usePresence`, …) work unchanged against a
 * Tauri app.
 *
 * Every method forwards to the plugin's `syncular_command` command (the whole
 * command surface in one `{method, params}` envelope). `query` uses the
 * dedicated `syncular_query` fast path; atomic reactive reads use
 * `syncular_query_snapshot`, backed by an independent read-only SQLite
 * connection so network sync cannot stall local UI reads. Client-observable
 * events arrive on the `syncular://event` Tauri event.
 *
 * `@tauri-apps/api` is a required peer dependency: the bridge takes
 * `invoke`/`listen` either from its ESM entry points, from the ambient
 * `window.__TAURI__`, or via injected doubles (tests).
 */
import type {
  AuthorityReadPolicy,
  ClientDiagnosticsListener,
  SecurityLifecycle,
  SnapshotRead,
} from '@syncular/client';
import {
  NativeBridgeClient,
  type NativeCreateConfig,
  type NativeReply,
  NativeSyncError,
  nativeCreateParams,
  type SyncularEvent,
} from '@syncular/client/native-bridge';

export type { BytesEnvelope } from '@syncular/client/native-bridge';

/** §7.5: one read-only statement in an atomic sidecar snapshot read. */
export type { SnapshotStatement } from '@syncular/client';

/** §7.5: the catch-up state of one subscription from the sidecar. */
export type { SubscriptionCatchup } from '@syncular/client';

/** §7.5: delivery status for one client commit id. */
export type { CommitDelivery } from '@syncular/client';

/** §7.5: one atomic sidecar snapshot read result with decoded rows. */
export type SnapshotReadResult = SnapshotRead;

/** The two Tauri primitives the bridge needs — injectable for tests. */
export interface TauriApi {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
}

/** The plugin's Tauri event name — mirror of `tauri-plugin-syncular`. */
export const SYNCULAR_EVENT = 'syncular://event';

const PLUGIN = 'plugin:syncular|';

/** SPEC §12 local authority lifecycle state. */
export type LocalAuthorityState = 'local' | 'attaching' | 'attached';

/** Config for {@link createTauriSyncClient}. */
export interface TauriSyncClientConfig extends NativeCreateConfig {
  /**
   * Name of the native database to open, for example one replica per
   * signed-in actor. The plugin opens `<database_dir>/<database>.db` from its
   * `SyncularConfig`; a name is 1 to 128 ASCII letters, digits, `-`, `_` or
   * `.` and starts with a letter or digit. Absent ⇒ the plugin's `db_path`.
   */
  readonly database?: string;
  readonly retainFailedCommits?: boolean;
  /** Fixed plain authority reads permitted before security activation. */
  readonly authorityReads?: AuthorityReadPolicy;
  /** Open local storage with network transport closed until explicitly resumed. */
  readonly transportEnabled?: boolean;
  /**
   * The Tauri primitives. Omit in a real Tauri webview to auto-resolve from
   * `@tauri-apps/api` (peer dep) or the ambient `window.__TAURI__`; inject in
   * tests. Resolution is async, so construction is a factory (below).
   */
  readonly tauri?: TauriApi;
}

/** The error a `{error}` reply surfaces (mirrors the web-client `ClientSyncError`). */
export class TauriSyncError extends NativeSyncError {
  override name = 'TauriSyncError';
}

/** Resolve the Tauri primitives from the ambient environment when not injected. */
async function resolveTauri(injected: TauriApi | undefined): Promise<TauriApi> {
  if (injected !== undefined) return injected;
  // Prefer the ambient global (present when `withGlobalTauri` is enabled).
  const ambient = (
    globalThis as {
      __TAURI__?: {
        core?: { invoke?: TauriApi['invoke'] };
        event?: { listen?: TauriApi['listen'] };
      };
    }
  ).__TAURI__;
  if (ambient?.core?.invoke && ambient.event?.listen) {
    return {
      invoke: ambient.core.invoke.bind(ambient.core),
      listen: ambient.event.listen.bind(ambient.event),
    };
  }
  // Fall back to the ESM package (the common path). These must remain literal,
  // bundler-visible specifiers: hiding a bare package import behind
  // `@vite-ignore` makes WebKit resolve it as a URL at runtime instead of
  // letting Vite/Bun include the Tauri API in the webview bundle.
  const [core, event] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  return { invoke: core.invoke, listen: event.listen };
}

/** The webview-side proxy implementing `SyncClientLike` over the plugin. */
export class TauriSyncClient extends NativeBridgeClient {
  readonly #tauri: TauriApi;
  #diagnosticsEnabled = false;

  /** @internal — use {@link createTauriSyncClient}. */
  constructor(
    tauri: TauriApi,
    unlisten: () => void,
    securityLifecycle: SecurityLifecycle = 'active',
  ) {
    super('tauri', TauriSyncError, unlisten, securityLifecycle);
    this.#tauri = tauri;
  }

  protected override send(
    method: string,
    params: Record<string, unknown>,
  ): Promise<NativeReply> {
    return this.#tauri.invoke(`${PLUGIN}syncular_command`, {
      command: { method, params },
    });
  }

  protected override sendQuery(
    sql: string,
    params: unknown,
  ): Promise<NativeReply> {
    return this.#tauri.invoke(`${PLUGIN}syncular_query`, { sql, params });
  }

  protected override sendQuerySnapshot(
    params: Record<string, unknown>,
  ): Promise<NativeReply> {
    return this.#tauri.invoke(`${PLUGIN}syncular_query_snapshot`, params);
  }

  protected override sendHeaders(
    headers: Readonly<Record<string, string>>,
  ): Promise<NativeReply> {
    return this.#tauri.invoke(`${PLUGIN}syncular_set_headers`, { headers });
  }

  /** Shut down the native core and release its keyring. */
  protected override async shutdown(): Promise<void> {
    await this.command('shutdown', {});
  }

  /**
   * The native core pushes diagnostics snapshots only once a consumer is
   * known (a `diagnosticsSnapshot` pull, or this `enableDiagnostics` signal).
   * The first listener sends it once, fire-and-forget and outside the
   * preflight gate: it is a pure observability registration, and the native
   * side stays silent until activation. An error is tolerated, because the
   * mount-time snapshot pull keeps `useDiagnostics` working without it.
   */
  override onDiagnostics(listener: ClientDiagnosticsListener): () => void {
    const off = super.onDiagnostics(listener);
    if (!this.#diagnosticsEnabled) {
      this.#diagnosticsEnabled = true;
      void this.send('enableDiagnostics', {}).catch(() => {});
    }
    return off;
  }

  /** Suspend new network work while retaining local access and queued commits. */
  async setTransportEnabled(enabled: boolean): Promise<void> {
    await this.command('setTransportEnabled', { enabled });
  }

  /** Browser offline-control parity; local reads and commits remain available. */
  async setOffline(offline: boolean): Promise<void> {
    await this.setTransportEnabled(!offline);
  }

  /**
   * Rotate the client id (§1.5) after a `sync.invalid_client_id` refusal
   * (`recommendedAction: resetClientId`). The next round carries the new id;
   * the replica and outbox stay in place.
   */
  async resetClientId(): Promise<string> {
    const result = (await this.command('resetClientId', {})) as {
      clientId: string;
    };
    return result.clientId;
  }
}

/**
 * Construct the bridge and issue the native `create` (opening/attaching the
 * file DB on the Rust side per the plugin config). Returns a ready
 * `TauriSyncClient` that satisfies `SyncClientLike` — pass it straight to the
 * React `<SyncProvider client={…}>`.
 */
export function createTauriSyncClient(
  config: TauriSyncClientConfig,
): Promise<TauriSyncClient>;
/** @internal Explicit bridge extension used by the authority entry. */
export function createTauriSyncClient<Client extends TauriSyncClient>(
  config: TauriSyncClientConfig,
  createClient: (
    ...args: ConstructorParameters<typeof TauriSyncClient>
  ) => Client,
): Promise<Client>;
export async function createTauriSyncClient(
  config: TauriSyncClientConfig,
  createClient = (...args: ConstructorParameters<typeof TauriSyncClient>) =>
    new TauriSyncClient(...args),
): Promise<TauriSyncClient> {
  // The native side owns every path (plugin config); the JS side names a
  // database and supplies the schema, clientId, and limits.
  const params = {
    ...nativeCreateParams(config, TauriSyncError),
    ...(config.database !== undefined ? { database: config.database } : {}),
    ...(config.retainFailedCommits !== undefined
      ? { retainFailedCommits: config.retainFailedCommits }
      : {}),
    ...(config.transportEnabled !== undefined
      ? { transportEnabled: config.transportEnabled }
      : {}),
    ...(config.authorityReads !== undefined
      ? { authorityReads: config.authorityReads.declarations }
      : {}),
  };
  const tauri = await resolveTauri(config.tauri);
  // Wire the event stream BEFORE create, so no early change batch is missed.
  let client: TauriSyncClient | undefined;
  const unlisten = await tauri.listen<SyncularEvent>(SYNCULAR_EVENT, (event) =>
    client?.__dispatchEvent(event.payload),
  );
  client = createClient(
    tauri,
    unlisten,
    config.securityPreflight === true ? 'preflight' : 'active',
  );
  await client.__open(() =>
    tauri.invoke<NativeReply>(`${PLUGIN}syncular_command`, {
      command: { method: 'create', params },
    }),
  );
  return client;
}
