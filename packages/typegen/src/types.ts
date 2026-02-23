/**
 * @syncular/typegen - Type definitions
 */

import type { DefinedMigrations } from '@syncular/migrations';

export type TypegenDialect = 'sqlite' | 'postgres';

export type SyncularImportType =
  | 'scoped'
  | 'umbrella'
  | {
      client: string;
      [packageName: string]: string;
    };

/**
 * Column information for a schema column.
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
 * Column codec definition shared across runtime and typegen.
 * Typegen only consumes the `ts` field, but a full codec object can be
 * provided as a single source of truth.
 */
export interface ColumnCodec<App, Db> {
  ts: TypeOverride;
  toDb(value: App): Db;
  fromDb(value: Db): App;
  dialects?: Partial<
    Record<
      TypegenDialect,
      {
        toDb?(value: App): Db;
        fromDb?(value: Db): App;
      }
    >
  >;
}

/**
 * Column codec resolver for a column.
 */
export type ColumnCodecResolver = (
  column: ColumnInfo
) => ColumnCodec<unknown, unknown> | undefined;

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
  /**
   * Controls how syncular package imports are rendered in generated output.
   * - 'scoped' (default): '@syncular/client'
   * - 'umbrella': 'syncular/client'
   * - object: explicit package mapping (must include `client`)
   */
  syncularImportType?: SyncularImportType;
  /** Generate versioned interfaces (ClientDbV1, ClientDbV2, etc.) */
  includeVersionHistory?: boolean;
  /** Only generate types for these tables (default: all tables) */
  tables?: string[];
  /**
   * Optional column codec resolver for per-column type overrides.
   * Receives full column metadata (table, column, sqlType, dialect, etc.).
   */
  codecs?: ColumnCodecResolver;
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
