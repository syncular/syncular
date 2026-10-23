/**
 * `ROUND_FAILURE` (SPEC.md §1.5): a client that ends a round without a
 * complete, decodable response keeps that round's code and reports it on
 * every following request. The server records the report as a failed round on
 * the client's existing record (§4.5), so a client that keeps losing
 * responses stops looking healthy in the admin view; the next request without
 * the frame clears it, exactly as a completed round does.
 *
 * Driven through the raw reference-codec surface: the frame, its grammar
 * position, and the recorded outcome are wire behavior, not client SDK
 * interpretation.
 */
import { check, checkEqual } from '../checks';
import type { DriverAdminClient } from '../driver';
import { rawPullHeader, rawSubscription } from '../raw';
import type { Scenario } from '../scenario';

const P1 = { project_id: ['p1'] } as const;

function clientOf(
  clients: readonly DriverAdminClient[],
  clientId: string,
): DriverAdminClient | undefined {
  return clients.find((client) => client.clientId === clientId);
}

export const roundFailureScenarios: readonly Scenario[] = [
  {
    name: 'round-failure/report-lands-on-the-client-record',
    specRefs: ['§1.5', '§4.5'],
    async run(ctx) {
      await ctx.server.setAllowedScopes('actor-1', P1);
      const clientId = 'reporting-client';
      const pull = () => [
        rawPullHeader(),
        rawSubscription('s1', 'tasks', P1, 0),
      ];
      const report = (code: string) => [
        { type: 'ROUND_FAILURE' as const, code },
        ...pull(),
      ];

      // A completed round registers the client.
      const first = await ctx.rawSync('actor-1', pull(), { clientId });
      check(first.ok, 'the registering pull succeeded');
      const registered = clientOf(await ctx.server.listClients(), clientId);
      check(registered !== undefined, 'the admin view lists the client');
      checkEqual(
        registered?.lastErrorCode,
        undefined,
        'a completed round records no error code',
      );
      checkEqual(
        registered?.consecutiveFailures,
        undefined,
        'a completed round records no failure streak',
      );

      // §1.5: the report is recorded before the round runs, and §4.5: the
      // completion of that round leaves it in place.
      const reported = await ctx.rawSync(
        'actor-1',
        report('sync.transport_failed'),
        { clientId },
      );
      check(reported.ok, 'the reporting pull succeeded');
      const afterReport = clientOf(await ctx.server.listClients(), clientId);
      checkEqual(
        afterReport?.lastErrorCode,
        'sync.transport_failed',
        'the reported code is on the client record after the round completed',
      );
      checkEqual(
        afterReport?.consecutiveFailures,
        1,
        'the report counted as one failed round',
      );

      // A second report counts again, and a newer code replaces the old one.
      const second = await ctx.rawSync('actor-1', report('sync.timeout'), {
        clientId,
      });
      check(second.ok, 'the second reporting pull succeeded');
      const afterSecond = clientOf(await ctx.server.listClients(), clientId);
      checkEqual(
        afterSecond?.lastErrorCode,
        'sync.timeout',
        'a newer report replaces the code',
      );
      checkEqual(
        afterSecond?.consecutiveFailures,
        2,
        'the streak counts reports in a row',
      );

      // §4.5: the next request without the frame clears the code and streak.
      const cleared = await ctx.rawSync('actor-1', pull(), { clientId });
      check(cleared.ok, 'the plain pull succeeded');
      const afterClear = clientOf(await ctx.server.listClients(), clientId);
      checkEqual(
        afterClear?.lastErrorCode,
        undefined,
        'a round without the frame clears the code',
      );
      checkEqual(
        afterClear?.consecutiveFailures,
        undefined,
        'a round without the frame clears the streak',
      );
    },
  },
  {
    name: 'round-failure/report-never-creates-a-client-record',
    specRefs: ['§1.5', '§4.5'],
    async run(ctx) {
      await ctx.server.setAllowedScopes('actor-1', P1);
      const clientId = 'unregistered-client';
      // A schema-floor round answers without the §4.5 cursor write, so the
      // report has no record to land on and must not create one.
      const result = await ctx.rawSync(
        'actor-1',
        [
          { type: 'ROUND_FAILURE' as const, code: 'sync.transport_failed' },
          rawPullHeader(),
        ],
        { clientId, schemaVersion: ctx.schema.version + 1 },
      );
      check(result.ok, 'the floor round was answered');
      checkEqual(
        clientOf(await ctx.server.listClients(), clientId),
        undefined,
        'a report never creates a client record (§4.5)',
      );
    },
  },
];
