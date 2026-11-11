/**
 * Units, the replica cursor and registration by reference (SPEC.md §4.1,
 * §4.4, §4.5; Appendix B.25, B.26), plus the version-guarded apply (§4.5),
 * duplicate deltas (§8.2), row ownership under a deferred eviction (§3.3),
 * a schema floor on a delta (§1.6) and a pre-upgrade server database (§9).
 */
import {
  decodeMessage,
  encodeMessage,
  type RequestFrame,
  type ResponseMessage,
  registrationDigest,
  unitId,
} from '@syncular/core';
import { check, checkEqual } from '../checks';
import type { DriverSchema, DriverUnitScopes } from '../driver';
import { doc, task } from '../fixture';
import {
  decodeResponse,
  rawDelete,
  rawPull,
  rawPushCommit,
  rawUpsert,
  responseLive,
  responsePushResults,
  responseSection,
} from '../raw';
import type { ClientHandle, Scenario, ScenarioContext } from '../scenario';
import {
  captureResponses,
  expectConverged,
  seedRows,
  seedTasks,
  syncIdle,
  syncOk,
} from './util';

const U1 = { project_id: 'p1' } as const;
const U2 = { project_id: 'p2' } as const;
const BOTH = { project_id: ['p1', 'p2'] } as const;

/** Three tables declaring one variable: one unit covers all of them. */
const COVERED_SCHEMA: DriverSchema = {
  version: 1,
  tables: ['labels', 'notes', 'tasks'].map((name) => ({
    name,
    columns: [
      { name: 'id', type: 'string', nullable: false },
      { name: 'project_id', type: 'string', nullable: false },
      { name: 'title', type: 'string', nullable: false },
    ],
    primaryKey: 'id',
    scopes: [{ pattern: 'project:{project_id}' }],
  })),
};

/** `docs` declares a second variable the wildcard fence adds; `notes` does
 * not, so a fence revocation leaves the unit active (§3.2 rule 5). */
const FENCE_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'docs',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'org_id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [
        { pattern: 'org:{org_id}' },
        { pattern: 'project:{projectId}', column: 'project_id' },
      ],
    },
    {
      name: 'notes',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{projectId}', column: 'project_id' }],
    },
  ],
};

/** The frames of every request `handle` sent from index `from` on. */
function requestsSince(handle: ClientHandle, from: number): RequestFrame[][] {
  return handle.sentRequests.slice(from).map((bytes) => {
    const message = decodeMessage(bytes);
    if (message.msgKind !== 'request') throw new Error('expected a request');
    return message.frames;
  });
}

/**
 * Unit B lags behind the replica cursor while unit A stays live through
 * realtime deltas: `writes` to row x land as deltas on A, then B's
 * post-bootstrap scan, cut to one change per round, re-delivers them one by
 * one (§4.5). `newest` holds after every round of the lagging scan.
 */
async function lagBehindDeltas(
  ctx: ScenarioContext,
  writes: readonly (
    | { readonly op: 'insert' | 'update'; readonly body: string }
    | { readonly op: 'delete' }
  )[],
  newest: unknown,
): Promise<void> {
  const a = await ctx.newClient({
    actorId: 'actor-a',
    clientId: 'client-a',
    allowed: { org_id: ['o1', 'o9'], projectId: ['p1'] },
    limits: {
      accept: 0b0011,
      limitCommits: 1,
      limitSnapshotRows: 1,
      maxSnapshotPages: 1,
    },
  });
  const lagging = { projectId: 'p1' };
  await a.api.subscribe({ org_id: 'o1' });
  await syncIdle(a);
  await a.api.connectRealtime();
  await syncIdle(a);
  await seedRows(ctx, 'docs', [doc('b1', 'o9', 'p1'), doc('b2', 'o9', 'p1')]);
  await a.api.subscribe(lagging);
  await syncOk(a); // the lagging unit's first page; its pin is this round's
  // A change only the lagging unit matches holds its scan below the writes.
  await seedRows(ctx, 'docs', [doc('y1', 'o9', 'p1')]);
  await ctx.server.setAllowedScopes('writer', {
    org_id: ['o1'],
    projectId: ['p1'],
  });
  for (const [index, write] of writes.entries()) {
    const pushed = await ctx.rawSync(
      'writer',
      [
        rawPushCommit(`write-x-${index}`, [
          write.op === 'delete'
            ? rawDelete('docs', 'x')
            : rawUpsert(
                ctx.serverSchema,
                'docs',
                doc('x', 'o1', 'p1', write.body),
                write.op === 'insert' ? 0 : undefined,
              ),
        ]),
      ],
      { clientId: 'writer' },
    );
    check(
      pushed.ok && responsePushResults(pushed.message)[0]?.status === 'applied',
      `write ${index} of x applies`,
    );
    await a.realtime.waitForAck(await ctx.server.getMaxCommitSeq());
  }
  const x = async () => {
    const row = (await a.api.readRows('docs')).find((r) => r.rowId === 'x');
    return row && { version: row.version, body: row.values.body };
  };
  checkEqual(await x(), newest, 'the deltas delivered the newest state of x');
  const newestVersion = (await ctx.server.readRows('docs')).find(
    (row) => row.rowId === 'x',
  )?.version;
  const responses = captureResponses(ctx, a);
  for (let round = 1; ; round += 1) {
    check(round <= 12, 'the lagging unit joins within 12 rounds');
    await syncOk(a);
    checkEqual(
      await x(),
      newest,
      `round ${round} of the lagging scan keeps the newest state of x`,
    );
    if ((await a.api.unitState(unitId(lagging)))?.cursor === undefined) break;
  }
  check(
    responses().some((response) =>
      responseLive(response).commits.some((commit) =>
        commit.changes.some(
          (change) =>
            change.rowId === 'x' && change.rowVersion < (newestVersion ?? 0),
        ),
      ),
    ),
    'the lagging scan re-delivered an older change of x',
  );
  await expectConverged(ctx, 'docs', [a]);
}

export const unitScenarios: readonly Scenario[] = [
  {
    name: 'units/one-commit-frame-across-covered-tables',
    specRefs: ['§4.1', '§4.5', '§8.2', 'B.25'],
    requires: ['realtime'],
    server: { schema: COVERED_SCHEMA },
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: COVERED_SCHEMA,
        allowed: { project_id: ['p1'] },
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      await ctx.server.setAllowedScopes('writer', { project_id: ['p1'] });
      const write = async (n: number) => {
        const pushed = await ctx.rawSync(
          'writer',
          [
            rawPushCommit(
              `three-tables-${n}`,
              COVERED_SCHEMA.tables.map((table) =>
                rawUpsert(ctx.serverSchema, table.name, {
                  id: `${table.name}-${n}`,
                  project_id: 'p1',
                  title: `write ${n}`,
                }),
              ),
            ),
          ],
          { clientId: 'writer' },
        );
        check(pushed.ok, 'the three-table commit applies');
      };
      const tableSets = (message: ResponseMessage | undefined) =>
        (message?.frames ?? []).flatMap((frame) =>
          frame.type === 'COMMIT' ? [[...frame.tables].sort()] : [],
        );

      const responses = captureResponses(ctx, a);
      await write(1);
      await syncOk(a);
      checkEqual(
        tableSets(responses().at(-1)),
        [['labels', 'notes', 'tasks']],
        'a pull carries the commit as one COMMIT frame naming the three tables',
      );

      const deltas: ResponseMessage[] = [];
      const original = ctx.server.connectRealtime.bind(ctx.server);
      ctx.server.connectRealtime = async (actorId, clientId, sink) =>
        original(actorId, clientId, {
          ...sink,
          onBinary(bytes) {
            if (bytes[0] === 0) deltas.push(decodeResponse(bytes.subarray(1)));
            return sink.onBinary(bytes);
          },
        });
      await a.api.connectRealtime();
      await syncIdle(a);
      await write(2);
      await a.realtime.waitForAck(await ctx.server.getMaxCommitSeq());
      checkEqual(
        deltas.map(tableSets),
        [[['labels', 'notes', 'tasks']]],
        'a delta carries the commit as one COMMIT frame naming the three tables',
      );
      for (const table of COVERED_SCHEMA.tables)
        await expectConverged(ctx, table.name, [a]);
    },
  },

  {
    name: 'units/registration-while-live-joins-without-loss',
    specRefs: ['§4.5', '§4.7', 'B.25'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: BOTH,
        // Rows segments page; a sqlite image would carry the table at once.
        limits: { accept: 0b0011, limitSnapshotRows: 1, maxSnapshotPages: 1 },
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      await seedTasks(ctx, [
        task('b1', 'p2'),
        task('b2', 'p2'),
        task('b3', 'p2'),
      ]);
      const responses = captureResponses(ctx, a);
      await a.api.subscribe(U2);
      await syncOk(a);
      const pin = responseSection(responses()[0]!, U2).end.nextCursor;
      // Changes for both units land while the second one bootstraps.
      await seedTasks(ctx, [task('a-new', 'p1')]);
      await seedTasks(ctx, [task('b-new', 'p2')]);
      await syncOk(a);
      check(
        (await a.api.replicaCursor()) > pin,
        'the live unit moved the replica cursor past the pin',
      );
      check(
        (await a.api.unitState(unitId(U2)))?.hasResumeToken === true,
        'the second unit still bootstraps',
      );
      await syncOk(a);
      const last = responseSection(responses().at(-1)!, U2).end;
      checkEqual(
        [last.bootstrapState, last.nextCursor],
        [undefined, pin],
        'the bootstrap completes with its pin below the replica cursor',
      );
      checkEqual(
        (await a.api.unitState(unitId(U2)))?.cursor,
        undefined,
        'the unit joins in the response that completes its bootstrap',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['a-new', 'b-new', 'b1', 'b2', 'b3'],
        'no change was lost across the join',
      );
      await expectConverged(ctx, 'tasks', [a]);
    },
  },

  {
    name: 'units/cut-section-keeps-a-completed-unit-catching-up',
    specRefs: ['§4.2', '§4.5', 'B.25'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: BOTH,
        limits: {
          accept: 0b0011,
          limitCommits: 1,
          limitSnapshotRows: 1,
          maxSnapshotPages: 1,
        },
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      await seedTasks(ctx, [
        task('b1', 'p2'),
        task('b2', 'p2'),
        task('b3', 'p2'),
      ]);
      await a.api.subscribe(U2);
      await syncOk(a);
      const pin = await ctx.server.getMaxCommitSeq();
      await seedTasks(ctx, [task('x1', 'p2')]);
      await seedTasks(ctx, [task('x2', 'p2')]);
      // The live unit matches neither change: its section is not cut.
      await syncOk(a);
      checkEqual(
        await a.api.replicaCursor(),
        pin + 2,
        'the replica cursor passed both changes',
      );
      // The last page completes the unit; its scan from the pin is cut after x1.
      for (let pages = 0; pages < 4; pages += 1) {
        await syncOk(a);
        if (!(await a.api.unitState(unitId(U2)))?.hasResumeToken) break;
      }
      const state = await a.api.unitState(unitId(U2));
      checkEqual(
        [state?.cursor, state?.hasResumeToken],
        [pin + 1, false],
        'a completed unit cut below the replica cursor stays catching up at T (§4.5 J)',
      );
      checkEqual(
        await a.api.replicaCursor(),
        pin + 2,
        'the replica cursor holds',
      );
      await syncOk(a);
      checkEqual(
        (await a.api.unitState(unitId(U2)))?.cursor,
        undefined,
        'the unit joins in the next round',
      );
      await expectConverged(ctx, 'tasks', [a]);
    },
  },

  {
    name: 'units/eviction-keeps-a-row-another-unit-holds',
    specRefs: ['§3.3', '§4.8', 'B.25'],
    async run(ctx) {
      await seedRows(ctx, 'docs', [
        doc('shared', 'o1', 'p1'),
        doc('lone', 'o2', 'p1'),
      ]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { org_id: ['o1', 'o2'], projectId: ['p1'] },
      });
      const base = { variable: 'projectId' };
      await a.api.subscribe({ org_id: 'o1' });
      await a.api.setWindow?.(base, ['p1']);
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.rowId),
        ['lone', 'shared'],
        'both units delivered their rows',
      );
      await a.api.setWindow?.(base, []);
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.rowId),
        ['shared'],
        'the eviction keeps the row the org unit holds',
      );
      await seedRows(ctx, 'docs', [doc('shared', 'o1', 'p1', 'edited')]);
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs'))[0]?.values.body,
        'edited',
        'the surviving unit receives the next change of the shared row',
      );
    },
  },

  {
    name: 'units/unregistered-in-flight-never-recreates-rows',
    specRefs: ['§4.4', '§4.5', 'B.25'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: BOTH,
      });
      if (a.api.prepareRound === undefined || a.api.completeRound === undefined)
        throw new Error('the reference clients expose the round barrier');
      await seedTasks(ctx, [task('b1', 'p2')]);
      const [, released] = await a.api.subscribeMany([U1, U2]);
      await syncIdle(a);
      await seedTasks(ctx, [task('a-new', 'p1'), task('b-new', 'p2')]);
      // The request names the p2 unit; the app releases it while the round
      // is in flight. Unsubscribing keeps the unit's rows (§4.1).
      await a.api.prepareRound();
      await a.api.unsubscribe(released!);
      const result = await a.api.completeRound();
      check(result.ok, 'the captured round completes');
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['a-new', 'b1'],
        'the change of the released unit never created its row',
      );
      checkEqual(
        await a.api.unitState(released!),
        undefined,
        'the section did not re-register the released unit',
      );
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        ['a-new', 'b1'],
        'later rounds do not create it either',
      );
    },
  },

  {
    name: 'units/progress-and-list-validation',
    specRefs: ['§1.7', '§4.1', '§4.3', 'B.25'],
    requires: ['server-limits'],
    server: { limits: { maxSubscriptionsPerRequest: 2 } },
    async run(ctx) {
      await ctx.server.setAllowedScopes('raw-actor', { project_id: ['*'] });
      const refused = async (
        what: string,
        code: string,
        frames: readonly RequestFrame[],
      ) => {
        const result = await ctx.rawSync('raw-actor', frames);
        check(!result.ok, `${what}: expected a request-level error`);
        if (!result.ok) checkEqual(result.error.code, code, what);
        return result.ok ? undefined : result.error;
      };
      await refused(
        'a PROGRESS id naming no registered unit',
        'sync.invalid_subscription',
        [
          ...rawPull([{ scopes: U1 }]),
          { type: 'PROGRESS', id: unitId(U2), cursor: -1 },
        ],
      );
      await refused(
        'a PROGRESS id that appears twice',
        'sync.invalid_subscription',
        [
          ...rawPull([{ scopes: U1, cursor: -1 }]),
          { type: 'PROGRESS', id: unitId(U1), cursor: -1 },
        ],
      );
      await refused(
        'a list that repeats a scope map',
        'sync.invalid_subscription',
        rawPull([{ scopes: U1 }, { scopes: U1 }]),
      );
      const capped = await refused(
        'three units past a cap of two',
        'sync.limit_exceeded',
        rawPull([
          { scopes: U1 },
          { scopes: U2 },
          { scopes: { project_id: 'p3' } },
        ]),
      );
      checkEqual(
        capped?.details,
        { limit: 'maxSubscriptionsPerRequest', max: 2, actual: 3 },
        'details name the UNIT cap and its value (§1.7)',
      );
      const atCap = await ctx.rawSync(
        'raw-actor',
        rawPull([
          { scopes: U1, cursor: -1 },
          { scopes: U2, cursor: -1 },
        ]),
      );
      check(
        atCap.ok,
        'two units with two PROGRESS frames are within the cap: it counts UNIT frames',
      );
    },
  },

  {
    name: 'registration/quiet-replica-pulls-by-reference',
    specRefs: ['§4.1', '§4.4', '§4.5', 'B.26'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      const sent = a.sentRequests.length;
      const responses = captureResponses(ctx, a);
      await syncOk(a);
      const [request] = requestsSince(a, sent);
      checkEqual(
        request?.filter((frame) => frame.type === 'UNIT').length,
        0,
        'the quiet pull refers to its list by digest',
      );
      const header = request?.find((frame) => frame.type === 'PULL_HEADER');
      checkEqual(
        header?.type === 'PULL_HEADER'
          ? [...header.registrationDigest]
          : undefined,
        [...registrationDigest([U1])],
        'the digest names the one-unit list',
      );
      checkEqual(
        responses()[0]?.frames.map((frame) => frame.type),
        ['RESP_HEADER', 'LIVE_START', 'LIVE_END'],
        'the response carries only the live section frames',
      );
    },
  },

  {
    name: 'registration/unregistered-answer-resends-the-list',
    specRefs: ['§4.1', '§4.4', 'B.26'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      // A second copy of the replica registers a different list under the
      // same clientId.
      const copy = await ctx.rawSync(a.actorId, rawPull([]), {
        clientId: a.clientId,
      });
      check(copy.ok, 'the copy registers the empty list');
      await seedTasks(ctx, [task('t1', 'p1', 'after the copy')]);
      const sent = a.sentRequests.length;
      const responses = captureResponses(ctx, a);
      await syncOk(a);
      checkEqual(
        responseLive(responses()[0]!).start.status,
        'unregistered',
        'a digest the server does not store answers unregistered',
      );
      checkEqual(
        responses()[0]?.frames.filter(
          (frame) => frame.type === 'COMMIT' || frame.type === 'SUB_START',
        ).length,
        0,
        'an unregistered answer carries no unit section and no commit',
      );
      await syncIdle(a);
      checkEqual(
        requestsSince(a, sent)[1]?.filter((frame) => frame.type === 'UNIT')
          .length,
        1,
        'the next round sends the list',
      );
      await expectConverged(ctx, 'tasks', [a]);
    },
  },

  {
    name: 'registration/traveling-digest-mismatch-fails',
    specRefs: ['§4.1', 'B.26'],
    async run(ctx) {
      await ctx.server.setAllowedScopes('raw-actor', { project_id: ['*'] });
      const result = await ctx.rawSync(
        'raw-actor',
        rawPull([{ scopes: U1, cursor: -1 }], {
          registrationDigest: registrationDigest([U2]),
        }),
      );
      check(!result.ok, 'a traveling list whose digest differs is refused');
      if (result.ok) return;
      checkEqual(result.error.code, 'sync.invalid_subscription', 'the code');
      const details = result.error.details;
      check(
        typeof details === 'object' &&
          details !== null &&
          'reason' in details &&
          details.reason === 'registration_digest',
        'details.reason names the registration digest',
      );
    },
  },

  {
    name: 'registration/fence-changes-reach-the-client-through-the-echo-digest',
    specRefs: ['§3.2', '§3.3', '§4.4', 'B.26'],
    server: { schema: FENCE_SCHEMA },
    requires: ['scope-authorization'],
    async run(ctx) {
      await ctx.server.setAllowedScopes('seed', {
        org_id: ['*'],
        projectId: ['*'],
      });
      const seeded = await ctx.rawSync(
        'seed',
        [
          rawPushCommit('seed-fence', [
            rawUpsert(FENCE_SCHEMA, 'docs', doc('d1', 'o1', 'p1')),
            rawUpsert(FENCE_SCHEMA, 'docs', doc('d3', 'o3', 'p1')),
            rawUpsert(FENCE_SCHEMA, 'notes', {
              id: 'n1',
              project_id: 'p1',
              body: 'note',
            }),
          ]),
        ],
        { clientId: 'seed' },
      );
      check(seeded.ok, 'the rows are seeded');
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        schema: FENCE_SCHEMA,
        allowed: { org_id: ['o1'], projectId: ['*'] },
      });
      const unit: DriverUnitScopes = { projectId: 'p1' };
      const id = await a.api.subscribe(unit);
      await syncIdle(a);
      const echo = async () => (await a.api.unitState(id))?.echo;
      checkEqual(
        await echo(),
        [{ table: 'docs', status: 'active', scopes: { org_id: ['o1'] } }],
        'the fence adds org_id to docs only',
      );

      await ctx.server.setAllowedScopes('actor-a', {
        org_id: ['o1', 'o3'],
        projectId: ['*'],
      });
      const sent = a.sentRequests.length;
      const responses = captureResponses(ctx, a);
      await syncOk(a);
      checkEqual(
        requestsSince(a, sent)[0]?.filter((frame) => frame.type === 'UNIT')
          .length,
        0,
        'the list did not travel',
      );
      check(
        responses()[0]?.frames.some(
          (frame) => frame.type === 'SUB_START' && frame.id === id,
        ) === true,
        'a changed echo digest brings the unit section (§4.4 rule 1)',
      );
      checkEqual(
        await echo(),
        [{ table: 'docs', status: 'active', scopes: { org_id: ['o1', 'o3'] } }],
        'the client persisted the widened fence',
      );

      await ctx.server.setAllowedScopes('actor-a', {
        org_id: [],
        projectId: ['*'],
      });
      await syncIdle(a);
      checkEqual(
        await echo(),
        [{ table: 'docs', status: 'revoked', scopes: {} }],
        'an empty fence list revokes the docs pair inside an active unit',
      );
      checkEqual(
        await a.api.readRows('docs'),
        [],
        'the revoked pair is purged',
      );
      checkEqual(
        (await a.api.readRows('notes')).map((row) => row.rowId),
        ['n1'],
        'the active notes pair keeps its rows',
      );

      await ctx.server.setAllowedScopes('actor-a', {
        org_id: ['o1'],
        projectId: ['*'],
      });
      await syncOk(a);
      checkEqual(
        (await a.api.unitState(id))?.cursor,
        -1,
        'the regrant moves the unit back to bootstrapping (§3.3)',
      );
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.rowId),
        ['d1'],
        'the re-bootstrap restores the regranted rows',
      );
    },
  },

  {
    name: 'registration/empty-list-travels-by-digest-alone',
    specRefs: ['§4.1', 'B.26'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      const responses = captureResponses(ctx, a);
      await syncOk(a);
      const statuses = () =>
        responses().flatMap((response) =>
          response.frames.flatMap((frame) =>
            frame.type === 'LIVE_START' ? [frame.status] : [],
          ),
        );
      checkEqual(
        statuses(),
        ['active'],
        'a replica without units is never unregistered',
      );
      const id = await a.api.subscribe(U1);
      await syncIdle(a);
      await a.api.unsubscribe(id);
      const sent = a.sentRequests.length;
      await syncOk(a);
      const [request] = requestsSince(a, sent);
      const header = request?.find((frame) => frame.type === 'PULL_HEADER');
      checkEqual(
        [
          request?.filter((frame) => frame.type === 'UNIT').length,
          header?.type === 'PULL_HEADER'
            ? [...header.registrationDigest]
            : undefined,
        ],
        [0, [...registrationDigest([])]],
        'releasing the last unit sends the empty digest and no UNIT frame',
      );
      checkEqual(
        (await ctx.server.listClients()).find(
          (client) => client.clientId === a.clientId,
        )?.units,
        [],
        'the empty digest replaced the stored list',
      );
      await syncOk(a);
      check(
        statuses().every((status) => status === 'active'),
        'every pull by the empty digest stays registered',
      );
    },
  },

  {
    name: 'units/scope-move-keeps-a-row-another-unit-holds',
    specRefs: ['§2.2', '§4.5'],
    async run(ctx) {
      await seedRows(ctx, 'docs', [doc('d1', 'o1', 'p1', 'before')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { org_id: ['o1'], projectId: ['p1', 'p2'] },
      });
      await a.api.subscribeMany([{ projectId: 'p1' }, { org_id: 'o1' }]);
      await syncIdle(a);
      await ctx.server.setAllowedScopes('mover', {
        org_id: ['o1'],
        projectId: ['*'],
      });
      const moved = await ctx.rawSync(
        'mover',
        [
          rawPushCommit('move-d1', [
            rawDelete('docs', 'd1'),
            rawUpsert(
              ctx.serverSchema,
              'docs',
              doc('d1', 'o1', 'p2', 'after'),
              0,
            ),
          ]),
        ],
        { clientId: 'mover' },
      );
      check(
        moved.ok && responsePushResults(moved.message)[0]?.status === 'applied',
        'the move applies as one commit',
      );
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.values),
        [doc('d1', 'o1', 'p2', 'after')],
        'the org unit keeps the moved row though the p1 unit matches its delete half',
      );
      await expectConverged(ctx, 'docs', [a]);
    },
  },

  {
    name: 'units/older-upsert-after-newer-state-does-not-rewind',
    specRefs: ['§4.5', '§8.2'],
    requires: ['realtime'],
    async run(ctx) {
      await lagBehindDeltas(
        ctx,
        [
          { op: 'insert', body: 'first' },
          { op: 'update', body: 'second' },
        ],
        { version: 2, body: 'second' },
      );
    },
  },

  {
    name: 'units/older-delete-below-the-local-version-is-skipped',
    specRefs: ['§2.2', '§4.5', '§8.2'],
    requires: ['realtime'],
    async run(ctx) {
      // x: insert at 1, delete at 2 (the floor), recreate at 3.
      await lagBehindDeltas(
        ctx,
        [
          { op: 'insert', body: 'first' },
          { op: 'delete' },
          { op: 'insert', body: 'again' },
        ],
        { version: 3, body: 'again' },
      );
    },
  },

  {
    name: 'realtime/duplicate-delta-is-skipped-without-sync-needed',
    specRefs: ['§4.5', '§8.2'],
    requires: ['realtime'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      // The transport delivers the first delta again right before the second.
      const deltas: Uint8Array[] = [];
      const original = ctx.server.connectRealtime.bind(ctx.server);
      ctx.server.connectRealtime = async (actorId, clientId, sink) =>
        original(actorId, clientId, {
          ...sink,
          async onBinary(bytes) {
            if (bytes[0] === 0) deltas.push(bytes.slice());
            if (deltas.length === 2 && bytes[0] === 0)
              await sink.onBinary(deltas[0]!);
            await sink.onBinary(bytes);
          },
        });
      await a.api.connectRealtime();
      await syncIdle(a);
      await seedTasks(ctx, [task('t1', 'p1', 'one')]);
      await a.realtime.waitForAck(await ctx.server.getMaxCommitSeq());
      check(!(await a.api.syncNeeded()), 'the first delta applied cleanly');
      await seedTasks(ctx, [task('t2', 'p1', 'two')]);
      await a.realtime.waitForAck(await ctx.server.getMaxCommitSeq());
      checkEqual(
        a.realtime.deltasDelivered,
        3,
        'the duplicate reached the client',
      );
      check(
        !(await a.api.syncNeeded()),
        'a duplicate delta is not a drop: no sync-needed signal (§8.2)',
      );
      checkEqual(
        await a.api.replicaCursor(),
        await ctx.server.getMaxCommitSeq(),
        'the deltas around the duplicate stayed contiguous',
      );
      await expectConverged(ctx, 'tasks', [a]);
    },
  },

  {
    name: 'window/deferred-eviction-keeps-a-bootstrapping-units-pages',
    specRefs: ['§3.3', '§4.8', '§5.6'],
    async run(ctx) {
      await seedRows(ctx, 'docs', [
        doc('d1', 'o1', 'p1'),
        doc('d2', 'o1', 'p1'),
        doc('d3', 'o1', 'p1'),
      ]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { org_id: ['o1'], projectId: ['p1'] },
        // Rows segments page; a sqlite image would carry the table at once.
        limits: { accept: 0b0011, limitSnapshotRows: 1, maxSnapshotPages: 1 },
      });
      const base = { variable: 'org_id' };
      await a.api.setWindow?.(base, ['o1']);
      await syncIdle(a);
      // The second unit's first page lands, then the window releases the first.
      await a.api.subscribe({ projectId: 'p1' });
      await syncOk(a);
      check(
        (await a.api.unitState(unitId({ projectId: 'p1' })))?.hasResumeToken ===
          true,
        'the second unit is mid-bootstrap',
      );
      await a.api.setWindow?.(base, []);
      await syncOk(a);
      check(
        (await a.api.readRows('docs')).some((row) => row.rowId === 'd1'),
        'the deferred eviction keeps the page the bootstrapping unit applied',
      );
      await syncIdle(a);
      checkEqual(
        (await a.api.readRows('docs')).map((row) => row.rowId),
        ['d1', 'd2', 'd3'],
        'the bootstrap completes with every page',
      );
      await expectConverged(ctx, 'docs', [a]);
    },
  },

  {
    name: 'realtime/delta-with-a-schema-floor-records-and-stops',
    specRefs: ['§1.6', '§7.4.2', '§8.2'],
    requires: ['realtime'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      // The next delta carries a schema floor in its RESP_HEADER.
      let floored = false;
      const acks: string[] = [];
      const delivered = Promise.withResolvers<void>();
      const original = ctx.server.connectRealtime.bind(ctx.server);
      ctx.server.connectRealtime = async (actorId, clientId, sink) => {
        const result = await original(actorId, clientId, {
          ...sink,
          async onBinary(bytes) {
            if (bytes[0] !== 0 || floored) return sink.onBinary(bytes);
            floored = true;
            acks.length = 0;
            const delta = decodeResponse(bytes.subarray(1));
            const header = delta.frames[0];
            if (header?.type !== 'RESP_HEADER')
              throw new Error('delta without RESP_HEADER');
            const payload = encodeMessage({
              ...delta,
              frames: [
                { ...header, requiredSchemaVersion: 2, latestSchemaVersion: 2 },
                ...delta.frames.slice(1),
              ],
            });
            const tagged = new Uint8Array(payload.length + 1);
            tagged.set(payload, 1);
            await sink.onBinary(tagged);
            delivered.resolve();
          },
        });
        if (!result.ok) return result;
        const { connection } = result;
        return {
          ok: true,
          connection: {
            ...connection,
            send(text) {
              acks.push(text);
              connection.send(text);
            },
            sendBinary: (bytes) => connection.sendBinary(bytes),
            close: () => connection.close(),
          },
        };
      };
      await a.api.connectRealtime();
      await syncIdle(a);
      await seedTasks(ctx, [task('t1', 'p1', 'with the floor')]);
      await delivered.promise;
      await syncIdle(a);
      checkEqual(
        await a.api.schemaFloor(),
        { requiredSchemaVersion: 2, latestSchemaVersion: 2 },
        'the client records the floor the delta carries (§1.6)',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        [],
        'the client applies nothing from the delta that carried the floor',
      );
      checkEqual(acks, [], 'the client acks nothing after the floored delta');
      await a.api.disconnectRealtime();
      await seedTasks(ctx, [task('t2', 'p1', 'after the floor')]);
      const stopped = await a.api.sync();
      check(
        !stopped.ok || stopped.report.schemaFloor !== undefined,
        'the client stops syncing in the floor state',
      );
      checkEqual(
        (await a.api.readRows('tasks')).map((row) => row.rowId),
        [],
        'the stopped client pulls nothing more',
      );
    },
  },

  {
    name: 'upgrade/cursor-into-pre-upgrade-history-resets',
    specRefs: ['§4.6', '§9'],
    // The Rust authority skips: the harness cannot seed a version 3 store
    // there. Its own test `a_store_from_0_59_migrates_to_the_fresh_schema`
    // covers that migration.
    requires: ['version3-database'],
    async run(ctx) {
      const reopen = ctx.server.reopenAsVersion3Database?.bind(ctx.server);
      if (reopen === undefined)
        throw new Error('version3-database without its method');
      await seedTasks(ctx, [task('t1', 'p1'), task('t2', 'p1')]);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: { project_id: ['p1'] },
      });
      await a.api.subscribe(U1);
      await syncIdle(a);
      // History the client has not pulled yet: a delete without a row version.
      await ctx.server.setAllowedScopes('deleter', { project_id: ['p1'] });
      const deleted = await ctx.rawSync(
        'deleter',
        [rawPushCommit('pre-upgrade-delete', [rawDelete('tasks', 't1')])],
        { clientId: 'deleter' },
      );
      check(deleted.ok, 'the pre-upgrade delete applies');
      const last = await ctx.server.getMaxCommitSeq();
      await reopen();
      checkEqual(
        await ctx.server.getHorizonSeq(),
        last,
        'the upgrade sets the pruning horizon to the last pre-upgrade commit (§9)',
      );
      const recovery = await syncIdle(a);
      checkEqual(
        recovery.resets,
        [unitId(U1)],
        'a cursor into pre-upgrade history answers the normal reset (§4.6)',
      );
      await expectConverged(ctx, 'tasks', [a]);
    },
  },
];
