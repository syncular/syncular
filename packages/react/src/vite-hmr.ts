import type { SyncClientLike } from './client';
import { createSyncClientResource, type SyncClientResource } from './resource';
import { SYNCULAR_REACT_RUNTIME_VERSION } from './runtime-version';

/** The exact value retained in `import.meta.hot.data.syncularClientResource`. */
export interface RetainedSyncularResource {
  readonly schemaVersion: number;
  readonly runtimeVersion: string;
  readonly resource: SyncClientResource;
}

export interface ViteSyncClientResourceResult {
  readonly resource: SyncClientResource;
  /**
   * Compatibility signal used by existing integrations to invalidate HMR.
   * True when either the schema or Syncular runtime identity changed.
   */
  readonly schemaChanged: boolean;
  /** True only when a retained owner came from another Syncular release. */
  readonly runtimeChanged: boolean;
  /** True whenever an incompatible retained owner was replaced. */
  readonly ownerChanged: boolean;
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

function retainedFrom(hotData: HotData | undefined):
  | {
      readonly schemaVersion?: number;
      readonly runtimeVersion?: string;
      readonly resource: SyncClientResource;
    }
  | undefined {
  const value = hotData?.syncularClientResource;
  if (isResource(value)) {
    // Compatibility with the pre-RFC guide, which retained the bare resource.
    return { resource: value };
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as {
    readonly schemaVersion?: unknown;
    readonly runtimeVersion?: unknown;
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
    ...(typeof candidate.runtimeVersion === 'string'
      ? { runtimeVersion: candidate.runtimeVersion }
      : {}),
    resource: candidate.resource,
  };
}

/**
 * Reuse a Vite-owned client only while both its captured generated schema and
 * materialized Syncular runtime identity match. On either change, the prior
 * resource is fully disposed before the replacement resource (and therefore
 * its worker) is constructed.
 */
export async function retainViteSyncClientResource(
  hotData: HotData | undefined,
  schemaVersion: number,
  factory: () => SyncClientLike | Promise<SyncClientLike>,
  runtimeVersion = SYNCULAR_REACT_RUNTIME_VERSION,
): Promise<ViteSyncClientResourceResult> {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new TypeError('schemaVersion must be a positive integer');
  }
  if (
    typeof runtimeVersion !== 'string' ||
    runtimeVersion.length === 0 ||
    runtimeVersion.length > 96
  ) {
    throw new TypeError('runtimeVersion must be a bounded non-empty string');
  }

  const retained = retainedFrom(hotData);
  if (
    retained?.schemaVersion === schemaVersion &&
    retained.runtimeVersion === runtimeVersion
  ) {
    return {
      resource: retained.resource,
      schemaChanged: false,
      runtimeChanged: false,
      ownerChanged: false,
    };
  }

  const ownerChanged = retained !== undefined;
  const runtimeChanged =
    retained !== undefined && retained.runtimeVersion !== runtimeVersion;

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
    const record: RetainedSyncularResource = {
      schemaVersion,
      runtimeVersion,
      resource,
    };
    hotData.syncularClientResource = record;
  }
  return {
    resource,
    // Existing apps already invalidate on this property. Preserve that
    // recovery behavior for a same-schema package upgrade.
    schemaChanged: ownerChanged,
    runtimeChanged,
    ownerChanged,
    ...(disposalError !== undefined ? { disposalError } : {}),
  };
}
