import type { PartitionRegistryEntry, ServerStorage } from './storage';

export interface RotatePartitionLogEpochOptions {
  readonly storage: ServerStorage;
  readonly partition: string;
  readonly nowMs?: number;
  /** Deterministic operator/test override. Defaults to a random UUID. */
  readonly logEpoch?: string;
}

/**
 * Fence clients from a prior authoritative database timeline after restore.
 * Call while traffic and realtime delivery remain stopped (§2.1).
 */
export function rotatePartitionLogEpoch(
  options: RotatePartitionLogEpochOptions,
): Promise<PartitionRegistryEntry> {
  if (options.partition.length === 0) {
    throw new TypeError('partition must be non-empty');
  }
  const logEpoch = options.logEpoch ?? crypto.randomUUID();
  if (logEpoch.length === 0) throw new TypeError('logEpoch must be non-empty');
  return options.storage.rotatePartitionLogEpoch(
    options.partition,
    logEpoch,
    options.nowMs ?? Date.now(),
  );
}
