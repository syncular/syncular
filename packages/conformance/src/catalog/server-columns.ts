/**
 * §6.12 server-owned columns: the server's hook sets them inside the push
 * transaction, so a pushed row is stored and delivered with the server's
 * values, under a server-set scope, in the same commit. Both client cores
 * refuse to author such a column; a push that carries one (an older app's
 * shape) has the value discarded.
 */
import { check, checkEqual } from '../checks';
import type { DriverSchema } from '../driver';
import { rawPushCommit, rawUpsert, responsePushResults } from '../raw';
import type { Scenario } from '../scenario';
import { syncIdle, syncOk } from './util';

const SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'events',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'facility_id', type: 'string', nullable: false },
        { name: 'day', type: 'string', nullable: false },
        {
          name: 'actor_label',
          type: 'string',
          nullable: true,
          serverOwned: true,
        },
        {
          name: 'activity_id',
          type: 'string',
          nullable: true,
          serverOwned: true,
        },
      ],
      primaryKey: 'id',
      scopes: [
        { pattern: 'facility:{facility_id}' },
        { pattern: 'activity:{activity_id}' },
      ],
      writeScopeVariables: ['facility_id'],
    },
  ],
};

export const serverColumnScenarios: readonly Scenario[] = [
  {
    name: 'server-columns/hook-sets-owned-columns-in-the-push-commit',
    specRefs: ['§6.12', '§3.4', '§6.2'],
    requires: ['server-columns', 'scope-authorization'],
    server: { schema: SCHEMA },
    async run(ctx) {
      check(
        ctx.server.installServerColumns !== undefined,
        'the server-columns capability requires installServerColumns',
      );
      await ctx.server.installServerColumns?.([
        {
          table: 'events',
          actorLabel: 'actor_label',
          scope: { column: 'activity_id', from: 'day', prefix: 'w-' },
        },
      ]);
      const reader = await ctx.newClient({
        actorId: 'reader',
        clientId: 'reader',
        schema: SCHEMA,
        allowed: { activity_id: ['w-day1'] },
      });
      await reader.api.subscribe({ activity_id: 'w-day1' });
      await syncIdle(reader);
      const writer = await ctx.newClient({
        actorId: 'writer',
        clientId: 'writer',
        schema: SCHEMA,
        allowed: { facility_id: ['f1'] },
      });
      await writer.api.subscribe({ facility_id: 'f1' });
      await syncIdle(writer);

      for (const key of ['actor_label', 'actorLabel']) {
        let code: unknown;
        try {
          await writer.api.mutate([
            {
              op: 'upsert',
              table: 'events',
              values: { id: 'e0', facility_id: 'f1', day: 'day1', [key]: 'x' },
            },
          ]);
        } catch (error) {
          code =
            error instanceof Error && 'code' in error ? error.code : undefined;
        }
        checkEqual(
          code,
          'sync.invalid_request',
          `the client refuses a mutation value for a server-owned column (${key})`,
        );
      }

      await writer.api.mutate([
        {
          op: 'upsert',
          table: 'events',
          values: { id: 'e1', facility_id: 'f1', day: 'day1' },
        },
      ]);
      checkEqual(
        (await writer.api.readRows('events')).map((row) => [
          row.values.actor_label,
          row.values.activity_id,
        ]),
        [[null, null]],
        'the optimistic row holds NULL until the server row arrives',
      );
      await syncIdle(writer);
      checkEqual(
        (await ctx.server.readRows('events')).map((row) => ({
          values: row.values,
          scopes: row.scopes,
          version: row.version,
        })),
        [
          {
            values: {
              id: 'e1',
              facility_id: 'f1',
              day: 'day1',
              actor_label: 'actor:writer',
              activity_id: 'w-day1',
            },
            scopes: { facility_id: 'f1', activity_id: 'w-day1' },
            version: 1,
          },
        ],
        'the server stores its values and the server-set scope in the push commit',
      );
      checkEqual(
        (await writer.api.readRows('events')).map(
          (row) => row.values.actor_label,
        ),
        ['actor:writer'],
        'the writer receives the server row',
      );
      await syncOk(reader);
      checkEqual(
        (await reader.api.readRows('events')).map((row) => row.values),
        [
          {
            id: 'e1',
            facility_id: 'f1',
            day: 'day1',
            actor_label: 'actor:writer',
            activity_id: 'w-day1',
          },
        ],
        "the server-set scope's unit receives the row in its next round",
      );

      const older = await ctx.rawSync(
        'writer',
        [
          rawPushCommit('older-shape', [
            rawUpsert(SCHEMA, 'events', {
              id: 'e2',
              facility_id: 'f1',
              day: 'day2',
              actor_label: 'forged',
              activity_id: 'w-day1',
            }),
          ]),
        ],
        { clientId: 'older' },
      );
      check(older.ok, 'the older-shaped push completes');
      if (!older.ok) return;
      checkEqual(
        responsePushResults(older.message)[0]?.status,
        'applied',
        'a push that carries server-owned values is accepted',
      );
      checkEqual(
        (await ctx.server.readRows('events')).find((row) => row.rowId === 'e2')
          ?.values,
        {
          id: 'e2',
          facility_id: 'f1',
          day: 'day2',
          actor_label: 'actor:writer',
          activity_id: 'w-day2',
        },
        'the server discards the pushed values and stores its own',
      );
    },
  },
];
