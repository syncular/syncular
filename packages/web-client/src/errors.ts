import type { RealtimeState } from './diagnostics';

/** A persistent local store is temporarily owned by another live engine. */
export const STORAGE_BUSY_CODE = 'client.storage_busy';

/** The browser cannot provide the persistent storage APIs Syncular requires. */
export const STORAGE_UNAVAILABLE_CODE = 'client.storage_unavailable';

/** A local read hit SQLITE_CORRUPT or SQLITE_NOTADB (SPEC §7.5). */
export const STORAGE_CORRUPT_CODE = 'client.storage_corrupt';

/** A local read hit SQLITE_IOERR (SPEC §7.5). */
export const STORAGE_IO_CODE = 'client.storage_io';

/** SPEC §8.8: a round under `realtimePolicy: 'required'` found no socket. */
export const REALTIME_UNAVAILABLE_CODE = 'sync.realtime_unavailable';

/** SPEC §8.8: a connected socket ended without a deliberate disconnect. */
export const REALTIME_LOST_CODE = 'client.realtime_lost';

/**
 * Client-side errors. Protocol codes from the SPEC.md §10 catalog are surfaced
 * unchanged. Host/runtime-only conditions may use the separate `client.*`
 * namespace and never travel on the wire.
 */
export class ClientSyncError extends Error {
  override readonly name: string = 'ClientSyncError';
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: string,
    message: string,
    retryable = false,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * SPEC §7.5: the latest sync attempt failed while a live query still waited
 * for its required coverage. `code` is the attempt's static progress error
 * code; `attempt` is the progress attempt that failed. `retryable` is true when
 * the client scheduled a background retry for the attempt, and `retryDelayMs`
 * is that retry's delay from the failure; a non-retryable failure has no
 * delay and no automatic next attempt. The query returns to waiting when the
 * next attempt starts.
 */
export class SyncRoundFailedError extends ClientSyncError {
  override readonly name = 'SyncRoundFailedError';
  readonly attempt: number;
  readonly retryDelayMs: number | undefined;

  constructor(code: string, attempt: number, retryDelayMs: number | undefined) {
    super(
      code,
      'the sync round failed before the query coverage completed',
      retryDelayMs !== undefined,
    );
    this.attempt = attempt;
    this.retryDelayMs = retryDelayMs;
  }
}

/**
 * SPEC §8.8: the `required` realtime policy refused a round because the
 * socket is not connected. `state` is the availability state that refused
 * (`connecting`, `lost`, `refused`, or `disconnected`), `reasonCode` is the
 * stable code behind a `lost` or `refused` state, and `retryDelayMs` is the
 * delay of the background retry intent the client scheduled with this throw.
 */
export class RealtimeUnavailableError extends ClientSyncError {
  override readonly name = 'RealtimeUnavailableError';
  readonly state: RealtimeState;
  readonly reasonCode: string | undefined;
  readonly retryDelayMs: number;

  constructor(
    state: RealtimeState,
    reasonCode: string | undefined,
    retryDelayMs: number,
  ) {
    super(
      REALTIME_UNAVAILABLE_CODE,
      'realtime is required and the realtime socket is not connected',
      true,
    );
    this.state = state;
    this.reasonCode = reasonCode;
    this.retryDelayMs = retryDelayMs;
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
