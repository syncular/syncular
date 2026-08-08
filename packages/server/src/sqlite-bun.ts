import { SqliteBlobStore as SharedSqliteBlobStore } from './sqlite-blob-store';
import { BunSqliteDatabase } from './sqlite-bun-driver';
import type { SqliteDatabase } from './sqlite-driver';
import { type SqliteImageBuilder, writeSqliteImage } from './sqlite-image';
import { SqliteLeaseStore as SharedSqliteLeaseStore } from './sqlite-lease-store';
import { SqliteSegmentStore as SharedSqliteSegmentStore } from './sqlite-segment-store';
import { SqliteServerStorage as SharedSqliteServerStorage } from './sqlite-storage';

function database(value: SqliteDatabase | string): SqliteDatabase {
  return typeof value === 'string' ? new BunSqliteDatabase(value) : value;
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
  const db = new BunSqliteDatabase();
  try {
    writeSqliteImage(db, input);
    return db.serialize();
  } finally {
    db.close();
  }
};

export { BunSqliteDatabase } from './sqlite-bun-driver';
