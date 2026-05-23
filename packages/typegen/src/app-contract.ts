import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SyncularScopeSource = 'actorId' | 'projectId';
export type SyncularCrdtYjsKind = 'text' | 'xml-fragment' | 'prosemirror';
export type SyncularCrdtYjsSyncMode =
  | 'server-merge'
  | 'encrypted-update-log';

export interface SyncularScopeDefinition {
  name?: string;
  column: string;
  source: SyncularScopeSource;
  required?: boolean;
}

export interface SyncularCrdtYjsFieldDefinition {
  field?: string;
  stateColumn: string;
  containerKey?: string;
  rowIdField?: string;
  kind?: SyncularCrdtYjsKind;
  syncMode?: SyncularCrdtYjsSyncMode;
}

export interface SyncularEncryptedFieldDefinition {
  field: string;
  scope?: string;
  rowIdField?: string;
}

export interface SyncedTableDefinition {
  table: string;
  subscriptionId?: string;
  subscriptionParams?: Record<string, unknown>;
  scopes?: readonly SyncularScopeDefinition[];
  serverVersion: string;
  blobColumns?: readonly string[];
  crdt?: Record<string, SyncularCrdtYjsFieldDefinition>;
  crdtYjsFields?: readonly SyncularCrdtYjsFieldDefinition[];
  encryptedFields?: readonly SyncularEncryptedFieldDefinition[];
  softDelete?: string;
  sqliteWithoutRowid?: boolean;
}

export interface SyncularCountByReadModelDefinition {
  name: string;
  kind: 'countBy';
  sourceTable: string;
  outputTable: string;
  dimensions: readonly string[];
  countColumn?: string;
}

export type SyncularLocalReadModelDefinition =
  SyncularCountByReadModelDefinition;

export interface SyncularClientSchemaSupportDefinition {
  minSupported?: number;
  supported?: readonly number[];
}

export interface SyncularCodegenPathsDefinition {
  schemaOutputPath?: string;
  typescriptOutputPath?: string;
  typescriptServerOutputPath?: string;
  typescriptRuntimeImportPath?: string;
  rustRuntimeCratePath?: string;
  nativeSwiftOutputPath?: string;
  nativeKotlinOutputPath?: string;
  nativeAndroidKotlinOutputPath?: string;
  nativeAndroidKotlinPackage?: string;
}

export interface DefineSyncularClientOptions<
  Tables extends Record<string, SyncedTableDefinition>,
> extends SyncularCodegenPathsDefinition {
  migrations?: unknown;
  tables: Tables;
  localReadModels?: readonly SyncularLocalReadModelDefinition[];
  clientSchemaSupport?: SyncularClientSchemaSupportDefinition;
}

export interface SyncularClientContract<
  Tables extends Record<string, SyncedTableDefinition> = Record<
    string,
    SyncedTableDefinition
  >,
> extends DefineSyncularClientOptions<Tables> {
  readonly kind: 'syncular-client-contract';
}

export interface SyncularCodegenScopeConfig {
  name?: string;
  column: string;
  source: SyncularScopeSource;
  required?: boolean;
}

export interface SyncularCodegenCrdtYjsFieldConfig {
  field: string;
  stateColumn: string;
  containerKey?: string;
  rowIdField?: string;
  kind?: SyncularCrdtYjsKind;
  syncMode?: SyncularCrdtYjsSyncMode;
}

export interface SyncularCodegenEncryptedFieldConfig {
  field: string;
  scope?: string;
  rowIdField?: string;
}

export interface SyncularCodegenTableConfig {
  subscriptionId?: string;
  subscriptionParams?: Record<string, unknown>;
  scopes?: SyncularCodegenScopeConfig[];
  serverVersionColumn: string;
  blobColumns?: string[];
  crdtYjsFields?: SyncularCodegenCrdtYjsFieldConfig[];
  encryptedFields?: SyncularCodegenEncryptedFieldConfig[];
  softDeleteColumn?: string;
  sqliteWithoutRowid?: boolean;
}

export interface SyncularCodegenLocalReadModelConfig {
  name: string;
  kind: 'countBy';
  sourceTable: string;
  outputTable: string;
  dimensions: string[];
  countColumn: string;
}

export interface SyncularCodegenConfig extends SyncularCodegenPathsDefinition {
  tables: Record<string, SyncularCodegenTableConfig>;
  localReadModels?: SyncularCodegenLocalReadModelConfig[];
  clientSchemaSupport?: {
    minSupported?: number;
    supported?: number[];
  };
}

export function defineSyncularClient<
  Tables extends Record<string, SyncedTableDefinition>,
>(options: DefineSyncularClientOptions<Tables>): SyncularClientContract<Tables> {
  return {
    ...options,
    kind: 'syncular-client-contract',
  };
}

export function syncedTable(options: SyncedTableDefinition): SyncedTableDefinition {
  return { ...options };
}

export function scope(
  name: string,
  options: {
    column?: string;
    source: SyncularScopeSource;
    required?: boolean;
  }
): SyncularScopeDefinition {
  return {
    name,
    column: options.column ?? name,
    source: options.source,
    required: options.required,
  };
}

export function yjsText(
  options: Omit<SyncularCrdtYjsFieldDefinition, 'kind'>
): SyncularCrdtYjsFieldDefinition {
  return { ...options, kind: 'text' };
}

export function encryptedField(
  field: string,
  options: Omit<SyncularEncryptedFieldDefinition, 'field'> = {}
): SyncularEncryptedFieldDefinition {
  return { field, ...options };
}

export function countByReadModel(
  options: Omit<SyncularCountByReadModelDefinition, 'kind'>
): SyncularCountByReadModelDefinition {
  return { ...options, kind: 'countBy' };
}

export function toSyncularCodegenConfig(
  contract: SyncularClientContract
): SyncularCodegenConfig {
  const config: SyncularCodegenConfig = {
    tables: Object.fromEntries(
      Object.values(contract.tables).map((table) => [
        table.table,
        toCodegenTable(table),
      ])
    ),
  };

  for (const key of CODEGEN_PATH_KEYS) {
    const value = contract[key];
    if (value !== undefined) {
      config[key] = value;
    }
  }

  if (contract.localReadModels && contract.localReadModels.length > 0) {
    config.localReadModels = contract.localReadModels.map((model) => ({
      name: model.name,
      kind: model.kind,
      sourceTable: model.sourceTable,
      outputTable: model.outputTable,
      dimensions: [...model.dimensions],
      countColumn: model.countColumn ?? 'row_count',
    }));
  }

  if (contract.clientSchemaSupport) {
    config.clientSchemaSupport = {
      ...(contract.clientSchemaSupport.minSupported !== undefined
        ? { minSupported: contract.clientSchemaSupport.minSupported }
        : {}),
      ...(contract.clientSchemaSupport.supported !== undefined
        ? { supported: [...contract.clientSchemaSupport.supported] }
        : {}),
    };
  }

  return config;
}

export function toSyncularCodegenJson(
  contract: SyncularClientContract,
  space = 2
): string {
  return `${JSON.stringify(toSyncularCodegenConfig(contract), null, space)}\n`;
}

export async function writeSyncularCodegenJson(
  contract: SyncularClientContract,
  outputPath: string | URL = 'syncular.codegen.json',
  space = 2
): Promise<void> {
  if (typeof outputPath === 'string') {
    await mkdir(dirname(outputPath), { recursive: true });
  } else if (outputPath.protocol === 'file:') {
    await mkdir(dirname(fileURLToPath(outputPath)), { recursive: true });
  }
  await writeFile(outputPath, toSyncularCodegenJson(contract, space));
}

const CODEGEN_PATH_KEYS = [
  'schemaOutputPath',
  'typescriptOutputPath',
  'typescriptServerOutputPath',
  'typescriptRuntimeImportPath',
  'rustRuntimeCratePath',
  'nativeSwiftOutputPath',
  'nativeKotlinOutputPath',
  'nativeAndroidKotlinOutputPath',
  'nativeAndroidKotlinPackage',
] as const satisfies readonly (keyof SyncularCodegenPathsDefinition)[];

function toCodegenTable(
  table: SyncedTableDefinition
): SyncularCodegenTableConfig {
  const config: SyncularCodegenTableConfig = {
    serverVersionColumn: table.serverVersion,
  };

  if (table.subscriptionId !== undefined) {
    config.subscriptionId = table.subscriptionId;
  }
  if (table.subscriptionParams !== undefined) {
    config.subscriptionParams = table.subscriptionParams;
  }
  if (table.scopes && table.scopes.length > 0) {
    config.scopes = table.scopes.map((item) => ({
      ...(item.name !== undefined ? { name: item.name } : {}),
      column: item.column,
      source: item.source,
      ...(item.required !== undefined ? { required: item.required } : {}),
    }));
  }
  if (table.blobColumns && table.blobColumns.length > 0) {
    config.blobColumns = [...table.blobColumns];
  }

  const crdtFields = [
    ...Object.entries(table.crdt ?? {}).map(([field, definition]) => ({
      field,
      ...definition,
    })),
    ...(table.crdtYjsFields ?? []),
  ];
  if (crdtFields.length > 0) {
    config.crdtYjsFields = crdtFields.map((field) => ({
      field: field.field ?? '',
      stateColumn: field.stateColumn,
      ...(field.containerKey !== undefined
        ? { containerKey: field.containerKey }
        : {}),
      ...(field.rowIdField !== undefined ? { rowIdField: field.rowIdField } : {}),
      ...(field.kind !== undefined ? { kind: field.kind } : {}),
      ...(field.syncMode !== undefined ? { syncMode: field.syncMode } : {}),
    }));
  }
  if (table.encryptedFields && table.encryptedFields.length > 0) {
    config.encryptedFields = table.encryptedFields.map((field) => ({
      field: field.field,
      ...(field.scope !== undefined ? { scope: field.scope } : {}),
      ...(field.rowIdField !== undefined ? { rowIdField: field.rowIdField } : {}),
    }));
  }
  if (table.softDelete !== undefined) {
    config.softDeleteColumn = table.softDelete;
  }
  if (table.sqliteWithoutRowid !== undefined) {
    config.sqliteWithoutRowid = table.sqliteWithoutRowid;
  }

  return config;
}
