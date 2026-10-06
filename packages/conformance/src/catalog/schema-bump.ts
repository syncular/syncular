/**
 * Schema-bump flow (SPEC.md §7.4): NO client-side migration
 * engine. On a schema version increase the client keeps its (schema-agnostic)
 * outbox, wipes local tables, re-bootstraps at the new version, and replays.
 *
 * Two triggers converge on one flow: the local generated-version change on
 * boot (§7.4.2 trigger 1) and the server schema floor after an app update
 * (§7.4.2 trigger 2). A pending commit that cannot re-encode under the new
 * schema surfaces as `sync.outbox_incompatible` (§7.4.4). The re-bootstrap
 * rides the image lane (§5.3) exactly like any fresh bootstrap.
 */
import { check, checkEqual } from '../checks';
import {
  FIXTURE_SCHEMA,
  FIXTURE_SCHEMA_V2,
  FIXTURE_SCHEMA_V2_DROP_META,
  task,
} from '../fixture';
import { rawPullHeader, rawSubscription, responseSection } from '../raw';
import type { DriverSchema } from '../driver';
import type { Scenario } from '../scenario';
import { expectConverged, seedTasks, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

/** Rows baseline + sqlite images (§5.3). */
const WITH_SQLITE = 0b0111;

export const schemaBumpScenarios: readonly Scenario[] = [
  {
    name: 'schema-bump/missing-paired-marker-refuses-recreation',
    specRefs: ['§7.4.1', '§7.4.2'],
    requires: ['storage-fault'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      const commit = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('kept', 'p1', 'pending') },
      ]);
      check(a.api.executeStorageSql !== undefined, 'storage fault seam');
      await a.api.executeStorageSql(
        "DELETE FROM _syncular_meta WHERE key = 'localSchemaVersion'",
      );
      let code: unknown;
      try {
        await ctx.recreateClient(a, FIXTURE_SCHEMA_V2_DROP_META);
      } catch (error) {
        code =
          error instanceof Error && 'code' in error ? error.code : undefined;
      }
      checkEqual(
        code,
        'sync.local_corrupt',
        'an existing descriptor cannot authorize an absent marker',
      );
      // Restore the exact known fixture marker, then reopen compatibly. The
      // refused recreation must leave durable intent and table contents intact.
      await a.api.executeStorageSql(
        "INSERT INTO _syncular_meta(key,value) VALUES ('localSchemaVersion','1')",
      );
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        await a.api.pendingCommitIds(),
        [commit],
        'queued intent survives refusal',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['kept'],
        'local row survives refusal',
      );
    },
  },

  {
    name: 'schema-bump/downgrade-refuses-and-preserves-v3-outbox',
    specRefs: ['§7.4.1', '§7.4.2'],
    server: { schema: { ...FIXTURE_SCHEMA, version: 3 } },
    async run(ctx) {
      const schema = { ...FIXTURE_SCHEMA, version: 3 };
      await seedTasks(ctx, [task('accepted', 'p1', 'accepted-v3')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema,
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(a);
      const commit = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task(
            'queued',
            'p1',
            'queued-v3',
            false,
            null,
            '{"pending":true}',
          ),
        },
      ]);
      const rows = await a.api.readRows('tasks');
      const subscription = await a.api.subscriptionState('tasks');
      let code: unknown;
      try {
        await ctx.recreateClient(a, FIXTURE_SCHEMA_V2_DROP_META);
      } catch (error) {
        code =
          error instanceof Error && 'code' in error ? error.code : undefined;
      }
      checkEqual(
        code,
        'client.schema_downgrade',
        '§7.4.2 refuses a v3 replica with a v2 schema',
      );
      // Reopen with the compatible build. This also checks the TS driver,
      // whose recreation releases the old core before starting the new one.
      await ctx.recreateClient(a, schema);
      checkEqual(
        await a.api.upgrading?.(),
        false,
        '§7.4.2 refusal did not reset the marker',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [commit],
        '§7.4.2 preserves the queued v3 write',
      );
      checkEqual(
        await a.api.readRows('tasks'),
        rows,
        '§7.4.2 preserves accepted and optimistic rows',
      );
      checkEqual(
        await a.api.subscriptionState('tasks'),
        subscription,
        '§7.4.2 preserves subscription cursors',
      );
      await syncIdle(a);
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the compatible build can deliver the retained write',
      );
      await expectConverged(ctx, 'tasks', [a]);
    },
  },
  {
    name: 'schema-bump/absent-legacy-marker-preserves-replica',
    specRefs: ['§7.4.1', '§7.4.2'],
    async run(ctx) {
      await seedTasks(ctx, [task('accepted', 'p1')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      check(
        a.api.executeStorageSql !== undefined,
        'reference clients expose storage fault injection',
      );
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(a);
      const commit = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('queued', 'p1') },
      ]);
      const rows = await a.api.readRows('tasks');
      const subscription = await a.api.subscriptionState('tasks');
      await a.api.executeStorageSql(
        "DELETE FROM _syncular_meta WHERE key = 'localSchemaVersion'",
      );
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        await a.api.pendingCommitIds(),
        [commit],
        '§7.4.1 absent legacy markers preserve the outbox',
      );
      checkEqual(
        await a.api.readRows('tasks'),
        rows,
        '§7.4.1 absent legacy markers preserve accepted rows',
      );
      checkEqual(
        await a.api.subscriptionState('tasks'),
        subscription,
        '§7.4.1 absent legacy markers preserve cursors',
      );
      checkEqual(
        await a.api.upgrading?.(),
        false,
        '§7.4.1 absent markers do not trigger reset',
      );
    },
  },
  {
    name: 'schema-bump/out-of-range-requested-version-refuses-before-storage',
    specRefs: ['§7.4.1', '§7.4.2'],
    async run(ctx) {
      for (const version of [0, -1, 2147483648]) {
        let code: unknown;
        try {
          await ctx.newClient({
            actorId: 'actor-a',
            clientId: `version-${version}`,
            schema: { ...FIXTURE_SCHEMA, version },
            allowed: P1,
          });
        } catch (error) {
          code =
            error instanceof Error && 'code' in error ? error.code : undefined;
        }
        checkEqual(
          code,
          'sync.invalid_request',
          `§7.4.2 a requested schema version of ${version} is refused`,
        );
      }
    },
  },
  {
    name: 'schema-bump/duplicated-marker-refuses-recreation',
    specRefs: ['§7.4.1', '§7.4.2'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
      });
      check(
        a.api.executeStorageSql !== undefined,
        'reference clients expose storage fault injection',
      );
      const commit = await a.api.mutate([
        { op: 'upsert', table: 'tasks', values: task('queued', 'p1') },
      ]);
      const rows = await a.api.readRows('tasks');
      // A hand-built/legacy metadata table without its primary key carries two
      // marker rows: taking one row could select an older version and reset.
      await a.api.executeStorageSql(
        'ALTER TABLE _syncular_meta RENAME TO _syncular_meta_keyed',
      );
      await a.api.executeStorageSql(
        'CREATE TABLE _syncular_meta(key TEXT, value TEXT)',
      );
      await a.api.executeStorageSql(
        'INSERT INTO _syncular_meta SELECT key, value FROM _syncular_meta_keyed',
      );
      await a.api.executeStorageSql(
        "INSERT INTO _syncular_meta(key, value) VALUES ('localSchemaVersion', '1')",
      );
      await a.api.executeStorageSql('DROP TABLE _syncular_meta_keyed');
      let code: unknown;
      try {
        await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
      } catch (error) {
        code =
          error instanceof Error && 'code' in error ? error.code : undefined;
      }
      checkEqual(
        code,
        'sync.local_corrupt',
        '§7.4.2 a duplicated marker is unreadable state, never a reset',
      );
      // Restore one canonical marker and prove the refusal reset nothing.
      await a.api.executeStorageSql(
        'ALTER TABLE _syncular_meta RENAME TO _syncular_meta_duplicated',
      );
      await a.api.executeStorageSql(
        'CREATE TABLE _syncular_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      );
      await a.api.executeStorageSql(
        "INSERT INTO _syncular_meta(key, value) SELECT key, value FROM _syncular_meta_duplicated WHERE key <> 'localSchemaVersion'",
      );
      await a.api.executeStorageSql(
        "INSERT INTO _syncular_meta(key, value) VALUES ('localSchemaVersion', '1')",
      );
      await a.api.executeStorageSql('DROP TABLE _syncular_meta_duplicated');
      await ctx.recreateClient(a, FIXTURE_SCHEMA);
      checkEqual(
        await a.api.pendingCommitIds(),
        [commit],
        'duplicated-marker refusal preserves the outbox',
      );
      checkEqual(
        await a.api.readRows('tasks'),
        rows,
        'duplicated-marker refusal preserves the replica rows',
      );
      checkEqual(
        await a.api.upgrading?.(),
        false,
        'duplicated-marker refusal preserves the schema',
      );
    },
  },
  ...(['invalid', 'unreadable'] as const).map(
    (failure): Scenario => ({
      name: `schema-bump/${failure}-marker-refuses-recreation`,
      specRefs: ['§7.4.1', '§7.4.2'],
      async run(ctx) {
        const a = await ctx.newClient({
          actorId: 'actor-a',
          clientId: 'client-a',
          allowed: P1,
        });
        check(
          a.api.executeStorageSql !== undefined,
          'reference clients expose storage fault injection',
        );
        const commit = await a.api.mutate([
          { op: 'upsert', table: 'tasks', values: task('queued', 'p1') },
        ]);
        const rows = await a.api.readRows('tasks');
        await a.api.executeStorageSql(
          failure === 'invalid'
            ? "UPDATE _syncular_meta SET value = 'invalid' WHERE key = 'localSchemaVersion'"
            : 'ALTER TABLE _syncular_meta RENAME COLUMN value TO unreadable_value',
        );
        let code: unknown;
        try {
          await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
        } catch (error) {
          code =
            error instanceof Error && 'code' in error ? error.code : undefined;
        }
        checkEqual(
          code,
          'sync.local_corrupt',
          '§7.4.2 read failures never become an absent marker',
        );
        await a.api.executeStorageSql(
          failure === 'invalid'
            ? "UPDATE _syncular_meta SET value = '1' WHERE key = 'localSchemaVersion'"
            : 'ALTER TABLE _syncular_meta RENAME COLUMN unreadable_value TO value',
        );
        await ctx.recreateClient(a, FIXTURE_SCHEMA);
        checkEqual(
          await a.api.pendingCommitIds(),
          [commit],
          'marker refusal preserves the outbox',
        );
        checkEqual(
          await a.api.readRows('tasks'),
          rows,
          'marker refusal preserves replica rows',
        );
        checkEqual(
          await a.api.upgrading?.(),
          false,
          'marker refusal preserves the schema',
        );
      },
    }),
  ),
  ...(['variable', 'prefix', 'column', 'compatible'] as const).map(
    (change): Scenario => {
      const oldSchema: DriverSchema = {
        ...FIXTURE_SCHEMA,
        version: 89,
        tables: [
          {
            ...FIXTURE_SCHEMA.tables[0]!,
            scopes: [
              {
                pattern: 'theatre:{theatre_calendar_id}',
                column: 'project_id',
              },
            ],
          },
          FIXTURE_SCHEMA.tables[1]!,
        ],
      };
      const schema: DriverSchema = {
        ...oldSchema,
        version: 90,
        tables: [
          {
            ...oldSchema.tables[0]!,
            scopes: [
              {
                pattern:
                  change === 'variable'
                    ? 'theatre:{calendar_theatre_id}'
                    : change === 'prefix'
                      ? 'calendar:{theatre_calendar_id}'
                      : 'theatre:{theatre_calendar_id}',
                column: change === 'column' ? 'title' : 'project_id',
              },
            ],
          },
          oldSchema.tables[1]!,
        ],
      };
      return {
        name: `schema-bump/subscription-scope-${change}`,
        specRefs: ['§7.4.3', '§3.1', '§4.8'],
        server: { schema },
        async run(ctx) {
          const allowed = {
            [change === 'variable'
              ? 'calendar_theatre_id'
              : 'theatre_calendar_id']: ['p1'],
            org_id: ['o1'],
            projectId: ['p1'],
          };
          const a = await ctx.newClient({
            actorId: 'actor-a',
            clientId: 'scope-client',
            schema: oldSchema,
            allowed,
          });
          const base = { table: 'tasks', variable: 'theatre_calendar_id' };
          await a.api.subscribe({
            id: 'old',
            table: 'tasks',
            scopes: { theatre_calendar_id: ['p1'] },
          });
          await a.api.subscribe({
            id: 'compatible',
            table: 'docs',
            scopes: { org_id: ['o1'], projectId: ['p1'] },
          });
          await a.api.setWindow?.(base, ['p1']);
          await a.api.executeStorageSql?.(
            `INSERT INTO _syncular_window_pending_evict(sub_id,tbl,effective_scopes) VALUES ('removed-unit','tasks','{"theatre_calendar_id":["p1"]}')`,
          );
          await ctx.recreateClient(a, schema);
          if (a.api.querySnapshot)
            checkEqual(
              (
                await a.api.querySnapshot(
                  "SELECT count(*) AS n FROM _syncular_window_pending_evict WHERE sub_id='removed-unit'",
                )
              ).rows,
              [{ n: change === 'compatible' ? 1 : 0 }],
              'orphaned pending window evictions obey the same compatibility fence',
            );
          checkEqual(
            (await a.api.subscriptionState('compatible'))?.cursor,
            -1,
            'compatible registration must rebootstrap wiped rows',
          );
          checkEqual(
            (await a.api.subscriptionState('old')) !== undefined,
            change === 'compatible',
            'only compatible scope declarations survive',
          );
          if (a.api.windowState)
            checkEqual(
              (await a.api.windowState(base)).units,
              change === 'compatible' ? ['p1'] : [],
              'incompatible window bookkeeping is removed',
            );
          await a.api.subscribe({
            id: 'current',
            table: 'tasks',
            scopes: {
              [change === 'variable'
                ? 'calendar_theatre_id'
                : 'theatre_calendar_id']: ['p1'],
            },
          });
          await syncIdle(a);
          const cursor = (await a.api.subscriptionState('current'))?.cursor;
          await ctx.recreateClient(a, schema);
          checkEqual(
            (await a.api.subscriptionState('current'))?.cursor,
            cursor,
            'same-version reopen keeps the cursor',
          );
          await syncIdle(a);
        },
      };
    },
  ),

  {
    name: 'schema-window/previous-client-push-pull',
    specRefs: ['§9', '§7.4.2', '§6.7'],
    server: {
      schema: FIXTURE_SCHEMA_V2,
      schemaWindow: [FIXTURE_SCHEMA_V2, FIXTURE_SCHEMA],
    },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'retained')]);
      const old = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-old',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
      });
      await old.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(old);
      checkEqual(
        await old.api.schemaFloor(),
        undefined,
        'the previous client is served',
      );
      checkEqual(
        (await old.api.readRows('tasks'))[0]?.values.title,
        'retained',
        'the previous codec decodes bootstrap rows',
      );
      await old.api.mutate([
        { table: 'tasks', op: 'upsert', values: task('t2', 'p1', 'from-old') },
      ]);
      await syncIdle(old);
      checkEqual(
        (await ctx.server.readRows('tasks')).length,
        2,
        'old pushes apply through current rules',
      );
    },
  },
  {
    // §7.4.2 trigger 1 + §7.4.3/§7.4.4: a client with vN data AND a pending
    // offline outbox commit boots with the vN+1 generated schema, wipes,
    // re-bootstraps, and replays the outbox on top — converging with the
    // v2 server, versions and rows correct.
    name: 'schema-bump/local-bump-wipe-rebootstrap-replay',
    specRefs: ['§7.4.2', '§7.4.3', '§7.4.4', '§0'],
    // The server serves version 2; the client starts at version 1.
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      // Server already holds v2 data before the client upgrades.
      await seedTasks(ctx, [
        task('t1', 'p1', 'server-one'),
        task('t2', 'p1', 'server-two'),
      ]);

      // A v1 client: subscribe, bootstrap, then go offline and mutate.
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });

      // The v1 client is below the server floor: its first sync stops.
      const stopped = await syncOk(a);
      checkEqual(
        stopped.schemaFloor?.requiredSchemaVersion,
        2,
        'the v1 client is below the v2 server floor (§1.6)',
      );

      // Offline local write recorded under v1 (schema-agnostic outbox, §0).
      const offline = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t3', 'p1', 'offline-v1'),
        },
      ]);
      checkEqual(
        await a.api.pendingCommitIds(),
        [offline],
        'the offline write is queued and survives the bump (§0)',
      );

      // "App ships new code": recreate with the v2 generated schema on the
      // SAME database. The boot-time §7.4.1 marker check fires the reset.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
      check(
        (await a.api.upgrading?.()) === true,
        'the reset raised the upgrading state (§7.4.5)',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [offline],
        'the reset preserved the outbox (§7.4.3)',
      );
      checkEqual(
        await a.api.schemaFloor(),
        undefined,
        'the stop state cleared — the client now ships a servable schema',
      );

      // First post-reset sync: fresh bootstrap of the v2 server + replay.
      const upgraded = await syncIdle(a);
      checkEqual(
        upgraded.schemaFloor,
        undefined,
        'no floor after the upgrade — the client is at the served version',
      );
      check(
        (await a.api.upgrading?.()) === false,
        'upgrading cleared once the re-bootstrap reached idle (§7.4.5)',
      );

      // The offline commit drained and everything converged (t1,t2 from the
      // bootstrap; t3 from the replayed outbox commit).
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the replayed v1 commit re-encoded under v2 and drained (§7.4.4)',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      const rows = await a.api.readRows('tasks');
      checkEqual(rows.length, 3, 't1, t2 (bootstrap) + t3 (replayed) present');
    },
  },

  {
    // §7.4.2 trigger 2: a running client is left behind by a server upgrade,
    // enters the schemaFloor stop state, then the app update (recreate with
    // the new schema) converges it — the floor trigger and the boot trigger
    // meet in the same flow.
    name: 'schema-bump/floor-triggered-bump-converges',
    specRefs: ['§1.6', '§7.4.2', '§7.4.3'],
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      await seedTasks(ctx, [task('t1', 'p1', 'v2-only')]);

      // A v1 client hits the v2 floor and stops (the §1.6 stop state).
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      const floored = await syncOk(a);
      checkEqual(
        floored.schemaFloor?.requiredSchemaVersion,
        2,
        'the floor names the required version (§1.6)',
      );
      check(
        (await a.api.schemaFloor()) !== undefined,
        'the client is stopped pending an upgrade',
      );
      // Syncing is inert while stopped: no bootstrap happened.
      checkEqual(
        (await a.api.readRows('tasks')).length,
        0,
        'nothing was processed under the floor (§1.6)',
      );

      // App update: recreate with the v2 schema. The marker still reads v1,
      // so the boot check drives the reset; the next sync converges.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
      const upgraded = await syncIdle(a);
      checkEqual(upgraded.schemaFloor, undefined, 'no floor after the update');
      check(
        (await a.api.upgrading?.()) === false,
        'the re-bootstrap completed (§7.4.5)',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // §7.4.4: a pending UPSERT that carried a column the bump DROPS cannot
    // re-encode — it surfaces cleanly as `sync.outbox_incompatible` (a
    // client-local rejection). A later commit that DOES encode (a delete
    // carries no row values) still replays. One bad commit never wedges the
    // queue. (Every v1 full-row upsert stores the `meta` key, so dropping
    // `meta` makes any such upsert incompatible — the honest semantics.)
    name: 'schema-bump/dropped-column-pending-commit-surfaces',
    specRefs: ['§7.4.4', '§7.2', '§10.3'],
    server: { schema: FIXTURE_SCHEMA_V2_DROP_META },
    async run(ctx) {
      // Seed t2 on the (drop-meta v2) server so the client has something to
      // delete after it upgrades and bootstraps.
      await seedTasks(ctx, [task('t2', 'p1', 'server-two')]);

      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });

      // Two offline commits under v1: an upsert (full-row, carries `meta`,
      // incompatible after the drop) and a delete (no row values, always
      // encodable).
      const upsertT1 = await a.api.mutate([
        {
          op: 'upsert',
          table: 'tasks',
          values: task('t1', 'p1', 'has-meta', false, 1, '{"k":"v"}'),
        },
      ]);
      const deleteT2 = await a.api.mutate([
        { op: 'delete', table: 'tasks', rowId: 't2' },
      ]);
      checkEqual(
        await a.api.pendingCommitIds(),
        [upsertT1, deleteT2],
        'both offline commits are queued',
      );

      // App update to the meta-dropping v2 schema, then replay.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2_DROP_META);
      const upgraded = await syncIdle(a);
      checkEqual(upgraded.schemaFloor, undefined, 'converged at v2');

      // The upsert is rejected client-side; the delete replayed and drained.
      const rejections = await a.api.rejections();
      const incompatible = rejections.find(
        (r) => r.code === 'sync.outbox_incompatible',
      );
      check(
        incompatible !== undefined,
        'the dropped-column upsert surfaced as sync.outbox_incompatible (§7.4.4)',
      );
      checkEqual(
        incompatible?.clientCommitId,
        upsertT1,
        'the incompatible rejection names the meta-carrying upsert',
      );
      checkEqual(
        incompatible?.retryable,
        false,
        'a schema-incompatible commit is not retryable',
      );
      checkEqual(
        await a.api.pendingCommitIds(),
        [],
        'the incompatible commit left the outbox; the delete drained',
      );

      // t2 was deleted server-side by the replayed delete; t1 never reached
      // the server (its only commit was dropped). The client converged.
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
      const serverRows = await ctx.server.readRows('tasks');
      checkEqual(
        serverRows.length,
        0,
        'the delete drained; the upsert did not',
      );
    },
  },

  {
    // §7.4.3 + §5.3: the re-bootstrap after a bump is an ordinary fresh
    // bootstrap, so it rides the image lane when the client advertises
    // accept bit 2 — asserted via the sqlite mediaType on the raw pull and
    // the single-shot whole-table completion the image lane guarantees.
    name: 'schema-bump/image-lane-rebootstrap',
    specRefs: ['§7.4.3', '§5.3', '§5.6'],
    server: { schema: FIXTURE_SCHEMA_V2 },
    async run(ctx) {
      await seedTasks(ctx, [
        task('t1', 'p1', 'one'),
        task('t2', 'p1', 'two'),
        task('t3', 'p1', 'three'),
        task('t4', 'p1', 'four'),
        task('t5', 'p1', 'five'),
      ]);

      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FIXTURE_SCHEMA,
        allowed: P1,
        // Tight paging that the rows lane could not satisfy in one pull —
        // only the whole-table image completes in a single page (§5.3).
        limits: {
          limitSnapshotRows: 2,
          maxSnapshotPages: 1,
          accept: WITH_SQLITE,
        },
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });

      // Reference raw pull: the server offers the whole table as one sqlite
      // descriptor at the v2 codec — pinning the re-bootstrap lane.
      await ctx.server.setAllowedScopes('raw-actor', P1);
      const raw = await ctx.rawSync(
        'raw-actor',
        [
          rawPullHeader({ accept: WITH_SQLITE, limitSnapshotRows: 2 }),
          rawSubscription('s1', 'tasks', P1, -1),
        ],
        { clientId: 'raw-client', schemaVersion: 2 },
      );
      check(raw.ok, 'raw v2 pull succeeded');
      if (raw.ok) {
        const section = responseSection(raw.message, 's1');
        const ref = section.body[0];
        checkEqual(section.body.length, 1, 'one segment covers the table');
        check(
          ref?.type === 'SEGMENT_REF' && ref.mediaType === 'sqlite',
          'the re-bootstrap lane is the sqlite image (§5.3)',
        );
      }

      // Upgrade the client and re-bootstrap: the wiped table refills from a
      // single image page despite the tight paging limits.
      await ctx.recreateClient(a, FIXTURE_SCHEMA_V2);
      const first = await syncOk(a);
      checkEqual(
        first.segmentRowsApplied,
        5,
        'the whole table re-bootstrapped as one image (§5.3)',
      );
      checkEqual(
        first.bootstrapping,
        [],
        'the image completed the table in one pull — paging limits do not apply',
      );
      check(
        (await a.api.upgrading?.()) === false,
        'upgrading cleared on the single-shot image re-bootstrap',
      );
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },
];
