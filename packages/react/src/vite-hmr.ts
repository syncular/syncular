import type { SyncClientLike } from './client';
import { createSyncClientResource, type SyncClientResource } from './resource';

/** The exact value retained in `import.meta.hot.data.syncularClientResource`. */
export interface RetainedSyncularResource {
  readonly schemaVersion: number;
  readonly resource: SyncClientResource;
}

export interface ViteSyncClientResourceResult {
  readonly resource: SyncClientResource;
  /** True only when an older captured schema identity was replaced. */
  readonly schemaChanged: boolean;
  /** A failed close is exposed by `resource` as a startup error. */
  readonly disposalError?: Error;
}

type HotData = Record<string, unknown>;

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isResource(value: unknown): value is SyncClientResource {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly kind?: unknown }).kind === 'syncular-client-resource'
  );
}

function retainedFrom(
  hotData: HotData | undefined,
):
  | { readonly schemaVersion?: number; readonly resource: SyncClientResource }
  | undefined {
  const value = hotData?.syncularClientResource;
  if (isResource(value)) {
    // Compatibility with the pre-RFC guide, which retained the bare resource.
    return { resource: value };
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as {
    readonly schemaVersion?: unknown;
    readonly resource?: unknown;
  };
  if (
    typeof candidate.schemaVersion !== 'number' ||
    !Number.isInteger(candidate.schemaVersion) ||
    !isResource(candidate.resource)
  ) {
    return undefined;
  }
  return {
    schemaVersion: candidate.schemaVersion,
    resource: candidate.resource,
  };
}

/**
 * Reuse a Vite-owned client only while its captured generated schema matches.
 * On a bump, the prior resource is fully disposed before the replacement
 * resource (and therefore its worker) is constructed.
 */
export async function retainViteSyncClientResource(
  hotData: HotData | undefined,
  schemaVersion: number,
  factory: () => SyncClientLike | Promise<SyncClientLike>,
): Promise<ViteSyncClientResourceResult> {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError('schemaVersion must be a positive integer');
  }

  const retained = retainedFrom(hotData);
  if (retained?.schemaVersion === schemaVersion) {
    return { resource: retained.resource, schemaChanged: false };
  }

  let disposalError: Error | undefined;
  if (retained !== undefined) {
    try {
      await retained.resource.dispose();
    } catch (error) {
      disposalError = errorOf(error);
    }
  }

  // A failed disposal must not open a competing owner. Publish a resource
  // whose ordinary provider startup boundary reports the close failure.
  const resource = createSyncClientResource(
    disposalError === undefined ? factory : () => Promise.reject(disposalError),
  );
  if (hotData !== undefined) {
    const record: RetainedSyncularResource = { schemaVersion, resource };
    hotData.syncularClientResource = record;
  }
  return {
    resource,
    schemaChanged: retained !== undefined,
    ...(disposalError !== undefined ? { disposalError } : {}),
  };
}
