/**
 * @syncular/typegen - Type definitions
 */

import type { DefinedMigrations } from '@syncular/migrations';

export type TypegenDialect = 'sqlite' | 'postgres';

/**
 * Column information passed to the resolver function.
 */
export interface ColumnInfo {
  table: string;
  column: string;
  sqlType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  hasDefault: boolean;
  dialect: TypegenDialect;
}

/**
 * Return type from a resolver function.
 */
export type TypeOverride =
  | string
  | { type: string; import?: { name: string; from: string } };

/**
 * User-provided function to override default type mapping.
 */
export type ResolveTypeFn = (col: ColumnInfo) => TypeOverride | undefined;

/**
 * Parsed table schema.
 */
export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
}

/**
 * Parsed column schema.
 */
export interface ColumnSchema {
  name: string;
  sqlType: string;
  tsType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  hasDefault: boolean;
}

/**
 * Schema snapshot at a specific version.
 */
export interface VersionedSchema {
  version: number;
  tables: TableSchema[];
}

/**
 * Options for generateTypes().
 */
export interface GenerateTypesOptions<DB = unknown> {
  /** Defined migrations from defineMigrations() */
  migrations: DefinedMigrations<DB>;
  /** Output file path for generated types */
  output: string;
  /** Database dialect to use for introspection (default: 'sqlite') */
  dialect?: TypegenDialect;
  /** Whether to extend SyncClientDb interface (adds sync infrastructure types) */
  extendsSyncClientDb?: boolean;
  /** Generate versioned interfaces (ClientDbV1, ClientDbV2, etc.) */
  includeVersionHistory?: boolean;
  /** Only generate types for these tables (default: all tables) */
  tables?: string[];
  /** Custom type resolver for overriding default type mapping */
  resolveType?: ResolveTypeFn;
}

/**
 * Result of type generation.
 */
export interface GenerateTypesResult {
  /** Path to the generated file */
  outputPath: string;
  /** Current schema version */
  currentVersion: number;
  /** Number of tables generated */
  tableCount: number;
  /** Generated TypeScript code */
  code: string;
}
