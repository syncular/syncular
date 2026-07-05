/**
 * `handleSyncRequest(bytes, ctx) → bytes` (SPEC.md §1, REVISE B2).
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
  decodeMessage,
  type PullHeaderFrame,
  type PushCommitFrame,
  type PushResultFrame,
  type ReqHeaderFrame,
  type RequestMessage,
  type ResponseFrame,
  type ScopeMap,
  type SubscriptionFrame,
} from '@syncular/core';
import type { SyncRequestContext } from './context';
import { clockOf, limitsOf, RESOLVER_OUTAGE } from './context';
import { SyncError, syncError } from './errors';
import {
  emitEvent,
  type PullSubscriptionSummary,
  type SyncularServerEvents,
} from './events';
import {
  END_FRAME_BYTES,
  encodeResponseFrame,
  RESPONSE_ENVELOPE_HEADER,
} from './frame-bytes';
import type { LeaseRecord } from './lease-store';
import {
  ACCEPT_EXTERNAL_ROWS,
  ACCEPT_INLINE_ROWS,
  clampPullLimits,
  type PullSectionTrace,
  type SubscriptionPlan,
  subscriptionSection,
} from './pull';
import { processPushCommit } from './push';
import type { CompiledSchema } from './schema';
import { compileSchema } from './schema';
import { computeEffective, type ResolvedScopes } from './scopes';
import type { ClientSubscription } from './storage';

interface RequestPlan {
  readonly header: ReqHeaderFrame;
  readonly pushes: readonly PushCommitFrame[];
  readonly pull: PullHeaderFrame | undefined;
  readonly subscriptions: readonly SubscriptionPlan[];
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
        `resolveScopes returned undeclared scope variable ${JSON.stringify(key)} (§3.2)`,
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
    // §3.2 rule 5 / §3.4 step 4: fail loud, never leak — subscriptions
    // revoke and writes reject with sync.forbidden. A throw is NOT an
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
): Promise<RequestPlan> {
  const header = request.frames[0];
  if (header === undefined || header.type !== 'REQ_HEADER') {
    throw syncError('sync.invalid_request', 'missing REQ_HEADER');
  }
  const pushes: PushCommitFrame[] = [];
  let pull: PullHeaderFrame | undefined;
  const subFrames: SubscriptionFrame[] = [];
  for (const frame of request.frames) {
    if (frame.type === 'PUSH_COMMIT') pushes.push(frame);
    else if (frame.type === 'PULL_HEADER') pull = frame;
    else if (frame.type === 'SUBSCRIPTION') subFrames.push(frame);
  }

  if (header.schemaVersion !== schema.version) {
    // §2.4: no degraded encoding — answer with the schema floor (§1.6).
    // No lease is issued on a floor round (§7.3.3).
    return {
      header,
      pushes,
      pull,
      subscriptions: [],
      resolved: { ok: false },
      schemaFloor: true,
      leaseToEmit: undefined,
    };
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
      `request carries ${totalOperations} operations (cap ${limits.maxOperationsPerRequest}, §6.1)`,
    );
  }

  if (pull !== undefined) {
    // §4.2: rows support is mandatory (bits 0 and 1) — reject its absence
    // as request validation (the MAY of §1.7).
    if ((pull.accept & (ACCEPT_INLINE_ROWS | ACCEPT_EXTERNAL_ROWS)) === 0) {
      throw syncError(
        'sync.invalid_request',
        'accept must include rows-segment support (bits 0 and 1, §4.2)',
      );
    }
  }

  // Request validation for subscriptions (§1.7): duplicate ids, unknown
  // tables, undeclared scope keys, requested '*'.
  const seenIds = new Set<string>();
  const validated: Array<{ frame: SubscriptionFrame; table: string }> = [];
  for (const frame of subFrames) {
    if (seenIds.has(frame.id)) {
      throw syncError(
        'sync.invalid_subscription',
        `duplicate subscription id ${JSON.stringify(frame.id)} (§4.1)`,
      );
    }
    seenIds.add(frame.id);
    const table = schema.tables.get(frame.table);
    if (table === undefined) {
      throw syncError(
        'sync.unknown_table',
        `subscription names unknown table ${JSON.stringify(frame.table)} (§4.3)`,
      );
    }
    for (const [key, values] of Object.entries(frame.scopes)) {
      if (!table.declaredVariables.has(key)) {
        throw syncError(
          'sync.invalid_subscription',
          `requested scope key ${JSON.stringify(key)} is not declared by table ${JSON.stringify(frame.table)} (§3.2)`,
        );
      }
      if (values.includes('*')) {
        throw syncError(
          'sync.invalid_subscription',
          `requested scope value '*' is reserved for allowed scopes (§3.2)`,
        );
      }
    }
    validated.push({ frame, table: frame.table });
  }

  const { resolved, leaseToEmit } = await resolveOnce(
    ctx,
    header.clientId,
    schema,
  );

  const subscriptions: SubscriptionPlan[] = validated.map(({ frame }) => {
    const table = schema.tables.get(frame.table);
    if (table === undefined) throw new Error('unreachable: validated table');
    const outcome = computeEffective(frame.scopes, resolved);
    if (outcome.status === 'active') {
      return { frame, table, status: 'active', effective: outcome.effective };
    }
    return { frame, table, status: 'revoked', effective: {} };
  });

  return {
    header,
    pushes,
    pull,
    subscriptions,
    resolved,
    schemaFloor: false,
    leaseToEmit,
  };
}

/** Mutable outcome box shared with the instrumented stream wrapper. */
interface RequestReport {
  outcome: 'ok' | 'schema_floor' | 'error';
  errorCode?: string;
}

function emitPushEvent(
  events: SyncularServerEvents,
  ctx: SyncRequestContext,
  clientId: string,
  push: PushCommitFrame,
  frame: PushResultFrame,
): void {
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
      replay: frame.status === 'cached',
    });
    return;
  }
  // Rejected (§6.3): exactly one terminating operation record.
  const record = frame.results[0];
  if (record?.status === 'conflict') {
    emitEvent(events, {
      type: 'push.conflicted',
      ...base,
      opIndex: record.opIndex,
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
  });
}

async function* streamResponse(
  plan: RequestPlan,
  ctx: SyncRequestContext,
  schema: CompiledSchema,
  report?: RequestReport,
): AsyncGenerator<Uint8Array> {
  const events = ctx.events;
  yield RESPONSE_ENVELOPE_HEADER;
  if (plan.schemaFloor) {
    if (report !== undefined) report.outcome = 'schema_floor';
    yield encodeResponseFrame({
      type: 'RESP_HEADER',
      requiredSchemaVersion: schema.version,
      latestSchemaVersion: schema.version,
    });
    yield END_FRAME_BYTES;
    return;
  }
  yield encodeResponseFrame({
    type: 'RESP_HEADER',
    latestSchemaVersion: schema.version,
  });
  // §7.3.2: the LEASE frame rides immediately after RESP_HEADER.
  if (plan.leaseToEmit !== undefined) {
    yield encodeResponseFrame({
      type: 'LEASE',
      leaseId: plan.leaseToEmit.leaseId,
      expiresAtMs: plan.leaseToEmit.expiresAtMs,
    });
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
  try {
    // Push half (§6): one PUSH_RESULT per PUSH_COMMIT, in request order.
    for (const push of plan.pushes) {
      const frame = await processPushCommit(
        ctx,
        schema,
        plan.resolved,
        plan.header.clientId,
        push,
      );
      if (events !== undefined) {
        emitPushEvent(events, ctx, plan.header.clientId, push, frame);
      }
      yield encodeResponseFrame(frame);
    }

    // Pull half (§4): subscriptions echoed in request order.
    const cursors: number[] = [];
    if (plan.pull !== undefined) {
      const summaries: PullSubscriptionSummary[] | undefined =
        events !== undefined ? [] : undefined;
      const limits = clampPullLimits(plan.pull);
      const maxSeq = await ctx.storage.getMaxCommitSeq(ctx.partition);
      const horizonSeq = await ctx.storage.getHorizonSeq(ctx.partition);
      for (const subscription of plan.subscriptions) {
        const trace: PullSectionTrace | undefined =
          summaries !== undefined ? { segments: [] } : undefined;
        const section = subscriptionSection(
          ctx,
          schema,
          limits,
          subscription,
          maxSeq,
          horizonSeq,
          trace,
        );
        let status: 'active' | 'revoked' | 'reset' = 'active';
        let bootstrap = false;
        let commits = 0;
        let changes = 0;
        let step = await section.next();
        while (!step.done) {
          const frame = step.value as ResponseFrame;
          if (summaries !== undefined) {
            if (frame.type === 'SUB_START') {
              status = frame.status;
              bootstrap = frame.bootstrap;
            } else if (frame.type === 'COMMIT') {
              commits += 1;
              changes += frame.changes.length;
            }
          }
          yield encodeResponseFrame(frame);
          step = await section.next();
        }
        if (step.value.active) cursors.push(step.value.nextCursor);
        if (summaries !== undefined && trace !== undefined) {
          summaries.push({
            id: subscription.frame.id,
            table: subscription.frame.table,
            status,
            mode:
              status !== 'active'
                ? 'none'
                : bootstrap
                  ? 'bootstrap'
                  : 'incremental',
            fromCursor: subscription.frame.cursor,
            nextCursor: step.value.nextCursor,
            commits,
            changes,
            segments: trace.segments,
          });
        }
      }
      if (events !== undefined && summaries !== undefined) {
        emitEvent(events, {
          type: 'pull.served',
          atMs: clockOf(ctx)(),
          partition: ctx.partition,
          actorId: ctx.actorId,
          clientId: plan.header.clientId,
          subscriptions: summaries,
        });
      }
    }

    // §4.5/§8.1: persist the cursor watermark and the request's
    // subscription list per (partition, clientId).
    const previous = await ctx.storage.getClientRecord(
      ctx.partition,
      plan.header.clientId,
    );
    const subscriptions: ClientSubscription[] =
      plan.pull !== undefined
        ? plan.subscriptions.map((s) => ({
            id: s.frame.id,
            table: s.frame.table,
            scopes: s.frame.scopes,
          }))
        : [...(previous?.subscriptions ?? [])];
    const cursor =
      cursors.length > 0 ? Math.min(...cursors) : (previous?.cursor ?? -1);
    await ctx.storage.putClientRecord(ctx.partition, {
      clientId: plan.header.clientId,
      actorId: ctx.actorId,
      cursor,
      updatedAtMs: clockOf(ctx)(),
      subscriptions,
    });
  } catch (error) {
    if (error instanceof SyncError) {
      if (report !== undefined) {
        report.outcome = 'error';
        report.errorCode = error.code;
      }
      // §1.6: in-band ERROR, then END, nothing else.
      yield encodeResponseFrame({
        type: 'ERROR',
        code: error.code,
        message: error.message,
        category: error.category,
        retryable: error.retryable,
        recommendedAction: error.recommendedAction,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
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
  const events = ctx.events;
  if (events === undefined) return createStreamCore(bytes, ctx, undefined);
  // Instrumented path: measure with the ctx clock, count bytes at the
  // seam, emit exactly one `request.handled` per request.
  const clock = clockOf(ctx);
  const startedAtMs = clock();
  try {
    return await createStreamCore(bytes, ctx, events, startedAtMs);
  } catch (error) {
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
      errorCode: error instanceof SyncError ? error.code : 'internal',
      pushCommits: 0,
      pulled: false,
      subscriptions: 0,
    });
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
    const message = decodeMessage(bytes);
    if (message.msgKind !== 'request') {
      throw syncError('sync.invalid_request', 'expected a request message');
    }
    request = message;
  } catch (error) {
    if (error instanceof DecodeError) {
      throw syncError(error.code, error.message);
    }
    throw error;
  }
  const schema = compileSchema(ctx.schema);
  // Relational row tables (DESIGN-relational-server-storage.md): create/
  // migrate on first contact; memoized per storage instance thereafter.
  await ctx.storage.ensureSchema(schema);
  const plan = await planRequest(request, ctx, schema);
  if (events === undefined) return streamResponse(plan, ctx, schema);
  const report: RequestReport = { outcome: 'ok' };
  return instrumentedStream(
    streamResponse(plan, ctx, schema, report),
    ctx,
    events,
    plan,
    report,
    bytes.length,
    startedAtMs,
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
      ...(report.errorCode !== undefined
        ? { errorCode: report.errorCode }
        : {}),
      pushCommits: plan.pushes.length,
      pulled: plan.pull !== undefined,
      subscriptions: plan.subscriptions.length,
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
