/**
 * Durable post-commit reactions. Planning runs inside the authoritative push
 * transaction and may only produce bounded data. Delivery runs later under a
 * lease and is at-least-once, so handlers receive the stable idempotency key.
 */
import type { SyncularServerEvents } from './events';
import { emitEvent } from './events';
import type {
  DurableJsonValue,
  NewReaction,
  ReactionFailure,
  ServerStorage,
} from './storage';
import type {
  CommitValidationReader,
  ValidateCommitOperation,
} from './validate';

export const MAX_REACTIONS_PER_COMMIT = 100;
export const MAX_REACTION_PAYLOAD_BYTES = 64 * 1024;
export const MAX_REACTION_FAILURE_DETAILS_BYTES = 8 * 1024;
export const DEFAULT_REACTION_MAX_ATTEMPTS = 10;
export const DEFAULT_REACTION_LEASE_MS = 30_000;
export const DEFAULT_REACTION_INITIAL_BACKOFF_MS = 1_000;
export const DEFAULT_REACTION_MAX_BACKOFF_MS = 5 * 60_000;

export interface ReactionRetentionPolicy {
  /** Keep completed rows for at least this duration (default 30 days). */
  readonly completedRetentionMs: number;
  /** Keep dead letters for at least this duration (default 90 days). */
  readonly deadLetterRetentionMs: number;
  /** Maximum terminal rows removed by one pass (default 1000). */
  readonly batchSize: number;
}

export const DEFAULT_REACTION_RETENTION: ReactionRetentionPolicy = {
  completedRetentionMs: 30 * 24 * 60 * 60 * 1000,
  deadLetterRetentionMs: 90 * 24 * 60 * 60 * 1000,
  batchSize: 1_000,
};

export type ReactionTypeMap = Readonly<Record<string, DurableJsonValue>>;

export interface ReactionPlan {
  /** Unique within the source client commit. */
  readonly key: string;
  readonly type: string;
  readonly version: number;
  readonly payload: DurableJsonValue;
  readonly maxAttempts?: number;
}

export type PlannedReaction<
  Reactions extends ReactionTypeMap = ReactionTypeMap,
> = {
  [Type in keyof Reactions & string]: {
    /** Unique within the source client commit. */
    readonly key: string;
    readonly type: Type;
    readonly version: number;
    readonly payload: Reactions[Type];
    readonly maxAttempts?: number;
  };
}[keyof Reactions & string];

export interface ReactionPlannerInput {
  readonly clientId: string;
  readonly clientCommitId: string;
  readonly actorId: string;
  readonly partition: string;
  readonly operations: readonly ValidateCommitOperation[];
  /** Candidate-state reads from the still-open authoritative transaction. */
  readonly read: CommitValidationReader;
}

/**
 * A pure planner over an accepted candidate commit. It may read candidate
 * state and return durable data. It must not execute user-visible side effects.
 */
export type ReactionPlanner<
  Reactions extends ReactionTypeMap = ReactionTypeMap,
> = (
  input: ReactionPlannerInput,
) =>
  | readonly PlannedReaction<Reactions>[]
  | Promise<readonly PlannedReaction<Reactions>[]>;

/** Erased planner shape stored on non-generic server configuration. */
export type AnyReactionPlanner = (
  input: ReactionPlannerInput,
) => readonly ReactionPlan[] | Promise<readonly ReactionPlan[]>;

export interface ReactionHandlerInput<Payload extends DurableJsonValue> {
  readonly partition: string;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly version: number;
  readonly payload: Payload;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly sourceClientId: string;
  readonly sourceClientCommitId: string;
  readonly sourceCommitSeq: number;
  /** Extend a long-running handler's lease; throws after ownership is lost. */
  readonly extendLease: () => Promise<void>;
}

export type ReactionHandler<Payload extends DurableJsonValue> = (
  input: ReactionHandlerInput<Payload>,
) => void | Promise<void>;

export type ReactionHandlers<
  Reactions extends ReactionTypeMap = ReactionTypeMap,
> = {
  readonly [Type in keyof Reactions & string]: ReactionHandler<Reactions[Type]>;
};

function normalizedJson(
  value: unknown,
  path: string,
  depth = 0,
): DurableJsonValue {
  if (depth > 16) throw new Error(`${path} exceeds the maximum JSON depth`);
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must be finite`);
    return value;
  }
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (
        typeof key !== 'string' ||
        !/^(?:0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length
      ) {
        throw new Error(`${path} arrays cannot carry extra properties`);
      }
    }
    const output: DurableJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new Error(`${path}[${index}] must be a plain JSON value`);
      }
      output.push(
        normalizedJson(descriptor.value, `${path}[${index}]`, depth + 1),
      );
    }
    return output;
  }
  if (typeof value !== 'object') {
    throw new Error(`${path} must contain only JSON values`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain JSON objects`);
  }
  const output: Record<string, DurableJsonValue> = {};
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error(`${path} cannot contain symbol keys`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new Error(`${path}.${key} must be an enumerable data property`);
    }
    entries.push([key, descriptor.value]);
  }
  for (const [key, entry] of entries.sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    Object.defineProperty(output, key, {
      value: normalizedJson(entry, `${path}.${key}`, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function boundedJson(
  value: unknown,
  path: string,
  maxBytes: number,
): DurableJsonValue {
  const normalized = normalizedJson(value, path);
  if (
    new TextEncoder().encode(JSON.stringify(normalized)).byteLength > maxBytes
  ) {
    throw new Error(`${path} exceeds ${maxBytes} persisted bytes`);
  }
  return normalized;
}

function assertName(value: string, field: string, maxBytes: number): void {
  if (
    !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(value) ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new Error(
      `${field} must be a code-like string no longer than ${maxBytes} bytes`,
    );
  }
}

/** Stable handler idempotency key for one planned item in a client commit. */
export function reactionIdempotencyKey(
  partition: string,
  clientId: string,
  clientCommitId: string,
  plannerKey: string,
): string {
  return JSON.stringify([partition, clientId, clientCommitId, plannerKey]);
}

export interface PreparedReaction {
  readonly idempotencyKey: string;
  readonly type: string;
  readonly version: number;
  readonly payload: DurableJsonValue;
  readonly maxAttempts: number;
}

/** Internal push seam, exported for focused planner tests and custom hosts. */
export async function prepareReactions(
  planner: AnyReactionPlanner,
  input: ReactionPlannerInput,
): Promise<PreparedReaction[]> {
  const planned = await planner(input);
  if (!Array.isArray(planned)) {
    throw new Error('reaction planner must return an array');
  }
  if (planned.length > MAX_REACTIONS_PER_COMMIT) {
    throw new Error(
      `reaction planner returned more than ${MAX_REACTIONS_PER_COMMIT} records`,
    );
  }
  const keys = new Set<string>();
  return planned.map((reaction, index) => {
    assertName(reaction.type, `reaction[${index}].type`, 128);
    if (
      reaction.key.length === 0 ||
      new TextEncoder().encode(reaction.key).byteLength > 256
    ) {
      throw new Error(
        `reaction[${index}].key must be non-empty and no longer than 256 bytes`,
      );
    }
    if (keys.has(reaction.key)) {
      throw new Error(
        `reaction planner returned duplicate key at index ${index}`,
      );
    }
    keys.add(reaction.key);
    if (
      !Number.isSafeInteger(reaction.version) ||
      reaction.version < 1 ||
      reaction.version > 2_147_483_647
    ) {
      throw new Error(`reaction[${index}].version must be a positive int32`);
    }
    const maxAttempts = reaction.maxAttempts ?? DEFAULT_REACTION_MAX_ATTEMPTS;
    if (
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 100
    ) {
      throw new Error(
        `reaction[${index}].maxAttempts must be from 1 through 100`,
      );
    }
    return {
      idempotencyKey: reactionIdempotencyKey(
        input.partition,
        input.clientId,
        input.clientCommitId,
        reaction.key,
      ),
      type: reaction.type,
      version: reaction.version,
      payload: boundedJson(
        reaction.payload,
        `reaction[${index}].payload`,
        MAX_REACTION_PAYLOAD_BYTES,
      ),
      maxAttempts,
    };
  });
}

class ReactionDeliveryError extends Error {
  readonly code: string;
  readonly details?: { readonly [key: string]: DurableJsonValue };

  constructor(
    name: string,
    code: string,
    details?: { readonly [key: string]: DurableJsonValue },
  ) {
    super(code);
    this.name = name;
    assertName(code, `${name}.code`, 128);
    this.code = code;
    if (details !== undefined) {
      this.details = boundedJson(
        details,
        `${name}.details`,
        MAX_REACTION_FAILURE_DETAILS_BYTES,
      ) as { readonly [key: string]: DurableJsonValue };
    }
  }
}

/** A handler failure that should be retried until its attempt limit. */
export class RetryableReactionError extends ReactionDeliveryError {
  constructor(
    code: string,
    details?: { readonly [key: string]: DurableJsonValue },
  ) {
    super('RetryableReactionError', code, details);
  }
}

/** A handler failure that should be dead-lettered immediately. */
export class PermanentReactionError extends ReactionDeliveryError {
  constructor(
    code: string,
    details?: { readonly [key: string]: DurableJsonValue },
  ) {
    super('PermanentReactionError', code, details);
  }
}

export interface ReactionRunnerOptions<
  Reactions extends ReactionTypeMap = ReactionTypeMap,
> {
  readonly storage: ServerStorage;
  readonly partition: string;
  readonly workerId: string;
  readonly handlers: ReactionHandlers<Reactions>;
  readonly events?: SyncularServerEvents;
  readonly clock?: () => number;
  readonly leaseDurationMs?: number;
  readonly batchSize?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export interface ReactionRunResult {
  readonly claimed: number;
  readonly completed: number;
  readonly retried: number;
  readonly deadLettered: number;
  /** Lease ownership changed before this worker could persist its outcome. */
  readonly lostLeases: number;
}

export interface PruneReactionsOptions {
  readonly storage: ServerStorage;
  readonly partition: string;
  readonly nowMs: number;
  readonly retention?: Partial<ReactionRetentionPolicy>;
  readonly events?: SyncularServerEvents;
}

export interface ReactionPruneResult {
  readonly completedBeforeMs: number;
  readonly deadLetterBeforeMs: number;
  readonly removedCompleted: number;
  readonly removedDeadLetter: number;
  /** True when the bounded pass filled its batch and another pass may help. */
  readonly mayHaveMore: boolean;
}

function requiredLifecycle(storage: ServerStorage): void {
  if (
    storage.claimReactions === undefined ||
    storage.completeReaction === undefined ||
    storage.extendReactionLease === undefined ||
    storage.failReaction === undefined
  ) {
    throw new Error('storage does not implement durable reaction delivery');
  }
}

/** Host-driven worker. Call `runOnce` from the host scheduler or queue wake. */
export class ReactionRunner<
  Reactions extends ReactionTypeMap = ReactionTypeMap,
> {
  readonly #options: ReactionRunnerOptions<Reactions>;
  readonly #types: string[];
  readonly #clock: () => number;
  readonly #leaseDurationMs: number;
  readonly #batchSize: number;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;

  constructor(options: ReactionRunnerOptions<Reactions>) {
    requiredLifecycle(options.storage);
    assertName(options.workerId, 'workerId', 128);
    this.#types = Object.keys(options.handlers).sort();
    if (this.#types.length === 0 || this.#types.length > 64) {
      throw new Error('reaction runner requires from 1 through 64 handlers');
    }
    for (const type of this.#types) assertName(type, 'handler type', 128);
    this.#leaseDurationMs =
      options.leaseDurationMs ?? DEFAULT_REACTION_LEASE_MS;
    this.#batchSize = options.batchSize ?? 10;
    this.#initialBackoffMs =
      options.initialBackoffMs ?? DEFAULT_REACTION_INITIAL_BACKOFF_MS;
    this.#maxBackoffMs =
      options.maxBackoffMs ?? DEFAULT_REACTION_MAX_BACKOFF_MS;
    for (const [name, value] of [
      ['leaseDurationMs', this.#leaseDurationMs],
      ['batchSize', this.#batchSize],
      ['initialBackoffMs', this.#initialBackoffMs],
      ['maxBackoffMs', this.#maxBackoffMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
      }
    }
    if (this.#batchSize > 100) throw new Error('batchSize cannot exceed 100');
    if (this.#initialBackoffMs > this.#maxBackoffMs) {
      throw new Error('initialBackoffMs cannot exceed maxBackoffMs');
    }
    this.#options = options;
    this.#clock = options.clock ?? Date.now;
  }

  async runOnce(): Promise<ReactionRunResult> {
    const claim = this.#options.storage.claimReactions;
    const complete = this.#options.storage.completeReaction;
    const extend = this.#options.storage.extendReactionLease;
    const fail = this.#options.storage.failReaction;
    if (
      claim === undefined ||
      complete === undefined ||
      extend === undefined ||
      fail === undefined
    ) {
      throw new Error('storage lost durable reaction delivery support');
    }
    const leaseOwner = `${this.#options.workerId}:${crypto.randomUUID()}`;
    const reactions = await claim.call(
      this.#options.storage,
      this.#options.partition,
      {
        leaseOwner,
        types: this.#types,
        nowMs: this.#clock(),
        leaseDurationMs: this.#leaseDurationMs,
        limit: this.#batchSize,
      },
    );
    let completed = 0;
    let retried = 0;
    let deadLettered = 0;
    let lostLeases = 0;
    for (const reaction of reactions) {
      const events = this.#options.events;
      const startedAtMs = this.#clock();
      const stillOwned = await extend.call(
        this.#options.storage,
        this.#options.partition,
        reaction.idempotencyKey,
        leaseOwner,
        Math.min(Number.MAX_SAFE_INTEGER, startedAtMs + this.#leaseDurationMs),
      );
      if (!stillOwned) {
        lostLeases += 1;
        continue;
      }
      if (events !== undefined) {
        emitEvent(events, {
          type: 'reaction.started',
          atMs: startedAtMs,
          partition: this.#options.partition,
          workerId: this.#options.workerId,
          idempotencyKey: reaction.idempotencyKey,
          reactionType: reaction.type,
          version: reaction.version,
          attempt: reaction.attempts,
        });
      }
      let handlerFailed = false;
      let handlerError: unknown;
      try {
        const handler = this.#options.handlers[reaction.type];
        if (handler === undefined) {
          throw new PermanentReactionError('reaction.handler_missing');
        }
        await handler({
          partition: this.#options.partition,
          idempotencyKey: reaction.idempotencyKey,
          type: reaction.type,
          version: reaction.version,
          payload: reaction.payload as Reactions[string],
          attempt: reaction.attempts,
          maxAttempts: reaction.maxAttempts,
          sourceClientId: reaction.sourceClientId,
          sourceClientCommitId: reaction.sourceClientCommitId,
          sourceCommitSeq: reaction.sourceCommitSeq,
          extendLease: async () => {
            const renewed = await extend.call(
              this.#options.storage,
              this.#options.partition,
              reaction.idempotencyKey,
              leaseOwner,
              Math.min(
                Number.MAX_SAFE_INTEGER,
                this.#clock() + this.#leaseDurationMs,
              ),
            );
            if (!renewed) throw new Error('reaction lease ownership lost');
          },
        });
      } catch (error) {
        handlerFailed = true;
        handlerError = error;
      }
      if (!handlerFailed) {
        const atMs = this.#clock();
        const acknowledged = await complete.call(
          this.#options.storage,
          this.#options.partition,
          reaction.idempotencyKey,
          leaseOwner,
          atMs,
        );
        if (!acknowledged) {
          lostLeases += 1;
          continue;
        }
        completed += 1;
        if (events !== undefined) {
          emitEvent(events, {
            type: 'reaction.completed',
            atMs,
            partition: this.#options.partition,
            workerId: this.#options.workerId,
            idempotencyKey: reaction.idempotencyKey,
            reactionType: reaction.type,
            version: reaction.version,
            attempt: reaction.attempts,
          });
        }
        continue;
      }
      const atMs = this.#clock();
      const permanent = handlerError instanceof PermanentReactionError;
      const failure: ReactionFailure = {
        code:
          handlerError instanceof ReactionDeliveryError
            ? handlerError.code
            : 'reaction.handler_failed',
        atMs,
        ...(handlerError instanceof ReactionDeliveryError &&
        handlerError.details !== undefined
          ? { details: handlerError.details }
          : {}),
      };
      const deadLetter = permanent || reaction.attempts >= reaction.maxAttempts;
      const retryAtMs = deadLetter
        ? undefined
        : Math.min(
            Number.MAX_SAFE_INTEGER,
            atMs +
              Math.min(
                this.#maxBackoffMs,
                this.#initialBackoffMs *
                  2 ** Math.min(30, reaction.attempts - 1),
              ),
          );
      const recorded = await fail.call(
        this.#options.storage,
        this.#options.partition,
        reaction.idempotencyKey,
        {
          leaseOwner,
          failure,
          ...(retryAtMs !== undefined ? { retryAtMs } : {}),
        },
      );
      if (!recorded) {
        lostLeases += 1;
        continue;
      }
      if (retryAtMs !== undefined) {
        retried += 1;
        if (events !== undefined) {
          emitEvent(events, {
            type: 'reaction.retried',
            atMs,
            partition: this.#options.partition,
            workerId: this.#options.workerId,
            idempotencyKey: reaction.idempotencyKey,
            reactionType: reaction.type,
            version: reaction.version,
            attempt: reaction.attempts,
            nextAttemptAtMs: retryAtMs,
            errorCode: failure.code,
          });
        }
      } else {
        deadLettered += 1;
        if (events !== undefined) {
          emitEvent(events, {
            type: 'reaction.dead_lettered',
            atMs,
            partition: this.#options.partition,
            workerId: this.#options.workerId,
            idempotencyKey: reaction.idempotencyKey,
            reactionType: reaction.type,
            version: reaction.version,
            attempt: reaction.attempts,
            errorCode: failure.code,
          });
        }
      }
    }
    return {
      claimed: reactions.length,
      completed,
      retried,
      deadLettered,
      lostLeases,
    };
  }
}

/** Explicit operator action for a dead-lettered reaction. */
export async function retryDeadLetterReaction(options: {
  readonly storage: ServerStorage;
  readonly partition: string;
  readonly idempotencyKey: string;
  readonly nowMs?: number;
}): Promise<boolean> {
  if (options.storage.retryReaction === undefined) {
    throw new Error('storage does not implement durable reaction retry');
  }
  return options.storage.retryReaction(
    options.partition,
    options.idempotencyKey,
    options.nowMs ?? Date.now(),
  );
}

/** Delete one bounded batch of aged completed and dead-lettered rows. */
export async function pruneReactions(
  options: PruneReactionsOptions,
): Promise<ReactionPruneResult> {
  const retention = {
    ...DEFAULT_REACTION_RETENTION,
    ...options.retention,
  };
  if (!Number.isSafeInteger(options.nowMs)) {
    throw new Error('nowMs must be a safe integer');
  }
  for (const [name, value] of [
    ['completedRetentionMs', retention.completedRetentionMs],
    ['deadLetterRetentionMs', retention.deadLetterRetentionMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
  if (
    !Number.isSafeInteger(retention.batchSize) ||
    retention.batchSize < 1 ||
    retention.batchSize > 10_000
  ) {
    throw new Error('batchSize must be from 1 through 10000');
  }
  const prune = options.storage.pruneReactions;
  if (prune === undefined) {
    throw new Error('storage does not implement durable reaction pruning');
  }
  const completedBeforeMs = Math.max(
    Number.MIN_SAFE_INTEGER,
    options.nowMs - retention.completedRetentionMs,
  );
  const deadLetterBeforeMs = Math.max(
    Number.MIN_SAFE_INTEGER,
    options.nowMs - retention.deadLetterRetentionMs,
  );
  const removed = await prune.call(options.storage, options.partition, {
    completedBeforeMs,
    deadLetterBeforeMs,
    limit: retention.batchSize,
  });
  const result: ReactionPruneResult = {
    completedBeforeMs,
    deadLetterBeforeMs,
    removedCompleted: removed.completed,
    removedDeadLetter: removed.deadLetter,
    mayHaveMore: removed.completed + removed.deadLetter === retention.batchSize,
  };
  if (options.events !== undefined) {
    emitEvent(options.events, {
      type: 'reaction.prune_completed',
      atMs: options.nowMs,
      partition: options.partition,
      limit: retention.batchSize,
      ...result,
    });
  }
  return result;
}

/** Helper used by the push path after commit sequence allocation. */
export function toNewReactions(
  prepared: readonly PreparedReaction[],
  source: {
    readonly clientId: string;
    readonly clientCommitId: string;
    readonly commitSeq: number;
    readonly createdAtMs: number;
  },
): NewReaction[] {
  return prepared.map((reaction) => ({
    ...reaction,
    sourceClientId: source.clientId,
    sourceClientCommitId: source.clientCommitId,
    sourceCommitSeq: source.commitSeq,
    createdAtMs: source.createdAtMs,
  }));
}
