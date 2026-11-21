/**
 * Preflight authority queries (SPEC.md §5.11) and subset coverage (§7.5):
 * declared SYQL reads over the accepted base, run in one read transaction.
 */
import { check, checkEqual } from '../checks';
import type { DriverAuthorityQuery, DriverRow } from '../driver';
import {
  AUTHORITY_FIXTURE_SCHEMA,
  CENTRE_WRAP_COVER,
  CENTRE_WRAP_COVER_SEALED,
  participant,
  sealedIdentity,
  surgery,
  TASK_ORIGINALS,
  task,
  wrap,
} from '../fixture';
import {
  type ClientHandle,
  DEFAULT_NOW_MS,
  type Scenario,
  type ScenarioContext,
  ScenarioSkip,
} from '../scenario';
import { seedRows, seedTasks, syncIdle } from './util';

const P1 = { project_id: ['p1'] } as const;
const U1 = { project_id: 'p1' } as const;
const T1 = DEFAULT_NOW_MS + 1_000;
const T2 = DEFAULT_NOW_MS + 2_000;
const T3 = DEFAULT_NOW_MS + 3_000;

/** Everything the centre `c1` may read in workspace `w1`. */
const CENTRE = {
  op_read_workspace_id: ['w1'],
  workspace_access_id: ['w1'],
  recipient_facility_id: ['c1'],
  sealer_facility_id: ['*'],
} as const;
const OP_UNITS = [
  { op_read_workspace_id: 'w1' },
  { workspace_access_id: 'w1' },
] as const;
const WRAP_UNIT = { recipient_facility_id: 'c1' } as const;
const COVER_PARAMS = {
  centreFacilityId: 'c1',
  workspaceId: 'w1',
  epochId: 'e1',
  trustedNowMs: DEFAULT_NOW_MS,
};
const SEALED_PARAMS = { ...COVER_PARAMS, sealerFacilityId: 'p1' };

/** Seed one OP pointer per surgery row, with its seals and participant. */
async function seedCentre(
  ctx: ScenarioContext,
  rows: {
    readonly surgeries: readonly DriverRow[];
    readonly identities: readonly DriverRow[];
    readonly wraps: readonly DriverRow[];
  },
): Promise<void> {
  await seedRows(ctx, 'surgeries', rows.surgeries);
  await seedRows(ctx, 'surgery_sealed_identities', rows.identities);
  if (rows.wraps.length > 0)
    await seedRows(ctx, 'record_key_wraps', rows.wraps);
  await seedRows(ctx, 'workspace_participants', [
    participant('pp1', 'w1', 'c1'),
  ]);
}

async function newCentre(
  ctx: ScenarioContext,
  clientId: string,
  allowed: Readonly<Record<string, readonly string[]>> = CENTRE,
): Promise<ClientHandle> {
  return ctx.newClient({
    actorId: clientId,
    clientId,
    allowed,
    schema: AUTHORITY_FIXTURE_SCHEMA,
    authorityReads: [CENTRE_WRAP_COVER, CENTRE_WRAP_COVER_SEALED],
  });
}

/** One request's result: completeness, its single row, its coverage. */
async function readOne(
  handle: ClientHandle,
  query: DriverAuthorityQuery,
  params: Readonly<Record<string, string | number>>,
) {
  const read = await handle.api.authorityRead([{ query: query.name, params }]);
  const result = read.results[0];
  if (result === undefined) throw new Error('authorityRead returned no result');
  return {
    complete: result.complete,
    row: result.rows[0],
    states: Object.fromEntries(
      result.coverage.map((entry) => [entry.table, entry.state]),
    ),
  };
}

async function codeOf(run: () => Promise<unknown>): Promise<{
  readonly code: string;
  readonly details: unknown;
}> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ScenarioSkip) throw error;
    const failure = error as { code?: string; details?: unknown };
    return { code: failure.code ?? '', details: failure.details };
  }
  return { code: '', details: undefined };
}

export const authorityScenarios: readonly Scenario[] = [
  {
    name: 'authority/three-relation-exists-and-max',
    specRefs: ['§5.11', '§7.5'],
    requires: ['scope-authorization'],
    server: { schema: AUTHORITY_FIXTURE_SCHEMA },
    async run(ctx) {
      await seedCentre(ctx, {
        surgeries: [surgery('s1', 'w1', 'i1'), surgery('s2', 'w1', 'i2')],
        identities: [
          sealedIdentity('i0', 'w1', 'k0'),
          sealedIdentity('i1', 'w1', 'k1'),
          sealedIdentity('i2', 'w1', 'k2'),
        ],
        wraps: [
          wrap('wa', 'k1', T1),
          wrap('wb', 'k2', T2),
          wrap('wc', 'k0', T3),
        ],
      });
      const centre = await newCentre(ctx, 'centre');
      for (const unit of [...OP_UNITS, WRAP_UNIT])
        await centre.api.subscribe(unit);
      await syncIdle(centre);
      await centre.api.beginSecurityPreflight();
      checkEqual(
        await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS),
        {
          complete: true,
          row: {
            qualifying: 1,
            latest_expires_at_ms: T2,
            unbounded_expiry: 0,
          },
          states: {
            record_key_wraps: 'complete',
            surgeries: 'complete',
            surgery_sealed_identities: 'complete',
            workspace_participants: 'complete',
          },
        },
        'only current seals count; the stale seal expiry is ignored',
      );
      checkEqual(
        await readOne(centre, CENTRE_WRAP_COVER_SEALED, SEALED_PARAMS),
        await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS),
        'a recipient-only unit proves the sealer-fixed entry (subset rule)',
      );
      await centre.api.activateSecurity();
      await seedRows(ctx, 'record_key_wraps', [
        wrap('wd', 'k1', null),
        wrap('we', 'k2', null, { sealer: 'p9' }),
      ]);
      await syncIdle(centre);
      checkEqual(
        (await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS)).row,
        { qualifying: 1, latest_expires_at_ms: T2, unbounded_expiry: 1 },
        'an accepted wrap without expiry sets unbounded_expiry',
      );
      checkEqual(
        (await readOne(centre, CENTRE_WRAP_COVER_SEALED, SEALED_PARAMS)).row,
        { qualifying: 1, latest_expires_at_ms: T2, unbounded_expiry: 1 },
        'the sealer chain keeps the trusted unbounded wrap',
      );
      await seedRows(ctx, 'record_key_wraps', [
        wrap('wd', 'k1', T3),
        wrap('we', 'k2', null, { sealer: 'p9' }),
      ]);
      await syncIdle(centre);
      checkEqual(
        (await readOne(centre, CENTRE_WRAP_COVER_SEALED, SEALED_PARAMS)).row,
        { qualifying: 1, latest_expires_at_ms: T3, unbounded_expiry: 0 },
        'a wrap from an untrusted sealer does not count',
      );
      await seedRows(ctx, 'record_key_wraps', [
        wrap('wa', 'k1', T1, { revokedAtMs: DEFAULT_NOW_MS }),
        wrap('wb', 'k2', T2, { revokedAtMs: DEFAULT_NOW_MS }),
        wrap('wd', 'k1', T3, { revokedAtMs: DEFAULT_NOW_MS }),
        wrap('we', 'k2', null, { revokedAtMs: DEFAULT_NOW_MS, sealer: 'p9' }),
      ]);
      await syncIdle(centre);
      const revoked = await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS);
      check(revoked.complete, 'the negative is complete');
      checkEqual(
        revoked.row,
        { qualifying: 0, latest_expires_at_ms: null, unbounded_expiry: 0 },
        'revoked wraps make a complete negative',
      );
    },
  },
  {
    name: 'authority/pending-local-creation-is-negative',
    specRefs: ['§5.11', '§7.2'],
    requires: ['scope-authorization'],
    server: { schema: AUTHORITY_FIXTURE_SCHEMA },
    async run(ctx) {
      await seedCentre(ctx, {
        surgeries: [surgery('s1', 'w1', 'i1')],
        identities: [sealedIdentity('i1', 'w1', 'k1')],
        wraps: [],
      });
      const centre = await newCentre(ctx, 'centre-local', {
        ...CENTRE,
        sealer_facility_id: ['p1'],
      });
      for (const unit of [...OP_UNITS, WRAP_UNIT])
        await centre.api.subscribe(unit);
      await syncIdle(centre);
      await centre.api.setTransportGate('closed');
      // The server refuses the sealer `p9` (not granted): a rejection.
      await centre.api.mutate([
        {
          op: 'upsert',
          table: 'record_key_wraps',
          values: wrap('wz', 'k1', T1, { sealer: 'p9' }),
        },
      ]);
      const negative = {
        qualifying: 0,
        latest_expires_at_ms: null,
        unbounded_expiry: 0,
      };
      checkEqual(
        await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS),
        {
          complete: true,
          row: negative,
          states: {
            record_key_wraps: 'complete',
            surgeries: 'complete',
            surgery_sealed_identities: 'complete',
            workspace_participants: 'complete',
          },
        },
        'a pending local creation never answers positively',
      );
      await centre.api.setTransportGate('open');
      await syncIdle(centre);
      checkEqual(
        await centre.api.pendingCommitIds(),
        [],
        'the server rejected the foreign sealer',
      );
      checkEqual(
        (await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS)).row,
        negative,
        'the rolled-back creation stays negative',
      );
      await centre.api.setTransportGate('closed');
      await centre.api.mutate([
        {
          op: 'upsert',
          table: 'record_key_wraps',
          values: wrap('wa', 'k1', T1),
        },
      ]);
      checkEqual(
        (await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS)).row,
        negative,
        'the pending creation is not evidence',
      );
      await centre.api.setTransportGate('open');
      await syncIdle(centre);
      checkEqual(
        (await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS)).row,
        { qualifying: 1, latest_expires_at_ms: T1, unbounded_expiry: 0 },
        'the accepted creation qualifies',
      );
    },
  },
  {
    name: 'authority/incomplete-coverage-versus-complete-negative',
    specRefs: ['§5.11', '§7.5'],
    requires: ['scope-authorization'],
    server: { schema: AUTHORITY_FIXTURE_SCHEMA },
    async run(ctx) {
      await seedCentre(ctx, {
        surgeries: [surgery('s1', 'w1', 'i1')],
        identities: [sealedIdentity('i1', 'w1', 'k1')],
        wraps: [wrap('wa', 'k1', T1, { epoch: 'e0' })],
      });
      const centre = await newCentre(ctx, 'centre-coverage');
      for (const unit of OP_UNITS) await centre.api.subscribe(unit);
      await syncIdle(centre);
      const missing = await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS);
      check(!missing.complete, 'an unregistered wrap unit is incomplete');
      checkEqual(
        missing.states['record_key_wraps'],
        'missing',
        'the wrap unit is reported missing',
      );
      await centre.api.subscribe(WRAP_UNIT);
      checkEqual(
        (await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS)).states[
          'record_key_wraps'
        ],
        'pending',
        'a registered unit is pending until its bootstrap completes',
      );
      await syncIdle(centre);
      checkEqual(
        await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS),
        {
          complete: true,
          row: {
            qualifying: 0,
            latest_expires_at_ms: null,
            unbounded_expiry: 0,
          },
          states: {
            record_key_wraps: 'complete',
            surgeries: 'complete',
            surgery_sealed_identities: 'complete',
            workspace_participants: 'complete',
          },
        },
        'a bootstrapped wrap set without a qualifying wrap is a complete negative',
      );
      await ctx.server.setAllowedScopes('centre-coverage', {
        ...CENTRE,
        recipient_facility_id: [],
      });
      await syncIdle(centre);
      const revoked = await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS);
      check(!revoked.complete, 'a revoked wrap unit is incomplete');
      checkEqual(
        revoked.states['record_key_wraps'],
        'revoked',
        'the wrap unit is reported revoked',
      );

      // A sealer-only registration never proves the recipient entry.
      const sealerOnly = await newCentre(ctx, 'centre-sealer-only');
      for (const unit of [...OP_UNITS, { sealer_facility_id: 'p1' }])
        await sealerOnly.api.subscribe(unit);
      await syncIdle(sealerOnly);
      const bySealer = await readOne(
        sealerOnly,
        CENTRE_WRAP_COVER,
        COVER_PARAMS,
      );
      check(
        !bySealer.complete,
        'a sealer-only unit leaves the read incomplete',
      );
      checkEqual(
        bySealer.states['record_key_wraps'],
        'missing',
        'key-wraps:{centreFacilityId} is missing',
      );

      // A recipient granted through the wildcard fences the unbound sealer
      // (§3.2 rule 4); that echo cannot prove a sealer-fixed entry.
      const restricted = await newCentre(ctx, 'centre-restricted', {
        ...CENTRE,
        recipient_facility_id: ['*'],
        sealer_facility_id: ['p1'],
      });
      for (const unit of [...OP_UNITS, WRAP_UNIT])
        await restricted.api.subscribe(unit);
      await syncIdle(restricted);
      const sealed = await readOne(
        restricted,
        CENTRE_WRAP_COVER_SEALED,
        SEALED_PARAMS,
      );
      check(!sealed.complete, 'a sealer-restricting echo is incomplete');
      checkEqual(
        sealed.states['record_key_wraps'],
        'pending',
        'the restricted unit is pending, not missing',
      );
      check(
        (await readOne(restricted, CENTRE_WRAP_COVER, COVER_PARAMS)).complete,
        'the same unit proves the entry without a sealer scope',
      );
    },
  },
  {
    name: 'authority/shadowed-read-matches-settlement',
    specRefs: ['§5.11'],
    requires: ['scope-authorization'],
    server: { schema: AUTHORITY_FIXTURE_SCHEMA },
    async run(ctx) {
      await seedCentre(ctx, {
        surgeries: [surgery('s1', 'w1', 'i1'), surgery('s2', 'w1', 'i2')],
        identities: [
          sealedIdentity('i1', 'w1', 'k1'),
          sealedIdentity('i2', 'w1', 'k2'),
        ],
        wraps: [wrap('wa', 'k1', T1), wrap('wb', 'k2', T2)],
      });
      const centre = await newCentre(ctx, 'centre-shadow');
      for (const unit of [...OP_UNITS, WRAP_UNIT])
        await centre.api.subscribe(unit);
      await syncIdle(centre);
      const accepted = await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS);
      await centre.api.setTransportGate('closed');
      await centre.api.mutate([
        {
          op: 'patch',
          table: 'record_key_wraps',
          values: { id: 'wb', expires_at_ms: null },
        },
        {
          op: 'patch',
          table: 'surgeries',
          values: { id: 's1', sealed_identity_id: null },
        },
      ]);
      checkEqual(
        await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS),
        accepted,
        'pending edits shadow nothing the accepted base does not hold',
      );
      await centre.api.setTransportGate('open');
      await syncIdle(centre);
      checkEqual(
        (await readOne(centre, CENTRE_WRAP_COVER, COVER_PARAMS)).row,
        { qualifying: 1, latest_expires_at_ms: null, unbounded_expiry: 1 },
        'the settled edits answer from the accepted rows',
      );
    },
  },
  {
    name: 'authority/declaration-refusals',
    specRefs: ['§5.11'],
    server: { schema: AUTHORITY_FIXTURE_SCHEMA },
    async run(ctx) {
      const centre = await ctx.newClient({
        actorId: 'refusals',
        clientId: 'refusals',
        schema: AUTHORITY_FIXTURE_SCHEMA,
        securityPreflight: true,
        transportGate: 'closed',
        authorityReads: [CENTRE_WRAP_COVER],
      });
      checkEqual(
        (
          await codeOf(() =>
            centre.api.authorityRead([{ query: 'undeclared', params: {} }]),
          )
        ).code,
        'client.authority_query_unknown',
        'an undeclared name is refused',
      );
      checkEqual(
        await codeOf(() =>
          centre.api.authorityRead([
            {
              query: CENTRE_WRAP_COVER.name,
              params: { ...COVER_PARAMS, trustedNowMs: 'now' },
            },
          ]),
        ),
        {
          code: 'sync.invalid_request',
          details: { query: CENTRE_WRAP_COVER.name, param: 'trustedNowMs' },
        },
        'a mistyped parameter is refused with its name',
      );
      checkEqual(
        centre.sentRequests.length,
        0,
        'authority reads never invoke transport',
      );
      const refused = await codeOf(() =>
        ctx.newClient({
          actorId: 'refused',
          clientId: 'refused',
          schema: AUTHORITY_FIXTURE_SCHEMA,
          securityPreflight: true,
          transportGate: 'closed',
          authorityReads: [
            {
              ...CENTRE_WRAP_COVER,
              sql: 'select w.wrapped_key from record_key_wraps as w where w.recipient_facility_id = ?',
              bind: ['centreFacilityId'],
              reads: {
                record_key_wraps: ['recipient_facility_id', 'wrapped_key'],
              },
            },
          ],
        }),
      );
      checkEqual(
        refused,
        {
          code: 'client.authority_read_forbidden',
          details: {
            query: CENTRE_WRAP_COVER.name,
            reason: 'column',
            table: 'record_key_wraps',
            column: 'wrapped_key',
          },
        },
        'a bytes column is refused at creation',
      );
    },
  },
  {
    name: 'authority/native-ceiling-refuses-the-real-read-set',
    specRefs: ['§5.11'],
    server: { schema: AUTHORITY_FIXTURE_SCHEMA },
    async run(ctx) {
      const ceiling = Object.fromEntries(
        Object.entries(CENTRE_WRAP_COVER.reads).map(([table, columns]) => [
          table,
          columns.filter((column) => column !== 'expires_at_ms'),
        ]),
      );
      checkEqual(
        await codeOf(() =>
          ctx.newClient({
            actorId: 'ceiling',
            clientId: 'ceiling',
            schema: AUTHORITY_FIXTURE_SCHEMA,
            securityPreflight: true,
            transportGate: 'closed',
            authorityColumns: ceiling,
            // The declared read set hides the column the SQL reads.
            authorityReads: [{ ...CENTRE_WRAP_COVER, reads: ceiling }],
          }),
        ),
        {
          code: 'client.authority_read_forbidden',
          details: {
            query: CENTRE_WRAP_COVER.name,
            reason: 'ceiling',
            table: 'record_key_wraps',
            column: 'expires_at_ms',
          },
        },
        'the native host authorizes the statement, not the declared read set',
      );
    },
  },
  {
    name: 'security/authority-read-preflight-base-intent-and-scope-loss',
    specRefs: ['§5.11', '§7.5'],
    requires: ['scope-authorization'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'authority',
        clientId: 'authority',
        allowed: P1,
        authorityReads: [TASK_ORIGINALS],
      });
      const originals = async () =>
        (
          await a.api.authorityRead([
            { query: TASK_ORIGINALS.name, params: { projectId: 'p1' } },
          ])
        ).results[0];
      checkEqual(
        (await originals())?.coverage.map((entry) => entry.state),
        ['missing'],
        'unregistered coverage is explicit',
      );
      await seedTasks(ctx, [task('t1', 'p1', 'accepted')]);
      await a.api.subscribe(U1);
      checkEqual(
        (await originals())?.coverage.map((entry) => entry.state),
        ['pending'],
        'registration is incomplete',
      );
      await syncIdle(a);
      await a.api.setTransportGate('closed');
      await a.api.mutate([
        {
          op: 'patch',
          table: 'tasks',
          values: { id: 't1', title: 'unaccepted' },
        },
        { op: 'upsert', table: 'tasks', values: task('local', 'p1', 'local') },
      ]);
      await a.api.beginSecurityPreflight();
      const revision = await a.api.localRevision!();
      const read = await a.api.authorityRead([
        { query: TASK_ORIGINALS.name, params: { projectId: 'p1' } },
      ]);
      checkEqual(
        read.revision,
        revision,
        'read revision is the committed revision',
      );
      check(
        read.results[0]?.complete ?? false,
        'completed accepted coverage survives preflight',
      );
      checkEqual(
        read.results[0]?.rows,
        [{ id: 't1', project_id: 'p1', title: 'accepted', server_version: 1 }],
        'the base is distinct from the edit and the local creation',
      );
      checkEqual(
        await a.api.localRevision!(),
        revision,
        'the read writes nothing',
      );
      checkEqual(
        (
          await codeOf(() =>
            a.api.mutate([{ op: 'delete', table: 'tasks', rowId: 't1' }]),
          )
        ).code,
        'client.security_preflight_required',
        'writes remain closed',
      );
      await a.api.activateSecurity();
      await a.api.setTransportGate('open');
      await ctx.server.setAllowedScopes('authority', {});
      await syncIdle(a);
      await a.api.setTransportGate('closed');
      await a.api.beginSecurityPreflight();
      const revoked = await originals();
      check(
        !(revoked?.complete ?? true),
        'scope loss invalidates completeness',
      );
      checkEqual(revoked?.rows, [], 'revoked base and intent disappear');
    },
  },
  {
    name: 'security/authority-read-static-policy-and-empty-preflight',
    specRefs: ['§5.11'],
    async run(ctx) {
      const a = await ctx.newClient({
        actorId: 'preflight',
        clientId: 'preflight',
        allowed: P1,
        securityPreflight: true,
        transportGate: 'closed',
        authorityReads: [TASK_ORIGINALS],
      });
      const read = await a.api.authorityRead([
        { query: TASK_ORIGINALS.name, params: { projectId: 'p1' } },
      ]);
      check(
        !(read.results[0]?.complete ?? true),
        'an empty replica has no coverage proof',
      );
      checkEqual(read.results[0]?.rows, [], 'empty evidence is explicit');
      checkEqual(
        a.sentRequests.length,
        0,
        'the read does not invoke transport',
      );
      for (const reads of [
        { tasks: ['id', 'missing'] },
        { tasks: ['_sync_origin'] },
        { _syncular_outbox: ['seq'] },
      ]) {
        checkEqual(
          (
            await codeOf(() =>
              ctx.newClient({
                actorId: 'forbidden',
                clientId: 'forbidden',
                securityPreflight: true,
                transportGate: 'closed',
                authorityReads: [{ ...TASK_ORIGINALS, reads }],
              }),
            )
          ).code,
          'client.authority_read_forbidden',
          'only schema-approved plain columns pass',
        );
      }
    },
  },
];
