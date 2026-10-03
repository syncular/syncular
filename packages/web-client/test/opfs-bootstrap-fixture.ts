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
      indexes: [
        {
          name: 'catalogue_unique_title',
          columns: ['project_id', 'title'],
          unique: true,
        },
      ],
      ftsIndexes: [
        { name: 'catalogue_fts', columns: ['title'], tokenize: 'unicode61' },
      ],
    },
  ],
};

export const OPFS_SCOPE_SCHEMAS = [89, 90, 91].map((version) => ({
  ...OPFS_SCHEMA,
  version,
  tables: OPFS_SCHEMA.tables.map((table) => ({
    ...table,
    scopes: [
      {
        pattern:
          version === 89
            ? 'theatre:{theatre_calendar_id}'
            : 'theatre:{calendar_theatre_id}',
        column: 'project_id',
      },
    ],
  })),
}));

export type CrashPoint =
  | 'download'
  | 'before-import'
  | 'mid-import'
  | 'after-chunk'
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
