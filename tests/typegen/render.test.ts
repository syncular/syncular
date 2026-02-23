import { describe, expect, it } from 'bun:test';
import type { VersionedSchema } from '@syncular/typegen';
import { renderTypes } from '@syncular/typegen';

function makeSchema(overrides?: Partial<VersionedSchema>): VersionedSchema {
  return {
    version: 1,
    tables: [
      {
        name: 'users',
        columns: [
          {
            name: 'id',
            sqlType: 'text',
            tsType: 'string',
            nullable: false,
            isPrimaryKey: true,
            hasDefault: false,
          },
          {
            name: 'name',
            sqlType: 'text',
            tsType: 'string',
            nullable: false,
            isPrimaryKey: false,
            hasDefault: false,
          },
          {
            name: 'age',
            sqlType: 'integer',
            tsType: 'number | null',
            nullable: true,
            isPrimaryKey: false,
            hasDefault: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('renderTypes', () => {
  it('generates interface with correct shape', () => {
    const code = renderTypes({ schemas: [makeSchema()] });
    expect(code).not.toContain("import type { Generated } from 'kysely';");
    expect(code).toContain('export interface UsersTable {');
    expect(code).toContain('  id: string;');
    expect(code).toContain('  name: string;');
    expect(code).toContain('  age: number | null;');
    expect(code).toContain('export interface ClientDb {');
    expect(code).toContain('  users: UsersTable;');
  });

  it('generates PascalCase names', () => {
    const schema: VersionedSchema = {
      version: 1,
      tables: [
        {
          name: 'catalog_items',
          columns: [
            {
              name: 'id',
              sqlType: 'text',
              tsType: 'string',
              nullable: false,
              isPrimaryKey: true,
              hasDefault: false,
            },
          ],
        },
      ],
    };
    const code = renderTypes({ schemas: [schema] });
    expect(code).toContain('export interface CatalogItemsTable {');
    expect(code).toContain('  catalog_items: CatalogItemsTable;');
  });

  it('uses Generated for defaults and keeps nullable select types strict', () => {
    const schema: VersionedSchema = {
      version: 1,
      tables: [
        {
          name: 'test',
          columns: [
            {
              name: 'required_col',
              sqlType: 'text',
              tsType: 'string',
              nullable: false,
              isPrimaryKey: false,
              hasDefault: false,
            },
            {
              name: 'nullable_col',
              sqlType: 'text',
              tsType: 'string | null',
              nullable: true,
              isPrimaryKey: false,
              hasDefault: false,
            },
            {
              name: 'default_col',
              sqlType: 'integer',
              tsType: 'number',
              nullable: false,
              isPrimaryKey: false,
              hasDefault: true,
            },
          ],
        },
      ],
    };
    const code = renderTypes({ schemas: [schema] });
    expect(code).toContain("import type { Generated } from 'kysely';");
    expect(code).toContain('  required_col: string;');
    expect(code).toContain('  nullable_col: string | null;');
    expect(code).toContain('  default_col: Generated<number>;');
  });

  it('renders extendsSyncClientDb import + extends', () => {
    const code = renderTypes({
      schemas: [makeSchema()],
      extendsSyncClientDb: true,
    });
    expect(code).toContain(
      "import type { SyncClientDb } from '@syncular/client';"
    );
    expect(code).toContain('export interface ClientDb extends SyncClientDb {');
  });

  it('supports umbrella syncular import type', () => {
    const code = renderTypes({
      schemas: [makeSchema()],
      extendsSyncClientDb: true,
      syncularImportType: 'umbrella',
    });
    expect(code).toContain(
      "import type { SyncClientDb } from 'syncular/client';"
    );
  });

  it('supports explicit package mapping for syncular imports', () => {
    const code = renderTypes({
      schemas: [makeSchema()],
      extendsSyncClientDb: true,
      syncularImportType: {
        client: 'my-sync/client',
      },
    });
    expect(code).toContain(
      "import type { SyncClientDb } from 'my-sync/client';"
    );
  });

  it('does not include SyncClientDb when not extending', () => {
    const code = renderTypes({ schemas: [makeSchema()] });
    expect(code).not.toContain('SyncClientDb');
    expect(code).toContain('export interface ClientDb {');
  });

  it('renders version history interfaces', () => {
    const v1: VersionedSchema = {
      version: 1,
      tables: [
        {
          name: 'users',
          columns: [
            {
              name: 'id',
              sqlType: 'text',
              tsType: 'string',
              nullable: false,
              isPrimaryKey: true,
              hasDefault: false,
            },
          ],
        },
      ],
    };
    const v2: VersionedSchema = {
      version: 2,
      tables: [
        {
          name: 'users',
          columns: [
            {
              name: 'id',
              sqlType: 'text',
              tsType: 'string',
              nullable: false,
              isPrimaryKey: true,
              hasDefault: false,
            },
            {
              name: 'email',
              sqlType: 'text',
              tsType: 'string | null',
              nullable: true,
              isPrimaryKey: false,
              hasDefault: false,
            },
          ],
        },
      ],
    };

    const code = renderTypes({
      schemas: [v1, v2],
      includeVersionHistory: true,
    });
    expect(code).toContain('export interface UsersTableV1 {');
    expect(code).toContain('export interface ClientDbV1 {');
    expect(code).toContain('export interface ClientDbV2 {');
  });

  it('renders custom imports from resolver', () => {
    const code = renderTypes({
      schemas: [makeSchema()],
      customImports: [
        { name: 'TaskMeta', from: './task-types' },
        { name: 'UserRole', from: './user-types' },
        { name: 'AnotherType', from: './task-types' },
      ],
    });
    // Should group by module
    expect(code).toContain(
      "import type { AnotherType, TaskMeta } from './task-types';"
    );
    expect(code).toContain("import type { UserRole } from './user-types';");
  });

  it('deduplicates custom imports', () => {
    const code = renderTypes({
      schemas: [makeSchema()],
      customImports: [
        { name: 'TaskMeta', from: './types' },
        { name: 'TaskMeta', from: './types' },
      ],
    });
    // Import line should have it once
    expect(code).toContain("import type { TaskMeta } from './types';");
  });

  it('handles empty schema', () => {
    const code = renderTypes({ schemas: [] });
    expect(code).toContain('// No migrations defined');
  });

  it('includes DO NOT EDIT header', () => {
    const code = renderTypes({ schemas: [makeSchema()] });
    expect(code).toContain('DO NOT EDIT');
    expect(code).toContain('@syncular/typegen');
  });
});
