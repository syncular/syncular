import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateTypes } from '@syncular/typegen';
import {
  multiTableMigrations,
  postgresMigrations,
  sqliteMigrations,
} from './fixtures';

const tmpDir = join(tmpdir(), 'syncular-typegen-test');

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('generateTypes - SQLite', () => {
  it('generates types from SQLite migrations', async () => {
    const output = join(tmpDir, 'sqlite.generated.ts');
    const result = await generateTypes({
      migrations: sqliteMigrations,
      output,
    });

    expect(result.outputPath).toBe(output);
    expect(result.currentVersion).toBe(2);
    expect(result.tableCount).toBe(1);
    expect(result.code).toContain('export interface UsersTable {');
    expect(result.code).toContain('  id: string;');
    expect(result.code).toContain('  age?: number | null;');
    expect(result.code).toContain('  avatar?: Uint8Array | null;');
    expect(result.code).toContain('  is_active?: number;'); // has default
    expect(result.code).toContain('  email?: string | null;');

    // File was written
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, 'utf-8')).toBe(result.code);
  });

  it('generates multi-table types', async () => {
    const output = join(tmpDir, 'multi.generated.ts');
    const result = await generateTypes({
      migrations: multiTableMigrations,
      output,
    });

    expect(result.tableCount).toBe(2);
    expect(result.code).toContain('export interface UsersTable {');
    expect(result.code).toContain('export interface TasksTable {');
    expect(result.code).toContain('  users: UsersTable;');
    expect(result.code).toContain('  tasks: TasksTable;');
  });

  it('generates with extendsSyncClientDb', async () => {
    const output = join(tmpDir, 'extends.generated.ts');
    const result = await generateTypes({
      migrations: sqliteMigrations,
      output,
      extendsSyncClientDb: true,
    });

    expect(result.code).toContain(
      "import type { SyncClientDb } from '@syncular/client';"
    );
    expect(result.code).toContain('extends SyncClientDb');
  });

  it('applies resolveType overrides', async () => {
    const output = join(tmpDir, 'resolver.generated.ts');
    const result = await generateTypes({
      migrations: sqliteMigrations,
      output,
      resolveType: (col) => {
        if (col.table === 'users' && col.column === 'metadata') {
          return {
            type: 'UserMeta',
            import: { name: 'UserMeta', from: './user-types' },
          };
        }
        if (col.column === 'created_at') {
          return 'Date';
        }
        return undefined;
      },
    });

    expect(result.code).toContain(
      "import type { UserMeta } from './user-types';"
    );
    // metadata is nullable so it gets | null
    expect(result.code).toContain('  metadata?: UserMeta | null;');
    // created_at is not nullable
    expect(result.code).toContain('  created_at: Date;');
    // Other columns use default mapping
    expect(result.code).toContain('  id: string;');
  });

  it('supports table filtering', async () => {
    const output = join(tmpDir, 'filtered.generated.ts');
    const result = await generateTypes({
      migrations: multiTableMigrations,
      output,
      tables: ['tasks'],
    });

    expect(result.tableCount).toBe(1);
    expect(result.code).toContain('export interface TasksTable {');
    expect(result.code).not.toContain('export interface UsersTable {');
  });
});

describe('generateTypes - PostgreSQL', () => {
  it('generates types from PostgreSQL migrations', async () => {
    const output = join(tmpDir, 'postgres.generated.ts');
    const result = await generateTypes({
      migrations: postgresMigrations,
      output,
      dialect: 'postgres',
    });

    expect(result.currentVersion).toBe(1);
    expect(result.tableCount).toBe(1);
    expect(result.code).toContain('export interface UsersTable {');
    expect(result.code).toContain('  id: string;'); // uuid → string
    expect(result.code).toContain('  is_active?: boolean;'); // bool → boolean, has default
    expect(result.code).toContain('  metadata?: unknown | null;'); // jsonb → unknown, nullable
    expect(result.code).toContain('  big_id?: string | null;'); // bigint → string
    expect(result.code).toContain('  avatar?: Uint8Array | null;'); // bytea → Uint8Array

    expect(existsSync(output)).toBe(true);
  });

  it('handles postgres array types', async () => {
    const output = join(tmpDir, 'pg-arrays.generated.ts');
    const result = await generateTypes({
      migrations: postgresMigrations,
      output,
      dialect: 'postgres',
    });

    expect(result.code).toContain('  tags?: string[] | null;'); // text[] → string[]
  });
});
