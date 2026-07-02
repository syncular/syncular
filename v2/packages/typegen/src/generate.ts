/**
 * Orchestration: manifest + migrations → IR → generated TS module, plus
 * the byte-exact `--check` freshness comparison.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { emitModule } from './emit';
import { TypegenError } from './errors';
import {
  canonicalizeExtensions,
  IR_VERSION,
  type IrDocument,
  type IrScope,
  type IrScopeValue,
  type IrSubscription,
  type IrSubscriptionScope,
  type IrTable,
  irHash,
  serializeIr,
} from './ir';
import {
  MANIFEST_FILENAME,
  type Manifest,
  type ManifestScopeSpec,
  parseManifest,
} from './manifest';
import { applyMigrationSql, type ParsedTable } from './sql';

export interface MigrationInput {
  /** Directory name, e.g. `0001_initial`. */
  readonly name: string;
  /** Contents of its `up.sql`. */
  readonly sql: string;
}

/** Same grammar the server compiles (§3.1): `prefix:{variable}`. */
const PATTERN_RE = /^([^{}]+):\{([^{}:]+)\}$/;
/** Whole-value placeholder: `{paramName}`. */
const PARAM_RE = /^\{([A-Za-z_$][A-Za-z0-9_$]*)\}$/;

function resolveScope(table: ParsedTable, spec: ManifestScopeSpec): IrScope {
  const pattern = typeof spec === 'string' ? spec : spec.pattern;
  const match = PATTERN_RE.exec(pattern);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new TypegenError(
      MANIFEST_FILENAME,
      `table ${table.name}: scope pattern ${JSON.stringify(pattern)} must be 'prefix:{variable}' with exactly one variable (§3.1)`,
    );
  }
  const variable = match[2];
  const column = typeof spec === 'string' ? variable : spec.column;
  if (!table.columns.some((c) => c.name === column)) {
    throw new TypegenError(
      MANIFEST_FILENAME,
      `table ${table.name}: scope pattern ${JSON.stringify(pattern)} names unknown column ${JSON.stringify(column)}`,
    );
  }
  return { pattern, variable, column };
}

function buildTable(
  manifestTable: {
    readonly name: string;
    readonly scopes: readonly ManifestScopeSpec[];
    readonly extensions: Readonly<Record<string, unknown>>;
  },
  parsed: ParsedTable,
): IrTable {
  const scopes = manifestTable.scopes.map((spec) => resolveScope(parsed, spec));
  for (const scope of scopes) {
    const clash = scopes.find(
      (s) => s.variable === scope.variable && s.column !== scope.column,
    );
    if (clash !== undefined) {
      throw new TypegenError(
        MANIFEST_FILENAME,
        `table ${parsed.name}: variable ${JSON.stringify(scope.variable)} maps to two different columns (§3.1)`,
      );
    }
  }
  return {
    name: parsed.name,
    primaryKey: parsed.primaryKey,
    columns: parsed.columns,
    scopes,
    extensions: canonicalizeExtensions(manifestTable.extensions) as Record<
      string,
      unknown
    >,
  };
}

function buildSubscription(
  sub: Manifest['subscriptions'][number],
  tables: readonly IrTable[],
): IrSubscription {
  const table = tables.find((t) => t.name === sub.table);
  if (table === undefined) {
    throw new TypegenError(
      MANIFEST_FILENAME,
      `subscription ${sub.name}: unknown table ${JSON.stringify(sub.table)}`,
    );
  }
  const declared = new Set(table.scopes.map((s) => s.variable));
  const scopes: IrSubscriptionScope[] = Object.entries(sub.scopes)
    .map(([variable, values]): IrSubscriptionScope => {
      if (!declared.has(variable)) {
        throw new TypegenError(
          MANIFEST_FILENAME,
          `subscription ${sub.name}: ${JSON.stringify(variable)} is not a scope variable of table ${sub.table} (declared: ${[...declared].join(', ')})`,
        );
      }
      const irValues: IrScopeValue[] = values.map((value) => {
        const param = PARAM_RE.exec(value);
        if (param?.[1] !== undefined) {
          return { kind: 'parameter', name: param[1] };
        }
        if (value.includes('{') || value.includes('}')) {
          throw new TypegenError(
            MANIFEST_FILENAME,
            `subscription ${sub.name}: scope value ${JSON.stringify(value)} mixes literals and placeholders — a value is either a literal or exactly '{param}'`,
          );
        }
        if (value === '*') {
          throw new TypegenError(
            MANIFEST_FILENAME,
            `subscription ${sub.name}: '*' is rejected in requested scopes (§3.2)`,
          );
        }
        return { kind: 'literal', value };
      });
      return { variable, values: irValues };
    })
    .sort((a, b) => (a.variable < b.variable ? -1 : 1));
  return { name: sub.name, table: sub.table, scopes };
}

function buildSchemaVersions(
  manifest: Manifest,
  migrations: readonly MigrationInput[],
): IrDocument['schemaVersions'] {
  const names = migrations.map((m) => m.name);
  let cursor = 0;
  const out = manifest.schemaVersions.map((entry) => {
    const index = names.indexOf(entry.through, cursor);
    if (index === -1) {
      throw new TypegenError(
        MANIFEST_FILENAME,
        `schemaVersions: version ${entry.version} names migration ${JSON.stringify(entry.through)}, which does not exist after ${JSON.stringify(names[cursor - 1] ?? '(start)')} (migrations: ${names.join(', ')})`,
      );
    }
    const covered = names.slice(cursor, index + 1);
    cursor = index + 1;
    return { version: entry.version, migrations: covered };
  });
  if (cursor !== names.length) {
    throw new TypegenError(
      MANIFEST_FILENAME,
      `schemaVersions: migrations ${names.slice(cursor).join(', ')} are not covered by any schema version — the last entry's "through" must be the last migration`,
    );
  }
  return out;
}

/** Pure IR construction — the testable heart of the generator. */
export function buildIr(
  manifest: Manifest,
  migrations: readonly MigrationInput[],
): IrDocument {
  if (migrations.length === 0) {
    throw new TypegenError(MANIFEST_FILENAME, 'no migrations found');
  }
  const parsedTables = new Map<string, ParsedTable>();
  for (const migration of migrations) {
    applyMigrationSql(parsedTables, migration.sql, `${migration.name}/up.sql`);
  }
  const schemaVersions = buildSchemaVersions(manifest, migrations);
  const tables = manifest.tables.map((manifestTable) => {
    const parsed = parsedTables.get(manifestTable.name);
    if (parsed === undefined) {
      throw new TypegenError(
        MANIFEST_FILENAME,
        `table ${JSON.stringify(manifestTable.name)} is not created by any migration`,
      );
    }
    return buildTable(manifestTable, parsed);
  });
  const listed = new Set(manifest.tables.map((t) => t.name));
  for (const name of parsedTables.keys()) {
    if (!listed.has(name)) {
      throw new TypegenError(
        MANIFEST_FILENAME,
        `migrated table ${JSON.stringify(name)} is missing from the manifest's tables list — every migrated table must be declared (fail loud; internal tables are a future manifest extension)`,
      );
    }
  }
  const subscriptions = manifest.subscriptions.map((sub) =>
    buildSubscription(sub, tables),
  );
  const last = manifest.schemaVersions[manifest.schemaVersions.length - 1];
  if (last === undefined) throw new Error('unreachable: schemaVersions');
  return {
    irVersion: IR_VERSION,
    schemaVersion: last.version,
    schemaVersions,
    tables,
    subscriptions,
    extensions: canonicalizeExtensions(manifest.extensions) as Record<
      string,
      unknown
    >,
  };
}

const MIGRATION_DIR_RE = /^(\d+)_[A-Za-z0-9_-]+$/;

/** Load `NNNN_name/up.sql` migrations, ordered by numeric prefix. */
export function loadMigrations(migrationsDir: string): MigrationInput[] {
  if (!existsSync(migrationsDir)) {
    throw new TypegenError(
      migrationsDir,
      'migrations directory does not exist',
    );
  }
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const parsed = entries.map((name) => {
    const match = MIGRATION_DIR_RE.exec(name);
    if (match === null || match[1] === undefined) {
      throw new TypegenError(
        migrationsDir,
        `migration directory ${JSON.stringify(name)} does not match NNNN_name`,
      );
    }
    return { name, order: Number.parseInt(match[1], 10) };
  });
  parsed.sort((a, b) => a.order - b.order);
  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1];
    const next = parsed[i];
    if (prev !== undefined && next !== undefined && prev.order === next.order) {
      throw new TypegenError(
        migrationsDir,
        `migrations ${prev.name} and ${next.name} share the ordinal ${next.order}`,
      );
    }
  }
  return parsed.map(({ name }) => {
    const upPath = join(migrationsDir, name, 'up.sql');
    if (!existsSync(upPath)) {
      throw new TypegenError(join(name, 'up.sql'), 'missing migration file');
    }
    return { name, sql: readFileSync(upPath, 'utf8') };
  });
}

export interface GenerateResult {
  readonly ir: IrDocument;
  /** Serialized IR document (the exact bytes of the `.ir.json` output). */
  readonly irJson: string;
  readonly hash: string;
  /** Generated TS module source (the exact bytes of the `.ts` output). */
  readonly module: string;
  readonly irPath: string;
  readonly modulePath: string;
}

/** Read `syncular.json` + migrations under `manifestDir`; build outputs. */
export function generate(manifestDir: string): GenerateResult {
  const manifestPath = resolve(manifestDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new TypegenError(manifestPath, 'manifest not found');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new TypegenError(
      manifestPath,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parseManifest(raw);
  const migrations = loadMigrations(resolve(manifestDir, manifest.migrations));
  const ir = buildIr(manifest, migrations);
  const irJson = serializeIr(ir);
  const hash = irHash(irJson);
  const module = emitModule(ir, hash);
  return {
    ir,
    irJson,
    hash,
    module,
    irPath: resolve(manifestDir, manifest.output.ir),
    modulePath: resolve(manifestDir, manifest.output.module),
  };
}

export function writeOutputs(result: GenerateResult): void {
  for (const [path, content] of [
    [result.irPath, result.irJson],
    [result.modulePath, result.module],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
}

/** Byte-exact freshness check; returns human-readable drift descriptions. */
export function checkOutputs(result: GenerateResult): string[] {
  const drift: string[] = [];
  for (const [path, expected] of [
    [result.irPath, result.irJson],
    [result.modulePath, result.module],
  ] as const) {
    if (!existsSync(path)) {
      drift.push(`${path}: missing — run generate`);
    } else if (readFileSync(path, 'utf8') !== expected) {
      drift.push(`${path}: stale — run generate`);
    }
  }
  return drift;
}
