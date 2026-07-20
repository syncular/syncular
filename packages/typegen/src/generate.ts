/**
 * Orchestration: manifest + migrations → IR → generated TS module, plus
 * the byte-exact `--check` freshness comparison.
 */

import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { emitModule } from './emit';
import { emitDartModule } from './emit-dart';
import { emitKotlinModule } from './emit-kotlin';
import { emitQueriesModule } from './emit-queries';
import { emitQueriesDartModule } from './emit-queries-dart';
import { emitQueriesKotlinModule } from './emit-queries-kotlin';
import { emitQueriesRustModule } from './emit-queries-rust';
import { emitQueriesSwiftModule } from './emit-queries-swift';
import { emitSwiftModule } from './emit-swift';
import { TypegenError } from './errors';
import {
  canonicalizeExtensions,
  IR_VERSION,
  type IrColumn,
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
import {
  buildMigrationLock,
  LEGACY_MIGRATION_LOCK_FORMAT_VERSION,
  MIGRATION_LOCK_FILENAME,
  readMigrationLock,
  serializeMigrationLock,
  updateMigrationLock,
} from './migration-lock';
import { buildNamingMap, type NamingTarget } from './naming';
import {
  type AnalyzedQuery,
  analyzeQueryFile,
  type QueryDb,
  type QueryNamingOptions,
  synthesizeDdl,
} from './query';
import { serializeQueryIr } from './query-ir';
import {
  applyMigrationSql,
  type ParsedTable,
  validateFinalSchemaIdentifiers,
} from './sql';
import { lowerSyqlQuery } from './syql-lowering';
import { buildSyqlModuleGraph } from './syql-modules';
import { analyzeSyqlSemantics } from './syql-semantics';
import { validateSyqlProgram } from './syql-validator';

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
    readonly encryptedColumns: readonly string[];
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
  const columns = applyEncryption(
    parsed,
    scopes,
    manifestTable.encryptedColumns,
  );
  return {
    name: parsed.name,
    primaryKey: parsed.primaryKey,
    columns,
    scopes,
    // Indexes flow through from the migration parser (already validated:
    // columns exist, names unique per schema) in declaration order.
    indexes: parsed.indexes,
    ftsIndexes: parsed.ftsIndexes,
    extensions: canonicalizeExtensions(manifestTable.extensions) as Record<
      string,
      unknown
    >,
  };
}

/**
 * §5.11: flip each `encryptedColumns` entry to wire type `bytes`, recording
 * `encrypted` + `declaredType`. Enforces the hard generate-time errors:
 * encrypted scope column, encrypted crdt column, encrypted primary key, and
 * an unknown/already-bytes column.
 */
function applyEncryption(
  parsed: ParsedTable,
  scopes: readonly { readonly column: string }[],
  encryptedColumns: readonly string[],
): readonly IrColumn[] {
  if (encryptedColumns.length === 0) return parsed.columns;
  const encrypted = new Set(encryptedColumns);
  const scopeColumns = new Set(scopes.map((s) => s.column));
  for (const name of encrypted) {
    const column = parsed.columns.find((c) => c.name === name);
    if (column === undefined) {
      throw new TypegenError(
        MANIFEST_FILENAME,
        `table ${parsed.name}: encryptedColumns names unknown column ${JSON.stringify(name)}`,
      );
    }
    if (name === parsed.primaryKey) {
      throw new TypegenError(
        MANIFEST_FILENAME,
        `table ${parsed.name}: primary key ${JSON.stringify(name)} cannot be encrypted — it renders the plaintext rowId (§2.2, §5.11)`,
      );
    }
    if (scopeColumns.has(name)) {
      throw new TypegenError(
        MANIFEST_FILENAME,
        `table ${parsed.name}: scope column ${JSON.stringify(name)} cannot be encrypted — scopes are extracted server-side and MUST stay plaintext (§3.1, §5.11)`,
      );
    }
    if (column.type === 'crdt') {
      throw new TypegenError(
        MANIFEST_FILENAME,
        `table ${parsed.name}: crdt column ${JSON.stringify(name)} cannot be encrypted — the server merges crdt bytes plaintext (§5.10.3, §5.11)`,
      );
    }
  }
  return parsed.columns.map((column): IrColumn => {
    if (!encrypted.has(column.name)) return column;
    // Flip wire type to bytes; keep the declared type for app-side emitters.
    return {
      name: column.name,
      type: 'bytes',
      nullable: column.nullable,
      encrypted: true,
      declaredType: column.type,
    };
  });
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
  const droppedTables = new Set<string>();
  for (const migration of migrations) {
    applyMigrationSql(
      parsedTables,
      migration.sql,
      `${migration.name}/up.sql`,
      droppedTables,
    );
  }
  validateFinalSchemaIdentifiers(parsedTables);
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

/** One named-query file (`.sql` — the compatibility floor — or `.syql`, the
 * DSL): path relative to the queries root (forward slashes) + raw contents.
 * A file may hold multiple statements/declarations. */
export interface QueryInput {
  /** Path relative to the queries root, forward-slashed (e.g.
   * `billing/invoices/list.sql`). Drives the path-derived default name for
   * `.sql`; `.syql` queries carry their own names. */
  readonly file: string;
  readonly sql: string;
}

/** Recursively collect `*.sql` + `*.syql` paths under `dir`, relative to
 * `root` (forward-slashed), sorted for deterministic emission. */
function collectSqlFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSqlFiles(root, abs));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.sql') || entry.name.endsWith('.syql'))
    ) {
      out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  return out;
}

/** Load `queries/**\/*.{sql,syql}` recursively, ordered by relative path
 * (deterministic emission). Folders are pure organization. */
export function loadQueries(queriesDir: string): QueryInput[] {
  if (!existsSync(queriesDir)) return [];
  return collectSqlFiles(queriesDir, queriesDir)
    .sort()
    .map((file) => ({
      file,
      sql: readFileSync(join(queriesDir, file), 'utf8'),
    }));
}

/** A {@link QueryDb} backed by an in-memory bun:sqlite built from the IR DDL.
 * `analyze` prepares the statement (validating references) and reads its
 * column names + declared types; it executes once against the empty DB so
 * `declaredTypes` (decltype) is populated. */
export function makeQueryDb(ir: IrDocument): {
  db: QueryDb;
  close: () => void;
} {
  const sqlite = new Database(':memory:');
  sqlite.run(synthesizeDdl(ir));
  const db: QueryDb = {
    analyze(sql: string) {
      const stmt = sqlite.prepare(sql);
      try {
        const columnNames = stmt.columnNames;
        // Execute once against the empty DB to populate decltype; result is [].
        const paramsCount = (stmt as unknown as { paramsCount: number })
          .paramsCount;
        // An unbound FTS5 MATCH parameter is treated as the empty query and
        // fails parsing. A numeric probe is valid for MATCH and LIMIT alike,
        // while the empty database still guarantees no result rows.
        const probe = /\bMATCH\b/i.test(sql)
          ? Array.from({ length: paramsCount }, () => 1)
          : [];
        (
          stmt as unknown as {
            all: (...params: readonly number[]) => unknown[];
          }
        ).all(...probe);
        const declaredTypes = (
          stmt as unknown as { declaredTypes: (string | null)[] }
        ).declaredTypes;
        return { columnNames, declaredTypes, paramsCount };
      } finally {
        stmt.finalize();
      }
    },
  };
  return { db, close: () => sqlite.close() };
}

/** Analyze every query file against the IR (SELECT-only, typed, deps). */
export function analyzeQueries(
  ir: IrDocument,
  queries: readonly QueryInput[],
  naming?: QueryNamingOptions,
  queriesRoot = resolve('/__syncular_queries__'),
): AnalyzedQuery[] {
  if (queries.length === 0) return [];
  const { db, close } = makeQueryDb(ir);
  try {
    const plain = queries
      .filter((query) => query.file.endsWith('.sql'))
      .flatMap((query) =>
        analyzeQueryFile(query.file, query.sql, ir, db, naming),
      );
    const syqlInputs = queries.filter((query) => query.file.endsWith('.syql'));
    let syql: AnalyzedQuery[] = [];
    if (syqlInputs.length > 0) {
      const root = resolve(queriesRoot);
      const sourceByFile = new Map(
        syqlInputs.map((query) => [resolve(root, query.file), query.sql]),
      );
      const displayByFile = new Map(
        syqlInputs.map((query) => [resolve(root, query.file), query.file]),
      );
      const graph = buildSyqlModuleGraph(
        root,
        syqlInputs.map((query) => query.file),
        (file) => sourceByFile.get(file),
      );
      const validated = validateSyqlProgram(
        analyzeSyqlSemantics(graph),
        ir,
        db,
        naming,
      );
      syql = validated.queries
        .map((query) => {
          const lowered = lowerSyqlQuery(query, ir, db, naming).analysis;
          return {
            ...lowered,
            file: displayByFile.get(query.logical.module.file) ?? lowered.file,
          };
        })
        .sort((left, right) => left.file.localeCompare(right.file));
    }
    const analyzed = [...plain, ...syql];
    // Names must be unique across the whole manifest — the filesystem no longer
    // guarantees uniqueness once `-- name:` overrides exist. Report BOTH source
    // locations (file + statement position) on a collision.
    const seen = new Map<string, string>();
    for (const q of analyzed) {
      const prev = seen.get(q.name);
      if (prev !== undefined) {
        throw new TypegenError(
          q.file,
          `duplicate query name ${JSON.stringify(q.name)} — defined at ${prev} and ${q.file}. Rename one (a file's path-derived default or its \`-- name:\` override).`,
        );
      }
      seen.set(q.name, q.file);
    }
    return analyzed;
  } finally {
    close();
  }
}

/** One generated artifact: an absolute output path and its exact bytes. */
export interface GeneratedOutput {
  readonly path: string;
  readonly content: string;
}

export interface GenerateResult {
  readonly ir: IrDocument;
  /** Serialized IR document (the exact bytes of the `.ir.json` output). */
  readonly irJson: string;
  readonly hash: string;
  /** Serialized QueryIR and its content hash. Query descriptors use this hash
   * so a SQL-only edit cannot reuse a stale reactive cache entry. */
  readonly queryIrJson: string;
  readonly queryHash: string;
  /** Generated TS module source (the exact bytes of the `.ts` output). */
  readonly module: string;
  /** Immutable application-migration history baseline. */
  readonly migrationLockJson: string;
  readonly migrationLockPath: string;
  readonly irPath: string;
  readonly modulePath: string;
  /** Analyzed named queries (empty when no `queries/` files / no query output). */
  readonly queries: readonly AnalyzedQuery[];
  /** Every artifact this manifest emits (IR + TS + any opt-in native), in a
   * stable order — the single list `writeOutputs`/`checkOutputs` iterate. */
  readonly outputs: readonly GeneratedOutput[];
}

interface ProjectInputs {
  readonly manifest: Manifest;
  readonly migrations: readonly MigrationInput[];
}

function loadProjectInputs(manifestDir: string): ProjectInputs {
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
  return { manifest, migrations };
}

/**
 * Build a first immutable migration baseline. The caller owns the one-time
 * write so the CLI can refuse replacement before touching the filesystem.
 */
export function baselineMigrationHistory(manifestDir: string): GeneratedOutput {
  const { manifest, migrations } = loadProjectInputs(manifestDir);
  // Baseline only a schema that is valid as a complete generated project.
  buildIr(manifest, migrations);
  return {
    path: resolve(manifestDir, MIGRATION_LOCK_FILENAME),
    content: serializeMigrationLock(buildMigrationLock(migrations)),
  };
}

/**
 * Validate and explicitly compact a version-1 migration lock to version 2.
 * The caller owns the in-place write so the CLI can make the format transition
 * visible and reviewable.
 */
export function upgradeMigrationHistory(manifestDir: string): GeneratedOutput {
  const { manifest, migrations } = loadProjectInputs(manifestDir);
  const locked = readMigrationLock(manifestDir);
  if (locked.formatVersion !== LEGACY_MIGRATION_LOCK_FORMAT_VERSION) {
    throw new TypegenError(
      MIGRATION_LOCK_FILENAME,
      'already uses the current compact migration-lock format',
    );
  }
  // Validate the immutable prefix before replacing its representation.
  updateMigrationLock(locked, migrations);
  buildIr(manifest, migrations);
  return {
    path: resolve(manifestDir, MIGRATION_LOCK_FILENAME),
    content: serializeMigrationLock(buildMigrationLock(migrations)),
  };
}

/** Fast CI check for migration history without emitting/query analysis. */
export function checkMigrationHistory(manifestDir: string): string[] {
  const { manifest, migrations } = loadProjectInputs(manifestDir);
  const current = updateMigrationLock(
    readMigrationLock(manifestDir),
    migrations,
  );
  buildIr(manifest, migrations);
  const output = {
    path: resolve(manifestDir, MIGRATION_LOCK_FILENAME),
    content: serializeMigrationLock(current),
  };
  if (readFileSync(output.path, 'utf8') !== output.content) {
    return [
      `${MIGRATION_LOCK_FILENAME}: new migrations are not locked — run generate and commit the updated lock`,
    ];
  }
  return [];
}

/** Read `syncular.json` + migrations under `manifestDir`; build outputs. */
export function generate(manifestDir: string): GenerateResult {
  const { manifest, migrations } = loadProjectInputs(manifestDir);
  const migrationLock = updateMigrationLock(
    readMigrationLock(manifestDir),
    migrations,
  );
  const ir = buildIr(manifest, migrations);

  // §5/§12 naming: the emitter targets this run generates (keyword hazards
  // are only real on targets that exist), and the per-table collision check
  // for the generated row types.
  const targets: NamingTarget[] = ['ts'];
  if (manifest.output.swift !== undefined) targets.push('swift');
  if (manifest.output.kotlin !== undefined) targets.push('kotlin');
  if (manifest.output.dart !== undefined) targets.push('dart');
  if (manifest.output.rust !== undefined) targets.push('rust');
  const naming: QueryNamingOptions = {
    naming: manifest.naming,
    targets,
    backend: manifest.queryBackend,
  };
  for (const table of ir.tables) {
    buildNamingMap(
      table.columns.map((c) => c.name),
      manifest.naming,
      MANIFEST_FILENAME,
      `table ${table.name}`,
      targets,
    );
  }

  const irJson = serializeIr(ir);
  const hash = irHash(irJson);
  const module = emitModule(ir, hash, manifest.naming);
  const migrationLockJson = serializeMigrationLock(migrationLock);
  const migrationLockPath = resolve(manifestDir, MIGRATION_LOCK_FILENAME);
  const irPath = resolve(manifestDir, manifest.output.ir);
  const modulePath = resolve(manifestDir, manifest.output.module);
  const outputs: GeneratedOutput[] = [
    { path: migrationLockPath, content: migrationLockJson },
    { path: irPath, content: irJson },
    { path: modulePath, content: module },
  ];
  // Opt-in native emitters — each present only when the manifest requests it.
  const {
    queryIr: queryIrPath,
    queries: tsQueriesPath,
    swift,
    kotlin,
    dart,
    rust,
  } = manifest.output;

  // Named queries: analyzed once (SELECT-only, typed against the IR via
  // SQLite), then emitted per-language into its OWN file so schema-only
  // consumers never churn. Only analyzed when SOME query output is requested.
  const wantsQueries =
    queryIrPath !== undefined ||
    tsQueriesPath !== undefined ||
    swift?.queriesPath !== undefined ||
    kotlin?.queriesPath !== undefined ||
    dart?.queriesPath !== undefined ||
    rust?.queriesPath !== undefined;
  const analyzedQueries = wantsQueries
    ? analyzeQueries(
        ir,
        loadQueries(resolve(manifestDir, manifest.queries)),
        naming,
        resolve(manifestDir, manifest.queries),
      )
    : [];
  if (wantsQueries && analyzedQueries.length === 0) {
    throw new TypegenError(
      resolve(manifestDir, manifest.queries),
      `an output requests named queries but no .sql files were found in ${manifest.queries} — add a query file or drop the queries output`,
    );
  }

  const queryIrJson = serializeQueryIr(analyzedQueries);
  const queryHash = irHash(queryIrJson);
  if (queryIrPath !== undefined) {
    outputs.push({
      path: resolve(manifestDir, queryIrPath),
      content: queryIrJson,
    });
  }

  if (tsQueriesPath !== undefined) {
    outputs.push({
      path: resolve(manifestDir, tsQueriesPath),
      content: emitQueriesModule(analyzedQueries, queryHash, ir.irVersion),
    });
  }
  if (swift !== undefined) {
    outputs.push({
      path: resolve(manifestDir, swift.path),
      content: emitSwiftModule(ir, hash, swift.enumName),
    });
    if (swift.queriesPath !== undefined) {
      outputs.push({
        path: resolve(manifestDir, swift.queriesPath),
        content: emitQueriesSwiftModule(
          analyzedQueries,
          queryHash,
          ir.irVersion,
          swift.enumName,
        ),
      });
    }
  }
  if (kotlin !== undefined) {
    outputs.push({
      path: resolve(manifestDir, kotlin.path),
      content: emitKotlinModule(ir, hash, kotlin.package, kotlin.objectName),
    });
    if (kotlin.queriesPath !== undefined) {
      outputs.push({
        path: resolve(manifestDir, kotlin.queriesPath),
        content: emitQueriesKotlinModule(
          analyzedQueries,
          queryHash,
          ir.irVersion,
          kotlin.package,
          kotlin.objectName,
        ),
      });
    }
  }
  if (dart !== undefined) {
    outputs.push({
      path: resolve(manifestDir, dart.path),
      content: emitDartModule(ir, hash),
    });
    if (dart.queriesPath !== undefined) {
      outputs.push({
        path: resolve(manifestDir, dart.queriesPath),
        content: emitQueriesDartModule(
          analyzedQueries,
          queryHash,
          ir.irVersion,
        ),
      });
    }
  }
  if (rust !== undefined) {
    outputs.push({
      path: resolve(manifestDir, rust.queriesPath),
      content: emitQueriesRustModule(
        analyzedQueries,
        queryHash,
        ir.irVersion,
        rust.clientCrate,
      ),
    });
  }
  return {
    ir,
    irJson,
    hash,
    queryIrJson,
    queryHash,
    module,
    migrationLockJson,
    migrationLockPath,
    irPath,
    modulePath,
    queries: analyzedQueries,
    outputs,
  };
}

export function writeOutputs(result: GenerateResult): void {
  for (const { path, content } of result.outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
}

/** Byte-exact freshness check; returns human-readable drift descriptions. */
export function checkOutputs(result: GenerateResult): string[] {
  const drift: string[] = [];
  for (const { path, content } of result.outputs) {
    if (!existsSync(path)) {
      drift.push(`${path}: missing — run generate`);
    } else if (readFileSync(path, 'utf8') !== content) {
      drift.push(`${path}: stale — run generate`);
    }
  }
  return drift;
}
