/**
 * Blobs / file attachments (SPEC.md §5.9; Appendix B.13). Upload→reference→
 * push→other-client-fetch, push referencing a missing blob fails loud
 * (`blob.not_found`), the cross-scope fetch probe is denied
 * (`blob.forbidden`), revocation purges cache refs, and a cache hit avoids a
 * re-download (asserted with the harness blob-download counter).
 *
 * The blob-bearing schema is scenario-local: `attachments` has a `blob_ref`
 * column scoped by `project_id`, so download authorization derives from the
 * owning row (§5.9.5). Both pairings run these (the Rust core bridges the
 * blob transport through the shim).
 */
import { check, checkEqual } from '../checks';
import type { DriverRow, DriverSchema } from '../driver';
import type { ClientHandle, Scenario, ScenarioContext } from '../scenario';
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
];
