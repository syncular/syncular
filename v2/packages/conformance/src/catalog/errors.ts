/**
 * Error catalog conformance (SPEC.md §1.7, §6.3, §10): request-level
 * failures carry the fixed catalog metadata; commit-level failures reject
 * only the enclosing commit and the batch continues. Driven through the
 * raw reference-codec surface so the assertions pin wire behavior, not a
 * client SDK's interpretation.
 */
import { check, checkEqual } from '../checks';
import type { DriverError } from '../driver';
import { task } from '../fixture';
import {
  rawInvalidRequestBytes,
  rawPullHeader,
  rawPushCommit,
  rawSubscription,
  rawUpsert,
  responsePushResults,
} from '../raw';
import type { Scenario, ScenarioContext } from '../scenario';

/** The §10.2 metadata this catalog asserts (code → fixed fields). */
const EXPECTED_METADATA: Readonly<
  Record<
    string,
    { category: string; retryable: boolean; recommendedAction: string }
  >
> = {
  'sync.invalid_request': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
  },
  'sync.invalid_client_id': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'resetClientId',
  },
  'sync.invalid_subscription': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
  },
  'sync.empty_commit': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'fixRequest',
  },
  'sync.unknown_table': {
    category: 'schema-mismatch',
    retryable: false,
    recommendedAction: 'regenerateClient',
  },
  'sync.too_many_operations': {
    category: 'invalid-request',
    retryable: false,
    recommendedAction: 'splitBatch',
  },
};

function checkMetadata(error: DriverError, code: string, what: string): void {
  checkEqual(error.code, code, `${what}: error code`);
  const expected = EXPECTED_METADATA[code];
  check(expected !== undefined, `${what}: ${code} missing from expectations`);
  if (expected === undefined) return;
  // Metadata fields are optional in DriverError (a minimal shim may omit
  // them) but MUST match the catalog when present (§10.1).
  if (error.category !== undefined) {
    checkEqual(error.category, expected.category, `${what}: category`);
  }
  if (error.retryable !== undefined) {
    checkEqual(error.retryable, expected.retryable, `${what}: retryable`);
  }
  if (error.recommendedAction !== undefined) {
    checkEqual(
      error.recommendedAction,
      expected.recommendedAction,
      `${what}: recommendedAction`,
    );
  }
}

async function expectRequestError(
  what: string,
  code: string,
  run: () => ReturnType<ScenarioContext['rawSync']>,
): Promise<void> {
  const result = await run();
  check(!result.ok, `${what}: expected a request-level error, got a response`);
  if (!result.ok) checkMetadata(result.error, code, what);
}

const P1 = { project_id: ['p1'] } as const;

export const errorScenarios: readonly Scenario[] = [
  {
    name: 'errors/request-level-catalog',
    specRefs: ['§1.7', '§4.2', '§10.1', '§10.2'],
    server: { limits: { maxOperationsPerRequest: 2 } },
    async run(ctx) {
      await ctx.server.setAllowedScopes('actor-1', P1);
      await ctx.server.setAllowedScopes('actor-2', P1);

      // Bind a clientId to actor-1, then present it as actor-2 (§1.5).
      const bind = await ctx.rawSync(
        'actor-1',
        [
          rawPushCommit('bind-1', [
            rawUpsert(ctx.schema, 'tasks', task('t1', 'p1')),
          ]),
        ],
        { clientId: 'shared-client' },
      );
      check(bind.ok, 'binding push succeeded');
      await expectRequestError(
        'clientId bound to another actor',
        'sync.invalid_client_id',
        () =>
          ctx.rawSync('actor-2', [rawPullHeader()], {
            clientId: 'shared-client',
          }),
      );

      await expectRequestError(
        'duplicate subscription id',
        'sync.invalid_subscription',
        () =>
          ctx.rawSync('actor-1', [
            rawPullHeader(),
            rawSubscription('dup', 'tasks', P1, 0),
            rawSubscription('dup', 'tasks', P1, 0),
          ]),
      );

      await expectRequestError(
        'undeclared scope key',
        'sync.invalid_subscription',
        () =>
          ctx.rawSync('actor-1', [
            rawPullHeader(),
            rawSubscription('s1', 'tasks', { bogus: ['x'] }, 0),
          ]),
      );

      await expectRequestError(
        "requested '*' is reserved for allowed scopes",
        'sync.invalid_subscription',
        () =>
          ctx.rawSync('actor-1', [
            rawPullHeader(),
            rawSubscription('s1', 'tasks', { project_id: ['*'] }, 0),
          ]),
      );

      await expectRequestError(
        'subscription names an unknown table',
        'sync.unknown_table',
        () =>
          ctx.rawSync('actor-1', [
            rawPullHeader(),
            rawSubscription('s1', 'nope', {}, -1),
          ]),
      );

      await expectRequestError(
        'operation cap exceeded — whole batch unapplied',
        'sync.too_many_operations',
        () =>
          ctx.rawSync('actor-1', [
            rawPushCommit('cap-1', [
              rawUpsert(ctx.schema, 'tasks', task('c1', 'p1')),
              rawUpsert(ctx.schema, 'tasks', task('c2', 'p1')),
            ]),
            rawPushCommit('cap-2', [
              rawUpsert(ctx.schema, 'tasks', task('c3', 'p1')),
            ]),
          ]),
      );
      checkEqual(
        await ctx.server.getMaxCommitSeq(),
        1,
        'the over-cap batch applied nothing (§6.1)',
      );

      await expectRequestError(
        'accept without rows support (bits 0 and 1 clear)',
        'sync.invalid_request',
        () =>
          ctx.rawSync('actor-1', [
            rawPullHeader({ accept: 0b0100 }),
            rawSubscription('s1', 'tasks', P1, 0),
          ]),
      );

      // The reference encoder refuses to produce these two shapes (its
      // validation mirrors the decoder), so the bytes are hand-built.
      await expectRequestError(
        'PUSH_COMMIT with zero operations',
        'sync.empty_commit',
        () =>
          ctx.rawSyncBytes('actor-1', rawInvalidRequestBytes('empty-commit')),
      );

      await expectRequestError(
        'request with neither push nor pull',
        'sync.invalid_request',
        () =>
          ctx.rawSyncBytes(
            'actor-1',
            rawInvalidRequestBytes('no-push-no-pull'),
          ),
      );
    },
  },

  {
    name: 'errors/commit-level-rejection-continues-batch',
    specRefs: ['§1.7', '§6.3', '§6.4', '§10.2'],
    async run(ctx) {
      await ctx.server.setAllowedScopes('actor-1', P1);

      // Commit 1 names an unknown table (commit-level, §1.7); commit 2 is
      // valid — a rejected commit does not stop the batch (§6.4).
      const result = await ctx.rawSync('actor-1', [
        rawPushCommit('bad-table', [
          {
            table: 'nope',
            rowId: 'x',
            op: 'upsert',
            payload: new Uint8Array([0]),
          },
        ]),
        rawPushCommit('good', [
          rawUpsert(ctx.schema, 'tasks', task('t1', 'p1')),
        ]),
        rawPushCommit('bad-payload', [
          {
            table: 'tasks',
            rowId: 'y',
            op: 'upsert',
            // Bytes that cannot row-codec decode for the schema (§6.1).
            payload: new Uint8Array([0xff, 0xff, 0xff]),
          },
        ]),
      ]);
      check(result.ok, 'commit-level failures are not request failures');
      if (!result.ok) return;
      const pushes = responsePushResults(result.message);
      checkEqual(pushes.length, 3, 'one PUSH_RESULT per PUSH_COMMIT, in order');

      checkEqual(
        pushes[0]?.status,
        'rejected',
        'unknown-table commit rejected',
      );
      checkEqual(pushes[0]?.commitSeq, undefined, 'no commitSeq on rejection');
      const first = pushes[0]?.results[0];
      check(
        first?.status === 'error' && first.code === 'sync.unknown_table',
        'the terminating record names sync.unknown_table',
      );
      checkEqual(
        pushes[0]?.results.length,
        1,
        'only the terminating record is reported (§6.3)',
      );

      checkEqual(pushes[1]?.status, 'applied', 'the batch continued (§6.4)');

      checkEqual(pushes[2]?.status, 'rejected', 'bad payload commit rejected');
      const third = pushes[2]?.results[0];
      check(
        third?.status === 'error' && third.code === 'sync.invalid_request',
        'row-codec failure is commit-level sync.invalid_request (§1.7)',
      );

      const rows = await ctx.server.readRows('tasks');
      checkEqual(
        rows.map((row) => row.rowId),
        ['t1'],
        'only the valid commit touched storage',
      );
    },
  },
];
