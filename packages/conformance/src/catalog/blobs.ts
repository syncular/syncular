/**
 * Blobs / file attachments (SPEC.md §5.9; Appendix B.13). Upload→reference→
 * push→other-client-fetch, push referencing a missing blob fails loud
 * (`blob.not_found`), the cross-scope fetch probe is denied
 * (`blob.forbidden`), revocation purges cache refs, and a cache hit avoids a
 * re-download (asserted with the harness blob-download counter). Plus the
 * presigned E2E rungs (§5.9.3/§5.9.5): presigned download consumed at the CDN
 * hop, expiry→fresh-url recovery, presigned upload grant→PUT→reference→fetch,
 * cache persistence across a client-core restart, and LRU cap eviction that
 * respects refcounts/pins.
 *
 * The blob-bearing schema is scenario-local: `attachments` has a `blob_ref`
 * column scoped by `project_id`, so download authorization derives from the
 * owning row (§5.9.5). Both pairings run these (the Rust core bridges the
 * blob transport through the shim).
 */
import { check, checkEqual } from '../checks';
import type { DriverRow, DriverSchema } from '../driver';
import {
  type ClientHandle,
  DEFAULT_NOW_MS,
  type Scenario,
  type ScenarioContext,
} from '../scenario';
import { syncIdle } from './util';

const P1 = { project_id: ['p1'] } as const;
const P2 = { project_id: ['p2'] } as const;

/** A schema with a blob_ref column (§2.4 tag 7), scoped by project. */
const BLOB_SCHEMA: DriverSchema = {
  version: 1,
  tables: [
    {
      name: 'attachments',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
        { name: 'file', type: 'blob_ref', nullable: true },
      ],
      primaryKey: 'id',
      scopes: [{ pattern: 'project:{project_id}' }],
    },
  ],
};

const BLOB_SERVER = { schema: BLOB_SCHEMA } as const;

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(bytes: { readonly $bytes: string }): string {
  const hex = bytes.$bytes;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(out);
}

function attachmentRow(
  id: string,
  projectId: string,
  fileRef: string | null,
  title = 'attachment',
): DriverRow {
  return { id, project_id: projectId, title, file: fileRef };
}

async function requireBlobs(client: ClientHandle): Promise<void> {
  check(
    typeof client.api.uploadBlob === 'function' &&
      typeof client.api.fetchBlob === 'function',
    'client driver must support the blob API for these scenarios',
  );
}

export const blobScenarios: readonly Scenario[] = [
  {
    // B.13(a): upload → reference → push → other-client fetch, plus
    // B.13(e): a second read of the same blob serves from cache (no fetch).
    name: 'blobs/upload-reference-push-fetch',
    specRefs: ['§5.9.3', '§5.9.5', '§5.9.7', '§6.6', 'B.13'],
    requires: ['blobs'],
    server: BLOB_SERVER,
    async run(ctx: ScenarioContext) {
      const author = await ctx.newClient({
        actorId: 'author',
        clientId: 'client-author',
        schema: BLOB_SCHEMA,
        allowed: P1,
      });
      await requireBlobs(author);
      await author.api.subscribe({
        id: 'a',
        table: 'attachments',
        scopes: P1,
      });
      await syncIdle(author);

      // Stage a blob, then reference it from a row (upload-before-push, B4).
      const payload = 'hello, this is an attached file';
      const ref = await author.api.uploadBlob?.(bytesOf(payload), {
        mediaType: 'text/plain',
        name: 'note.txt',
      });
      check(ref !== undefined, 'uploadBlob returned a ref string');
      await author.api.mutate([
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow('att1', 'p1', ref ?? null),
        },
      ]);
      const pushed = await syncIdle(author);
      checkEqual(
        pushed.rejected,
        [],
        'the push with a referenced blob applied',
      );
      check(
        author.blobUploads.length >= 1,
        'the blob was uploaded before the push (§5.9.7 B4)',
      );

      // A second client in the same scope pulls the row and fetches bytes.
      const reader = await ctx.newClient({
        actorId: 'reader',
        clientId: 'client-reader',
        schema: BLOB_SCHEMA,
        allowed: P1,
      });
      await reader.api.subscribe({
        id: 'a',
        table: 'attachments',
        scopes: P1,
      });
      await syncIdle(reader);
      const localRows = await reader.api.readRows('attachments');
      checkEqual(localRows.length, 1, 'reader received the referencing row');
      const fileRef = localRows[0]?.values.file;
      check(
        typeof fileRef === 'string',
        'the blob_ref column arrived as a canonical string',
      );

      const fetched = await reader.api.fetchBlob?.(fileRef as string);
      check(fetched !== undefined, 'reader fetched the blob bytes');
      checkEqual(
        fetched === undefined ? '' : decode(fetched),
        payload,
        'downloaded bytes equal the uploaded bytes (content addressing)',
      );
      checkEqual(
        reader.blobDownloads.length,
        1,
        'exactly one download for the first fetch',
      );

      // B.13(e): the cache hit avoids a re-download.
      const again = await reader.api.fetchBlob?.(fileRef as string);
      checkEqual(
        again === undefined ? '' : decode(again),
        payload,
        'cache hit returns identical bytes',
      );
      checkEqual(
        reader.blobDownloads.length,
        1,
        'a cache hit performs no second download (§5.9.7 B1)',
      );

      // The author reads its own blob straight from cache (no download).
      const authorFetch = await author.api.fetchBlob?.(ref ?? '');
      checkEqual(
        authorFetch === undefined ? '' : decode(authorFetch),
        payload,
        'author serves its own upload from cache',
      );
      checkEqual(
        author.blobDownloads.length,
        0,
        'the uploader never downloads its own blob',
      );
    },
  },

  {
    // B.13(b): a push referencing a blob that was never uploaded is
    // rejected loud with blob.not_found; no dangling reference enters the
    // log (§5.9.6, §6.6).
    name: 'blobs/push-missing-blob-fails-loud',
    specRefs: ['§5.9.6', '§6.6', 'B.13'],
    requires: ['blobs'],
    server: BLOB_SERVER,
    async run(ctx: ScenarioContext) {
      const author = await ctx.newClient({
        actorId: 'author',
        clientId: 'client-author',
        schema: BLOB_SCHEMA,
        allowed: P1,
      });
      await author.api.subscribe({
        id: 'a',
        table: 'attachments',
        scopes: P1,
      });
      await syncIdle(author);

      // Reference a fabricated blobId that was never uploaded.
      const fakeBlobId = `sha256:${'0'.repeat(64)}`;
      const ref = JSON.stringify({ blobId: fakeBlobId, byteLength: 3 });
      await author.api.mutate([
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow('att-bad', 'p1', ref),
        },
      ]);
      const report = await syncIdle(author);
      checkEqual(
        report.rejected.length,
        1,
        'the commit referencing an absent blob is rejected (§6.6)',
      );
      const rejections = await author.api.rejections();
      checkEqual(
        rejections[0]?.code,
        'blob.not_found',
        'the rejection code is blob.not_found (§5.9.6)',
      );
      // No dangling reference reached the server log.
      checkEqual(
        (await ctx.server.readRows('attachments')).length,
        0,
        'no row with a dangling blob reference landed server-side',
      );
    },
  },

  {
    // B.13(c): the cross-scope probe — an actor holding a different scope
    // that learns the blobId (e.g. from a leaked ref) is denied, because no
    // row it may see references the blob. A blobId is never a capability.
    name: 'blobs/cross-scope-fetch-denied',
    specRefs: ['§5.9.5', 'B.13'],
    requires: ['blobs'],
    server: BLOB_SERVER,
    async run(ctx: ScenarioContext) {
      const owner = await ctx.newClient({
        actorId: 'owner',
        clientId: 'client-owner',
        schema: BLOB_SCHEMA,
        allowed: P1,
      });
      await owner.api.subscribe({
        id: 'a',
        table: 'attachments',
        scopes: P1,
      });
      await syncIdle(owner);
      const secret = 'p1-only secret bytes';
      const ref = await owner.api.uploadBlob?.(bytesOf(secret));
      check(ref !== undefined, 'owner uploaded the blob');
      await owner.api.mutate([
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow('att1', 'p1', ref ?? null),
        },
      ]);
      await syncIdle(owner);
      const blobId = JSON.parse(ref ?? '{}').blobId as string;

      // An intruder in a DIFFERENT scope tries to fetch the blobId directly.
      const intruder = await ctx.newClient({
        actorId: 'intruder',
        clientId: 'client-intruder',
        schema: BLOB_SCHEMA,
        allowed: P2,
      });
      let denied = false;
      let code = '';
      try {
        await intruder.api.fetchBlob?.(blobId);
      } catch (error) {
        denied = true;
        code = (error as { code?: string }).code ?? '';
      }
      check(denied, 'a cross-scope blob fetch is denied (§5.9.5)');
      checkEqual(
        code,
        'blob.forbidden',
        'the denial is blob.forbidden — a blobId is never a capability',
      );
      checkEqual(
        intruder.blobDownloads.length,
        1,
        'the download endpoint was reached and refused (not a client short-circuit)',
      );
    },
  },

  {
    // B.13(d): revocation drops blob-cache references and deletes the
    // now-unauthorized cached body (evicted ≠ revoked, §5.9.7 B2).
    name: 'blobs/revocation-purges-cache-refs',
    specRefs: ['§3.3', '§5.9.7', 'B.13'],
    requires: ['blobs'],
    server: BLOB_SERVER,
    async run(ctx: ScenarioContext) {
      // Owner uploads + references the blob in p1.
      const owner = await ctx.newClient({
        actorId: 'owner',
        clientId: 'client-owner',
        schema: BLOB_SCHEMA,
        allowed: P1,
      });
      await owner.api.subscribe({
        id: 'a',
        table: 'attachments',
        scopes: P1,
      });
      await syncIdle(owner);
      const ref = await owner.api.uploadBlob?.(bytesOf('revocable bytes'));
      await owner.api.mutate([
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow('att1', 'p1', ref ?? null),
        },
      ]);
      await syncIdle(owner);

      // A reader in p1 pulls the row and fetches (caches) the blob.
      const reader = await ctx.newClient({
        actorId: 'reader',
        clientId: 'client-reader',
        schema: BLOB_SCHEMA,
        allowed: P1,
      });
      await reader.api.subscribe({
        id: 'a',
        table: 'attachments',
        scopes: P1,
      });
      await syncIdle(reader);
      const fileRef = (await reader.api.readRows('attachments'))[0]?.values
        .file as string;
      await reader.api.fetchBlob?.(fileRef);
      checkEqual(reader.blobDownloads.length, 1, 'reader cached the blob');

      // Revoke the reader's p1 grant; next sync purges the row.
      await ctx.server.setAllowedScopes('reader', {});
      const report = await syncIdle(reader);
      check(
        report.revoked.includes('a'),
        'the subscription was revoked (§3.3)',
      );
      checkEqual(
        (await reader.api.readRows('attachments')).length,
        0,
        'the scoped row was purged',
      );

      // §5.9.7 B2: the now-unauthorized body was deleted — re-fetching it
      // requires a fresh download (cache miss).
      let refetchDenied = false;
      try {
        await reader.api.fetchBlob?.(fileRef);
      } catch {
        refetchDenied = true;
      }
      check(
        reader.blobDownloads.length === 2 || refetchDenied,
        'the revoked body is no longer a cache hit — a re-fetch downloads or is denied (§5.9.7 B2)',
      );
    },
  },

  {
    // B.13(f): presigned download consumed — the consumer's fetchBlob receives
    // a signed url and fetches the bytes from the CDN hop; the harness counts
    // the url fetch and ZERO authorized-endpoint byte serves (the server exited
    // the egress path). Content address verified (§5.9.5 always-issue).
    name: 'blobs/presigned-download-consumed',
    specRefs: ['§5.9.5', 'B.13'],
    requires: ['blobs', 'blob-presign'],
    server: BLOB_SERVER,
    async run(ctx: ScenarioContext) {
      await ctx.server.setBlobPresign?.(true);
      const owner = await ctx.newClient({
        actorId: 'owner',
        clientId: 'client-owner',
        schema: BLOB_SCHEMA,
        allowed: P1,
        // Pin the client clock to the server's virtual now — the §5.9.5 url
        // expiry check compares against it (as the §5.4 signed-url scenarios).
        nowMs: DEFAULT_NOW_MS,
      });
      await requireBlobs(owner);
      await owner.api.subscribe({ id: 'a', table: 'attachments', scopes: P1 });
      await syncIdle(owner);
      const payload = 'presigned image bytes';
      const ref = await owner.api.uploadBlob?.(bytesOf(payload), {
        mediaType: 'text/plain',
      });
      await owner.api.mutate([
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow('att1', 'p1', ref ?? null),
        },
      ]);
      await syncIdle(owner);

      const reader = await ctx.newClient({
        actorId: 'reader',
        clientId: 'client-reader',
        schema: BLOB_SCHEMA,
        allowed: P1,
        nowMs: DEFAULT_NOW_MS,
      });
      await reader.api.subscribe({ id: 'a', table: 'attachments', scopes: P1 });
      await syncIdle(reader);
      const fileRef = (await reader.api.readRows('attachments'))[0]?.values
        .file as string;
      const fetched = await reader.api.fetchBlob?.(fileRef);
      checkEqual(
        fetched === undefined ? '' : decode(fetched),
        payload,
        'presigned download returns the uploaded bytes (content addressing)',
      );
      // The authorized endpoint was hit exactly once (to mint the url)...
      checkEqual(
        reader.blobDownloads.length,
        1,
        'one authorized-endpoint request minted the url',
      );
      // ...and the actual bytes rode the CDN hop, not the endpoint.
      checkEqual(
        reader.blobUrlFetches.length,
        1,
        'the bytes were fetched from the presigned url — the CDN hop (§5.9.5)',
      );

      // A second read is a cache hit: no endpoint request, no CDN hop.
      await reader.api.fetchBlob?.(fileRef);
      checkEqual(
        reader.blobDownloads.length,
        1,
        'a cache hit performs no second authorized-endpoint request (B1)',
      );
      checkEqual(
        reader.blobUrlFetches.length,
        1,
        'a cache hit performs no second CDN hop (B1)',
      );
    },
  },

  {
    // B.13(g): a failed presigned download never falls through — recovery is a
    // fresh request. Two probes on the §5.9.5 recovery rule: (1) a lost CDN hop
    // fails the fetch and caches nothing, no direct-byte fall-through; then the
    // re-request re-mints a url and converges. (2) the no-fetch-past-expiry
    // MUST: a client clock past `urlExpiresAtMs` refuses to fetch.
    name: 'blobs/presigned-download-expiry-recovers',
    specRefs: ['§5.9.5', 'B.13'],
    requires: ['blobs', 'blob-presign'],
    server: BLOB_SERVER,
    async run(ctx: ScenarioContext) {
      await ctx.server.setBlobPresign?.(true);
      const owner = await ctx.newClient({
        actorId: 'owner',
        clientId: 'client-owner',
        schema: BLOB_SCHEMA,
        allowed: P1,
        nowMs: DEFAULT_NOW_MS,
      });
      await owner.api.subscribe({ id: 'a', table: 'attachments', scopes: P1 });
      await syncIdle(owner);
      const payload = 'expiring bytes';
      const ref = await owner.api.uploadBlob?.(bytesOf(payload));
      await owner.api.mutate([
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow('att1', 'p1', ref ?? null),
        },
      ]);
      await syncIdle(owner);

      const reader = await ctx.newClient({
        actorId: 'reader',
        clientId: 'client-reader',
        schema: BLOB_SCHEMA,
        allowed: P1,
        nowMs: DEFAULT_NOW_MS,
      });
      await reader.api.subscribe({ id: 'a', table: 'attachments', scopes: P1 });
      await syncIdle(reader);
      const fileRef = (await reader.api.readRows('attachments'))[0]?.values
        .file as string;

      // Probe 1 — loss ⇒ re-request, never fall-through.
      // First attempt: drop the CDN hop (a transport loss) — the fetch fails,
      // nothing is cached, and there is no fall-through to a direct byte serve.
      reader.faults.dropNextUrlFetches = 1;
      let failed = false;
      try {
        await reader.api.fetchBlob?.(fileRef);
      } catch {
        failed = true;
      }
      check(failed, 'a lost presigned-url fetch fails the fetchBlob (§5.9.5)');
      // Recovery: the re-request mints a fresh url and the retry converges.
      const fetched = await reader.api.fetchBlob?.(fileRef);
      checkEqual(
        fetched === undefined ? '' : decode(fetched),
        payload,
        'the re-request minted a fresh url and converged (§5.9.5 recovery)',
      );
      check(
        reader.blobDownloads.length >= 2,
        'recovery re-requested the authorized endpoint (fresh url), not a detour',
      );

      // Probe 2 — no fetch past expiry. A second reader whose clock is beyond
      // the url TTL refuses to fetch (the url is born expired to it).
      const late = await ctx.newClient({
        actorId: 'late',
        clientId: 'client-late',
        schema: BLOB_SCHEMA,
        allowed: P1,
        // 900 s TTL + a margin: the minted url's urlExpiresAtMs < this clock.
        nowMs: DEFAULT_NOW_MS + 1_000_000,
      });
      await late.api.subscribe({ id: 'a', table: 'attachments', scopes: P1 });
      await syncIdle(late);
      const lateRef = (await late.api.readRows('attachments'))[0]?.values
        .file as string;
      let expiredRefused = false;
      let code = '';
      try {
        await late.api.fetchBlob?.(lateRef);
      } catch (error) {
        expiredRefused = true;
        code = (error as { code?: string }).code ?? '';
      }
      check(
        expiredRefused,
        'a url past urlExpiresAtMs is never fetched (§5.9.5 no-fetch-past-expiry)',
      );
      checkEqual(
        late.blobUrlFetches.length,
        0,
        'MUST NOT start a fetch past expiry — zero CDN hops',
      );
      void code;
    },
  },

  {
    // B.13(h): presigned upload grant→PUT→reference→fetch. The uploader obtains
    // a grant and PUTs bytes direct-to-storage (the harness counts the direct
    // PUT, not a server upload); the push existence check passes; another
    // client fetches the bytes (§5.9.3 grant flow).
    name: 'blobs/presigned-upload-grant-flow',
    specRefs: ['§5.9.3', '§5.9.6', 'B.13'],
    requires: ['blobs', 'blob-presign'],
    server: BLOB_SERVER,
    async run(ctx: ScenarioContext) {
      await ctx.server.setBlobPresign?.(true);
      const author = await ctx.newClient({
        actorId: 'author',
        clientId: 'client-author',
        schema: BLOB_SCHEMA,
        allowed: P1,
        nowMs: DEFAULT_NOW_MS,
      });
      await requireBlobs(author);
      await author.api.subscribe({
        id: 'a',
        table: 'attachments',
        scopes: P1,
      });
      await syncIdle(author);
      const payload = 'direct-to-storage bytes';
      const ref = await author.api.uploadBlob?.(bytesOf(payload), {
        mediaType: 'text/plain',
      });
      await author.api.mutate([
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow('att1', 'p1', ref ?? null),
        },
      ]);
      const pushed = await syncIdle(author);
      checkEqual(pushed.rejected, [], 'the push with a granted blob applied');
      // The bytes rode the presigned direct PUT, not the server upload path.
      checkEqual(
        author.blobDirectPuts.length,
        1,
        'the blob was PUT direct-to-storage via the grant (§5.9.3)',
      );
      checkEqual(
        author.blobUploads.length,
        0,
        'no server upload — the grant flow bypassed the server bandwidth path',
      );

      // Another client fetches the bytes (via presigned download).
      const reader = await ctx.newClient({
        actorId: 'reader',
        clientId: 'client-reader',
        schema: BLOB_SCHEMA,
        allowed: P1,
        nowMs: DEFAULT_NOW_MS,
      });
      await reader.api.subscribe({ id: 'a', table: 'attachments', scopes: P1 });
      await syncIdle(reader);
      const fileRef = (await reader.api.readRows('attachments'))[0]?.values
        .file as string;
      const fetched = await reader.api.fetchBlob?.(fileRef);
      checkEqual(
        fetched === undefined ? '' : decode(fetched),
        payload,
        'the granted-upload bytes are downloadable by another client',
      );
    },
  },

  {
    // B.13(i): cache persistence across a client-core restart. A client
    // uploads/fetches a blob, then its core is recreated on the SAME database
    // (same schema version ⇒ no wipe); a post-restart fetchBlob serves from
    // cache with NO network — the download counter proves the body survived.
    name: 'blobs/cache-persists-across-restart',
    specRefs: ['§5.9.7', 'B.13'],
    requires: ['blobs'],
    server: BLOB_SERVER,
    async run(ctx: ScenarioContext) {
      const owner = await ctx.newClient({
        actorId: 'owner',
        clientId: 'client-owner',
        schema: BLOB_SCHEMA,
        allowed: P1,
      });
      if (owner.api.recreateWithSchema === undefined) return; // driver predates it
      await owner.api.subscribe({ id: 'a', table: 'attachments', scopes: P1 });
      await syncIdle(owner);
      const payload = 'bytes that survive a reboot';
      const ref = await owner.api.uploadBlob?.(bytesOf(payload));
      await owner.api.mutate([
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow('att1', 'p1', ref ?? null),
        },
      ]);
      await syncIdle(owner);
      const blobId = JSON.parse(ref ?? '{}').blobId as string;
      // The uploader never downloads its own blob.
      checkEqual(owner.blobDownloads.length, 0, 'no download before restart');

      // Restart the client core on the SAME database (same schema ⇒ no wipe).
      await ctx.recreateClient(owner, BLOB_SCHEMA);

      // Post-restart fetch is a cache hit — no network download.
      const fetched = await owner.api.fetchBlob?.(blobId);
      checkEqual(
        fetched === undefined ? '' : decode(fetched),
        payload,
        'the blob body survived the restart and served from cache',
      );
      checkEqual(
        owner.blobDownloads.length,
        0,
        'no download after restart — the cached body persisted (§5.9.7 B1)',
      );
    },
  },

  {
    // B.13(j): LRU cap eviction respects refcounts/pins. With a small cache
    // cap, staging bodies past the cap evicts zero-ref bodies LRU-first, while
    // a still-referenced body and a pending-upload-pinned body are retained
    // (B1 cap + eviction).
    name: 'blobs/lru-eviction-respects-refcounts',
    specRefs: ['§5.9.7', 'B.13'],
    requires: ['blobs'],
    server: BLOB_SERVER,
    async run(ctx: ScenarioContext) {
      // A ~300-byte cache cap: each body below is 100 bytes, so at most 3 fit.
      const owner = await ctx.newClient({
        actorId: 'owner',
        clientId: 'client-owner',
        schema: BLOB_SCHEMA,
        allowed: P1,
        limits: { blobCacheMaxBytes: 300 },
      });
      await requireBlobs(owner);
      await owner.api.subscribe({ id: 'a', table: 'attachments', scopes: P1 });
      await syncIdle(owner);

      const body = (fill: string) => bytesOf(fill.repeat(100));
      // Body A: referenced by a pushed+drained row (refcount 1, pinned by ref).
      const refA = await owner.api.uploadBlob?.(body('a'));
      const idA = JSON.parse(refA ?? '{}').blobId as string;
      await owner.api.mutate([
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow('attA', 'p1', refA ?? null),
        },
      ]);
      await syncIdle(owner); // A's upload drains; its row references it.

      // Bodies B, C, D: staged but NOT referenced (zero-ref once uploaded).
      // We fetch them (not upload-stage) so they are not pinned by the outbox.
      // Stage-then-fetch a fresh unreferenced body by uploading + fetching so
      // it lands in cache zero-ref: upload pins via outbox, so instead push a
      // referencing row then delete it to reach zero-ref cleanly.
      const stageZeroRef = async (
        id: string,
        fill: string,
      ): Promise<string> => {
        const ref = await owner.api.uploadBlob?.(body(fill));
        await owner.api.mutate([
          {
            op: 'upsert',
            table: 'attachments',
            values: attachmentRow(id, 'p1', ref ?? null),
          },
        ]);
        await syncIdle(owner); // upload drains (unpins), row references it
        await owner.api.mutate([
          { op: 'delete', table: 'attachments', rowId: id },
        ]);
        await syncIdle(owner); // row gone ⇒ body is zero-ref, retained (LRU)
        return JSON.parse(ref ?? '{}').blobId as string;
      };
      const idC = await stageZeroRef('attC', 'c');
      const idD = await stageZeroRef('attD', 'd');
      // Touch D so it is more-recently-used than C (C evicts before D).
      await owner.api.fetchBlob?.(idD);
      // Adding E pushes total over the cap ⇒ evict the LRU zero-ref body (C).
      // A stays (refcount 1, referenced) and E is the newest (retained).
      const idE = await stageZeroRef('attE', 'e');
      void idE;

      // A is referenced ⇒ never evicted; it remains a cache hit (no download).
      const beforeA = owner.blobDownloads.length;
      await owner.api.fetchBlob?.(idA);
      checkEqual(
        owner.blobDownloads.length,
        beforeA,
        'the referenced body A is retained (never evicted, §5.9.7 B1)',
      );

      // Re-reference C and D so the server authorizes their download again
      // (their rows were deleted to reach zero-ref; §5.9.5 authz derives from
      // a live row). Eviction is proved by the download counter on re-fetch.
      await owner.api.mutate([
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow(
            'refC',
            'p1',
            JSON.stringify({ blobId: idC, byteLength: 100 }),
          ),
        },
        {
          op: 'upsert',
          table: 'attachments',
          values: attachmentRow(
            'refD',
            'p1',
            JSON.stringify({ blobId: idD, byteLength: 100 }),
          ),
        },
      ]);
      await syncIdle(owner);

      // C was the LRU zero-ref body ⇒ evicted ⇒ a re-fetch is a cache miss.
      const beforeC = owner.blobDownloads.length;
      await owner.api.fetchBlob?.(idC);
      check(
        owner.blobDownloads.length > beforeC,
        'the LRU zero-ref body C was evicted — a re-fetch re-downloads (B1)',
      );
      // D was more-recently-used ⇒ retained ⇒ a re-fetch is a cache hit.
      const beforeD = owner.blobDownloads.length;
      await owner.api.fetchBlob?.(idD);
      checkEqual(
        owner.blobDownloads.length,
        beforeD,
        'the more-recently-used zero-ref body D is retained (B1 LRU)',
      );
    },
  },
];
