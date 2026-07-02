/**
 * Client-side errors. Protocol codes come from the SPEC.md §10 catalog;
 * the client never invents wire codes, it surfaces them.
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
