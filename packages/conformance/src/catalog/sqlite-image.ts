/**
 * SQLite-image bootstrap (SPEC.md §5.3; Appendix B.10): whole-table
 * image delivery, rows-lane equivalence, integrity failure + recovery,
 * capability gating (§4.2 negotiation), server-side reuse (the
 * bootstrap-storm rule), and mid-table lane pinning.
 *
 * The image *file format* checks open the served bytes with bun:sqlite —
 * a harness-side reference decoder, like raw.ts's reference codec: the
 * server's §5.3 production is pinned no matter which client is paired.
 */
import { Database } from 'bun:sqlite';
import { canonicalScopeJson } from '@syncular-v2/core';
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import { rawPullHeader, rawSubscription, responseSection } from '../raw';
import type { Scenario } from '../scenario';
import { expectConverged, seedTasks, syncIdle, syncOk } from './util';

const P1 = { project_id: ['p1'] } as const;

/** Rows lane pinned (§4.2 baseline). */
const ROWS_ONLY = 0b0011;
/** Rows baseline + sqlite images (§5.3). */
const WITH_SQLITE = 0b0111;

/** Five rows with type variety; t1 reaches server_version 2. */
async function seedEligibleTable(ctx: Parameters<Scenario['run']>[0]) {
  await seedTasks(ctx, [
    task('t1', 'p1', 'naïve 🚀', true, 3, '{"a":[1,2]}'),
    task('t2', 'p1', '', false, null, null),
    task('t3', 'p1', 'three', false, 0, 'null'),
    task('t4', 'p1', 'four', true, -7, null),
    task('t5', 'p1', 'five', false, null, '{"k":"v"}'),
  ]);
  await seedTasks(ctx, [
    task('t1', 'p1', 'naïve 🚀 v2', true, 3, '{"a":[1,2]}'),
  ]);
}

export const sqliteImageScenarios: readonly Scenario[] = [
  {
    // B.10(a): an image bootstrap is byte-for-byte equivalent (values AND
    // versions) to a rows bootstrap, completes in a single pull despite
    // paging limits, and hands off to incremental pulls at the pin.
    name: 'sqlite-image/bootstrap-equivalence-single-shot',
    specRefs: ['§5.3', '§5.6', '§4.7', 'B.10'],
    async run(ctx) {
      await seedEligibleTable(ctx);

      // Control: the mandatory rows lane, paged.
      const control = await ctx.newClient({
        actorId: 'actor-c',
        clientId: 'client-control',
        allowed: P1,
        limits: { limitSnapshotRows: 2, accept: ROWS_ONLY },
      });
      await control.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(control);

      // Image lane: page limits that would take 3 pulls on the rows lane.
      const image = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-image',
        allowed: P1,
        limits: {
          limitSnapshotRows: 2,
          maxSnapshotPages: 1,
          accept: WITH_SQLITE,
        },
      });
      await image.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      const first = await syncOk(image);
      checkEqual(
        first.segmentRowsApplied,
        5,
        'the whole table arrived as one image',
      );
      checkEqual(
        first.bootstrapping,
        [],
        'an image completes its table in one pull — paging limits do not apply (§5.3)',
      );
      const pin = await ctx.server.getMaxCommitSeq();
      checkEqual(
        (await image.api.subscriptionState('tasks'))?.cursor,
        pin,
        'SUB_END.nextCursor is the bootstrap pin (§4.7)',
      );

      // Equivalence: image-bootstrapped state ≡ rows-bootstrapped state,
      // versions included (§5.6 version seeding via _syncular_version).
      checkEqual(
        await image.api.readRows('tasks'),
        await control.api.readRows('tasks'),
        'image-bootstrapped client state equals the rows-lane control',
      );
      await expectConverged(ctx, 'tasks', [image, control], {
        variable: 'project_id',
        values: ['p1'],
      });

      // Handoff: post-pin commits arrive incrementally, no re-bootstrap.
      await seedTasks(ctx, [task('t6', 'p1', 'after-pin')]);
      const second = await syncOk(image);
      checkEqual(second.segmentRowsApplied, 0, 'no second bootstrap');
      checkEqual(second.commitsApplied, 1, 'incremental pull took over');
      await expectConverged(ctx, 'tasks', [image], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // B.10(b) + (d): descriptor shape, §5.3 file format, server-side
    // reuse across clients, and §4.2 capability gating — all pinned at
    // the raw-bytes surface so any paired client implementation counts.
    name: 'sqlite-image/descriptor-format-reuse-and-gating',
    specRefs: ['§5.3', '§4.2', '§5.4', '§5.7', 'B.10'],
    async run(ctx) {
      await seedEligibleTable(ctx);
      await ctx.server.setAllowedScopes('raw-actor', P1);
      const pin = await ctx.server.getMaxCommitSeq();
      const pullFrames = (accept: number) => [
        rawPullHeader({ accept, limitSnapshotRows: 2 }),
        rawSubscription('s1', 'tasks', P1, -1),
      ];

      // Without bit 2 the same table bootstraps on the rows lane —
      // capability negotiation, not a fallback path (§5.3 eligibility).
      const gated = await ctx.rawSync('raw-actor', pullFrames(ROWS_ONLY), {
        clientId: 'raw-gated',
      });
      check(gated.ok, 'rows-lane pull succeeded');
      if (!gated.ok) return;
      const gatedSection = responseSection(gated.message, 's1');
      check(
        gatedSection.body.length > 0 &&
          gatedSection.body.every(
            (frame) =>
              frame.type === 'SEGMENT_INLINE' ||
              (frame.type === 'SEGMENT_REF' && frame.mediaType === 'rows'),
          ),
        'without accept bit 2 every segment is a rows segment (§4.2)',
      );

      // With bit 2: exactly one whole-table sqlite descriptor.
      const first = await ctx.rawSync('raw-actor', pullFrames(WITH_SQLITE), {
        clientId: 'raw-a',
      });
      check(first.ok, 'image pull succeeded');
      if (!first.ok) return;
      const section = responseSection(first.message, 's1');
      const ref = section.body[0];
      checkEqual(section.body.length, 1, 'one segment covers the table');
      check(
        ref?.type === 'SEGMENT_REF',
        'image delivery is SEGMENT_REF only (§5.7)',
      );
      if (ref?.type !== 'SEGMENT_REF') return;
      checkEqual(ref.mediaType, 'sqlite', 'mediaType');
      checkEqual(ref.rowCount, 5, 'descriptor rowCount');
      checkEqual(ref.asOfCommitSeq, pin, 'descriptor pin');
      checkEqual(ref.rowCursor, undefined, 'rowCursor absent (§5.3)');
      checkEqual(ref.nextRowCursor, undefined, 'nextRowCursor absent (§5.3)');
      checkEqual(
        section.end.bootstrapState,
        undefined,
        'an image completes the bootstrap — no resume token',
      );
      checkEqual(section.end.nextCursor, pin, 'nextCursor is the pin (§4.7)');

      // §5.3 file format, via the reference decoder (bun:sqlite).
      const download = await ctx.server.downloadSegment(
        'raw-actor',
        ref.segmentId,
        canonicalScopeJson({ project_id: ['p1'] }),
      );
      check(download.ok, 'the image downloads through §5.5');
      if (!download.ok) return;
      const img = Database.deserialize(download.bytes);
      try {
        const meta = img
          .query(
            `SELECT format, "table" AS tbl, "schemaVersion" AS sv,
                    "asOfCommitSeq" AS pin, "scopeDigest" AS sd,
                    "rowCount" AS rc
             FROM _syncular_segment`,
          )
          .all() as Array<Record<string, unknown>>;
        checkEqual(meta.length, 1, '_syncular_segment has exactly one row');
        checkEqual(meta[0]?.format, 1, 'metadata format');
        checkEqual(meta[0]?.tbl, 'tasks', 'metadata table');
        checkEqual(Number(meta[0]?.sv), 1, 'metadata schemaVersion');
        checkEqual(Number(meta[0]?.pin), pin, 'metadata asOfCommitSeq');
        checkEqual(meta[0]?.sd, ref.scopeDigest, 'metadata scopeDigest');
        checkEqual(Number(meta[0]?.rc), 5, 'metadata rowCount');
        const columns = (
          img.query(`PRAGMA table_info("tasks")`).all() as Array<{
            name: string;
          }>
        ).map((row) => row.name);
        checkEqual(
          columns,
          [
            'id',
            'project_id',
            'title',
            'done',
            'priority',
            'meta',
            '_syncular_version',
          ],
          'schema-IR columns in order plus _syncular_version last (§5.3)',
        );
      } finally {
        img.close();
      }

      // B.10(b) reuse: a second client at the same (scopes, pin) receives
      // the SAME segmentId — build-once, the bootstrap-storm answer.
      const second = await ctx.rawSync('raw-actor', pullFrames(WITH_SQLITE), {
        clientId: 'raw-b',
      });
      check(second.ok, 'second image pull succeeded');
      if (!second.ok) return;
      const secondRef = responseSection(second.message, 's1').body[0];
      check(secondRef?.type === 'SEGMENT_REF', 'second pull got a descriptor');
      if (secondRef?.type !== 'SEGMENT_REF') return;
      checkEqual(
        secondRef.segmentId,
        ref.segmentId,
        'the stored image is reused, never rebuilt per client (§5.3)',
      );
    },
  },

  {
    // B.10(c): corrupted image bytes fail the §5.1 content address,
    // abort per §1.4 rule 5 with the named error, persist nothing, and
    // the re-pull converges.
    name: 'sqlite-image/integrity-failure-recovers',
    specRefs: ['§5.1', '§5.3', '§1.4', 'B.10'],
    async run(ctx) {
      await seedEligibleTable(ctx);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
        limits: { limitSnapshotRows: 2, accept: WITH_SQLITE },
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });

      a.faults.truncateNextSegmentDownload = true;
      const result = await a.api.sync();
      check(!result.ok, 'the corrupted image failed the sync round');
      if (!result.ok) {
        checkEqual(
          result.errorCode,
          'sync.invalid_request',
          'content-address failure surfaces the named error (§5.1)',
        );
      }
      const state = await a.api.subscriptionState('tasks');
      checkEqual(state?.cursor, -1, 'the cursor did not advance (§1.4 rule 5)');
      checkEqual(state?.hasResumeToken, false, 'no resume token persisted');
      checkEqual((await a.api.readRows('tasks')).length, 0, 'nothing applied');

      await syncIdle(a);
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // B.10(e): a bootstrap resumed mid-table stays on the rows lane even
    // when the resuming pull advertises bit 2 — servers never switch
    // lanes mid-table (§5.3).
    name: 'sqlite-image/resume-stays-on-rows-lane',
    specRefs: ['§5.3', '§4.7', 'B.10'],
    async run(ctx) {
      await seedEligibleTable(ctx);
      await ctx.server.setAllowedScopes('raw-actor', P1);
      const pin = await ctx.server.getMaxCommitSeq();

      // Start on the rows lane, one page only → a mid-table resume token.
      const first = await ctx.rawSync(
        'raw-actor',
        [
          rawPullHeader({
            accept: ROWS_ONLY,
            limitSnapshotRows: 2,
            maxSnapshotPages: 1,
          }),
          rawSubscription('s1', 'tasks', P1, -1),
        ],
        { clientId: 'raw-a' },
      );
      check(first.ok, 'first rows page succeeded');
      if (!first.ok) return;
      const token = responseSection(first.message, 's1').end.bootstrapState;
      check(token !== undefined, 'a mid-table resume token was issued');
      if (token === undefined) return;

      // Resume WITH bit 2: the server must finish on the rows lane.
      const resumed = await ctx.rawSync(
        'raw-actor',
        [
          rawPullHeader({ accept: WITH_SQLITE, limitSnapshotRows: 2 }),
          rawSubscription('s1', 'tasks', P1, pin, { bootstrapState: token }),
        ],
        { clientId: 'raw-a' },
      );
      check(resumed.ok, 'resumed pull succeeded');
      if (!resumed.ok) return;
      const section = responseSection(resumed.message, 's1');
      check(
        section.body.length > 0 &&
          section.body.every(
            (frame) =>
              frame.type === 'SEGMENT_INLINE' ||
              (frame.type === 'SEGMENT_REF' && frame.mediaType === 'rows'),
          ),
        'the resumed bootstrap stays on the rows lane (§5.3 lane pinning)',
      );
      checkEqual(
        section.end.bootstrapState,
        undefined,
        'the rows lane completed the remaining pages',
      );
      checkEqual(section.end.nextCursor, pin, 'resume kept the original pin');
    },
  },
];
