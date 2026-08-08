import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeRow, type RowColumn } from '@syncular/core';
import { blobIdFor } from '../../src/blob-store';
import { compileSchema } from '../../src/schema';
import type { SqliteImageBuilder } from '../../src/sqlite-image';
import type { SqliteLeaseStore } from '../../src/sqlite-lease-store';
import type { SqliteSegmentStore } from '../../src/sqlite-segment-store';
import type { SqliteServerStorage } from '../../src/sqlite-storage';
import type { SqliteBlobStore } from '../../src/sqlite-blob-store';
import { StorageConstraintError } from '../../src/storage-errors';

interface Runtime {
  storage(path: string): SqliteServerStorage;
  segments(): SqliteSegmentStore;
  blobs(): SqliteBlobStore;
  leases(): SqliteLeaseStore;
  buildImage: SqliteImageBuilder;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`server-sqlite-contract: ${message}`);
}

export async function runServerSqliteContract(runtime: Runtime): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'syncular-server-contract-'));
  const path = join(directory, 'server.db');
  const columns: readonly RowColumn[] = [
    { name: 'id', type: 'string', nullable: false },
    { name: 'workspace_id', type: 'string', nullable: false },
    { name: 'title', type: 'string', nullable: false },
  ];
  const schema = compileSchema({
    version: 1,
    tables: [
      {
        name: 'tasks',
        columns,
        primaryKey: 'id',
        scopes: ['workspace:{workspace_id}'],
        indexes: [
          { name: 'tasks_unique_title', columns: ['title'], unique: true },
        ],
      },
    ],
  });
  const row = {
    rowId: 'task-1',
    serverVersion: 1,
    scopes: { workspace_id: 'workspace-1' },
    payload: encodeRow(columns, ['task-1', 'workspace-1', 'Prepare room']),
  };

  try {
    const storage = runtime.storage(path);
    await storage.ensureSchema(schema);
    const transaction = await storage.begin('hospital');
    await transaction.upsertRow('tasks', row);
    const commitSeq = await transaction.appendCommit({
      clientId: 'worker',
      clientCommitId: 'commit-1',
      actorId: 'system',
      createdAtMs: 1,
      changes: [
        {
          table: 'tasks',
          rowId: row.rowId,
          op: 'upsert',
          rowVersion: row.serverVersion,
          scopes: row.scopes,
          payload: row.payload,
        },
      ],
    });
    await transaction.commit();
    assert(commitSeq === 1, 'commit sequence');
    storage.db.close();

    const reopened = runtime.storage(path);
    await reopened.ensureSchema(schema);
    assert(
      (await reopened.getRow('hospital', 'tasks', row.rowId)) !== undefined,
      'persistent row',
    );
    assert(
      (await reopened.getMaxCommitSeq('hospital')) === 1,
      'persistent commit',
    );
    const conflicting = await reopened.begin('hospital');
    let constraint: unknown;
    try {
      await conflicting.upsertRow(
        'tasks',
        {
          ...row,
          rowId: 'task-2',
          payload: encodeRow(columns, [
            'task-2',
            'workspace-1',
            'Prepare room',
          ]),
        },
        { opIndex: 2 },
      );
    } catch (error) {
      constraint = error;
    } finally {
      await conflicting.rollback();
    }
    assert(
      constraint instanceof StorageConstraintError && constraint.opIndex === 2,
      'constraint classification',
    );
    reopened.db.close();

    const segments = runtime.segments();
    const storedSegment = await segments.put(
      {
        partition: 'hospital',
        table: 'tasks',
        schemaVersion: 1,
        mediaType: 'rows',
        scopeDigest: 'scope',
        asOfCommitSeq: 1,
        rowCount: 1,
        rowCursor: null,
        nextRowCursor: null,
      },
      new Uint8Array([1, 2, 3]),
      10,
    );
    assert(
      (await segments.get(storedSegment.segmentId)) !== undefined,
      'segment round trip',
    );
    segments.db.close();

    const blobs = runtime.blobs();
    const bytes = new Uint8Array([4, 5, 6]);
    const blobId = await blobIdFor(bytes);
    await blobs.put('hospital', blobId, bytes, 10);
    assert(await blobs.has('hospital', blobId), 'blob round trip');
    blobs.db.close();

    const leases = runtime.leases();
    const lease = await leases.issue(
      'hospital',
      'worker',
      'system',
      { workspace_id: ['workspace-1'] },
      10,
      100,
    );
    assert(
      (await leases.get('hospital', 'worker'))?.leaseId === lease.leaseId,
      'lease round trip',
    );
    leases.db.close();

    const table = schema.tables.get('tasks');
    assert(table !== undefined, 'compiled table');
    const image = runtime.buildImage({
      table,
      schemaVersion: 1,
      asOfCommitSeq: 1,
      scopeDigest: 'scope',
      rows: [row],
    });
    const header = new TextDecoder().decode(image.slice(0, 16));
    assert(header === 'SQLite format 3\0', 'SQLite image header');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
