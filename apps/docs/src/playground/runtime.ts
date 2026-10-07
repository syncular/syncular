// The playground's execution path, shared by the compiler worker and the
// docs tests: one in-memory SQLite per schema (the synthesized replica DDL
// plus the schema's seed rows), and the generated-runtime rules that pick a
// physical statement and bind its parameters from public inputs.
import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import type { IrDocument } from '../../../../packages/typegen/src/ir';
import {
  type QueryDb,
  synthesizeDdl,
} from '../../../../packages/typegen/src/query';
import { SYQL_DIAGNOSTIC_REMEDIES } from '../../../../packages/typegen/src/syql-diagnostics';
import { SyqlFrontendError } from '../../../../packages/typegen/src/syql-lexer';
import type { SyqlLoweredQuery } from '../../../../packages/typegen/src/syql-lowering';
import type {
  PlaygroundDiagnostic,
  PlaygroundQuery,
  PlaygroundSqlValue,
  PlaygroundStatement,
} from './protocol';

/** One app-shaped upsert, structurally a `SeedMutation` from the server. */
export interface PlaygroundSeedRow {
  readonly table: string;
  readonly op: 'upsert';
  readonly values: Readonly<Record<string, unknown>>;
}

/** A public input value as a generated TypeScript runtime receives it:
 * `undefined` is absent, a record is a present group or range. */
export type PlaygroundParam =
  | PlaygroundSqlValue
  | boolean
  | Readonly<Record<string, PlaygroundSqlValue>>
  | undefined;

export type PlaygroundParams = Readonly<Record<string, PlaygroundParam>>;

/** A public-input error with a generated-runtime code. */
export class PlaygroundRunError extends Error {
  readonly code: string;
  readonly input: string;

  constructor(code: string, message: string, input: string) {
    super(message);
    this.name = 'PlaygroundRunError';
    this.code = code;
    this.input = input;
  }
}

export interface PlaygroundDatabase {
  readonly database: Database;
  readonly queryDb: QueryDb;
}

const camel = (name: string): string =>
  name.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

/** Create the replica tables of `ir` and insert every seed row. */
export function openPlaygroundDatabase(
  sqlite3: Sqlite3Static,
  ir: IrDocument,
  seed: readonly PlaygroundSeedRow[],
): PlaygroundDatabase {
  const database = new sqlite3.oo1.DB(':memory:', 'c');
  try {
    database.exec(synthesizeDdl(ir));
    database.exec('begin');
    for (const row of seed) {
      const table = ir.tables.find((candidate) => candidate.name === row.table);
      if (table === undefined) {
        throw new Error(`playground seed names unknown table ${row.table}`);
      }
      const values = table.columns.map(({ name, nullable }) => {
        const value = row.values[name] ?? row.values[camel(name)];
        if (value === undefined || value === null) {
          if (!nullable) {
            throw new Error(`playground seed misses ${table.name}.${name}`);
          }
          return null;
        }
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'string' || typeof value === 'number') {
          return value;
        }
        return JSON.stringify(value);
      });
      database.exec({
        sql: `insert into "${table.name}" (${table.columns.map(({ name }) => `"${name}"`).join(', ')}) values (${table.columns.map(() => '?').join(', ')})`,
        bind: values,
      });
    }
    database.exec('commit');
  } catch (error) {
    database.close();
    throw error;
  }
  return {
    database,
    queryDb: {
      analyze(sql) {
        const statement = database.prepare(sql);
        try {
          return {
            columnNames:
              statement.columnCount === 0 ? [] : statement.getColumnNames(),
            declaredTypes: Array.from(
              { length: statement.columnCount },
              (_, index) =>
                sqlite3.capi.sqlite3_column_decltype(statement, index),
            ),
            paramsCount: statement.parameterCount,
          };
        } finally {
          statement.finalize();
        }
      },
    },
  };
}

/** Run one positional statement and return its result columns and rows. */
export function executeStatement(
  database: Database,
  sql: string,
  values: readonly PlaygroundSqlValue[],
): {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly PlaygroundSqlValue[])[];
} {
  const statement = database.prepare(sql);
  try {
    if (values.length > 0) statement.bind([...values]);
    const columns = statement.getColumnNames();
    const rows: PlaygroundSqlValue[][] = [];
    while (statement.step()) {
      rows.push(
        columns.map((_, index) => {
          const value = statement.get(index);
          if (typeof value === 'bigint') return Number(value);
          if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            return `<${value.byteLength} bytes>`;
          }
          return value ?? null;
        }),
      );
    }
    return { columns, rows };
  } finally {
    statement.finalize();
  }
}

function controlActive(
  query: PlaygroundQuery,
  control: string,
  params: PlaygroundParams,
): boolean {
  const input = query.inputs.find((candidate) => candidate.name === control);
  if (input?.kind === 'value' && input.default === false) {
    return params[control] === true;
  }
  return params[control] !== undefined;
}

/**
 * Select the physical statement for `params` and compute its positional
 * binds, following the generated TypeScript runtime: the activation mask
 * and sort profile pick the statement, and each plan bind reads one input.
 */
export function bindStatement(
  query: PlaygroundQuery,
  params: PlaygroundParams,
): {
  readonly statement: PlaygroundStatement;
  readonly values: readonly PlaygroundSqlValue[];
} {
  for (const input of query.inputs) {
    const value = params[input.name];
    if (input.kind === 'value' && input.required && value === undefined) {
      throw new PlaygroundRunError(
        'SYQL_RUNTIME_MISSING_REQUIRED_INPUT',
        'missing required input',
        input.name,
      );
    }
    if (
      input.kind === 'limit' &&
      value !== undefined &&
      (typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > input.maxSize)
    ) {
      throw new PlaygroundRunError(
        'SYQL_RUNTIME_INVALID_LIMIT',
        'limit is outside its declared range',
        input.name,
      );
    }
    if (
      input.kind === 'sort' &&
      value !== undefined &&
      !input.profiles.some((profile) => profile.name === value)
    ) {
      throw new PlaygroundRunError(
        'SYQL_RUNTIME_INVALID_SORT',
        'unknown sort profile',
        input.name,
      );
    }
  }
  const sort = query.inputs.find((input) => input.kind === 'sort');
  const profile =
    sort?.kind === 'sort'
      ? (params[sort.name] ?? sort.defaultProfile)
      : undefined;
  const mask =
    query.backend === 'variants'
      ? query.activationControls.reduce(
          (bits, control, index) =>
            controlActive(query, control, params) ? bits | (2 ** index) : bits,
          0,
        )
      : 0;
  const statement = query.statements.find(
    (candidate) =>
      candidate.sortProfile === profile &&
      (candidate.activationMask ?? 0) === mask,
  );
  if (statement === undefined) {
    throw new Error(`no physical statement for mask ${mask}`);
  }
  const values = statement.binds.map((bind): PlaygroundSqlValue => {
    if (bind.kind === 'condition-active') {
      return bind.controls.every((control) =>
        controlActive(query, control, params),
      )
        ? 1
        : 0;
    }
    const value = params[bind.input];
    if (bind.kind === 'limit') {
      const input = query.inputs.find(({ name }) => name === bind.input);
      return typeof value === 'number'
        ? value
        : input?.kind === 'limit'
          ? input.defaultSize
          : null;
    }
    if (bind.kind === 'group-member') {
      return typeof value === 'object' && value !== null
        ? (value[bind.member] ?? null)
        : null;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === undefined || value === null) return null;
    if (typeof value === 'object') {
      throw new PlaygroundRunError(
        'SYQL_RUNTIME_INVALID_INPUT',
        'a record was passed to a value input',
        bind.input,
      );
    }
    return value;
  });
  return { statement, values };
}

function inputMode(
  input: PlaygroundQuery['inputs'][number] | undefined,
  active: boolean,
): string {
  if (input?.kind === 'value' && input.default === false) {
    return active ? 'true' : 'false';
  }
  return active ? 'present' : 'absent';
}

/** The structured-clone-safe view of one lowered query. */
export function serializeQuery(lowered: SyqlLoweredQuery): PlaygroundQuery {
  const metadata = lowered.analysis.syql;
  if (metadata === undefined) {
    throw new Error('compiled SYQL query has no SYQL metadata');
  }
  const inputByName = new Map(
    metadata.inputs.map((input) => [input.name, input] as const),
  );
  const sortInput = metadata.inputs.find((input) => input.kind === 'sort');
  const controls = lowered.selected.activationControls;
  return {
    name: lowered.validated.logical.declaration.name,
    sync: lowered.validated.logical.declaration.sync,
    backend: lowered.selected.backend,
    activationControls: controls,
    ...(sortInput?.kind === 'sort'
      ? { defaultSortProfile: sortInput.defaultProfile }
      : {}),
    statements: lowered.selected.statements.map((statement) => ({
      sql: statement.sql,
      positionalSql: statement.positionalSql,
      ...(statement.sortProfile === undefined
        ? {}
        : { sortProfile: statement.sortProfile }),
      ...(statement.activationMask === undefined
        ? {}
        : { activationMask: statement.activationMask }),
      activationLabel:
        controls.length === 0
          ? 'always'
          : lowered.selected.backend === 'neutralize'
            ? 'runtime conditions'
            : controls
                .map((control, index) => {
                  const active =
                    ((statement.activationMask ?? 0) & (2 ** index)) !== 0;
                  return `${control} ${inputMode(inputByName.get(control), active)}`;
                })
                .join(' · '),
      binds: statement.binds,
    })),
    inputs: metadata.inputs,
    columns: lowered.analysis.columns.map(({ langName, type, nullable }) => ({
      name: langName,
      type,
      nullable,
    })),
    dependencies: lowered.analysis.reactive.dependencies,
    coverage: lowered.analysis.reactive.coverage,
    ...(metadata.identity === undefined ? {} : { identity: metadata.identity }),
  };
}

/** Map a thrown compiler error to a diagnostic with its source span. */
export function playgroundDiagnostic(error: unknown): PlaygroundDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof SyqlFrontendError
      ? error.code
      : (/\b(?:SYQL\d{4}\w*|PLAYGROUND_[A-Z_]+)\b/.exec(message)?.[0] ??
        'PLAYGROUND_COMPILE_ERROR');
  const remedy = Object.entries(SYQL_DIAGNOSTIC_REMEDIES).find(
    ([candidate]) => candidate === code,
  )?.[1];
  return {
    code,
    message: error instanceof SyqlFrontendError ? error.detail : message,
    ...(remedy === undefined ? {} : { remedy }),
    ...(error instanceof SyqlFrontendError
      ? {
          line: error.span.start.line,
          column: error.span.start.column,
          endLine: error.span.end.line,
          endColumn: error.span.end.column,
        }
      : {}),
  };
}
