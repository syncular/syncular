/**
 * `syncular.json` manifest (REVISE B5) — designed here, minimal but
 * forward-extensible:
 *
 * ```json
 * {
 *   "manifestVersion": 1,
 *   "migrations": "./migrations",
 *   "output": { "ir": "./syncular.ir.json",
 *               "module": "./syncular.generated.ts" },
 *   "schemaVersions": [{ "version": 1, "through": "0001_initial" }],
 *   "tables": [{ "name": "tasks", "scopes": ["project:{project_id}"] }],
 *   "subscriptions": [{ "name": "projectTasks", "table": "tasks",
 *                       "scopes": { "project_id": ["{projectId}"] } }],
 *   "extensions": {}
 * }
 * ```
 *
 * - `tables` is ordered: it is the handler-declared bootstrap order (§4.7).
 * - `schemaVersions` is the §1.5 version history: strictly increasing
 *   versions, each naming the last migration it includes (`through`); the
 *   final entry must cover the final migration.
 * - Subscription scope values are literals or whole-value `{param}`
 *   placeholders (partial templates are unsupported).
 * - Unknown keys are hard errors everywhere (fail loud; growth happens by
 *   bumping `manifestVersion`), except inside `extensions`, the reserved
 *   WP-49 passthrough slot copied verbatim into the IR.
 */
import { TypegenError } from './errors';

export const MANIFEST_FILENAME = 'syncular.json';

/** Same shorthand the server schema accepts (§3.1). */
export type ManifestScopeSpec = string | { pattern: string; column: string };

export interface ManifestTable {
  readonly name: string;
  readonly scopes: readonly ManifestScopeSpec[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface ManifestSubscription {
  readonly name: string;
  readonly table: string;
  readonly scopes: Readonly<Record<string, readonly string[]>>;
}

export interface ManifestSchemaVersion {
  readonly version: number;
  readonly through: string;
}

export interface Manifest {
  readonly manifestVersion: 1;
  readonly migrations: string;
  readonly output: { readonly ir: string; readonly module: string };
  readonly schemaVersions: readonly ManifestSchemaVersion[];
  readonly tables: readonly ManifestTable[];
  readonly subscriptions: readonly ManifestSubscription[];
  readonly extensions: Readonly<Record<string, unknown>>;
}

const SOURCE = MANIFEST_FILENAME;

function fail(message: string): never {
  throw new TypegenError(SOURCE, message);
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  return value;
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`${context} has unknown key ${JSON.stringify(key)}`);
    }
  }
}

function parseExtensions(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (value === undefined) return {};
  return asObject(value, `${context}.extensions`);
}

function parseScopeSpec(value: unknown, context: string): ManifestScopeSpec {
  if (typeof value === 'string') return value;
  const obj = asObject(value, context);
  rejectUnknownKeys(obj, ['pattern', 'column'], context);
  return {
    pattern: asString(obj.pattern, `${context}.pattern`),
    column: asString(obj.column, `${context}.column`),
  };
}

function parseTable(value: unknown, index: number): ManifestTable {
  const context = `tables[${index}]`;
  const obj = asObject(value, context);
  rejectUnknownKeys(obj, ['name', 'scopes', 'extensions'], context);
  const name = asString(obj.name, `${context}.name`);
  if (!Array.isArray(obj.scopes) || obj.scopes.length === 0) {
    fail(`table ${name}: scopes must be a non-empty array (§3.1)`);
  }
  return {
    name,
    scopes: obj.scopes.map((spec, i) =>
      parseScopeSpec(spec, `table ${name} scopes[${i}]`),
    ),
    extensions: parseExtensions(obj.extensions, `table ${name}`),
  };
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function parseSubscription(
  value: unknown,
  index: number,
): ManifestSubscription {
  const context = `subscriptions[${index}]`;
  const obj = asObject(value, context);
  rejectUnknownKeys(obj, ['name', 'table', 'scopes'], context);
  const name = asString(obj.name, `${context}.name`);
  if (!IDENTIFIER_RE.test(name)) {
    fail(
      `subscription ${JSON.stringify(name)}: name must be a valid identifier`,
    );
  }
  const table = asString(obj.table, `subscription ${name}: table`);
  const scopesObj = asObject(obj.scopes, `subscription ${name}: scopes`);
  const scopes: Record<string, readonly string[]> = {};
  for (const [variable, values] of Object.entries(scopesObj)) {
    if (!Array.isArray(values) || values.length === 0) {
      fail(
        `subscription ${name}: scopes.${variable} must be a non-empty array`,
      );
    }
    scopes[variable] = values.map((v, i) =>
      asString(v, `subscription ${name}: scopes.${variable}[${i}]`),
    );
  }
  if (Object.keys(scopes).length === 0) {
    fail(`subscription ${name}: scopes must not be empty`);
  }
  return { name, table, scopes };
}

function parseSchemaVersion(
  value: unknown,
  index: number,
): ManifestSchemaVersion {
  const context = `schemaVersions[${index}]`;
  const obj = asObject(value, context);
  rejectUnknownKeys(obj, ['version', 'through'], context);
  const version = obj.version;
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    fail(`${context}.version must be an integer ≥ 1 (§1.5)`);
  }
  return {
    version,
    through: asString(obj.through, `${context}.through`),
  };
}

export function parseManifest(raw: unknown): Manifest {
  const obj = asObject(raw, 'manifest');
  rejectUnknownKeys(
    obj,
    [
      'manifestVersion',
      'migrations',
      'output',
      'schemaVersions',
      'tables',
      'subscriptions',
      'extensions',
    ],
    'manifest',
  );
  if (obj.manifestVersion !== 1) {
    fail(
      `manifestVersion must be 1, got ${JSON.stringify(obj.manifestVersion)}`,
    );
  }
  const migrations =
    obj.migrations === undefined
      ? './migrations'
      : asString(obj.migrations, 'migrations');
  let ir = './syncular.ir.json';
  let module = './syncular.generated.ts';
  if (obj.output !== undefined) {
    const output = asObject(obj.output, 'output');
    rejectUnknownKeys(output, ['ir', 'module'], 'output');
    if (output.ir !== undefined) ir = asString(output.ir, 'output.ir');
    if (output.module !== undefined) {
      module = asString(output.module, 'output.module');
    }
  }
  if (!Array.isArray(obj.schemaVersions) || obj.schemaVersions.length === 0) {
    fail('schemaVersions must be a non-empty array (§1.5 version history)');
  }
  const schemaVersions = obj.schemaVersions.map(parseSchemaVersion);
  for (let i = 1; i < schemaVersions.length; i++) {
    const prev = schemaVersions[i - 1] as ManifestSchemaVersion;
    const next = schemaVersions[i] as ManifestSchemaVersion;
    if (next.version <= prev.version) {
      fail(
        `schemaVersions must be strictly increasing (${prev.version} then ${next.version})`,
      );
    }
  }
  if (!Array.isArray(obj.tables) || obj.tables.length === 0) {
    fail('tables must be a non-empty array');
  }
  const tables = obj.tables.map(parseTable);
  const tableNames = new Set<string>();
  for (const table of tables) {
    if (tableNames.has(table.name)) {
      fail(`duplicate table ${JSON.stringify(table.name)}`);
    }
    tableNames.add(table.name);
  }
  const subscriptions = Array.isArray(obj.subscriptions)
    ? obj.subscriptions.map(parseSubscription)
    : obj.subscriptions === undefined
      ? []
      : fail('subscriptions must be an array');
  const subNames = new Set<string>();
  for (const sub of subscriptions) {
    if (subNames.has(sub.name)) {
      fail(`duplicate subscription ${JSON.stringify(sub.name)}`);
    }
    subNames.add(sub.name);
  }
  return {
    manifestVersion: 1,
    migrations,
    output: { ir, module },
    schemaVersions,
    tables,
    subscriptions,
    extensions: parseExtensions(obj.extensions, 'manifest'),
  };
}
