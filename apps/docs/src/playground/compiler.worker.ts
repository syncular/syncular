/// <reference lib="webworker" />

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';
import {
  compileSyqlSource,
  formatSyqlSource,
  type QueryDb,
  synthesizeDdl,
} from '@syncular/typegen/syql-browser';
import { PLAYGROUND_SCHEMAS } from './examples';
import type {
  PlaygroundDiagnostic,
  PlaygroundQuery,
  PlaygroundWorkerRequest,
  PlaygroundWorkerResponse,
} from './protocol';

const MAX_SOURCE_LENGTH = 64 * 1024;
const context = globalThis as unknown as DedicatedWorkerGlobalScope;

let sqlitePromise: Promise<Sqlite3Static> | undefined;
let activeSchemaId: string | undefined;
let activeDatabase: Database | undefined;
let activeQueryDb: QueryDb | undefined;

function sqlite(): Promise<Sqlite3Static> {
  if (sqlitePromise === undefined) {
    sqlitePromise = sqlite3InitModule();
  }
  return sqlitePromise;
}

function closeActiveDatabase(): void {
  activeDatabase?.close();
  activeSchemaId = undefined;
  activeDatabase = undefined;
  activeQueryDb = undefined;
}

async function queryDb(schemaId: string): Promise<QueryDb> {
  if (schemaId === activeSchemaId && activeQueryDb !== undefined) {
    return activeQueryDb;
  }
  const schema =
    PLAYGROUND_SCHEMAS[schemaId as keyof typeof PLAYGROUND_SCHEMAS];
  if (schema === undefined) {
    throw new Error(`unknown playground schema ${JSON.stringify(schemaId)}`);
  }
  closeActiveDatabase();
  const sqlite3 = await sqlite();
  const database = new sqlite3.oo1.DB(':memory:', 'c');
  try {
    database.exec(synthesizeDdl(schema));
  } catch (error) {
    database.close();
    throw error;
  }
  activeSchemaId = schemaId;
  activeDatabase = database;
  activeQueryDb = {
    analyze(sql) {
      const statement = database.prepare(sql);
      try {
        const columnNames =
          statement.columnCount === 0 ? [] : statement.getColumnNames();
        const declaredTypes = Array.from(
          { length: statement.columnCount },
          (_, index) => sqlite3.capi.sqlite3_column_decltype(statement, index),
        );
        return {
          columnNames,
          declaredTypes,
          paramsCount: statement.parameterCount,
        };
      } finally {
        statement.finalize();
      }
    },
  };
  return activeQueryDb;
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

function serializeQuery(
  lowered: ReturnType<typeof compileSyqlSource>['queries'][number],
): PlaygroundQuery {
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
    backend: lowered.selected.backend,
    ...(sortInput?.kind === 'sort'
      ? { defaultSortProfile: sortInput.defaultProfile }
      : {}),
    statements: lowered.selected.statements.map((statement) => {
      const activationLabel =
        lowered.selected.backend === 'neutralize'
          ? controls.length === 0
            ? 'always'
            : 'runtime conditions'
          : controls.length === 0
            ? 'always'
            : controls
                .map((control, index) => {
                  const active =
                    ((statement.activationMask ?? 0) & (2 ** index)) !== 0;
                  return `${control} ${inputMode(inputByName.get(control), active)}`;
                })
                .join(' · ');
      return {
        sql: statement.sql,
        positionalSql: statement.positionalSql,
        ...(statement.sortProfile === undefined
          ? {}
          : { sortProfile: statement.sortProfile }),
        ...(statement.activationMask === undefined
          ? {}
          : { activationMask: statement.activationMask }),
        activationLabel,
        binds: statement.binds,
      };
    }),
    inputs: metadata.inputs,
    dependencies: lowered.analysis.reactive.dependencies,
    coverage: lowered.analysis.reactive.coverage,
    ...(metadata.identity === undefined ? {} : { identity: metadata.identity }),
  };
}

function diagnostic(error: unknown): PlaygroundDiagnostic {
  const candidate = error as {
    readonly code?: unknown;
    readonly detail?: unknown;
    readonly message?: unknown;
    readonly span?: {
      readonly start: { readonly line: number; readonly column: number };
      readonly end: { readonly line: number; readonly column: number };
    };
  };
  const message =
    typeof candidate?.detail === 'string'
      ? candidate.detail
      : typeof candidate?.message === 'string'
        ? candidate.message
        : error instanceof Error
          ? error.message
          : String(error);
  const codeFromMessage = /\b(?:SYQL\d{4}|PLAYGROUND_[A-Z_]+)\b/.exec(
    message,
  )?.[0];
  const code =
    typeof candidate?.code === 'string'
      ? candidate.code
      : (codeFromMessage ?? 'PLAYGROUND_COMPILE_ERROR');
  const span = candidate?.span;
  return {
    code,
    message,
    ...(span === undefined
      ? {}
      : {
          line: span.start.line,
          column: span.start.column,
          endLine: span.end.line,
          endColumn: span.end.column,
        }),
  };
}

function post(response: PlaygroundWorkerResponse): void {
  context.postMessage(response);
}

async function handle(request: PlaygroundWorkerRequest): Promise<void> {
  if (request.source.length > MAX_SOURCE_LENGTH) {
    post({
      kind: 'diagnostics',
      requestId: request.requestId,
      diagnostics: [
        {
          code: 'PLAYGROUND_SOURCE_TOO_LARGE',
          message: `playground compilation is limited to ${MAX_SOURCE_LENGTH / 1024} KiB`,
        },
      ],
    });
    return;
  }
  try {
    if (request.kind === 'format') {
      post({
        kind: 'formatted',
        requestId: request.requestId,
        source: formatSyqlSource(request.source),
      });
      return;
    }
    const started = performance.now();
    const schema =
      PLAYGROUND_SCHEMAS[request.schemaId as keyof typeof PLAYGROUND_SCHEMAS];
    if (schema === undefined) {
      throw new Error(
        `unknown playground schema ${JSON.stringify(request.schemaId)}`,
      );
    }
    const result = compileSyqlSource(
      request.source,
      schema,
      await queryDb(request.schemaId),
    );
    if (result.queries.length === 0) {
      throw new Error('PLAYGROUND_NO_QUERY: declare at least one query');
    }
    post({
      kind: 'compiled',
      requestId: request.requestId,
      elapsedMs: performance.now() - started,
      queries: result.queries.map(serializeQuery),
    });
  } catch (error) {
    post({
      kind: 'diagnostics',
      requestId: request.requestId,
      diagnostics: [diagnostic(error)],
    });
  }
}

context.addEventListener(
  'message',
  (event: MessageEvent<PlaygroundWorkerRequest>) => {
    void handle(event.data);
  },
);

post({ kind: 'ready' });
