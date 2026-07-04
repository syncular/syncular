/**
 * `syncular.json` manifest (REVISE B5) — designed here, minimal but
 * forward-extensible:
 *
 * ```json
 * {
 *   "manifestVersion": 1,
 *   "migrations": "./migrations",
 *   "output": { "ir": "./syncular.ir.json",
 *               "module": "./syncular.generated.ts",
 *               "swift": "./Sources/App/Syncular.generated.swift",
 *               "kotlin": { "path": "./Syncular.generated.kt",
 *                           "package": "dev.example" },
 *               "dart": "./lib/syncular.generated.dart" },
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
 * - `output.ir` / `output.module` are the always-emitted TS defaults.
 *   `output.swift` / `output.kotlin` / `output.dart` are OPT-IN native
 *   emitters — a bare string is the output path; an object carries
 *   language-appropriate options (Kotlin `package`/`objectName`, Swift
 *   `enumName`; Dart takes `path` only). This is additive within the `output`
 *   object (the same forward-extension shape `output.ir`/`output.module`
 *   already use); no `manifestVersion` bump — new *recognized* keys, not
 *   tolerated-unknown ones. Absent → that language is not generated (TS
 *   stays the default).
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

/** Swift emitter output: a `.swift` path plus optional options. */
export interface SwiftOutput {
  readonly path: string;
  /** The generated enum namespace (default `SyncularSchema`). */
  readonly enumName: string;
  /** Opt-in named-queries output path (a sibling `.swift` file). */
  readonly queriesPath?: string;
}

/** Kotlin emitter output: a `.kt` path plus its package declaration. */
export interface KotlinOutput {
  readonly path: string;
  /** The Kotlin package declaration (default `syncular.generated`). */
  readonly package: string;
  /** The generated top-level object name (default `SyncularSchema`). */
  readonly objectName: string;
  /** Opt-in named-queries output path (a sibling `.kt` file). */
  readonly queriesPath?: string;
}

/** Dart emitter output: a `.dart` path plus optional options. */
export interface DartOutput {
  readonly path: string;
  /** Opt-in named-queries output path (a sibling `.dart` file). */
  readonly queriesPath?: string;
}

export interface ManifestOutput {
  readonly ir: string;
  readonly module: string;
  /** Opt-in TS named-queries output path (a sibling `.ts` file). Undefined →
   * named queries are not generated for TS. */
  readonly queries?: string;
  /** Opt-in native emitters; undefined → that language is not generated. */
  readonly swift?: SwiftOutput;
  readonly kotlin?: KotlinOutput;
  readonly dart?: DartOutput;
}

export interface Manifest {
  readonly manifestVersion: 1;
  readonly migrations: string;
  /** Directory of `.sql` named-query files (default `./queries`). Only read
   * when at least one output requests a named-queries file. */
  readonly queries: string;
  readonly output: ManifestOutput;
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

/** Parse a native-emitter output spec: a bare path string, or an object with
 * `path` + language options. Returns the resolved output or throws. */
function parseSwiftOutput(value: unknown): SwiftOutput {
  if (typeof value === 'string') {
    return {
      path: asString(value, 'output.swift'),
      enumName: 'SyncularSchema',
    };
  }
  const obj = asObject(value, 'output.swift');
  rejectUnknownKeys(obj, ['path', 'enumName', 'queriesPath'], 'output.swift');
  return {
    path: asString(obj.path, 'output.swift.path'),
    enumName:
      obj.enumName === undefined
        ? 'SyncularSchema'
        : asString(obj.enumName, 'output.swift.enumName'),
    ...(obj.queriesPath !== undefined
      ? { queriesPath: asString(obj.queriesPath, 'output.swift.queriesPath') }
      : {}),
  };
}

function parseKotlinOutput(value: unknown): KotlinOutput {
  if (typeof value === 'string') {
    return {
      path: asString(value, 'output.kotlin'),
      package: 'syncular.generated',
      objectName: 'SyncularSchema',
    };
  }
  const obj = asObject(value, 'output.kotlin');
  rejectUnknownKeys(
    obj,
    ['path', 'package', 'objectName', 'queriesPath'],
    'output.kotlin',
  );
  return {
    path: asString(obj.path, 'output.kotlin.path'),
    package:
      obj.package === undefined
        ? 'syncular.generated'
        : asString(obj.package, 'output.kotlin.package'),
    objectName:
      obj.objectName === undefined
        ? 'SyncularSchema'
        : asString(obj.objectName, 'output.kotlin.objectName'),
    ...(obj.queriesPath !== undefined
      ? { queriesPath: asString(obj.queriesPath, 'output.kotlin.queriesPath') }
      : {}),
  };
}

function parseDartOutput(value: unknown): DartOutput {
  if (typeof value === 'string') {
    return { path: asString(value, 'output.dart') };
  }
  const obj = asObject(value, 'output.dart');
  rejectUnknownKeys(obj, ['path', 'queriesPath'], 'output.dart');
  return {
    path: asString(obj.path, 'output.dart.path'),
    ...(obj.queriesPath !== undefined
      ? { queriesPath: asString(obj.queriesPath, 'output.dart.queriesPath') }
      : {}),
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
      'queries',
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
  const queries =
    obj.queries === undefined ? './queries' : asString(obj.queries, 'queries');
  let ir = './syncular.ir.json';
  let module = './syncular.generated.ts';
  let queriesOut: string | undefined;
  let swift: SwiftOutput | undefined;
  let kotlin: KotlinOutput | undefined;
  let dart: DartOutput | undefined;
  if (obj.output !== undefined) {
    const output = asObject(obj.output, 'output');
    rejectUnknownKeys(
      output,
      ['ir', 'module', 'queries', 'swift', 'kotlin', 'dart'],
      'output',
    );
    if (output.ir !== undefined) ir = asString(output.ir, 'output.ir');
    if (output.module !== undefined) {
      module = asString(output.module, 'output.module');
    }
    if (output.queries !== undefined) {
      queriesOut = asString(output.queries, 'output.queries');
    }
    if (output.swift !== undefined) swift = parseSwiftOutput(output.swift);
    if (output.kotlin !== undefined) kotlin = parseKotlinOutput(output.kotlin);
    if (output.dart !== undefined) dart = parseDartOutput(output.dart);
  }
  // Build `output` with only the keys that are set — `exactOptionalPropertyTypes`
  // forbids explicit `undefined` on optional properties.
  const outputSpec: ManifestOutput = {
    ir,
    module,
    ...(queriesOut !== undefined ? { queries: queriesOut } : {}),
    ...(swift !== undefined ? { swift } : {}),
    ...(kotlin !== undefined ? { kotlin } : {}),
    ...(dart !== undefined ? { dart } : {}),
  };
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
    queries,
    output: outputSpec,
    schemaVersions,
    tables,
    subscriptions,
    extensions: parseExtensions(obj.extensions, 'manifest'),
  };
}
