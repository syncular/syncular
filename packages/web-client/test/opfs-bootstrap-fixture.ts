import type { ClientSchema } from '../src/schema';

export const OPFS_SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'catalogue',
      primaryKey: 'id',
      scopes: ['project:{project_id}'],
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'project_id', type: 'string', nullable: false },
        { name: 'title', type: 'string', nullable: false },
      ],
      ftsIndexes: [
        { name: 'catalogue_fts', columns: ['title'], tokenize: 'unicode61' },
      ],
    },
  ],
};

export type CrashPoint =
  | 'download'
  | 'before-import'
  | 'mid-import'
  | 'after-import';

export interface CrashReceipt {
  point: CrashPoint;
  bytes: number;
  databaseWrite: boolean;
}

export interface OpfsProbe {
  integrity: unknown;
  sqliteVersion: string;
  journal: unknown;
  synchronous: unknown;
  ftsCount: number;
  ftsIntegrity: string;
}
