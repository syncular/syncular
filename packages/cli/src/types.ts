export type RootCommand =
  | 'help'
  | 'version'
  | 'doctor'
  | 'migrate'
  | 'create'
  | 'console'
  | 'interactive';

export type MigrateSubcommand = 'status' | 'up';
export type DoctorCheckName = 'bun' | 'workspace' | 'git';
export type ChecksumMismatchMode = 'error' | 'reset';
export type ServerDialect = 'postgres' | 'sqlite';
export type ClientDialect =
  | 'wa-sqlite'
  | 'pglite'
  | 'bun-sqlite'
  | 'better-sqlite3'
  | 'sqlite3';
export type ElectronDialect = 'electron-sqlite' | 'better-sqlite3';
export type LibrariesTarget =
  | 'server'
  | 'react'
  | 'vanilla'
  | 'expo'
  | 'react-native'
  | 'electron'
  | 'proxy-api';

export interface ParsedArgs {
  command: RootCommand | null;
  subcommand: string | null;
  flags: Set<string>;
  flagValues: Map<string, string>;
  positionals: string[];
}

export interface CommandResult {
  title: string;
  lines: string[];
  ok: boolean;
}

export interface DoctorCheck {
  name: DoctorCheckName;
  ok: boolean;
  detail: string;
}

export interface SyncularCliConfig {
  mode?: 'libraries' | 'demo';
  targets?: LibrariesTarget[];
  dialects?: Partial<{
    server: ServerDialect;
    react: ClientDialect;
    vanilla: ClientDialect;
    electron: ElectronDialect;
  }>;
  migrate?: {
    adapter: string;
    export?: string;
  };
}

export interface MigrationStatusInput {
  cwd: string;
}

export interface MigrationUpInput extends MigrationStatusInput {
  onChecksumMismatch: ChecksumMismatchMode;
  dryRun: boolean;
}

export interface MigrationStatusResult {
  currentVersion: number;
  targetVersion: number;
  pendingVersions: number[];
  trackingTable?: string;
}

export interface MigrationUpResult {
  appliedVersions: number[];
  currentVersion: number;
  wasReset?: boolean;
  dryRun?: boolean;
}

export interface MigrationAdapter {
  status: (input: MigrationStatusInput) => Promise<MigrationStatusResult>;
  up: (input: MigrationUpInput) => Promise<MigrationUpResult>;
}

export interface LibrariesOptions {
  targetDir: string;
  force: boolean;
  targets: LibrariesTarget[];
  serverDialect: ServerDialect;
  reactDialect: ClientDialect;
  vanillaDialect: ClientDialect;
  electronDialect: ElectronDialect;
}

export interface DemoOptions {
  targetDir: string;
  force: boolean;
}

export interface ClientDialectTemplateData {
  id: ClientDialect;
  label: string;
  importStatement: string;
  dbFactoryLine: string;
  installPackages: string[];
}

export interface ServerDialectTemplateData {
  id: ServerDialect;
  label: string;
  installPackages: string[];
  templateFile: string;
}

export interface ElectronDialectTemplateData {
  id: ElectronDialect;
  label: string;
  importStatement: string;
  dbFactoryLine: string;
  installPackages: string[];
}

export interface MenuItem {
  id:
    | 'doctor'
    | 'create'
    | 'create-demo'
    | 'migrate-status'
    | 'migrate-up'
    | 'migrate-reset-mode'
    | 'help'
    | 'quit';
  label: string;
  description: string;
}
