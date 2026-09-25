/** A persistent local store is temporarily owned by another live engine. */
export const STORAGE_BUSY_CODE = 'client.storage_busy';

/** The browser cannot provide the persistent storage APIs Syncular requires. */
export const STORAGE_UNAVAILABLE_CODE = 'client.storage_unavailable';

/** A local read hit SQLITE_CORRUPT or SQLITE_NOTADB (SPEC §7.5). */
export const STORAGE_CORRUPT_CODE = 'client.storage_corrupt';

/** A local read hit SQLITE_IOERR (SPEC §7.5). */
export const STORAGE_IO_CODE = 'client.storage_io';

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

/**
 * SPEC §7.5: classify a local SQLite read failure by the numeric result code
 * the driver exposes (bun:sqlite `errno`, node:sqlite `errcode`, sqlite-wasm
 * `resultCode`), never by message text. `error` is what the read throws: a
 * stable `ClientSyncError` for corruption or I/O failure, otherwise the
 * original value.
 */
export function classifySqliteFailure(error: unknown): {
  readonly sqliteCode: number | undefined;
  readonly code:
    | typeof STORAGE_CORRUPT_CODE
    | typeof STORAGE_IO_CODE
    | undefined;
  readonly error: unknown;
} {
  const sqliteCode =
    error instanceof Error
      ? error.name === 'SQLiteError' &&
        'errno' in error &&
        typeof error.errno === 'number'
        ? error.errno
        : 'errcode' in error && typeof error.errcode === 'number'
          ? error.errcode
          : error.name === 'SQLite3Error' &&
              'resultCode' in error &&
              typeof error.resultCode === 'number'
            ? error.resultCode
            : undefined
      : undefined;
  const primary = sqliteCode === undefined ? undefined : sqliteCode & 0xff;
  if (primary === 11 || primary === 26) {
    return {
      sqliteCode,
      code: STORAGE_CORRUPT_CODE,
      error: new ClientSyncError(
        STORAGE_CORRUPT_CODE,
        'local SQLite storage is corrupt',
      ),
    };
  }
  if (primary === 10) {
    return {
      sqliteCode,
      code: STORAGE_IO_CODE,
      error: new ClientSyncError(
        STORAGE_IO_CODE,
        'local SQLite storage I/O failed',
      ),
    };
  }
  return { sqliteCode, code: undefined, error };
}
