import process from 'node:process';
import type {
  ClientDialect,
  ClientDialectTemplateData,
  ElectronDialect,
  ElectronDialectTemplateData,
  LibrariesTarget,
  ServerDialect,
  ServerDialectTemplateData,
} from './types';

export const CLI_VERSION = process.env.npm_package_version ?? '0.0.0';
export const DEFAULT_CONFIG_PATH = 'syncular.config.json';
export const DEFAULT_MIGRATE_EXPORT = 'migrationRunner';

export const LIBRARIES_TARGETS: LibrariesTarget[] = [
  'server',
  'react',
  'vanilla',
  'expo',
  'react-native',
  'electron',
  'proxy-api',
];

export const DEFAULT_LIBRARIES_TARGETS: LibrariesTarget[] = ['server', 'react'];

export const CLIENT_DIALECT_TEMPLATES: Record<
  ClientDialect,
  ClientDialectTemplateData
> = {
  'wa-sqlite': {
    id: 'wa-sqlite',
    label: 'Browser WA-SQLite',
    importStatement:
      "import { createWaSqliteDb } from '@syncular/dialect-wa-sqlite';",
    dbFactoryLine: "return createWaSqliteDb<DB>({ fileName: 'app.sqlite' });",
    installPackages: ['@syncular/dialect-wa-sqlite'],
  },
  pglite: {
    id: 'pglite',
    label: 'Browser PGlite',
    importStatement:
      "import { createPgliteDb } from '@syncular/dialect-pglite';",
    dbFactoryLine: 'return createPgliteDb<DB>();',
    installPackages: ['@syncular/dialect-pglite'],
  },
  'bun-sqlite': {
    id: 'bun-sqlite',
    label: 'Bun SQLite',
    importStatement:
      "import { createBunSqliteDb } from '@syncular/dialect-bun-sqlite';",
    dbFactoryLine:
      "return createBunSqliteDb<DB>({ path: './data/client.sqlite' });",
    installPackages: ['@syncular/dialect-bun-sqlite'],
  },
  'better-sqlite3': {
    id: 'better-sqlite3',
    label: 'Node better-sqlite3',
    importStatement:
      "import { createBetterSqlite3Db } from '@syncular/dialect-better-sqlite3';",
    dbFactoryLine:
      "return createBetterSqlite3Db<DB>({ path: './data/client.sqlite' });",
    installPackages: ['@syncular/dialect-better-sqlite3'],
  },
  sqlite3: {
    id: 'sqlite3',
    label: 'Node sqlite3',
    importStatement:
      "import { createSqlite3Db } from '@syncular/dialect-sqlite3';",
    dbFactoryLine:
      "return createSqlite3Db<DB>({ path: './data/client.sqlite' });",
    installPackages: ['@syncular/dialect-sqlite3'],
  },
};

export const ELECTRON_DIALECT_TEMPLATES: Record<
  ElectronDialect,
  ElectronDialectTemplateData
> = {
  'electron-sqlite': {
    id: 'electron-sqlite',
    label: 'Electron IPC SQLite',
    importStatement:
      "import { createElectronSqliteDbFromWindow } from '@syncular/dialect-electron-sqlite';",
    dbFactoryLine: 'return createElectronSqliteDbFromWindow<DB>();',
    installPackages: ['@syncular/dialect-electron-sqlite'],
  },
  'better-sqlite3': {
    id: 'better-sqlite3',
    label: 'Node better-sqlite3',
    importStatement:
      "import { createBetterSqlite3Db } from '@syncular/dialect-better-sqlite3';",
    dbFactoryLine:
      "return createBetterSqlite3Db<DB>({ path: './data/electron-client.sqlite' });",
    installPackages: ['@syncular/dialect-better-sqlite3'],
  },
};

export const SERVER_DIALECT_TEMPLATES: Record<
  ServerDialect,
  ServerDialectTemplateData
> = {
  postgres: {
    id: 'postgres',
    label: 'Postgres',
    installPackages: [
      '@syncular/server',
      '@syncular/server-hono',
      '@syncular/server-dialect-postgres',
      'kysely',
      'pg',
      'hono',
    ],
    templateFile: 'libraries/syncular-server.postgres.ts.tpl',
  },
  sqlite: {
    id: 'sqlite',
    label: 'SQLite',
    installPackages: [
      '@syncular/server',
      '@syncular/server-hono',
      '@syncular/server-dialect-sqlite',
      '@syncular/dialect-bun-sqlite',
      'kysely',
      'hono',
    ],
    templateFile: 'libraries/syncular-server.sqlite.ts.tpl',
  },
};

export const BASE_CLIENT_PACKAGES = [
  '@syncular/client',
  '@syncular/transport-http',
  'kysely',
];

export const BASE_SCRIPT_COMMANDS = {
  migrateStatus: 'syncular migrate status --config syncular.config.json',
  migrate: 'syncular migrate up --config syncular.config.json',
  migrateReset:
    'syncular migrate up --config syncular.config.json --on-checksum-mismatch reset --yes',
  typegen: 'bun run scripts/syncular-typegen.ts',
  prepare: 'bun run db:migrate && bun run db:typegen',
} as const;
