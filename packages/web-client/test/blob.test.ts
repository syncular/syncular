import { describe, expect, test } from 'bun:test';
import { BunClientDatabase } from '@syncular/client/bun';
import { ensureBlobSchema, reconcileBlobRefcounts } from '../src/blob';
import { compileClientSchema, ensureLocalSchema } from '../src/schema';

describe('targeted blob refcount reconciliation', () => {
  test('counts valid references across columns without rewriting other bodies', () => {
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
      `INSERT INTO _syncular_blobs(blob_id, bytes, byte_length, refcount, created_at_ms, last_used_ms)
       VALUES (?, X'01', 1, 0, 0, 0), ('sha256:other', X'02', 1, 77, 0, 0)`,
      [target],
    );

    reconcileBlobRefcounts(db, schema, { blobId: target });

    expect(
      db.query(
        'SELECT blob_id, refcount FROM _syncular_blobs ORDER BY blob_id',
      ),
    ).toEqual([
      { blob_id: 'sha256:other', refcount: 77 },
      { blob_id: target, refcount: 5 },
    ]);
    db.close();
  });
});
