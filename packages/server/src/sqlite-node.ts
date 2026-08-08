import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteBlobStore as SharedSqliteBlobStore } from './sqlite-blob-store';
import type { SqliteDatabase } from './sqlite-driver';
import { type SqliteImageBuilder, writeSqliteImage } from './sqlite-image';
import { SqliteLeaseStore as SharedSqliteLeaseStore } from './sqlite-lease-store';
import { NodeSqliteDatabase } from './sqlite-node-driver';
import { SqliteSegmentStore as SharedSqliteSegmentStore } from './sqlite-segment-store';
import { SqliteServerStorage as SharedSqliteServerStorage } from './sqlite-storage';

function database(value: SqliteDatabase | string): SqliteDatabase {
  return typeof value === 'string' ? new NodeSqliteDatabase(value) : value;
}

export class SqliteServerStorage extends SharedSqliteServerStorage {
  constructor(value: SqliteDatabase | string = ':memory:') {
    super(database(value));
  }
}

export class SqliteSegmentStore extends SharedSqliteSegmentStore {
  constructor(
    value: SqliteDatabase | string = ':memory:',
    options?: { ttlMs?: number },
  ) {
    super(database(value), options);
  }
}

export class SqliteBlobStore extends SharedSqliteBlobStore {
  constructor(value: SqliteDatabase | string = ':memory:') {
    super(database(value));
  }
}

export class SqliteLeaseStore extends SharedSqliteLeaseStore {
  constructor(
    value: SqliteDatabase | string = ':memory:',
    options?: { readonly leaseId?: () => string },
  ) {
    super(database(value), options);
  }
}

export const buildSqliteImage: SqliteImageBuilder = (input) => {
  const directory = mkdtempSync(join(tmpdir(), 'syncular-server-image-'));
  const path = join(directory, 'segment.db');
  const db = new NodeSqliteDatabase(path);
  try {
    try {
      writeSqliteImage(db, input);
    } finally {
      db.close();
    }
    return new Uint8Array(readFileSync(path));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

export { NodeSqliteDatabase } from './sqlite-node-driver';
