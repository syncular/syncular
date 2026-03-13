export type SyncClientFailureStage =
  | 'pull'
  | 'snapshot-chunk-fetch'
  | 'snapshot-gzip-decode'
  | 'snapshot-chunk-decode'
  | 'snapshot-integrity'
  | 'snapshot-apply'
  | 'bootstrap-timeout';

export interface SyncClientFailureContext {
  stage: SyncClientFailureStage;
  stateId?: string;
  subscriptionId?: string;
  table?: string;
  chunkId?: string;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class SyncClientStageError extends Error {
  readonly stage: SyncClientFailureStage;
  readonly stateId?: string;
  readonly subscriptionId?: string;
  readonly table?: string;
  readonly chunkId?: string;

  constructor(
    message: string,
    context: SyncClientFailureContext,
    cause?: unknown
  ) {
    const normalizedCause =
      cause === undefined ? undefined : normalizeError(cause);
    super(message);
    this.name = 'SyncClientStageError';
    this.stage = context.stage;
    this.stateId = context.stateId;
    this.subscriptionId = context.subscriptionId;
    this.table = context.table;
    this.chunkId = context.chunkId;
    if (normalizedCause) {
      this.cause = normalizedCause;
    }
  }
}

export function wrapSyncClientStageError(
  error: unknown,
  context: SyncClientFailureContext,
  message?: string
): SyncClientStageError {
  if (error instanceof SyncClientStageError) {
    return error;
  }
  const cause = normalizeError(error);
  return new SyncClientStageError(message ?? cause.message, context, cause);
}
