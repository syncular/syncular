import type {
  AuthorityReadPolicy,
  AuthoritySnapshot,
} from '@syncular/client/authority';
import {
  createTauriSyncClient,
  decodeRow,
  TauriSyncClient,
  TauriSyncError,
  type TauriSyncClientConfig,
} from './index';

/** Explicit native bridge with the zero-argument preflight authority read. */
export class TauriAuthoritySyncClient extends TauriSyncClient {
  async authoritySnapshot(): Promise<AuthoritySnapshot> {
    this.requireOpen();
    if (arguments.length)
      throw new TauriSyncError(
        'client.authority_read_forbidden',
        'authoritySnapshot accepts no arguments',
      );
    const result = (await this.command('authoritySnapshot', {})) as Omit<
      AuthoritySnapshot,
      'revision'
    > & { revision: string };
    this.requireOpen();
    return {
      ...result,
      revision: BigInt(result.revision),
      tables: result.tables.map((table) => ({
        ...table,
        rows: table.rows.map((row) => ({
          ...row,
          values: decodeRow(row.values),
        })),
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
