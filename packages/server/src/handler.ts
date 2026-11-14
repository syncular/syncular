/**
 * `handleSyncRequest(bytes, ctx) → bytes` (SPEC.md §1).
 *
 * Internally streaming-friendly (§1.4): `createSyncResponseStream` returns
 * an async iterable of encoded chunks — one per frame — after performing
 * request validation (§1.7) eagerly, so validation failures throw as
 * `SyncError`s before any bytes are produced (HTTP-level errors, §1.1).
 * `handleSyncRequest` is the byte-concatenating convenience wrapper.
 * A `SyncError` thrown after streaming began becomes an in-band `ERROR`
 * frame (§1.6).
 */
import {
  DecodeError,
  decodeRequest,
  echoDigest,
  type ProgressFrame,
  type PullHeaderFrame,
  type PushCommitFrame,
  type PushResultDetailsFrame,
  type PushResultFrame,
  type ReqHeaderFrame,
  type RequestMessage,
  type ResponseFrame,
  type RoundFailureFrame,
  type ScopeMap,
  type UnitFrame,
  type UnitScopes,
  registrationDigest,
  unitId,
} from '@syncular/core';
import type { SyncRequestContext } from './context';
import {
  clockOf,
  limitsOf,
  REMOTE_COMMAND_CLIENT_ID_PREFIX,
  RESOLVER_OUTAGE,
  touchAuthenticatedPartition,
} from './context';
import { reportError, SyncError, syncError } from './errors';
import {
  emitEvent,
  type PullUnitSummary,
  type SyncularServerEvents,
} from './events';
import {
  END_FRAME_BYTES,
  encodeResponseFrame,
  responseEnvelopeHeader,
} from './frame-bytes';
import type { LeaseRecord } from './lease-store';
import {
  ACCEPT_EXTERNAL_ROWS,
  ACCEPT_INLINE_ROWS,
  bootstrapSegments,
  clampPullLimits,
  commitFrame,
  coveredTables,
  type PullLimits,
  type PullSectionTrace,
  planBootstrap,
  planUnit,
  type UnitPlan,
} from './pull';
import { type ProcessedPushCommit, processPushCommitWithTrace } from './push';
import { serveNotReadyError } from './readiness';
import type { CompiledSchema, CompiledTable } from './schema';
import { compileSchema } from './schema';
import { schemaWindowOf, projectRowPayload } from './schema-window';
import type { ResolvedScopes } from './scopes';
import { StorageQueryError } from './storage-errors';
import {
  type CatchingUpUnit,
  type ClientRecord,
  type ClientRegistration,
  type LiveWindow,
  type PartitionRegistryEntry,
  serveGateRefusal,
  serveGateTokenChanged,
} from './storage';

interface PlannedUnit {
  readonly plan: UnitPlan;
  /** Absent for a live unit. */
  readonly progress: ProgressFrame | undefined;
}

interface PullPlan {
  readonly header: PullHeaderFrame;
  readonly limits: PullLimits;
  /** The traveling list (§4.1); absent when the request referred to it. */
  readonly registration: ClientRegistration | undefined;
  /** The effective list; absent when the answer is `unregistered`. */
  readonly units: readonly PlannedUnit[] | undefined;
}

interface RequestPlan {
  readonly wireVersion: number;
  readonly logEpoch: string;
  readonly epochReset: boolean;
  readonly header: ReqHeaderFrame;
  /** §1.5: the code this request reports for its last unseen round failure. */
  readonly roundFailure: RoundFailureFrame | undefined;
  readonly pushes: readonly PushCommitFrame[];
  readonly pull: PullPlan | undefined;
  /** The client record read for the actor binding (§1.5, §4.5). */
  readonly record: ClientRecord | undefined;
  readonly resolved: ResolvedScopes;
  readonly schemaFloor: boolean;
  /**
   * §7.3.3: the lease to issue/refresh and emit as a `LEASE` frame this
   * round. Present only when leases are configured and the request
   * resolved live scopes (never on an outage-served or floor request).
   */
  readonly leaseToEmit: LeaseRecord | undefined;
}

/** Outcome of resolution: the allowed scopes, plus the lease (if any) to
 * issue this round (§7.3.3). Lease-error surfaces throw as SyncErrors. */
interface ResolveOutcome {
  readonly resolved: ResolvedScopes;
  readonly leaseToEmit: LeaseRecord | undefined;
}

function validateResolvedKeys(allowed: ScopeMap, schema: CompiledSchema): void {
  for (const key of Object.keys(allowed)) {
    if (!schema.declaredVariables.has(key)) {
      // §3.2 step 3: a resolver returning undeclared keys is a server
      // bug — fail the request, do not guess.
      throw syncError(
        'sync.invalid_subscription',
        'resolveScopes returned an undeclared scope variable (§3.2)',
        JSON.stringify({
          reason: 'undeclared_resolved_variable',
          variable: key,
        }),
      );
    }
  }
}

/**
 * Authorize the request against the actor's stored lease (§7.3.3), used
 * when the resolver signalled an outage. Throws the request-level lease
 * codes; returns the leased allowed map on success. Never issues/refreshes
 * (an outage cannot re-resolve).
 */
async function authorizeFromLease(
  ctx: SyncRequestContext,
  clientId: string,
  schema: CompiledSchema,
): Promise<ResolvedScopes> {
  const leases = ctx.leases;
  if (leases === undefined) {
    // §7.3.3: outage signalled but the feature is off — no lease to fall
    // to. The client needs a live authorization.
    throw syncError(
      'sync.auth_lease_required',
      'live authorization is unavailable and auth leases are not configured (§7.3.3)',
    );
  }
  const lease = await leases.store.get(ctx.partition, clientId);
  if (lease === undefined || lease.actorId !== ctx.actorId) {
    throw syncError(
      'sync.auth_lease_required',
      'no valid auth lease for this client during an authorization outage (§7.3.3)',
    );
  }
  if (lease.revoked) {
    throw syncError(
      'sync.auth_lease_revoked',
      `auth lease ${lease.leaseId} was revoked (§7.3.4)`,
    );
  }
  if (clockOf(ctx)() >= lease.expiresAtMs) {
    throw syncError(
      'sync.auth_lease_required',
      `auth lease ${lease.leaseId} is expired (§7.3.3)`,
    );
  }
  validateResolvedKeys(lease.allowedScopes, schema);
  return { ok: true, allowed: lease.allowedScopes };
}

async function resolveOnce(
  ctx: SyncRequestContext,
  clientId: string,
  schema: CompiledSchema,
): Promise<ResolveOutcome> {
  let allowed: ScopeMap | typeof RESOLVER_OUTAGE;
  try {
    allowed = await ctx.resolveScopes({
      partition: ctx.partition,
      actorId: ctx.actorId,
      clientId,
    });
  } catch (error) {
    if (error instanceof SyncError) throw error;
    // §3.2 rule 5 / §3.4 step 4: fail loud, never leak — units revoke and
    // writes reject with sync.forbidden. A throw is NOT an
    // outage (§7.3.3): it never reaches the lease.
    const events = ctx.events;
    if (events !== undefined) {
      emitEvent(events, {
        type: 'scopes.resolve_failed',
        atMs: clockOf(ctx)(),
        partition: ctx.partition,
        actorId: ctx.actorId,
        phase: 'request',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { resolved: { ok: false }, leaseToEmit: undefined };
  }

  if (allowed === RESOLVER_OUTAGE) {
    // §7.3.3: the host opted this request into lease authorization. No
    // lease is issued/refreshed on an outage-served round.
    const resolved = await authorizeFromLease(ctx, clientId, schema);
    return { resolved, leaseToEmit: undefined };
  }

  validateResolvedKeys(allowed, schema);
  // §7.3.3: a successful authorized round issues/refreshes the lease
  // (sliding window) and emits a LEASE frame — only when configured.
  let leaseToEmit: LeaseRecord | undefined;
  if (ctx.leases !== undefined) {
    leaseToEmit = await ctx.leases.store.issue(
      ctx.partition,
      clientId,
      ctx.actorId,
      allowed,
      clockOf(ctx)(),
      ctx.leases.ttlMs,
    );
  }
  return { resolved: { ok: true, allowed }, leaseToEmit };
}

async function planRequest(
  request: RequestMessage,
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  registry: PartitionRegistryEntry,
): Promise<RequestPlan> {
  const header = request.frames[0];
  if (header === undefined || header.type !== 'REQ_HEADER') {
    throw syncError('sync.invalid_request', 'missing REQ_HEADER');
  }
  const pushes: PushCommitFrame[] = [];
  let roundFailure: RoundFailureFrame | undefined;
  let pullHeader: PullHeaderFrame | undefined;
  const unitFrames: UnitFrame[] = [];
  const progressFrames: ProgressFrame[] = [];
  for (const frame of request.frames) {
    if (frame.type === 'ROUND_FAILURE') roundFailure = frame;
    else if (frame.type === 'PUSH_COMMIT') pushes.push(frame);
    else if (frame.type === 'PULL_HEADER') pullHeader = frame;
    else if (frame.type === 'UNIT') unitFrames.push(frame);
    else if (frame.type === 'PROGRESS') progressFrames.push(frame);
  }

  if (header.logEpoch === undefined && pushes.length > 0) {
    throw syncError(
      'sync.invalid_request',
      'epoch acquisition requests must not carry push commits (§2.1)',
    );
  }
  const epochReset = header.logEpoch !== registry.logEpoch;
  const unserved = {
    wireVersion: request.wireVersion,
    logEpoch: registry.logEpoch,
    epochReset,
    header,
    roundFailure,
    pushes: [],
    pull: undefined,
    record: undefined,
    resolved: { ok: false },
    leaseToEmit: undefined,
  } as const;

  if (header.schemaVersion !== schema.version) {
    // §2.4: no degraded encoding — answer with the schema floor (§1.6).
    // No lease is issued on a floor round (§7.3.3).
    return { ...unserved, schemaFloor: true };
  }
  if (epochReset) return { ...unserved, schemaFloor: false };

  if (header.clientId.startsWith(REMOTE_COMMAND_CLIENT_ID_PREFIX)) {
    throw syncError(
      'sync.invalid_client_id',
      'clientId uses a reserved server-command namespace (§1.5)',
    );
  }

  // §1.5: a clientId already bound to a different actor is rejected.
  const record = await ctx.storage.getClientRecord(
    ctx.partition,
    header.clientId,
  );
  if (record !== undefined && record.actorId !== ctx.actorId) {
    throw syncError(
      'sync.invalid_client_id',
      'clientId is bound to a different actor in this partition (§1.5)',
    );
  }

  // §6.1: operation cap per request, whole batch unapplied.
  const totalOperations = pushes.reduce((n, p) => n + p.operations.length, 0);
  const limits = limitsOf(ctx);
  if (totalOperations > limits.maxOperationsPerRequest) {
    throw syncError(
      'sync.too_many_operations',
      'request carries more operations than the server accepts (§6.1)',
      JSON.stringify({
        max: limits.maxOperationsPerRequest,
        actual: totalOperations,
      }),
    );
  }
  // §6.1 sequence rules: with an outbox every clientSeq is ≥ 1 and strictly
  // increasing in frame order; without one every clientSeq is 0.
  if (
    pushes.some((push, i) =>
      header.outboxId === undefined
        ? push.clientSeq !== 0
        : push.clientSeq < 1 ||
          (i > 0 && push.clientSeq <= pushes[i - 1]!.clientSeq),
    )
  ) {
    throw syncError(
      'sync.invalid_request',
      'push commits break the clientSeq rules (§6.1)',
      JSON.stringify({
        outbox: header.outboxId !== undefined,
        clientSeqs: pushes.map((push) => push.clientSeq),
      }),
    );
  }
  // §1.7: the UNIT cap, checked before any unit is planned.
  if (unitFrames.length > limits.maxSubscriptionsPerRequest) {
    throw syncError(
      'sync.limit_exceeded',
      'request carries more units than the server accepts (§1.7)',
      JSON.stringify({
        limit: 'maxSubscriptionsPerRequest',
        max: limits.maxSubscriptionsPerRequest,
        actual: unitFrames.length,
      }),
    );
  }

  // §4.1: the effective list is the traveling list, or the stored list the
  // digest names; a digest naming neither answers `unregistered`.
  let list:
    | { scopes: UnitScopes; tables: CompiledTable[]; id: string }[]
    | undefined;
  let registration: ClientRegistration | undefined;
  if (pullHeader !== undefined) {
    // §4.2: rows support is mandatory (bits 0 and 1).
    if (
      (pullHeader.accept & (ACCEPT_INLINE_ROWS | ACCEPT_EXTERNAL_ROWS)) ===
      0
    ) {
      throw syncError(
        'sync.invalid_request',
        'accept must include rows-segment support (bits 0 and 1, §4.2)',
      );
    }
    const traveling =
      unitFrames.length > 0 ||
      sameBytes(pullHeader.registrationDigest, registrationDigest([]));
    if (traveling) {
      const units = unitFrames.map((frame) => frame.scopes);
      const digest = registrationDigest(units);
      if (!sameBytes(digest, pullHeader.registrationDigest)) {
        throw syncError(
          'sync.invalid_subscription',
          'the registration digest differs from the traveling list (§4.1)',
          JSON.stringify({ reason: 'registration_digest' }),
        );
      }
      registration = { units, digest };
    }
    const units =
      registration?.units ??
      (record?.registration !== undefined &&
      sameBytes(record.registration.digest, pullHeader.registrationDigest)
        ? record.registration.units
        : undefined);
    if (units !== undefined) {
      const ids = new Set<string>();
      list = units.map((scopes) => {
        const tables = coveredTables(schema, scopes);
        const id = unitId(scopes);
        if (ids.has(id)) {
          throw syncError(
            'sync.invalid_subscription',
            'the registration list names a scope map twice (§4.1)',
            JSON.stringify({ reason: 'duplicate_unit', scopes }),
          );
        }
        ids.add(id);
        return { scopes, tables, id };
      });
      const progressed = new Set<string>();
      for (const frame of progressFrames) {
        if (!ids.has(frame.id) || progressed.has(frame.id)) {
          throw syncError(
            'sync.invalid_subscription',
            'a PROGRESS frame names no registered unit or repeats one (§4.1)',
            JSON.stringify({
              reason: ids.has(frame.id) ? 'duplicate_progress' : 'unknown_unit',
              id: frame.id,
            }),
          );
        }
        progressed.add(frame.id);
      }
    }
  }

  const { resolved, leaseToEmit } = await resolveOnce(
    ctx,
    header.clientId,
    compileSchema(ctx.schema),
  );
  const progress = new Map(progressFrames.map((frame) => [frame.id, frame]));
  return {
    wireVersion: request.wireVersion,
    logEpoch: registry.logEpoch,
    epochReset: false,
    header,
    roundFailure,
    pushes,
    pull:
      pullHeader === undefined
        ? undefined
        : {
            header: pullHeader,
            limits: clampPullLimits(pullHeader),
            registration,
            units: list?.map(({ scopes, tables, id }) => {
              const plan = planUnit(scopes, tables, resolved, id);
              return { plan, progress: progress.get(plan.id) };
            }),
          },
    record,
    resolved,
    schemaFloor: false,
    leaseToEmit,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Mutable outcome box shared with the instrumented stream wrapper. */
interface RequestReport {
  outcome: 'ok' | 'schema_floor' | 'epoch_acquired' | 'reset' | 'error';
  errorCode?: string;
  /**
   * The completed round's client-record write (§4.5, §8.1). Set only by a
   * round that streamed without an in-band error; runs after the serve-gate
   * verification.
   */
  persist?: () => Promise<void>;
}

function pushResultDetailsFrame(
  frame: PushResultFrame,
): PushResultDetailsFrame | undefined {
  const entries = frame.results.flatMap((result) =>
    result.status === 'error' && result.details !== undefined
      ? [{ opIndex: result.opIndex, details: result.details }]
      : [],
  );
  return entries.length === 0
    ? undefined
    : {
        type: 'PUSH_RESULT_DETAILS',
        clientCommitId: frame.clientCommitId,
        entries,
      };
}

function emitPushEvent(
  events: SyncularServerEvents,
  ctx: SyncRequestContext,
  clientId: string,
  push: PushCommitFrame,
  processed: ProcessedPushCommit,
): void {
  const { frame } = processed;
  const base = {
    atMs: clockOf(ctx)(),
    partition: ctx.partition,
    actorId: ctx.actorId,
    clientId,
    clientCommitId: push.clientCommitId,
    operations: push.operations.length,
  };
  if (frame.status === 'applied' || frame.status === 'cached') {
    emitEvent(events, {
      type: 'push.applied',
      ...base,
      ...(frame.commitSeq !== undefined ? { commitSeq: frame.commitSeq } : {}),
      replay: processed.replayed,
    });
    return;
  }
  // Rejected (§6.3): exactly one terminating operation record.
  const record = frame.results[0];
  const op = record !== undefined ? push.operations[record.opIndex] : undefined;
  const target = op !== undefined ? { table: op.table, rowId: op.rowId } : {};
  if (record?.status === 'conflict') {
    emitEvent(events, {
      type: 'push.conflicted',
      ...base,
      opIndex: record.opIndex,
      ...target,
      replay: processed.replayed,
      ...(processed.recordedAtMs !== undefined
        ? { recordedAtMs: processed.recordedAtMs }
        : {}),
      ...(processed.cacheIdentity !== undefined
        ? { cacheIdentity: processed.cacheIdentity }
        : {}),
    });
    return;
  }
  emitEvent(events, {
    type: 'push.rejected',
    ...base,
    code:
      record !== undefined && record.status === 'error'
        ? record.code
        : 'sync.invalid_request',
    opIndex: record?.opIndex ?? 0,
    ...target,
    replay: processed.replayed,
    ...(processed.recordedAtMs !== undefined
      ? { recordedAtMs: processed.recordedAtMs }
      : {}),
    ...(processed.cacheIdentity !== undefined
      ? { cacheIdentity: processed.cacheIdentity }
      : {}),
  });
}

async function* streamResponse(
  plan: RequestPlan,
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  report: RequestReport,
): AsyncGenerator<Uint8Array> {
  const events = ctx.events;
  yield responseEnvelopeHeader(plan.wireVersion);
  if (plan.schemaFloor) {
    report.outcome = 'schema_floor';
    yield encodeResponseFrame(
      {
        type: 'RESP_HEADER',
        requiredSchemaVersion: schemaWindowOf(ctx.schema, ctx.schemaWindow).at(
          -1,
        )!.version,
        latestSchemaVersion: ctx.schema.version,
        logEpoch: plan.logEpoch,
        resetRequired: plan.epochReset,
      },
      plan.wireVersion,
    );
    yield END_FRAME_BYTES;
    return;
  }
  yield encodeResponseFrame(
    {
      type: 'RESP_HEADER',
      latestSchemaVersion: ctx.schema.version,
      logEpoch: plan.logEpoch,
      resetRequired: plan.epochReset,
    },
    plan.wireVersion,
  );
  if (plan.epochReset) {
    report.outcome =
      plan.header.logEpoch === undefined ? 'epoch_acquired' : 'reset';
    yield END_FRAME_BYTES;
    return;
  }
  // §7.3.2: the LEASE frame rides immediately after RESP_HEADER.
  if (plan.leaseToEmit !== undefined) {
    yield encodeResponseFrame(
      {
        type: 'LEASE',
        leaseId: plan.leaseToEmit.leaseId,
        expiresAtMs: plan.leaseToEmit.expiresAtMs,
      },
      plan.wireVersion,
    );
    if (events !== undefined) {
      emitEvent(events, {
        type: 'lease.issued',
        atMs: clockOf(ctx)(),
        partition: ctx.partition,
        actorId: ctx.actorId,
        clientId: plan.header.clientId,
        leaseId: plan.leaseToEmit.leaseId,
        expiresAtMs: plan.leaseToEmit.expiresAtMs,
      });
    }
  }
  const { clientId, outboxId } = plan.header;
  try {
    // Push half (§6): one PUSH_RESULT per PUSH_COMMIT, in request order.
    const currentSchema = compileSchema(ctx.schema);
    let acceptedThrough = 0;
    // §6.3.2: the request's first commit settles the outbox and reads `W`.
    let watermark = 0;
    for (const [index, push] of plan.pushes.entries()) {
      const processed = await processPushCommitWithTrace(
        ctx,
        currentSchema,
        plan.resolved,
        clientId,
        push,
        schema,
        outboxId === undefined
          ? undefined
          : {
              outboxId,
              clientSeq: push.clientSeq,
              watermark,
              ...(index === 0
                ? {
                    settlement: {
                      outboxId,
                      commits: plan.pushes.map((commit) => ({
                        clientCommitId: commit.clientCommitId,
                        clientSeq: commit.clientSeq,
                      })),
                    },
                  }
                : {}),
            },
      );
      watermark = processed.watermark ?? watermark;
      acceptedThrough = Math.max(
        acceptedThrough,
        processed.frame.commitSeq ?? 0,
      );
      const frame = {
        ...processed.frame,
        results: processed.frame.results.map((result) => {
          if (result.status !== 'conflict' || schema === currentSchema) {
            return result;
          }
          const operation = push.operations[result.opIndex];
          // §2.3: a replay returns the persisted result without rebuilding
          // operations, so a reused clientCommitId with changed operations
          // leaves no table to project the stored conflict row through.
          if (operation === undefined) {
            throw syncError(
              'sync.invalid_request',
              'replayed clientCommitId carries changed operations',
              JSON.stringify({
                clientCommitId: push.clientCommitId,
                opIndex: result.opIndex,
              }),
            );
          }
          const target = schema.tables.get(operation.table)!;
          const bitmapBytes = Math.ceil(target.columns.length / 8);
          return {
            ...result,
            serverRow: projectRowPayload(
              currentSchema.tables.get(operation.table)!,
              target,
              result.serverRow,
            ),
            conflictColumns: result.conflictColumns
              .slice(0, bitmapBytes)
              .map((byte, i) =>
                i === bitmapBytes - 1 && target.columns.length % 8 !== 0
                  ? byte & ((1 << (target.columns.length % 8)) - 1)
                  : byte,
              ),
          };
        }),
      };
      if (events !== undefined) {
        emitPushEvent(events, ctx, clientId, push, processed);
      }
      yield encodeResponseFrame(frame, plan.wireVersion);
      const details = pushResultDetailsFrame(frame);
      if (details !== undefined) {
        yield encodeResponseFrame(details, plan.wireVersion);
      }
    }

    const previous = plan.record;
    const base = {
      clientId,
      actorId: ctx.actorId,
      wireVersion: plan.wireVersion,
      schemaVersion: schema.version,
    };
    const pull = plan.pull;
    if (pull === undefined) {
      // A push-only round keeps the registration, its states and the cursor;
      // its record binds the actor (§1.5) and anchors the watermark rows
      // (§6.3.2).
      report.persist = () =>
        ctx.storage.putClientRecord(
          ctx.partition,
          {
            ...base,
            cursor: previous?.cursor ?? -1,
            updatedAtMs: clockOf(ctx)(),
            catchingUp: previous?.catchingUp ?? [],
          },
          plan.roundFailure !== undefined
            ? { keepRoundOutcome: true }
            : undefined,
        );
    } else {
      // Pull half (§4): unit sections in registration order, then one live
      // section.
      const maxSeq = await ctx.storage.getMaxCommitSeq(ctx.partition);
      if (maxSeq < acceptedThrough)
        throw syncError(
          'sync.storage_stale_read',
          'storage returned a commit sequence older than the accepted push; disable query caching for sync storage',
          JSON.stringify({ acceptedThrough, storageMaxCommitSeq: maxSeq }),
        );
      const { limits } = pull;
      const units = pull.units;
      if (units === undefined) {
        // §4.1: no unit section, no COMMIT; PROGRESS frames are ignored.
        yield encodeResponseFrame(
          { type: 'LIVE_START', status: 'unregistered', reasonCode: '' },
          plan.wireVersion,
        );
        yield encodeResponseFrame(
          { type: 'LIVE_END', throughSeq: -1, echoDigest: new Uint8Array() },
          plan.wireVersion,
        );
        if (events !== undefined) {
          emitEvent(events, {
            type: 'pull.served',
            atMs: clockOf(ctx)(),
            partition: ctx.partition,
            actorId: ctx.actorId,
            clientId,
            acceptedThrough,
            storageMaxCommitSeq: maxSeq,
            registrationTraveled: false,
            units: [],
            live: {
              status: 'unregistered',
              fromCursor: pull.header.cursor,
              throughSeq: -1,
              commits: 0,
              changes: 0,
            },
          });
        }
        // §4.5: an `unregistered` answer writes only the round outcome; the
        // stored record keeps its cursor, timestamp and states.
        if (previous !== undefined) {
          report.persist = () =>
            ctx.storage.putClientRecord(
              ctx.partition,
              {
                clientId,
                actorId: previous.actorId,
                wireVersion: previous.wireVersion,
                cursor: previous.cursor,
                updatedAtMs: previous.updatedAtMs,
                lastRoundAtMs: clockOf(ctx)(),
                ...(previous.schemaVersion !== undefined
                  ? { schemaVersion: previous.schemaVersion }
                  : {}),
                catchingUp: previous.catchingUp,
              },
              plan.roundFailure !== undefined
                ? { keepRoundOutcome: true }
                : undefined,
            );
        }
      } else {
        const horizonSeq = await ctx.storage.getHorizonSeq(ctx.partition);
        const R = pull.header.cursor;
        const echo = echoDigest(
          units.map(({ plan: unit }) => ({
            id: unit.id,
            status: unit.status,
            fenced: unit.fenced,
          })),
        );
        // §4.4 rule 1: every unit gets a section when the list traveled or
        // the client holds another echo.
        const echoSections =
          pull.registration !== undefined ||
          !sameBytes(pull.header.echoDigest, echo);
        const liveUnits = units.some(
          (unit) =>
            unit.progress === undefined && unit.plan.status === 'active',
        );
        // §4.6 replica reset: a live unit with R outside [horizon, max].
        let liveReset = liveUnits && (R < horizonSeq || R > maxSeq);
        // Per unit: its section kind and its scan-set bound (§4.5).
        type UnitState =
          | { kind: 'revoked' }
          | { kind: 'reset' }
          | { kind: 'live' }
          | { kind: 'post'; cursor: number }
          | {
              kind: 'bootstrap';
              pin: number;
              frames: ResponseFrame[];
              token: string | undefined;
            };
        const states: UnitState[] = units.map(({ plan: unit, progress }) => {
          if (unit.status === 'revoked') return { kind: 'revoked' };
          if (progress === undefined) return { kind: 'live' };
          // §4.7: a token, cursor -1 or a cursor from the future bootstraps.
          if (
            progress.bootstrapState === undefined &&
            progress.cursor >= 0 &&
            progress.cursor <= maxSeq
          ) {
            return progress.cursor < horizonSeq
              ? { kind: 'reset' }
              : { kind: 'post', cursor: progress.cursor };
          }
          // Replaced by the section the bootstrap below produces.
          return { kind: 'bootstrap', pin: -1, frames: [], token: '' };
        });
        const traces = units.map((): PullSectionTrace | undefined =>
          events !== undefined ? { segments: [] } : undefined,
        );
        // Bootstrap sections run before the live read: a bootstrap that
        // completes in this response enters the scan set at its pin (§4.5).
        // A window of units runs its pre-frame reads together, so a
        // batching storage answers them in one statement per table. A unit
        // reads ahead the first page of at most `maxSnapshotPages` tables,
        // and a window holds at most 100,000 first-page rows, so read memory
        // follows the configured limits, never the unit count.
        const bootstrapping = states.flatMap((state, index) =>
          state.kind === 'bootstrap' ? [index] : [],
        );
        const firstPages = Math.max(
          1,
          Math.floor(100_000 / (limits.limitSnapshotRows + 1)),
        );
        for (let next = 0; next < bootstrapping.length;) {
          const window: number[] = [];
          let pages = 0;
          while (next < bootstrapping.length) {
            const index = bootstrapping[next]!;
            const reads = Math.min(
              limits.maxSnapshotPages,
              units[index]!.plan.pairs.size,
            );
            if (window.length > 0 && pages + reads > firstPages) break;
            window.push(index);
            pages += reads;
            next += 1;
          }
          const batch = window.map((index) => ({
            index,
            plan: planBootstrap(
              ctx,
              schema,
              limits,
              units[index]!.plan,
              units[index]!.progress?.bootstrapState,
              maxSeq,
              horizonSeq,
              plan.logEpoch,
            ),
          }));
          for (const { index, plan: bootstrap } of batch) {
            const frames: ResponseFrame[] = [];
            const segments = bootstrapSegments(
              ctx,
              schema,
              limits,
              bootstrap,
              traces[index],
              plan.logEpoch,
            );
            let step = await segments.next();
            while (!step.done) {
              frames.push(step.value);
              step = await segments.next();
            }
            states[index] = {
              kind: 'bootstrap',
              pin: bootstrap.pin,
              frames,
              token: step.value,
            };
          }
        }
        const bound = (state: UnitState): number | undefined =>
          state.kind === 'live'
            ? R
            : state.kind === 'post'
              ? state.cursor
              : state.kind === 'bootstrap' && state.token === undefined
                ? state.pin
                : undefined;
        // §4.5 order of work: read and buffer the live section, then recheck
        // the horizon. A bound below it leaves the scan set (a live unit's
        // resets the live section), and the section is read again.
        let live: LiveWindow | undefined;
        for (;;) {
          const scanned = units.flatMap(({ plan: unit }, index) => {
            const afterSeq = bound(states[index]!);
            return afterSeq === undefined
              ? []
              : [{ index, scopes: unit.scopes, afterSeq, tables: unit.pairs }];
          });
          if (liveReset || scanned.length === 0) break;
          live = await ctx.storage.readLiveWindow(ctx.partition, {
            units: scanned,
            throughSeq: maxSeq,
            limitChanges: limits.limitCommits,
            limitBytes: limitsOf(ctx).maxLiveSectionBytes,
          });
          // §4.6: a commit past the byte budget on its own cannot be served
          // from the log; the units it reaches reset and bootstrap.
          for (const at of live.oversized?.units ?? []) {
            const index = scanned[at]!.index;
            if (states[index]!.kind === 'live') liveReset = true;
            else states[index] = { kind: 'reset' };
          }
          if (live.oversized !== undefined) {
            live = undefined;
            continue;
          }
          const recheck = await ctx.storage.getHorizonSeq(ctx.partition);
          let expired = false;
          for (const [index, state] of states.entries()) {
            const afterSeq = bound(state);
            if (afterSeq === undefined || afterSeq >= recheck) continue;
            expired = true;
            if (state.kind === 'live') liveReset = true;
            else states[index] = { kind: 'reset' };
          }
          if (!expired) break;
          live = undefined;
        }
        const T = liveReset ? -1 : (live?.throughSeq ?? maxSeq);

        const summaries: PullUnitSummary[] = [];
        for (const [index, { plan: unit, progress }] of units.entries()) {
          const state = states[index]!;
          const requestCursor = progress?.cursor ?? R;
          const section =
            state.kind === 'revoked' ||
            state.kind === 'reset' ||
            state.kind === 'bootstrap' ||
            echoSections;
          if (section) {
            yield encodeResponseFrame(
              state.kind === 'revoked'
                ? {
                    type: 'SUB_START',
                    id: unit.id,
                    status: 'revoked',
                    reasonCode: 'sync.scope_revoked',
                    bootstrap: false,
                    fenced: [],
                  }
                : state.kind === 'reset'
                  ? {
                      type: 'SUB_START',
                      id: unit.id,
                      status: 'reset',
                      reasonCode: 'sync.cursor_expired',
                      bootstrap: false,
                      fenced: [],
                    }
                  : {
                      type: 'SUB_START',
                      id: unit.id,
                      status: 'active',
                      reasonCode: '',
                      bootstrap: state.kind === 'bootstrap',
                      fenced: [...unit.fenced],
                    },
              plan.wireVersion,
            );
            if (state.kind === 'bootstrap') {
              for (const frame of state.frames) {
                yield encodeResponseFrame(frame, plan.wireVersion);
              }
            }
            yield encodeResponseFrame(
              state.kind === 'bootstrap'
                ? {
                    type: 'SUB_END',
                    nextCursor: state.pin,
                    ...(state.token !== undefined
                      ? { bootstrapState: state.token }
                      : {}),
                  }
                : { type: 'SUB_END', nextCursor: requestCursor },
              plan.wireVersion,
            );
          }
          summaries.push({
            id: unit.id,
            scopes: unit.scopes,
            status:
              state.kind === 'revoked' || state.kind === 'reset'
                ? state.kind
                : 'active',
            mode:
              state.kind === 'revoked' || state.kind === 'reset'
                ? 'none'
                : state.kind === 'post'
                  ? 'catching-up'
                  : state.kind,
            section,
            fenced: unit.fenced,
            fromCursor: requestCursor,
            segments: traces[index]?.segments ?? [],
          });
        }
        yield encodeResponseFrame(
          liveReset
            ? {
                type: 'LIVE_START',
                status: 'reset',
                reasonCode: 'sync.cursor_expired',
              }
            : { type: 'LIVE_START', status: 'active', reasonCode: '' },
          plan.wireVersion,
        );
        let changes = 0;
        for (const commit of live?.commits ?? []) {
          changes += commit.changes.length;
          yield encodeResponseFrame(
            commitFrame(commit, currentSchema, schema),
            plan.wireVersion,
          );
        }
        yield encodeResponseFrame(
          { type: 'LIVE_END', throughSeq: T, echoDigest: echo },
          plan.wireVersion,
        );
        if (events !== undefined) {
          const commits = live?.commits ?? [];
          emitEvent(events, {
            type: 'pull.served',
            atMs: clockOf(ctx)(),
            partition: ctx.partition,
            actorId: ctx.actorId,
            clientId,
            acceptedThrough,
            storageMaxCommitSeq: maxSeq,
            registrationTraveled: pull.registration !== undefined,
            units: summaries,
            live: {
              status: liveReset ? 'reset' : 'active',
              fromCursor: R,
              throughSeq: T,
              commits: commits.length,
              changes,
              ...(commits.length > 0
                ? {
                    firstCommitSeq: commits[0]!.commitSeq,
                    lastCommitSeq: commits.at(-1)!.commitSeq,
                  }
                : {}),
            },
          });
        }

        // §4.5 join rule J and the record the round writes: the live units,
        // the catching-up ids with their cursors, and the record cursor.
        const joined = Math.max(R, T);
        let anyLive = false;
        const catchingUp: CatchingUpUnit[] = [];
        for (const [index, { plan: unit }] of units.entries()) {
          const state = states[index]!;
          const catching = (cursor: number): void => {
            catchingUp.push({ id: unit.id, cursor });
          };
          if (state.kind === 'live') {
            if (liveReset) catching(-1);
            else anyLive = true;
          } else if (state.kind === 'revoked' || state.kind === 'reset') {
            catching(-1);
          } else if (state.kind === 'bootstrap' && state.token !== undefined) {
            catching(state.pin);
          } else {
            // Post-bootstrap, or a bootstrap completed here at its pin.
            const cursor = state.kind === 'post' ? state.cursor : state.pin;
            if (liveReset) catching(cursor);
            else if (Math.max(cursor, T) >= joined) anyLive = true;
            else catching(Math.max(cursor, T));
          }
        }
        const held = [
          ...(anyLive ? [joined] : []),
          ...catchingUp.map((unit) => unit.cursor).filter((c) => c >= 0),
        ];
        const liveIds = (
          listed: readonly UnitScopes[],
          catching: readonly CatchingUpUnit[],
        ): string =>
          JSON.stringify(
            listed
              .map((scopes) => unitId(scopes))
              .filter((id) => !catching.some((unit) => unit.id === id)),
          );
        const next: ClientRecord = {
          ...base,
          cursor: held.length === 0 ? -1 : Math.min(...held),
          updatedAtMs: clockOf(ctx)(),
          ...(pull.registration !== undefined
            ? { registration: pull.registration }
            : {}),
          catchingUp,
        };
        report.persist = async () => {
          await ctx.storage.putClientRecord(
            ctx.partition,
            next,
            // §4.5: a round that carried a `ROUND_FAILURE` report completes
            // without clearing the reported code and streak.
            plan.roundFailure !== undefined
              ? { keepRoundOutcome: true }
              : undefined,
          );
          // §8.1: a traveled list or a changed live set re-registers the
          // client's sockets on this hub.
          if (
            ctx.realtime?.notifySubscriptions !== undefined &&
            (pull.registration !== undefined ||
              liveIds(
                previous?.registration?.units ?? [],
                previous?.catchingUp ?? [],
              ) !==
                liveIds(
                  units.map(({ plan: unit }) => unit.scopes),
                  catchingUp,
                ))
          ) {
            await ctx.realtime.notifySubscriptions(ctx.partition, clientId);
          }
        };
      }
    }
  } catch (error) {
    if (error instanceof SyncError) {
      report.outcome = 'error';
      report.errorCode = error.code;
      await recordRoundFailure(ctx, clientId, error);
      // §1.6: in-band ERROR, then END, nothing else.
      yield encodeResponseFrame(
        {
          type: 'ERROR',
          code: error.code,
          message: error.message,
          category: error.category,
          retryable: error.retryable,
          recommendedAction: error.recommendedAction,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
        plan.wireVersion,
      );
      yield END_FRAME_BYTES;
      return;
    }
    throw error;
  }
  yield END_FRAME_BYTES;
}

/**
 * Decode and validate the request, then return the streaming response.
 * Request-validation failures (§1.7) throw `SyncError` here, before any
 * bytes are produced; adapters map them to HTTP JSON errors (§1.1).
 */
export async function createSyncResponseStream(
  bytes: Uint8Array,
  ctx: SyncRequestContext,
): Promise<AsyncIterable<Uint8Array>> {
  const sink = ctx.events;
  if (sink === undefined) {
    try {
      return await createStreamCore(bytes, ctx, undefined);
    } catch (error) {
      await recordRoundFailure(ctx, requestClientId(bytes), error);
      throw error;
    }
  }
  // Instrumented path: measure with the ctx clock, count bytes at the
  // seam, emit exactly one `request.handled` per request. Every event of
  // this request carries one `requestId`.
  const requestId = crypto.randomUUID();
  const events: SyncularServerEvents = {
    emit: (event) => sink.emit({ ...event, requestId }),
  };
  const requestCtx = { ...ctx, events };
  const clock = clockOf(ctx);
  const startedAtMs = clock();
  try {
    return await createStreamCore(bytes, requestCtx, events, startedAtMs);
  } catch (error) {
    const clientId = requestClientId(bytes);
    emitEvent(events, {
      type: 'request.handled',
      kind: 'sync',
      atMs: clock(),
      partition: ctx.partition,
      actorId: ctx.actorId,
      durationMs: clock() - startedAtMs,
      bytesIn: bytes.length,
      bytesOut: 0,
      outcome: 'rejected',
      ...(clientId !== undefined ? { clientId } : {}),
      errorCode: error instanceof SyncError ? error.code : 'internal',
      pushCommits: 0,
      pulled: false,
      units: 0,
    });
    await recordRoundFailure(ctx, clientId, error);
    throw error;
  }
}

/** The `REQ_HEADER` clientId of a request that failed before planning. */
function requestClientId(bytes: Uint8Array): string | undefined {
  try {
    const header = decodeRequest(bytes).frames[0];
    return header?.type === 'REQ_HEADER' ? header.clientId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record a failed round on the client's stored record so an operator can see
 * a stuck client and why. A storage failure here is reported through
 * `onError` and never replaces the round's own outcome.
 */
async function recordRoundFailure(
  ctx: SyncRequestContext,
  clientId: string | undefined,
  error: unknown,
): Promise<void> {
  await recordRoundFailureCode(
    ctx,
    clientId,
    error instanceof SyncError ? error.code : 'sync.internal_error',
  );
}

/** As `recordRoundFailure`, for a code that is not a thrown catalog error
 * (a `ROUND_FAILURE` report, §1.5). */
async function recordRoundFailureCode(
  ctx: SyncRequestContext,
  clientId: string | undefined,
  code: string,
): Promise<void> {
  if (clientId === undefined) return;
  try {
    await ctx.storage.recordClientRoundFailure(
      ctx.partition,
      clientId,
      ctx.actorId,
      code,
      clockOf(ctx)(),
    );
  } catch (failure) {
    reportError(failure, ctx.onError, 'sync');
  }
}

/** Record a failure thrown while the response streams (after planning). */
async function* recordedStream(
  stream: AsyncIterable<Uint8Array>,
  ctx: SyncRequestContext,
  clientId: string,
): AsyncGenerator<Uint8Array> {
  try {
    yield* stream;
  } catch (error) {
    await recordRoundFailure(ctx, clientId, error);
    throw error;
  }
}

async function createStreamCore(
  bytes: Uint8Array,
  ctx: SyncRequestContext,
  events: SyncularServerEvents | undefined,
  startedAtMs = 0,
): Promise<AsyncIterable<Uint8Array>> {
  let request: RequestMessage;
  try {
    request = decodeRequest(bytes);
  } catch (error) {
    if (error instanceof DecodeError) {
      throw syncError(error.code, error.message);
    }
    throw error;
  }
  const schema = compileSchema(ctx.schema);
  // Relational row tables: create/
  // migrate on first contact; memoized per storage instance thereafter.
  try {
    await ctx.storage.ensureSchema(schema, ctx.checkpoints);
  } catch (error) {
    if (
      error instanceof StorageQueryError &&
      error.code === 'sync.storage.checkpoint_incomplete'
    ) {
      const refusal = serveGateRefusal(
        await ctx.storage.readServeGate(ctx.partition, schema.version),
        schema.version,
        ctx.checkpoints,
      );
      throw refusal !== undefined ? serveNotReadyError(refusal) : error;
    }
    throw error;
  }
  // RFC 0007 serve gate: re-read stored state on every request so an
  // already-serving process notices a migration or a newly declared
  // checkpoint. Read after `touchAuthenticatedPartition` establishes the
  // partition's log epoch, so the entry token is the epoch this request
  // serves under. Nothing has escaped at this point; the push transaction
  // re-evaluates the gate under the partition lock.
  const registry = await touchAuthenticatedPartition(ctx);
  const gate = await ctx.storage.readServeGate(ctx.partition, schema.version);
  const refusal = serveGateRefusal(gate, schema.version, ctx.checkpoints);
  if (refusal !== undefined) throw serveNotReadyError(refusal);
  const window = schemaWindowOf(ctx.schema, ctx.schemaWindow);
  const header = request.frames[0];
  const selected = window.find(
    (candidate) =>
      header?.type === 'REQ_HEADER' &&
      candidate.version === header.schemaVersion,
  );
  const served = selected ?? schema;
  const plan = await planRequest(request, ctx, served, registry);
  // §1.5/§4.5: record the reported round failure on the existing record
  // before the round runs (it never creates one, never touches another
  // actor's record). The completion of this round leaves it in place.
  if (plan.roundFailure !== undefined) {
    await recordRoundFailureCode(
      ctx,
      plan.header.clientId,
      plan.roundFailure.code,
    );
  }
  const report: RequestReport = { outcome: 'ok' };
  // RFC 0007 read-verify-refuse for the streamed read path: the generator
  // builds the whole response (its data reads) before yielding the first
  // frame, then compares the gate token across those reads. Nothing escapes
  // before the verification, and the buffered size is bounded by the request's
  // pull limits and the server's inline segment cap. Every request verifies,
  // including a mixed push+pull: a write that already applied when the token
  // changed is durable and replayable under the same commit id / idempotency
  // key, so refusing the request is safe (proved in the serve-gate lane).
  const verified = async function* (): AsyncGenerator<Uint8Array> {
    const buffered: Uint8Array[] = [];
    for await (const chunk of streamResponse(plan, ctx, served, report)) {
      buffered.push(chunk);
    }
    const after = await ctx.storage.readServeGate(
      ctx.partition,
      schema.version,
    );
    const changed = serveGateTokenChanged(gate, after);
    const afterRefusal = serveGateRefusal(
      after,
      schema.version,
      ctx.checkpoints,
    );
    if (afterRefusal !== undefined) throw serveNotReadyError(afterRefusal);
    if (changed !== undefined) throw serveNotReadyError(changed);
    await report.persist?.();
    for (const chunk of buffered) yield chunk;
  };
  if (events === undefined) {
    return recordedStream(verified(), ctx, plan.header.clientId);
  }
  return recordedStream(
    instrumentedStream(
      verified(),
      ctx,
      events,
      plan,
      report,
      bytes.length,
      startedAtMs,
    ),
    ctx,
    plan.header.clientId,
  );
}

/** Counts response bytes and emits `request.handled` when the stream
 * finishes — including a thrown host failure mid-stream (fail loud). */
async function* instrumentedStream(
  stream: AsyncGenerator<Uint8Array>,
  ctx: SyncRequestContext,
  events: SyncularServerEvents,
  plan: RequestPlan,
  report: RequestReport,
  bytesIn: number,
  startedAtMs: number,
): AsyncGenerator<Uint8Array> {
  const clock = clockOf(ctx);
  let bytesOut = 0;
  const emitHandled = (): void => {
    emitEvent(events, {
      type: 'request.handled',
      kind: 'sync',
      atMs: clock(),
      partition: ctx.partition,
      actorId: ctx.actorId,
      durationMs: clock() - startedAtMs,
      bytesIn,
      bytesOut,
      outcome: report.outcome,
      clientId: plan.header.clientId,
      ...(report.errorCode !== undefined
        ? { errorCode: report.errorCode }
        : {}),
      pushCommits: plan.pushes.length,
      pulled: plan.pull !== undefined,
      units: plan.pull?.units?.length ?? 0,
    });
  };
  try {
    for await (const chunk of stream) {
      bytesOut += chunk.length;
      yield chunk;
    }
  } catch (error) {
    report.outcome = 'error';
    report.errorCode = error instanceof SyncError ? error.code : 'internal';
    emitHandled();
    throw error;
  }
  emitHandled();
}

/** Byte-concatenating wrapper over the streaming core (§1.4). */
export async function handleSyncRequest(
  bytes: Uint8Array,
  ctx: SyncRequestContext,
): Promise<Uint8Array> {
  const stream = await createSyncResponseStream(bytes, ctx);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
