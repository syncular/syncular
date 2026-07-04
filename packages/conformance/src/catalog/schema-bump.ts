/**
 * Schema-bump flow (SPEC.md §7.4; TODO 3.3): NO client-side migration
 * engine. On a schema version change the client keeps its (schema-agnostic)
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
import type { Scenario } from '../scenario';
import { expectConverged, seedTasks, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

/** Rows baseline + sqlite images (§5.3). */
const WITH_SQLITE = 0b0111;

export const schemaBumpScenarios: readonly Scenario[] = [
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
