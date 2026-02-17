import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG_PATH, DEFAULT_MIGRATE_EXPORT } from './constants';
import type { MigrationAdapter, ParsedArgs, SyncularCliConfig } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseConfig(value: unknown): SyncularCliConfig | { error: string } {
  if (!isRecord(value)) {
    return { error: 'Config must be a JSON object.' };
  }

  const config: SyncularCliConfig = {};

  if (value.project !== undefined) {
    if (!isRecord(value.project)) {
      return {
        error: 'Config field "project" must be an object when provided.',
      };
    }
  }

  const migrateValue = value.migrate;
  if (migrateValue !== undefined) {
    if (!isRecord(migrateValue)) {
      return { error: 'Config field "migrate" must be an object.' };
    }
    const adapter = migrateValue.adapter;
    const exportName = migrateValue.export;
    if (typeof adapter !== 'string' || adapter.length === 0) {
      return {
        error: 'Config field "migrate.adapter" must be a non-empty string.',
      };
    }
    if (
      exportName !== undefined &&
      (typeof exportName !== 'string' || exportName.length === 0)
    ) {
      return {
        error:
          'Config field "migrate.export" must be a non-empty string when provided.',
      };
    }
    config.migrate = {
      adapter,
      ...(exportName ? { export: exportName } : {}),
    };
  }

  return config;
}

async function loadConfig(
  configPath: string
): Promise<{ config: SyncularCliConfig } | { error: string }> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    return {
      error: `Config not found at ${configPath}. Run "syncular create" first.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      error: `Config at ${configPath} is not valid JSON.`,
    };
  }

  const normalized = parseConfig(parsed);
  if ('error' in normalized) {
    return {
      error: `${normalized.error} (path: ${configPath})`,
    };
  }

  return { config: normalized };
}

function isMigrationAdapter(value: unknown): value is MigrationAdapter {
  if (!isRecord(value)) return false;
  return typeof value.status === 'function' && typeof value.up === 'function';
}

export async function loadMigrationAdapter(args: {
  configPath: string;
}): Promise<{ adapter: MigrationAdapter } | { error: string }> {
  const loaded = await loadConfig(args.configPath);
  if ('error' in loaded) return loaded;

  const migrate = loaded.config.migrate;
  if (!migrate) {
    return {
      error:
        'Config does not define "migrate". Run "syncular create" to scaffold adapter files.',
    };
  }

  const adapterModulePath = resolve(dirname(args.configPath), migrate.adapter);
  const adapterExportName = migrate.export ?? DEFAULT_MIGRATE_EXPORT;

  let moduleValue: unknown;
  try {
    const moduleUrl = pathToFileURL(adapterModulePath).href;
    moduleValue = await import(moduleUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: `Failed to load migrate adapter module (${adapterModulePath}): ${message}`,
    };
  }

  if (!isRecord(moduleValue)) {
    return {
      error: `Adapter module ${adapterModulePath} did not load as an object module.`,
    };
  }

  const exportValue = moduleValue[adapterExportName];
  if (!isMigrationAdapter(exportValue)) {
    return {
      error:
        `Adapter export "${adapterExportName}" in ${adapterModulePath} is missing ` +
        'required methods: status() and up().',
    };
  }

  return { adapter: exportValue };
}

export function configPathFromArgs(args: ParsedArgs, cwd: string): string {
  const configured = args.flagValues.get('--config') ?? DEFAULT_CONFIG_PATH;
  return resolve(cwd, configured);
}
