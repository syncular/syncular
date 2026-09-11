import { describe, expect, test } from 'bun:test';
import { BunClientDatabase } from '@syncular/client/bun';
import { deleteUnreferencedCachedBlobs, ensureBlobSchema } from '../src/blob';
import { compileClientSchema, ensureLocalSchema } from '../src/schema';

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
