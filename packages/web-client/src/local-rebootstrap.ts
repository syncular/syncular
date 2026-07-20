/**
 * Application-authorized recovery of the replicated local projection.
 *
 * This is deliberately separate from `purgeLocalData`: rebootstrap keeps
 * device identity, the outbox, commit outcomes, subscription registrations,
 * lease state, and protected bookkeeping. It only discards server-derived
 * projection state so the registered subscriptions can bootstrap it again.
 */

import { ClientSyncError } from './errors';

const CODE_LIKE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RESULT_KEYS = [
  'alreadyApplied',
  'resetSubscriptions',
  'retainedCommits',
] as const;

/** A non-direct host returned a response that does not match its public API. */
export const INVALID_HOST_RESPONSE_CODE = 'client.invalid_host_response';

/** A durable idempotency key supplied by the application repair coordinator. */
export interface LocalDataRebootstrapInput {
  readonly rebootstrapId: string;
}

/** Privacy-safe acknowledgement; no row or subscription identifiers escape. */
export interface LocalDataRebootstrapResult {
  readonly alreadyApplied: boolean;
  readonly retainedCommits: number;
  readonly resetSubscriptions: number;
}

function invalidHostResponse(): never {
  throw new ClientSyncError(
    INVALID_HOST_RESPONSE_CODE,
    'rebootstrapLocalData returned an invalid host response',
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strictly decode the privacy-safe acknowledgement returned by a Worker or
 * native command bridge. Compile-time host types are not runtime proof: this
 * rejects version drift and malformed bridge values before an application can
 * persist or display them.
 */
export function decodeLocalDataRebootstrapResult(
  value: unknown,
): LocalDataRebootstrapResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidHostResponse();
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  if (
    keys.length !== RESULT_KEYS.length ||
    keys.some((key, index) => key !== RESULT_KEYS[index]) ||
    typeof source.alreadyApplied !== 'boolean' ||
    !isCount(source.retainedCommits) ||
    !isCount(source.resetSubscriptions)
  ) {
    return invalidHostResponse();
  }
  return {
    alreadyApplied: source.alreadyApplied,
    retainedCommits: source.retainedCommits,
    resetSubscriptions: source.resetSubscriptions,
  };
}

/** Validate before entering the recovery transaction. */
export function compileLocalDataRebootstrap(
  input: LocalDataRebootstrapInput,
): string {
  if (
    input.rebootstrapId.length === 0 ||
    input.rebootstrapId.length > 128 ||
    !CODE_LIKE_VALUE.test(input.rebootstrapId)
  ) {
    throw new ClientSyncError(
      'sync.invalid_request',
      'local rebootstrap rebootstrapId must be a 1–128 character code-like identifier',
    );
  }
  return input.rebootstrapId;
}

export function localDataRebootstrapMetaKey(rebootstrapId: string): string {
  return `localRebootstrap:${rebootstrapId}`;
}
