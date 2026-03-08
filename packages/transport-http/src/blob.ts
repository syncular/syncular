import type { SyncTransport, SyncTransportBlobs } from '@syncular/core';
import { SyncTransportError } from '@syncular/core';
import { executeWithAuthRetry, getErrorMessage } from './shared';
import {
  createTransportApiClient,
  createTransportAuthRetryResolver,
  HTTP_TRANSPORT_SOURCE,
  type HttpTransportSource,
} from './transport-client';

type HttpTransportWithSource = SyncTransport & {
  [HTTP_TRANSPORT_SOURCE]?: HttpTransportSource;
};

export function createHttpTransportBlobs(
  source: HttpTransportSource
): SyncTransportBlobs {
  const client = createTransportApiClient(source);
  const resolveAuthRetry = createTransportAuthRetryResolver(source);

  return {
    async initiateUpload(args) {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) => client.initiateUpload(args, signal),
        undefined,
        'blobInitiateUpload',
        resolveAuthRetry
      );

      if (error || !data) {
        throw new SyncTransportError(
          `Blob upload init failed: ${getErrorMessage(error) || response.statusText}`,
          response.status
        );
      }

      return data;
    },

    async completeUpload(hash) {
      const { data, error } = await executeWithAuthRetry(
        (signal) => client.completeUpload(hash, signal),
        undefined,
        'blobCompleteUpload',
        resolveAuthRetry
      );

      if (error || !data) {
        return {
          ok: false,
          error: getErrorMessage(error) || 'Complete upload failed',
        };
      }

      return data;
    },

    async getDownloadUrl(hash) {
      const { data, error, response } = await executeWithAuthRetry(
        (signal) => client.getDownloadUrl(hash, signal),
        undefined,
        'blobGetDownloadUrl',
        resolveAuthRetry
      );

      if (error || !data) {
        throw new SyncTransportError(
          `Get download URL failed: ${getErrorMessage(error) || response.statusText}`,
          response.status
        );
      }

      return data;
    },
  };
}

export function ensureHttpTransportBlobs(
  transport: SyncTransport
): SyncTransportBlobs | null {
  if (transport.blobs) {
    return transport.blobs;
  }

  const source = (transport as HttpTransportWithSource)[HTTP_TRANSPORT_SOURCE];
  if (!source) {
    return null;
  }

  const blobs = createHttpTransportBlobs(source);
  transport.blobs = blobs;
  return blobs;
}

export type { SyncClient } from './api-client';
