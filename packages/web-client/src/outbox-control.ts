/**
 * Opt-in outbox control: `replacePendingCommit` (§7.2.3) and the
 * `{ through }` transport gate (§8.8). Pass `outboxControl:
 * defineOutboxControl()` at client creation, or
 * `startSyncWorker({ createOutboxControl })` in a worker; ordinary client and
 * worker graphs never load this module.
 */
import {
  decodeFenceResponse,
  definedObject,
  encodeFenceRequest,
  PROTOCOL_WIRE_VERSION,
  type ResponseMessage,
} from '@syncular/core';
import type { MutationInput, SyncClient } from './client';
import { BLOB_COMMIT_REFS } from './blob';
import type { ClientDatabase } from './database';
import { ClientSyncError, invalidRequest } from './errors';
import type { ChangeAccumulator } from './invalidation';
import {
  OUTBOX_TABLE,
  type OutboxCommit,
  type OutboxOperation,
} from './outbox';
import {
  commitOutcome,
  isReplacedOutcome,
  OUTCOMES_TABLE,
  pendingDecisions,
} from './outcomes';
import { LOCAL_SCHEMA_VERSION_KEY } from './schema';
import { getMeta } from './state';

/** @internal Called by the client with the internals the controls use. */
export interface OutboxControl {
  replace: OutboxReplace;
  /**
   * §8.8: validate `clientCommitId`, then `set` the boundary seq the push
   * encode reads; the control falls back to `pull` through the client.
   */
  through(
    client: SyncClient,
    clientCommitId: string,
    set: (seq: number) => void,
  ): void;
  /** The staged blobs the commits up to `seq` reference. */
  blobs(db: ClientDatabase, seq: number): ReadonlySet<unknown>;
}

type OutboxReplace = (
  client: SyncClient,
  /** The client's clock. */
  now: () => number,
  /** One round trip on the client's transport, outside any sync round. */
  send: (request: Uint8Array) => Promise<Uint8Array>,
  /** The push-result path of a sync response, for a fence's stored result. */
  receive: (message: ResponseMessage, commit: OutboxCommit) => Promise<unknown>,
  /**
   * Validate `mutations` as `mutate` does, roll `replacing` back and record
   * the replacement in its outbox position, with `within` in its transaction.
   */
  append: (
    clientCommitId: string,
    mutations: readonly MutationInput[],
    within: (batch: ChangeAccumulator) => void,
    replacing: OutboxCommit,
  ) => void,
  clientCommitId: string,
  operations: readonly MutationInput[],
  replacementClientCommitId: string,
) => Promise<string>;

const notPending = (clientCommitId: string) =>
  new ClientSyncError(
    'sync.outcome_not_found',
    'the commit is not pending',
    false,
    {
      clientCommitId,
    },
  );

/** Enable `replacePendingCommit` (§7.2.3) and the `{ through }` transport
 * gate (§8.8) on the client created with it. */
export function defineOutboxControl(): OutboxControl {
  return { replace, through, blobs };
}

/**
 * §8.8: the state covers the commits pending at or before the boundary when it
 * is set. After each committed change it falls back to `pull` once the
 * boundary left the outbox, or a covered commit left with an outcome other
 * than an acknowledgement; after a failed round, once a covered commit is
 * pending with its send attempt recorded.
 */
function through(
  client: SyncClient,
  clientCommitId: string,
  set: (seq: number) => void,
): void {
  const db = client.database;
  const bound = db.query(
    `SELECT seq FROM ${OUTBOX_TABLE} WHERE client_commit_id=?`,
    [clientCommitId],
  )[0]?.seq;
  if (typeof bound !== 'number') throw notPending(clientCommitId);
  const gate = client.transportGate();
  if (typeof gate === 'object' && gate.through === clientCommitId) return;
  const prefix = () =>
    new Map(
      db
        .query(
          `SELECT client_commit_id AS id,attempted FROM ${OUTBOX_TABLE} WHERE seq<=?`,
          [bound],
        )
        .map((row) => [row.id, row.attempted]),
    );
  const covered = [...prefix().keys()].map(String);
  set(bound);
  let armed = false;
  const stops: (() => void)[] = [];
  const check = (failed: boolean) => {
    const current = client.transportGate();
    if (typeof current !== 'object' || current.through !== clientCommitId)
      return stops.forEach((stop) => stop());
    const pending = prefix();
    if (
      !pending.has(clientCommitId) ||
      covered.some((id) =>
        pending.has(id)
          ? failed && pending.get(id) === 1
          : !['applied', 'cached'].includes(
              commitOutcome(db, id)?.status ?? '',
            ),
      )
    )
      client.setTransportGate('pull');
  };
  stops.push(
    client.onChange(() => check(false)),
    // The listener receives the latest snapshot at once; only later rounds count.
    client.onProgress(
      (progress) => armed && progress.state === 'failed' && check(true),
    ),
  );
  armed = true;
}

function blobs(db: ClientDatabase, seq: number): ReadonlySet<unknown> {
  return new Set(
    db
      .query(
        `SELECT blob_id FROM ${BLOB_COMMIT_REFS} WHERE commit_id IN(SELECT client_commit_id FROM ${OUTBOX_TABLE} WHERE seq<=?)`,
        [seq],
      )
      .map((row) => row.blob_id),
  );
}

const replace: OutboxReplace = async (
  client,
  now,
  send,
  receive,
  append,
  clientCommitId,
  mutations,
  replacementClientCommitId,
) => {
  const db = client.database;
  if (
    !replacementClientCommitId ||
    replacementClientCommitId === clientCommitId
  )
    throw invalidRequest('the replacement needs a new client commit id');
  const prior = commitOutcome(db, clientCommitId);
  // A retry after a lost reply returns the replacement it already made.
  if (
    prior &&
    isReplacedOutcome(prior) &&
    prior.replacementClientCommitId === replacementClientCommitId
  )
    return replacementClientCommitId;
  const pending = (): OutboxCommit & { readonly attempted: boolean } => {
    const row = db.query(
      `SELECT * FROM ${OUTBOX_TABLE} WHERE client_commit_id=?`,
      [clientCommitId],
    )[0];
    if (!row) throw notPending(clientCommitId);
    return {
      seq: row.seq as number,
      clientCommitId,
      createdAtMs: row.created_at_ms as number,
      operations: JSON.parse(row.operations as string),
      attempted: row.attempted === 1,
    };
  };
  const { attempted } = pending();
  // §7.2.2: a held replacement changes only through its decision.
  if (
    pendingDecisions(db).some(
      (decision) => decision.replacementClientCommitId === clientCommitId,
    )
  )
    throw new ClientSyncError(
      'client.replacement_pending',
      'the outcome has a pending replacement',
      false,
      { clientCommitId },
    );
  // A refused payload fails before the fence, which the server keeps: the
  // replacement transaction runs once and rolls back.
  const dryRun = new Error('dry run');
  try {
    append(
      replacementClientCommitId,
      mutations,
      () => {
        throw dryRun;
      },
      pending(),
    );
  } catch (caught) {
    if (caught !== dryRun) throw caught;
  }
  if (attempted) {
    if (client.transportGate() === 'closed')
      throw new ClientSyncError('sync.offline', 'transport gate is closed');
    const response = decodeFenceResponse(
      await send(
        encodeFenceRequest(
          definedObject({
            type: 'REQ_HEADER',
            clientId: client.clientId,
            schemaVersion: Number(getMeta(db, LOCAL_SCHEMA_VERSION_KEY)),
            logEpoch: getMeta(db, 'logEpoch'),
            outboxId: getMeta(db, 'outboxId'),
          }),
          [clientCommitId],
        ),
      ),
      [clientCommitId],
    );
    const { error: refusal } = response;
    if (refusal) {
      let details: Record<string, unknown> | undefined;
      try {
        details = refusal.details && JSON.parse(refusal.details);
      } catch {
        // A malformed details member adds no evidence.
      }
      throw new ClientSyncError(
        refusal.code,
        refusal.message,
        refusal.retryable,
        details,
        refusal.recommendedAction,
      );
    }
    const answer = response.answers[0];
    if (answer?.type !== 'COMMIT_FENCED') {
      // The response header and the server's stored receipt of the original
      // run through the push-result path, as the push response it lost.
      await receive(
        {
          wireVersion: PROTOCOL_WIRE_VERSION,
          msgKind: 'response',
          frames: [
            response.header,
            ...(answer
              ? [answer.result, ...(answer.details ? [answer.details] : [])]
              : []),
          ],
        },
        pending(),
      );
      // A schema floor (§1.6) serves no fence; the floor is now recorded.
      if (!answer)
        throw new ClientSyncError(
          'sync.schema_mismatch',
          'the server served no fence answer',
          false,
          { clientCommitId },
        );
      const error = answer.result.results.find(
        (result) => result.status === 'error',
      );
      // A retryable serving failure (§6.3) settles nothing; the commit stays.
      if (
        error?.status === 'error' &&
        error.code === 'sync.idempotency_cache_miss' &&
        error.retryable
      )
        throw new ClientSyncError(error.code, error.message, true, {
          clientCommitId,
        });
      throw new ClientSyncError(
        'client.commit_settled',
        'the commit settled before the fence',
        false,
        {
          clientCommitId,
          status: answer.result.status === 'rejected' ? 'rejected' : 'applied',
        },
      );
    }
  }
  // The commit as it stands now: a local purge can drop it during the fence.
  const original = pending();
  append(
    replacementClientCommitId,
    mutations,
    (batch) => {
      // §7.2.3: a row the original touched keeps the original's base version
      // and insert intent; another row keeps what `mutate` assigned.
      const operations: OutboxOperation[] = JSON.parse(
        db.query(`SELECT operations FROM ${OUTBOX_TABLE} WHERE seq=?`, [
          original.seq,
        ])[0]!.operations as string,
      );
      db.exec(`UPDATE ${OUTBOX_TABLE} SET operations=? WHERE seq=?`, [
        JSON.stringify(
          operations.map((operation, index) => {
            const touched = original.operations.find(
              (candidate) =>
                candidate.table === operation.table &&
                candidate.rowId === operation.rowId,
            );
            return touched
              ? {
                  ...operation,
                  baseVersion: touched.baseVersion,
                  insert:
                    mutations[index]!.op === 'upsert' && touched.insert
                      ? true
                      : undefined,
                }
              : operation;
          }),
        ),
        original.seq,
      ]);
      // §7.2.1: a decided rejection with one `client.commit_replaced`
      // result per operation, stored as a purge stores its drops.
      const at = now();
      db.exec(
        `INSERT INTO ${OUTCOMES_TABLE}(client_commit_id,status,recorded_at_ms,results,resolution,resolved_at_ms,replacement_client_commit_id)VALUES(?,'rejected',?,?,'superseded',?,?)`,
        [
          clientCommitId,
          at,
          JSON.stringify(
            original.operations.map((_operation, opIndex) => ({
              status: 'error',
              rejection: {
                clientCommitId,
                opIndex,
                code: 'client.commit_replaced',
                message: 'the commit was replaced',
                retryable: false,
              },
            })),
          ),
          at,
          replacementClientCommitId,
        ],
      );
      batch.outcomes();
    },
    original,
  );
  return replacementClientCommitId;
};
