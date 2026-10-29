/**
 * Local authority (SPEC.md §12, Appendix B.24): a client syncs against a
 * server in its own process, survives a schema bump without a remote server,
 * and moves its data to a remote server with attach (§12.3) followed by the
 * ordinary log-epoch reset (§2.1, §12.4).
 */
import { check, checkEqual } from '../checks';
import type {
  DriverRow,
  DriverSchema,
  DriverTable,
  LocalAuthorityInstance,
} from '../driver';
import type { ClientHandle, Scenario, ScenarioContext } from '../scenario';
import { expectConverged, syncFails, syncIdle } from './util';

const P1 = { project_id: ['p1'] } as const;

const LOCAL_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'projects',
      columns: [
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      primaryKey: 'project_id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
    {
      name: 'nodes',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'parent_id', type: 'string', nullable: true },
        { name: 'owner', type: 'string', nullable: true },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
      references: [
        { column: 'parent_id', parentTable: 'nodes', onDelete: 'SET NULL' },
        { column: 'owner', parentTable: 'projects', onDelete: 'CASCADE' },
      ],
    },
  ],
};

/** Version 2 appends a nullable column and a table (§7.4, §12.2). */
const LOCAL_SCHEMA_V2: DriverSchema = {
  version: 2,
  tables: [
    LOCAL_SCHEMA.tables[0] as DriverTable,
    {
      ...(LOCAL_SCHEMA.tables[1] as DriverTable),
      columns: [
        ...(LOCAL_SCHEMA.tables[1] as DriverTable).columns,
        { name: 'note', type: 'string', nullable: true },
      ],
    },
    {
      name: 'tags',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
  ],
};

function node(
  id: string,
  parentId: string | null,
  owner: string | null = null,
  projectId = 'p1',
): DriverRow {
  return { id, project_id: projectId, parent_id: parentId, owner };
}

async function localClient(
  ctx: ScenarioContext,
  authority: LocalAuthorityInstance,
  schema: DriverSchema = LOCAL_SCHEMA,
  scopes: Readonly<Record<string, readonly string[]>> = P1,
): Promise<ClientHandle> {
  const handle = await ctx.newClient({
    actorId: 'owner',
    clientId: 'device',
    server: authority,
    schema,
  });
  for (const table of ['projects', 'nodes']) {
    await handle.api.subscribe({ id: table, table, scopes });
  }
  await syncIdle(handle);
  return handle;
}

/** The client mirror equals the authority's rows, version for version. */
async function expectLocalConverged(
  authority: LocalAuthorityInstance,
  handle: ClientHandle,
  table: string,
): Promise<void> {
  checkEqual(
    (await handle.api.readRows(table)).map((row) => ({
      rowId: row.rowId,
      version: row.version,
      values: row.values,
    })),
    (await authority.readRows(table)).map((row) => ({
      rowId: row.rowId,
      version: row.version,
      values: row.values,
    })),
    `the client mirrors the local authority on ${table}`,
  );
}

export const localAuthorityScenarios: readonly Scenario[] = [
  {
    name: 'local-authority/round-trip-applies-server-rules',
    specRefs: ['§12.1', '§12.2', '§6.11', 'B.24'],
    requires: ['local-authority'],
    async run(ctx) {
      const authority = await ctx.newLocalAuthority(LOCAL_SCHEMA);
      const a = await localClient(ctx, authority);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'projects',
          values: { project_id: 'p1', title: 'P1' },
        },
        { op: 'upsert', table: 'nodes', values: node('n1', null, 'p1') },
        { op: 'upsert', table: 'nodes', values: node('n2', 'n1') },
      ]);
      await syncIdle(a);

      checkEqual(await a.api.pendingCommitIds(), [], 'the outbox drains');
      check(
        (await a.api.readRows('nodes')).every((row) => row.version === 1),
        'delivered rows carry authority versions',
      );
      await expectLocalConverged(authority, a, 'nodes');

      // CASCADE removes n1; SET NULL then clears n2's parent (§6.11).
      await a.api.mutate([{ op: 'delete', table: 'projects', rowId: 'p1' }]);
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('nodes')).map((row) => row.values),
        [node('n2', null)],
        'the authority cascades and nullifies locally',
      );
      await expectLocalConverged(authority, a, 'nodes');
      await expectLocalConverged(authority, a, 'projects');
    },
  },

  {
    name: 'local-authority/schema-bump-keeps-rows',
    specRefs: ['§12.2', '§7.4', 'B.24'],
    requires: ['local-authority'],
    async run(ctx) {
      const authority = await ctx.newLocalAuthority(LOCAL_SCHEMA);
      const a = await localClient(ctx, authority);
      await a.api.mutate([
        { op: 'upsert', table: 'nodes', values: node('n1', null) },
        { op: 'upsert', table: 'nodes', values: node('n2', 'n1') },
      ]);
      await syncIdle(a);
      // A queued update replays after the bump. (A queued insert re-encodes
      // without the appended column and §6.2 refuses it as a partial insert;
      // RFC-LOCAL-AUTHORITY §7 records that gap.)
      const pending = await a.api.mutate([
        { op: 'upsert', table: 'nodes', values: node('n2', null) },
      ]);

      await authority.restart(LOCAL_SCHEMA_V2);
      await ctx.recreateClient(a, LOCAL_SCHEMA_V2);
      checkEqual(
        await a.api.pendingCommitIds(),
        [pending],
        'the pending commit survives the reset',
      );
      await syncIdle(a);
      checkEqual(await a.api.rejections(), [], 'the queued update applies');

      checkEqual(
        (await a.api.readRows('nodes')).map((row) => row.values),
        [
          { ...node('n1', null), note: null },
          { ...node('n2', null), note: null },
        ],
        'every row survives the bump with the appended column NULL',
      );
      await expectLocalConverged(authority, a, 'nodes');
    },
  },

  {
    name: 'local-authority/attach-converges-with-the-remote',
    specRefs: ['§12.3', '§12.4', '§2.1', 'B.24'],
    requires: ['local-authority'],
    server: { schema: LOCAL_SCHEMA },
    async run(ctx) {
      const authority = await ctx.newLocalAuthority(LOCAL_SCHEMA);
      const a = await localClient(ctx, authority);
      // A chain whose children sort before their parents, and a two-row
      // reference cycle that only one commit can carry.
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'projects',
          values: { project_id: 'p1', title: 'P1' },
        },
        { op: 'upsert', table: 'nodes', values: node('k3', null, 'p1') },
        { op: 'upsert', table: 'nodes', values: node('k2', 'k3') },
        { op: 'upsert', table: 'nodes', values: node('k1', 'k2') },
        { op: 'upsert', table: 'nodes', values: node('x', null) },
        { op: 'upsert', table: 'nodes', values: node('y', 'x') },
      ]);
      await syncIdle(a);
      await a.api.mutate([
        { op: 'upsert', table: 'nodes', values: node('x', 'y') },
      ]);
      await syncIdle(a);
      await ctx.server.setAllowedScopes('owner', P1);

      const lost = await authority.attach(ctx.server, 'owner', {
        loseResponseOfCommit: 0,
      });
      checkEqual(
        lost,
        { ok: false, code: 'sync.transport_failed' },
        'a lost response stops attach',
      );
      checkEqual(
        await authority.state(),
        'attaching',
        'attach stays resumable',
      );
      await syncFails(
        a,
        'sync.authority_unavailable',
        'the attaching authority',
      );
      const late = await a.api.mutate([
        { op: 'upsert', table: 'nodes', values: node('late', 'k1') },
      ]);

      await authority.restart(LOCAL_SCHEMA);
      checkEqual(
        await authority.attach(ctx.server, 'owner'),
        { ok: true },
        'the restarted attach resumes and completes',
      );
      checkEqual(await authority.state(), 'attached', 'the authority retires');

      a.route.server = ctx.server;
      await syncIdle(a);
      checkEqual(await a.api.pendingCommitIds(), [], 'the queued write drains');
      check(
        (await a.api.commitOutcomes()).some(
          (outcome) =>
            outcome.clientCommitId === late && outcome.status === 'applied',
        ),
        'the write queued during attach applies on the remote',
      );
      await expectConverged(ctx, 'projects', [a]);
      await expectConverged(ctx, 'nodes', [a]);
      checkEqual(
        (await ctx.server.readRows('nodes')).map((row) => [
          row.rowId,
          row.version,
          row.values.parent_id,
        ]),
        [
          ['k1', 1, 'k2'],
          ['k2', 1, 'k3'],
          ['k3', 1, null],
          ['late', 1, 'k1'],
          ['x', 1, 'y'],
          ['y', 1, 'x'],
        ],
        'the remote holds one insert per live row',
      );
    },
  },

  {
    name: 'local-authority/rejected-attach-abandons-and-reattaches',
    specRefs: ['§12.3', '§2.3', 'B.24'],
    requires: ['local-authority'],
    server: { schema: LOCAL_SCHEMA },
    async run(ctx) {
      const authority = await ctx.newLocalAuthority(LOCAL_SCHEMA);
      const a = await localClient(ctx, authority, LOCAL_SCHEMA, {
        project_id: ['p1', 'p2'],
      });
      await a.api.mutate([
        { op: 'upsert', table: 'nodes', values: node('n1', null) },
        { op: 'upsert', table: 'nodes', values: node('n2', null, null, 'p2') },
      ]);
      await syncIdle(a);
      await ctx.server.setAllowedScopes('owner', P1);

      const rejected = await authority.attach(ctx.server, 'owner');
      check(!rejected.ok, 'the remote refuses the p2 row');
      if (!rejected.ok) {
        checkEqual(rejected.code, 'sync.attach_rejected', 'the attach code');
        checkEqual(
          [
            rejected.details?.reason,
            rejected.details?.opIndex,
            rejected.details?.code,
          ],
          ['commit_rejected', 1, 'sync.forbidden'],
          'the details name the refused operation',
        );
      }
      checkEqual(
        (await ctx.server.readRows('nodes')).length,
        0,
        'the rejected commit applied nothing',
      );

      await authority.abandonAttach();
      checkEqual(await authority.state(), 'local', 'abandon serves the client');
      await a.api.mutate([{ op: 'delete', table: 'nodes', rowId: 'n2' }]);
      await syncIdle(a);

      checkEqual(
        await authority.attach(ctx.server, 'owner'),
        { ok: true },
        'a new attach completes',
      );
      a.route.server = ctx.server;
      await syncIdle(a);
      await expectConverged(ctx, 'nodes', [a]);
    },
  },
];
