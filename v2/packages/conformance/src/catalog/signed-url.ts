/**
 * Signed-URL segment delivery (SPEC.md §5.4; Appendix B.12): the
 * issue→fetch→verify loop on the native HMAC scheme, expiry (no fetch
 * past `urlExpiresAtMs` → re-pull recovery), tamper (content-address
 * failure with no direct-endpoint fall-through), and bit-3 gating at the
 * raw surface.
 *
 * Delegated presign (S3/R2) is pinned by `packages/server` tests against
 * the S3 stub (§5.4 equivalence rule) — behaviorally indistinguishable
 * to the client, so the pairing scenarios here run the native scheme.
 */
import { check, checkEqual } from '../checks';
import { task } from '../fixture';
import { rawPullHeader, rawSubscription, responseSection } from '../raw';
import { DEFAULT_NOW_MS, type Scenario } from '../scenario';
import {
  expectConverged,
  seedTasks,
  syncFails,
  syncIdle,
  syncOk,
} from './util';

const P1 = { project_id: ['p1'] } as const;

/** Rows baseline + external + signed URLs, no sqlite (§4.2). */
const ROWS_WITH_URLS = 0b1011;
/** Everything: rows + sqlite + signed URLs. */
const ALL_BITS = 0b1111;
/** Rows baseline + sqlite, no signed URLs. */
const NO_URLS = 0b0111;

async function seedFive(ctx: Parameters<Scenario['run']>[0]) {
  await seedTasks(ctx, [
    task('t1', 'p1', 'one'),
    task('t2', 'p1', 'two'),
    task('t3', 'p1', 'three'),
    task('t4', 'p1', 'four'),
    task('t5', 'p1', 'five'),
  ]);
}

export const signedUrlScenarios: readonly Scenario[] = [
  {
    // B.12(a): issue→fetch→verify on both segment formats — every
    // external segment travels the URL host, zero direct downloads, and
    // a no-capability control negotiates onto the direct endpoint.
    name: 'signed-url/issue-fetch-verify-both-lanes',
    specRefs: ['§5.4', '§4.2', '§5.1', 'B.12'],
    requires: ['signed-urls'],
    server: {
      limits: { inlineSegmentMaxBytes: 1 },
      signedUrls: { ttlSeconds: 900 },
    },
    async run(ctx) {
      await seedFive(ctx);

      // Rows lane over URLs (bit 3, no bit 2): three external pages.
      const rows = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-rows',
        allowed: P1,
        signedUrls: true,
        nowMs: DEFAULT_NOW_MS,
        limits: { limitSnapshotRows: 2, accept: ROWS_WITH_URLS },
      });
      await rows.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(rows);
      check(rows.urlFetches.length >= 1, 'rows segments fetched via URL');
      checkEqual(
        rows.directDownloads,
        [],
        'a url-carrying descriptor never touches the direct endpoint (§5.4)',
      );
      check(
        rows.urlFetches.every((url) => url.includes('?st=')),
        'native-scheme URLs carry the st token (§5.4)',
      );
      await expectConverged(ctx, 'tasks', [rows], {
        variable: 'project_id',
        values: ['p1'],
      });

      // Image lane over URLs (bits 2+3): one sqlite image, same rows.
      const image = await ctx.newClient({
        actorId: 'actor-b',
        clientId: 'client-image',
        allowed: P1,
        signedUrls: true,
        nowMs: DEFAULT_NOW_MS,
        limits: { limitSnapshotRows: 2, accept: ALL_BITS },
      });
      await image.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      const report = await syncOk(image);
      checkEqual(report.segmentRowsApplied, 5, 'the image arrived whole');
      checkEqual(image.urlFetches.length, 1, 'one URL fetch for the image');
      checkEqual(image.directDownloads, [], 'no direct downloads');
      checkEqual(
        await image.api.readRows('tasks'),
        await rows.api.readRows('tasks'),
        'URL-delivered image equals URL-delivered rows lane',
      );

      // Capability negotiation: no bit 3 ⇒ direct endpoint, no URL host.
      const control = await ctx.newClient({
        actorId: 'actor-c',
        clientId: 'client-direct',
        allowed: P1,
        limits: { limitSnapshotRows: 2, accept: NO_URLS },
      });
      await control.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });
      await syncIdle(control);
      checkEqual(control.urlFetches, [], 'no URL host without bit 3');
      check(
        control.directDownloads.length >= 1,
        'the direct endpoint serves clients without bit 3 (§4.2 negotiation)',
      );
      await expectConverged(ctx, 'tasks', [control], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // B.12(b): a URL already at expiry is never fetched; the sync aborts
    // with sync.segment_expired semantics and persists nothing; a
    // re-pull under a fresh TTL recovers through the URL host.
    name: 'signed-url/expired-url-no-fetch-repull-recovers',
    specRefs: ['§5.4', '§1.4', '§10.2', 'B.12'],
    requires: ['signed-urls'],
    server: {
      limits: { inlineSegmentMaxBytes: 1 },
      signedUrls: { ttlSeconds: 900 },
    },
    async run(ctx) {
      await seedFive(ctx);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
        signedUrls: true,
        nowMs: DEFAULT_NOW_MS,
        limits: { limitSnapshotRows: 2, accept: ROWS_WITH_URLS },
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });

      // TTL 0: descriptors are born expired (urlExpiresAtMs == now).
      await ctx.server.setSignedUrlTtlSeconds?.(0);
      await syncFails(
        a,
        'sync.segment_expired',
        'expired URL must abort with re-pull semantics (§5.4)',
      );
      checkEqual(a.urlFetches, [], 'MUST NOT start a fetch past expiry');
      checkEqual(a.directDownloads, [], 'and MUST NOT fall through (§5.4)');
      const state = await a.api.subscriptionState('tasks');
      checkEqual(state?.cursor, -1, 'cursor unpersisted (§1.4 rule 5)');
      checkEqual((await a.api.readRows('tasks')).length, 0, 'nothing applied');

      // Fresh TTL: the re-pull mints live descriptors and recovers.
      await ctx.server.setSignedUrlTtlSeconds?.(900);
      await syncIdle(a);
      check(a.urlFetches.length >= 1, 'recovery rode the URL host');
      checkEqual(a.directDownloads, [], 'still zero direct downloads');
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // B.12(c): tampered CDN bytes fail the §5.1 content address with the
    // named error; a lost URL fetch likewise invalidates the descriptor.
    // Neither ever falls through to the direct endpoint; re-pulls
    // converge once the path heals.
    name: 'signed-url/tamper-and-loss-invalidate-descriptor',
    specRefs: ['§5.4', '§5.1', '§1.4', 'B.12'],
    requires: ['signed-urls'],
    server: {
      limits: { inlineSegmentMaxBytes: 1 },
      signedUrls: { ttlSeconds: 900 },
    },
    async run(ctx) {
      await seedFive(ctx);
      const a = await ctx.newClient({
        actorId: 'actor-a',
        clientId: 'client-a',
        allowed: P1,
        signedUrls: true,
        nowMs: DEFAULT_NOW_MS,
        limits: { limitSnapshotRows: 2, accept: ROWS_WITH_URLS },
      });
      await a.api.subscribe({ id: 'tasks', table: 'tasks', scopes: P1 });

      // Tamper: corrupted bytes fail the content address (§5.1).
      a.faults.corruptNextUrlFetch = true;
      await syncFails(
        a,
        'sync.invalid_request',
        'tampered URL bytes must fail the content address (§5.1)',
      );
      checkEqual(a.directDownloads, [], 'no fall-through on tamper (§5.4)');
      checkEqual(
        (await a.api.subscriptionState('tasks'))?.cursor,
        -1,
        'cursor unpersisted (§1.4 rule 5)',
      );
      checkEqual((await a.api.readRows('tasks')).length, 0, 'nothing applied');

      // Loss: a dropped URL fetch is a transport failure, not a detour.
      a.faults.dropNextUrlFetches = 1;
      const lost = await a.api.sync();
      check(!lost.ok, 'a lost URL fetch fails the round');
      checkEqual(a.directDownloads, [], 'no fall-through on loss (§5.4)');

      // Healed path: the re-pull converges through the URL host.
      await syncIdle(a);
      checkEqual(a.directDownloads, [], 'recovery is re-pull, not detour');
      await expectConverged(ctx, 'tasks', [a], {
        variable: 'project_id',
        values: ['p1'],
      });
    },
  },

  {
    // B.12(d): bit-3 gating at the raw surface — url/urlExpiresAtMs are
    // emitted iff the pull advertised bit 3, paired per the §5.4 field
    // tie, on a server WITH signed URLs configured.
    name: 'signed-url/gating-no-bit3-no-url-fields',
    specRefs: ['§5.4', '§4.2', 'B.12'],
    requires: ['signed-urls'],
    server: {
      limits: { inlineSegmentMaxBytes: 1 },
      signedUrls: { ttlSeconds: 900 },
    },
    async run(ctx) {
      await seedFive(ctx);
      await ctx.server.setAllowedScopes('raw-actor', P1);
      const pull = (accept: number) => [
        rawPullHeader({ accept, limitSnapshotRows: 2 }),
        rawSubscription('s1', 'tasks', P1, -1),
      ];

      const gated = await ctx.rawSync('raw-actor', pull(NO_URLS), {
        clientId: 'raw-gated',
      });
      check(gated.ok, 'no-bit-3 pull succeeded');
      if (!gated.ok) return;
      const gatedRefs = responseSection(gated.message, 's1').body.filter(
        (frame) => frame.type === 'SEGMENT_REF',
      );
      check(gatedRefs.length >= 1, 'external descriptors were issued');
      check(
        gatedRefs.every(
          (ref) =>
            ref.type === 'SEGMENT_REF' &&
            ref.url === undefined &&
            ref.urlExpiresAtMs === undefined,
        ),
        'no accept bit 3 ⇒ no url fields (§5.4 issuance gating)',
      );

      const urled = await ctx.rawSync('raw-actor', pull(ALL_BITS), {
        clientId: 'raw-urled',
      });
      check(urled.ok, 'bit-3 pull succeeded');
      if (!urled.ok) return;
      const urledRefs = responseSection(urled.message, 's1').body.filter(
        (frame) => frame.type === 'SEGMENT_REF',
      );
      check(urledRefs.length >= 1, 'external descriptors were issued');
      check(
        urledRefs.every(
          (ref) =>
            ref.type === 'SEGMENT_REF' &&
            ref.url !== undefined &&
            ref.urlExpiresAtMs !== undefined,
        ),
        'accept bit 3 ⇒ url + urlExpiresAtMs, always paired (§5.4)',
      );
    },
  },
];
