import { encodeMessage, PROTOCOL_WIRE_VERSION } from '@syncular/core';
import { BunClientDatabase } from '../src/bun-database';
import { ClientSyncError } from '../src/errors';
import { httpSyncTransport } from '../src/http';
import { startSyncWorker } from '../src/worker-remote';

startSyncWorker({
  openDatabase: () => new BunClientDatabase(),
  createTransport: (config) => {
    const mode =
      config.database.mode === 'custom' ? config.database.options : undefined;
    let first = true;
    const response = encodeMessage({
      wireVersion: PROTOCOL_WIRE_VERSION,
      msgKind: 'response',
      frames: [
        { type: 'RESP_HEADER', logEpoch: 'epoch-1', resetRequired: true },
      ],
    });
    if (mode === 'coded-network')
      return async () => {
        if (!first) return response;
        first = false;
        throw new ClientSyncError(
          'sync.transport_failed',
          'fixture.offline',
          true,
          { causeKind: 'network' },
        );
      };
    return httpSyncTransport(config.endpoints.syncUrl, {
      fetch: Object.assign(
        async () => {
          if (!first)
            return new Response(response.slice().buffer as ArrayBuffer);
          first = false;
          const secret =
            'https://user:password@example.invalid/private?token=secret';
          if (mode === 'network') throw new TypeError(secret);
          if (mode === 'timeout')
            throw new DOMException(secret, 'TimeoutError');
          if (mode === 'unknown') throw new Error(secret);
          if (mode === 'auth')
            return Response.json(
              { code: 'sync.auth_required', message: secret },
              { status: 401 },
            );
          return new Response(secret, { status: 500 });
        },
        { preconnect: fetch.preconnect },
      ),
    });
  },
});
