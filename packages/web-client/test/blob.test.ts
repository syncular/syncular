import { describe, expect, test } from 'bun:test';
import { httpBlobTransport } from '@syncular/client';
import { decodeMessage } from '@syncular/core';
import { BunClientDatabase } from '@syncular/client/bun';
import { deleteUnreferencedCachedBlobs, ensureBlobSchema } from '../src/blob';
import { defineOutboxControl } from '../src/outbox-control';
import { compileClientSchema, ensureLocalSchema } from '../src/schema';
import {
  CLIENT_SCHEMA,
  makeClient,
  makeServer,
  PARTITION,
  SERVER_SCHEMA,
  taskValues,
  outcomeOf,
} from './helpers';

describe('blob retention', () => {
  test('keeps valid visible references and removes unrelated bodies', () => {
    const db = new BunClientDatabase();
    const schema = compileClientSchema({
      version: 1,
      tables: [
        {
          name: 'attachments',
          primaryKey: 'id',
          columns: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'body', type: 'blob_ref', nullable: true },
            { name: 'preview', type: 'blob_ref', nullable: true },
          ],
          scopes: ['attachment:{id}'],
        },
        {
          name: 'avatars',
          primaryKey: 'id',
          columns: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'photo', type: 'blob_ref', nullable: true },
          ],
          scopes: ['avatar:{id}'],
        },
      ],
    });
    ensureLocalSchema(db, schema);
    ensureBlobSchema(db);
    const target = 'sha256:target';
    db.exec(
      `INSERT INTO attachments VALUES
       ('one', ?, ?, 0),
       ('two', ?, 'malformed', 0),
       ('three', 12, ?, 0)`,
      [
        JSON.stringify({ blobId: target, byteLength: 1 }),
        JSON.stringify({ blobId: target, byteLength: 1 }),
        JSON.stringify({ blobId: target, byteLength: 1 }),
        JSON.stringify({ blobId: target, byteLength: 1 }),
      ],
    );
    db.exec(
      `INSERT INTO avatars VALUES
       ('one', ?, 0),
       ('two', '{"blobId":12}', 0)`,
      [JSON.stringify({ blobId: target, byteLength: 1 })],
    );
    db.exec(
      `INSERT INTO _syncular_blobs(blob_id, bytes, byte_length, media_type, created_at_ms)
       VALUES (?, X'01', 1, NULL, 0), ('sha256:other', X'02', 1, NULL, 0)`,
      [target],
    );

    deleteUnreferencedCachedBlobs(db, schema);

    expect(
      db.query('SELECT blob_id FROM _syncular_blobs ORDER BY blob_id'),
    ).toEqual([{ blob_id: target }]);
    db.close();
  });
});

const ATTACHMENTS = {
  name: 'attachments',
  primaryKey: 'id',
  columns: [
    { name: 'id', type: 'string', nullable: false },
    { name: 'project_id', type: 'string', nullable: false },
    { name: 'file', type: 'blob_ref', nullable: true },
  ],
  scopes: ['project:{project_id}'],
} as const;

describe('refused blob uploads (§5.9.7)', () => {
  test('a non-retryable refusal rejects the referencing commit and the round continues', async () => {
    const refusedBytes = new Uint8Array(32).fill(7);
    const puts: string[] = [];
    let refusedId = '';
    const fetchStub = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/upload-grant'))
        return Response.json({}, { status: 200 });
      const blobId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      puts.push(blobId);
      if (init?.method === 'PUT' && blobId === refusedId) {
        return Response.json(
          {
            code: 'blob.too_large',
            message: 'blob exceeds the byte cap',
            retryable: false,
          },
          { status: 413 },
        );
      }
      return new Response(null, { status: 200 });
    };
    const server = makeServer({
      version: 1,
      tables: [...SERVER_SCHEMA.tables, ATTACHMENTS],
    });
    const local = await makeClient(server, {
      clientId: 'refused-blob',
      schema: { version: 1, tables: [...CLIENT_SCHEMA.tables, ATTACHMENTS] },
      realtimePolicy: 'off',
      blobs: httpBlobTransport('https://blobs.test/blobs', {
        fetch: Object.assign(fetchStub, { preconnect: fetch.preconnect }),
      }),
    });
    const refused = await local.client.uploadBlob(refusedBytes);
    refusedId = refused.blobId;
    const refusedCommit = local.client.mutate([
      {
        table: 'attachments',
        op: 'upsert',
        values: {
          id: 'big',
          project_id: 'p1',
          file: local.client.blobRefString(refused),
        },
      },
    ]);
    local.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('unrelated', 'p1') },
    ]);

    const summary = await local.client.syncUntilIdle();
    expect(summary.pushed).toBe(1);
    expect(puts).toEqual([refused.blobId]);
    expect(local.client.pendingCommits()).toHaveLength(0);
    expect(
      local.db.query('SELECT blob_id FROM _syncular_blob_uploads'),
    ).toEqual([]);
    // The refusal is the commit's durable outcome, with the server's code.
    expect(local.client.rejections()).toMatchObject([
      {
        clientCommitId: refusedCommit,
        code: 'blob.too_large',
        retryable: false,
      },
    ]);
    expect(outcomeOf(local.client.commitDelivery(refusedCommit))?.status).toBe(
      'rejected',
    );
    expect(
      local.client.query('SELECT id FROM attachments ORDER BY id'),
    ).toEqual([]);
    expect(await server.storage.getRow(PARTITION, 'attachments', 'big')).toBe(
      undefined,
    );
    expect(
      await server.storage.getRow(PARTITION, 'tasks', 'unrelated'),
    ).toBeDefined();
    await local.client.close();
    local.db.close();
  });

  test('a retryable refusal keeps the staged upload and fails the round', async () => {
    const local = await makeClient(
      makeServer({ version: 1, tables: [ATTACHMENTS] }),
      {
        clientId: 'retryable-blob',
        schema: { version: 1, tables: [ATTACHMENTS] },
        realtimePolicy: 'off',
        blobs: {
          upload: async () => {
            throw Object.assign(new Error('storage busy'), {
              code: 'sync.internal_error',
              retryable: true,
            });
          },
          download: async () => ({ kind: 'bytes', bytes: new Uint8Array() }),
        },
      },
    );
    const ref = await local.client.uploadBlob(new Uint8Array([9]));
    local.client.mutate([
      {
        table: 'attachments',
        op: 'upsert',
        values: {
          id: 'kept',
          project_id: 'p1',
          file: local.client.blobRefString(ref),
        },
      },
    ]);
    await expect(local.client.sync()).rejects.toMatchObject({
      code: 'sync.internal_error',
    });
    expect(local.client.pendingCommits()).toHaveLength(1);
    expect(
      local.db.query('SELECT blob_id FROM _syncular_blob_uploads'),
    ).toEqual([{ blob_id: ref.blobId }]);
    expect(local.client.rejections()).toEqual([]);
    await local.client.close();
    local.db.close();
  });
});

describe('blob uploads follow the transport gate (§8.8)', () => {
  async function gated() {
    const puts: string[] = [];
    const state = { refuse: false };
    const fetchStub = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/upload-grant'))
        return Response.json({}, { status: 200 });
      if (init?.method !== 'PUT') return new Response(null, { status: 200 });
      puts.push(decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)));
      return state.refuse
        ? Response.json(
            {
              code: 'blob.too_large',
              message: 'blob exceeds the byte cap',
              retryable: false,
            },
            { status: 413 },
          )
        : new Response(null, { status: 200 });
    };
    const server = makeServer({
      version: 1,
      tables: [...SERVER_SCHEMA.tables, ATTACHMENTS],
    });
    const local = await makeClient(server, {
      clientId: 'gated-blob',
      schema: { version: 1, tables: [...CLIENT_SCHEMA.tables, ATTACHMENTS] },
      realtimePolicy: 'off',
      outboxControl: defineOutboxControl(),
      blobs: httpBlobTransport('https://blobs.test/blobs', {
        fetch: Object.assign(fetchStub, { preconnect: fetch.preconnect }),
      }),
    });
    local.client.setTransportGate('pull');
    const attach = (id: string, ref: string) =>
      local.client.mutate([
        {
          table: 'attachments',
          op: 'upsert',
          values: { id, project_id: 'p1', file: ref },
        },
      ]);
    const held = (id: string) => ({
      pending: local.client
        .pendingCommits()
        .some((commit) => commit.clientCommitId === id),
      outcome: outcomeOf(local.client.commitDelivery(id)),
      attempted: local.db.query(
        'SELECT attempted FROM _syncular_outbox WHERE client_commit_id=?',
        [id],
      ),
    });
    // The test server has no blob store, so it refuses the landed commit;
    // what this checks is that the client pushes it exactly once.
    const pushes = (id: string) =>
      local.requests.filter((bytes) =>
        decodeMessage(bytes).frames.some(
          (frame) =>
            frame.type === 'PUSH_COMMIT' && frame.clientCommitId === id,
        ),
      ).length;
    return { puts, state, server, local, attach, held, pushes };
  }

  test('a host flush and a round leave a held commit and its blob alone', async () => {
    const { puts, state, local, attach, held, pushes } = await gated();
    const blob = await local.client.uploadBlob(new Uint8Array(8).fill(1));
    const prefix = local.client.mutate([
      { table: 'tasks', op: 'upsert', values: taskValues('t1', 'p1') },
    ]);
    const tail = attach('a1', local.client.blobRefString(blob));
    state.refuse = true;
    const untouched = held(tail);
    expect(untouched).toEqual({
      pending: true,
      outcome: undefined,
      attempted: [{ attempted: 0 }],
    });
    // `pull`: neither a host flush nor a round uploads.
    await local.client.flushBlobUploads();
    await local.client.syncUntilIdle();
    expect(puts).toEqual([]);
    expect(held(tail)).toEqual(untouched);
    // `through`: only the prefix's blobs, and this prefix has none.
    local.client.setTransportGate({ through: prefix });
    await local.client.flushBlobUploads();
    await local.client.syncUntilIdle();
    expect(puts).toEqual([]);
    expect(outcomeOf(local.client.commitDelivery(prefix))?.status).toBe(
      'applied',
    );
    expect(held(tail)).toEqual(untouched);
    expect(local.client.rejections()).toEqual([]);
    // Open, with the blob service accepting: the commit is pushed once.
    state.refuse = false;
    local.client.setTransportGate('open');
    await local.client.syncUntilIdle();
    expect(puts).toEqual([blob.blobId]);
    expect(pushes(tail)).toBe(1);
    await local.client.close();
    local.db.close();
  });

  test('a refusal for a due commit leaves a held commit on the same body pending', async () => {
    const { puts, state, local, attach, held, pushes } = await gated();
    const blob = await local.client.uploadBlob(new Uint8Array(8).fill(2));
    const ref = local.client.blobRefString(blob);
    const due = attach('photo', ref);
    const tail = attach('photo-copy', ref);
    state.refuse = true;
    local.client.setTransportGate({ through: due });
    await local.client.syncUntilIdle();
    // The due commit takes the refusal as its terminal outcome, as before.
    expect(puts).toEqual([blob.blobId]);
    expect(local.client.rejections()).toMatchObject([
      { clientCommitId: due, code: 'blob.too_large', retryable: false },
    ]);
    // The held commit naming the same body is untouched; the body stays queued.
    expect(held(tail)).toEqual({
      pending: true,
      outcome: undefined,
      attempted: [{ attempted: 0 }],
    });
    expect(
      local.db.query('SELECT blob_id FROM _syncular_blob_uploads'),
    ).toEqual([{ blob_id: blob.blobId }]);
    // Once due and accepted, the body uploads again and the commit is pushed once.
    state.refuse = false;
    local.client.setTransportGate('open');
    await local.client.syncUntilIdle();
    expect(puts).toEqual([blob.blobId, blob.blobId]);
    expect([pushes(due), pushes(tail)]).toEqual([0, 1]);
    await local.client.close();
    local.db.close();
  });
});
