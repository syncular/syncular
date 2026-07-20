import { ClientSyncError } from './errors';

const LEGACY_MARKER = 'v1';
const RECEIPT_VERSION = 2;
const RECEIPT_KEYS = [
  'resetSubscriptions',
  'retainedCommits',
  'version',
] as const;

export interface LocalDataRebootstrapReceipt {
  readonly retainedCommits: number;
  readonly resetSubscriptions: number;
}

function invalidReceipt(): never {
  throw new ClientSyncError(
    'sync.local_corrupt',
    'persisted local rebootstrap receipt is invalid',
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Encode only the bounded counts that are safe to replay outside the core. */
export function encodeLocalDataRebootstrapReceipt(
  receipt: LocalDataRebootstrapReceipt,
): string {
  if (
    !isCount(receipt.retainedCommits) ||
    !isCount(receipt.resetSubscriptions)
  ) {
    return invalidReceipt();
  }
  return JSON.stringify({
    version: RECEIPT_VERSION,
    retainedCommits: receipt.retainedCommits,
    resetSubscriptions: receipt.resetSubscriptions,
  });
}

/**
 * Decode a committed receipt without leaking its application-owned key. The
 * original counts were not retained by pre-0.15.36 `v1` markers, so those
 * historical repairs keep their former zero-count replay behavior.
 */
export function decodeLocalDataRebootstrapReceipt(
  value: string,
): LocalDataRebootstrapReceipt {
  if (value === LEGACY_MARKER) {
    return { retainedCommits: 0, resetSubscriptions: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalidReceipt();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidReceipt();
  }
  const source = parsed as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  if (
    keys.length !== RECEIPT_KEYS.length ||
    keys.some((key, index) => key !== RECEIPT_KEYS[index]) ||
    source.version !== RECEIPT_VERSION ||
    !isCount(source.retainedCommits) ||
    !isCount(source.resetSubscriptions)
  ) {
    return invalidReceipt();
  }
  return {
    retainedCommits: source.retainedCommits,
    resetSubscriptions: source.resetSubscriptions,
  };
}
