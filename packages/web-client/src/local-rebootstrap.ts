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
