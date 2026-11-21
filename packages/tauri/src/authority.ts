import type {
  AuthorityReadPolicy,
  AuthorityReadRequest,
  AuthorityReadResult,
} from '@syncular/client/authority';
import {
  createTauriSyncClient,
  TauriSyncClient,
  TauriSyncError,
  type TauriSyncClientConfig,
} from './index';

/** Explicit native bridge with the preflight authority read. */
export class TauriAuthoritySyncClient extends TauriSyncClient {
  async authorityRead(
    requests: readonly AuthorityReadRequest[],
  ): Promise<AuthorityReadResult> {
    if (arguments.length !== 1)
      throw new TauriSyncError(
        'client.authority_read_forbidden',
        'authorityRead takes one requests list',
      );
    const result = (await this.command('authorityRead', {
      requests,
    })) as Omit<AuthorityReadResult, 'revision'> & { revision: string };
    this.requireOpen();
    return {
      revision: BigInt(result.revision),
      results: result.results.map((read) => ({
        ...read,
        rows: read.rows.map((row) => this.decodeRow(row)),
      })),
    };
  }
}

/** Construct an authority-enabled bridge; Rust still enforces its independent ceiling. */
export function createTauriAuthoritySyncClient(
  config: TauriSyncClientConfig & {
    readonly authorityReads: AuthorityReadPolicy;
  },
): Promise<TauriAuthoritySyncClient> {
  return createTauriSyncClient(
    config,
    (...args) => new TauriAuthoritySyncClient(...args),
  );
}
