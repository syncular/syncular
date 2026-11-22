import {
  attachTauriSyncClient as attachRemoteTauriSyncClient,
  createTauriSyncClient as createRemoteTauriSyncClient,
  TauriSyncClient as RemoteTauriSyncClient,
  type LocalAuthorityState,
  type TauriSyncClientConfig,
} from './remote';

export * from './remote';

/** Tauri bridge with the optional local-authority lifecycle (§12). */
export class TauriSyncClient extends RemoteTauriSyncClient {
  protected override allowPreflightCommand(method: string): boolean {
    return (
      method === 'localAuthorityState' || super.allowPreflightCommand(method)
    );
  }

  /** Local authority state, or null when the plugin configured no authority. */
  async localAuthorityState(): Promise<LocalAuthorityState | null> {
    const result = (await this.command('localAuthorityState', {})) as {
      state: LocalAuthorityState | null;
    };
    return result.state;
  }

  /** Upload the authority's live rows to the remote server (§12.3). */
  async attachLocalAuthority(): Promise<void> {
    await this.command('attachLocalAuthority', {});
  }

  /** Roll back a stopped attach and resume the local authority. */
  async abandonLocalAuthorityAttach(): Promise<void> {
    await this.command('abandonLocalAuthorityAttach', {});
  }
}

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
export function createTauriSyncClient(
  config: TauriSyncClientConfig,
  createClient = (...args: ConstructorParameters<typeof TauriSyncClient>) =>
    new TauriSyncClient(...args),
): Promise<TauriSyncClient> {
  return createRemoteTauriSyncClient(config, createClient);
}

export function attachTauriSyncClient(
  config?: Pick<TauriSyncClientConfig, 'tauri'>,
): Promise<TauriSyncClient> {
  return attachRemoteTauriSyncClient(
    config ?? {},
    (...args) => new TauriSyncClient(...args),
  );
}
