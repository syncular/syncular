/**
 * Local authority (SPEC.md §12, Appendix B.24): a client syncs against a
 * server in its own process, survives a schema bump without a remote server,
 * and moves its data to a remote server with attach (§12.3) followed by the
 * ordinary log-epoch reset (§2.1, §12.4).
 */
import { YjsColumn } from '@syncular/crdt-yjs';
import { check, checkEqual } from '../checks';
import type {
  DriverRow,
  DriverSchema,
  DriverTable,
  LocalAuthorityInstance,
} from '../driver';
import type { ClientHandle, Scenario, ScenarioContext } from '../scenario';
import {
  CRDT_SCHEMA,
  CRDT_SERVER,
  docBytesOf,
  noteRow,
  readText,
  textUpdate,
  valueBytes,
} from './crdt';
import { E2EE_SCHEMA, goodKeys, utf8Hex } from './encryption';
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
      // A queued update and a queued insert both replay after the bump; the
      // insert carries §7.1 insert intent, so the appended column is NULL.
      const pending = await a.api.mutate([
        { op: 'upsert', table: 'nodes', values: node('n2', null) },
        { op: 'upsert', table: 'nodes', values: node('n3', 'n2') },
      ]);

      await authority.restart(LOCAL_SCHEMA_V2);
      await ctx.recreateClient(a, LOCAL_SCHEMA_V2);
      checkEqual(
        await a.api.pendingCommitIds(),
        [pending],
        'the pending commit survives the reset',
      );
      await syncIdle(a);
      checkEqual(await a.api.rejections(), [], 'the queued writes apply');

      checkEqual(
        (await a.api.readRows('nodes')).map((row) => row.values),
        [
          { ...node('n1', null), note: null },
          { ...node('n2', null), note: null },
          { ...node('n3', 'n2'), note: null },
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
    name: 'local-authority/rejected-attach-rolls-back-and-reattaches',
    specRefs: ['§12.3', '§2.3', 'B.24'],
    requires: ['local-authority'],
    server: { schema: LOCAL_SCHEMA },
    async run(ctx) {
      const authority = await ctx.newLocalAuthority(LOCAL_SCHEMA);
      const a = await localClient(ctx, authority, LOCAL_SCHEMA, {
        project_id: ['p1', 'p2'],
      });
      // 500 rows fill the first upload commit; the p2 row lands in the second.
      await a.api.mutate(
        Array.from({ length: 500 }, (_, i) => ({
          op: 'upsert' as const,
          table: 'nodes',
          values: node(`n${String(i).padStart(3, '0')}`, null),
        })),
      );
      await a.api.mutate([
        { op: 'upsert', table: 'nodes', values: node('z', null, null, 'p2') },
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
          ['commit_rejected', 0, 'sync.forbidden'],
          'the details name the refused operation',
        );
      }
      checkEqual(
        (await ctx.server.readRows('nodes')).length,
        500,
        'the first commit applied before the rejection',
      );
      checkEqual(
        await authority.attach(ctx.server, 'owner'),
        rejected,
        'resuming replays the stored rejection (§2.3)',
      );

      checkEqual(
        await authority.abandonAttach(ctx.server, 'owner'),
        { ok: true },
        'abandon rolls back the applied commit',
      );
      checkEqual(await authority.state(), 'local', 'abandon serves the client');
      checkEqual(
        await ctx.server.readRows('nodes'),
        [],
        'the remote holds none of the abandoned rows',
      );
      await a.api.mutate([{ op: 'delete', table: 'nodes', rowId: 'z' }]);
      await syncIdle(a);

      checkEqual(
        await authority.attach(ctx.server, 'owner'),
        { ok: true },
        'a new attach recreates the rows over their tombstones',
      );
      a.route.server = ctx.server;
      await syncIdle(a);
      await expectConverged(ctx, 'nodes', [a]);
      checkEqual(
        (await ctx.server.readRows('nodes')).length,
        500,
        'the remote holds the 500 rows once',
      );
    },
  },

  {
    // §12.3: the authority stores the client's §5.11 ciphertext and uploads
    // it as stored; neither the authority nor the remote holds a key.
    name: 'local-authority/attach-carries-ciphertext',
    specRefs: ['§12.3', '§5.11', 'B.24'],
    requires: ['local-authority'],
    server: { schema: E2EE_SCHEMA },
    async run(ctx) {
      const authority = await ctx.newLocalAuthority(E2EE_SCHEMA);
      const a = await ctx.newClient({
        actorId: 'owner',
        clientId: 'device',
        server: authority,
        schema: E2EE_SCHEMA,
        encryption: goodKeys,
      });
      await a.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'secrets',
          values: {
            id: 'r1',
            project_id: 'p1',
            note: 'top secret',
            amount: 42,
          },
        },
        {
          op: 'upsert',
          table: 'secrets',
          values: { id: 'r2', project_id: 'p1', note: 'second', amount: null },
        },
      ]);
      await syncIdle(a);
      const local = (await authority.readRows('secrets')).map((row) => [
        row.rowId,
        row.values,
      ]);

      await ctx.server.setAllowedScopes('owner', P1);
      checkEqual(
        await authority.attach(ctx.server, 'owner'),
        { ok: true },
        'attach uploads the encrypted rows',
      );
      const remote = await ctx.server.readRows('secrets');
      checkEqual(
        remote.map((row) => [row.rowId, row.values]),
        local,
        'the remote stores the authority ciphertext byte for byte',
      );
      for (const [row, plaintext] of [
        [remote[0], 'top secret'],
        [remote[1], 'second'],
      ] as const) {
        const note = row?.values.note;
        check(
          typeof note === 'object' &&
            note !== null &&
            note.$bytes.startsWith('01') &&
            !note.$bytes.includes(utf8Hex(plaintext)),
          'the remote note is a §5.11 envelope without the plaintext',
        );
      }

      a.route.server = ctx.server;
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('secrets')).map((row) => row.values),
        [
          { id: 'r1', project_id: 'p1', note: 'top secret', amount: 42 },
          { id: 'r2', project_id: 'p1', note: 'second', amount: null },
        ],
        'the rebound client decrypts the remote rows',
      );

      const b = await ctx.newClient({
        actorId: 'b',
        clientId: 'client-b',
        schema: E2EE_SCHEMA,
        allowed: P1,
        encryption: goodKeys,
      });
      await b.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      await syncIdle(b);
      checkEqual(
        (await b.api.readRows('secrets')).map((row) => row.values),
        (await a.api.readRows('secrets')).map((row) => row.values),
        'a client holding the key bootstraps the plaintext from the remote',
      );

      const locked = await ctx.newClient({
        actorId: 'locked',
        clientId: 'client-locked',
        schema: E2EE_SCHEMA,
        allowed: P1,
        encryption: { keys: {} },
      });
      await locked.api.subscribe({ id: 's', table: 'secrets', scopes: P1 });
      await syncFails(
        locked,
        'client.decrypt_failed',
        'a client without the key',
      );
      checkEqual(
        await locked.api.readRows('secrets'),
        [],
        'the undecryptable rows are not applied',
      );
    },
  },

  {
    // §12.3: attach uploads a `crdt` column as its stored state, which
    // `merge(null, state)` stores unchanged on the remote (§5.10.2).
    name: 'local-authority/attach-carries-crdt-state',
    specRefs: ['§12.3', '§5.10.2', '§5.10.3', 'B.24'],
    requires: ['local-authority', 'crdt'],
    server: CRDT_SERVER,
    async run(ctx) {
      const authority = await ctx.newLocalAuthority(CRDT_SCHEMA);
      const a = await ctx.newClient({
        actorId: 'owner',
        clientId: 'device',
        server: authority,
        schema: CRDT_SCHEMA,
      });
      await a.api.subscribe({ id: 's', table: 'notes', scopes: P1 });
      await syncIdle(a);
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', textUpdate('hello')),
        },
      ]);
      await syncIdle(a);
      const localEdit = new YjsColumn(await docBytesOf(a, 'n1'));
      localEdit.text().insert(localEdit.text().length, ' local');
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', localEdit.columnBytes()),
        },
      ]);
      localEdit.destroy();
      await syncIdle(a);
      const local = (await authority.readRows('notes'))[0]?.values.doc;
      checkEqual(
        readText(valueBytes(local)),
        'hello local',
        'the authority merged both local edits',
      );

      await ctx.server.setAllowedScopes('owner', P1);
      checkEqual(
        await authority.attach(ctx.server, 'owner'),
        { ok: true },
        'attach uploads the crdt row',
      );
      checkEqual(
        (await ctx.server.readRows('notes'))[0]?.values.doc,
        local,
        'the remote stores the authority state unchanged',
      );

      a.route.server = ctx.server;
      await syncIdle(a);
      const b = await ctx.newClient({
        actorId: 'b',
        clientId: 'client-b',
        schema: CRDT_SCHEMA,
        allowed: P1,
      });
      await b.api.subscribe({ id: 's', table: 'notes', scopes: P1 });
      await syncIdle(b);

      // Concurrent baseVersion-less edits on top of the attached state.
      const aDoc = new YjsColumn(await docBytesOf(a, 'n1'));
      aDoc.text().insert(aDoc.text().length, ' A');
      const bDoc = new YjsColumn(await docBytesOf(b, 'n1'));
      bDoc.text().insert(0, 'B ');
      await a.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', aDoc.columnBytes()),
        },
      ]);
      await b.api.mutate([
        {
          op: 'upsert',
          table: 'notes',
          values: noteRow('n1', 't', bDoc.columnBytes()),
        },
      ]);
      aDoc.destroy();
      bDoc.destroy();
      for (let i = 0; i < 2; i++) {
        await syncIdle(a);
        await syncIdle(b);
      }

      checkEqual(
        await a.api.conflicts(),
        [],
        'the rebound client saw no conflict',
      );
      checkEqual(
        await b.api.conflicts(),
        [],
        'the remote client saw no conflict',
      );
      await expectConverged(ctx, 'notes', [a, b]);
      checkEqual(
        readText(await docBytesOf(a, 'n1')),
        'B hello local A',
        'the remote merges both edits into the attached state',
      );
    },
  },
];
