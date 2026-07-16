/** A persistent local store is temporarily owned by another live engine. */
export const STORAGE_BUSY_CODE = 'client.storage_busy';

/** The browser cannot provide the persistent storage APIs Syncular requires. */
export const STORAGE_UNAVAILABLE_CODE = 'client.storage_unavailable';

/**
 * Client-side errors. Protocol codes from the SPEC.md §10 catalog are surfaced
 * unchanged. Host/runtime-only conditions may use the separate `client.*`
 * namespace and never travel on the wire.
 */
export class ClientSyncError extends Error {
  override readonly name = 'ClientSyncError';
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}
