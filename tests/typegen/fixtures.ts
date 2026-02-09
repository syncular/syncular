import { defineMigrations } from '@syncular/migrations';
import { sql } from 'kysely';

// SQLite test migrations
export const sqliteMigrations = defineMigrations({
  v1: async (db) => {
    await db.schema
      .createTable('users')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('age', 'integer')
      .addColumn('score', 'real')
      .addColumn('is_active', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('avatar', 'blob')
      .addColumn('metadata', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull())
      .execute();
  },
  v2: async (db) => {
    await db.schema.alterTable('users').addColumn('email', 'text').execute();
  },
});

// PostgreSQL test migrations
export const postgresMigrations = defineMigrations({
  v1: async (db) => {
    await db.schema
      .createTable('users')
      .addColumn('id', 'uuid', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('age', 'integer')
      .addColumn('big_id', 'bigint')
      .addColumn('score', sql`double precision`)
      .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('avatar', 'bytea')
      .addColumn('metadata', 'jsonb')
      .addColumn('tags', sql`text[]`)
      .addColumn('created_at', sql`timestamptz`, (col) => col.notNull())
      .addColumn('ip_address', sql`inet`)
      .execute();
  },
});

// Multi-table SQLite migrations
export const multiTableMigrations = defineMigrations({
  v1: async (db) => {
    await db.schema
      .createTable('users')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('name', 'text', (col) => col.notNull())
      .execute();

    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('completed', 'integer', (col) => col.defaultTo(0))
      .execute();
  },
});
