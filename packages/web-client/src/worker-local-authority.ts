import type { SiblingDatabase } from './database';
import { ClientSyncError } from './errors';
import type { SyncTransport } from './transport';
import type {
  WorkerLocalAuthority,
  WorkerLocalAuthorityFactory,
} from './worker-core';
import { LOCAL_AUTHORITY_UNCONFIGURED_CODE } from './worker-protocol';

/** §12 behavior loaded by the authority-enabled worker entry. */
export const createWorkerLocalAuthority: WorkerLocalAuthorityFactory = (
  context,
) => {
  let authority: WorkerLocalAuthority | undefined;
  let sibling: SiblingDatabase | undefined;
  let remoteTransport: SyncTransport | undefined;
  const active = () =>
    authority !== undefined && authority.state !== 'attached';

  async function drive(
    run: (local: WorkerLocalAuthority, remote: SyncTransport) => Promise<void>,
  ): Promise<void> {
    const running = context.requireClient();
    const local = authority;
    const remote = remoteTransport;
    if (local === undefined || remote === undefined) {
      throw new ClientSyncError(
        LOCAL_AUTHORITY_UNCONFIGURED_CODE,
        'init did not enable the local authority',
      );
    }
    running.setTransportEnabled(false);
    try {
      await context.serializedSync(() => run(local, remote));
    } catch (error) {
      if (
        error instanceof Error &&
        !(error instanceof ClientSyncError) &&
        'code' in error &&
        typeof error.code === 'string'
      ) {
        throw new ClientSyncError(
          error.code,
          error.message,
          false,
          'details' in error &&
            typeof error.details === 'object' &&
            error.details !== null
            ? { ...error.details }
            : undefined,
        );
      }
      throw error;
    } finally {
      running.setTransportEnabled(!context.isOffline());
    }
    context.wake();
  }

  return {
    methods: {
      localAuthorityState: () => authority?.state,
      attachLocalAuthority: () =>
        drive((local, remote) => local.attach(remote)),
      abandonLocalAuthorityAttach: () =>
        drive((local, remote) => local.abandonAttach(remote)),
    },
    async open(config, database, remote, segments) {
      remoteTransport = remote;
      if (context.overrides.openLocalAuthority === undefined) {
        throw new ClientSyncError(
          LOCAL_AUTHORITY_UNCONFIGURED_CODE,
          'localAuthority requires startSyncWorker({ openLocalAuthority })',
        );
      }
      sibling = database.openSibling?.('local-authority');
      if (sibling === undefined) {
        throw new ClientSyncError(
          LOCAL_AUTHORITY_UNCONFIGURED_CODE,
          'localAuthority requires a database with sibling files',
        );
      }
      const local = await context.overrides.openLocalAuthority(
        sibling.database,
        config.schema,
      );
      authority = local;
      return {
        transport: (request) =>
          active() ? local.sync(request) : remote(request),
        segments: (request) => {
          if (active()) return local.downloadSegment(request);
          if (segments === undefined) {
            throw new ClientSyncError(
              'sync.invalid_request',
              'no segment endpoint configured',
            );
          }
          return segments(request);
        },
      };
    },
    active,
    close: () => sibling?.close(),
  };
};
