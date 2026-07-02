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
  type ReqHeaderFrame,
  type RequestMessage,
  type ResponseFrame,
  type SubscriptionFrame,
} from '@syncular-v2/core';
import type { SyncRequestContext } from './context';
import { clockOf, limitsOf } from './context';
import { SyncError, syncError } from './errors';
import {
  END_FRAME_BYTES,
  encodeResponseFrame,
  RESPONSE_ENVELOPE_HEADER,
} from './frame-bytes';
import {
  ACCEPT_EXTERNAL_ROWS,
  ACCEPT_INLINE_ROWS,
  clampPullLimits,
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
}

async function resolveOnce(
  ctx: SyncRequestContext,
  schema: CompiledSchema,
): Promise<ResolvedScopes> {
  try {
    const allowed = await ctx.resolveScopes({
      partition: ctx.partition,
      actorId: ctx.actorId,
    });
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
    return { ok: true, allowed };
  } catch (error) {
    if (error instanceof SyncError) throw error;
    // §3.2 rule 5 / §3.4 step 4: fail loud, never leak — subscriptions
    // revoke and writes reject with sync.forbidden.
    return { ok: false };
  }
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
    return {
      header,
      pushes,
      pull,
      subscriptions: [],
      resolved: { ok: false },
      schemaFloor: true,
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

  const resolved = await resolveOnce(ctx, schema);

  const subscriptions: SubscriptionPlan[] = validated.map(({ frame }) => {
    const table = schema.tables.get(frame.table);
    if (table === undefined) throw new Error('unreachable: validated table');
    const outcome = computeEffective(frame.scopes, resolved);
    if (outcome.status === 'active') {
      return { frame, table, status: 'active', effective: outcome.effective };
    }
    return { frame, table, status: 'revoked', effective: {} };
  });

  return { header, pushes, pull, subscriptions, resolved, schemaFloor: false };
}

async function* streamResponse(
  plan: RequestPlan,
  ctx: SyncRequestContext,
  schema: CompiledSchema,
): AsyncGenerator<Uint8Array> {
  yield RESPONSE_ENVELOPE_HEADER;
  if (plan.schemaFloor) {
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
      yield encodeResponseFrame(frame);
    }

    // Pull half (§4): subscriptions echoed in request order.
    const cursors: number[] = [];
    if (plan.pull !== undefined) {
      const limits = clampPullLimits(plan.pull);
      const maxSeq = await ctx.storage.getMaxCommitSeq(ctx.partition);
      const horizonSeq = await ctx.storage.getHorizonSeq(ctx.partition);
      for (const subscription of plan.subscriptions) {
        const section = subscriptionSection(
          ctx,
          schema,
          limits,
          subscription,
          maxSeq,
          horizonSeq,
        );
        let step = await section.next();
        while (!step.done) {
          yield encodeResponseFrame(step.value as ResponseFrame);
          step = await section.next();
        }
        if (step.value.active) cursors.push(step.value.nextCursor);
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
  const plan = await planRequest(request, ctx, schema);
  return streamResponse(plan, ctx, schema);
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
