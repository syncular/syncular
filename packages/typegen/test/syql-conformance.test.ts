import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  analyzeSyqlSemantics,
  buildSyqlModuleGraph,
  emitQueriesDartModule,
  emitQueriesKotlinModule,
  emitQueriesModule,
  emitQueriesRustModule,
  emitQueriesSwiftModule,
  formatSyql,
  type IrDocument,
  lexSyqlSource,
  lowerSyqlQuery,
  parseSyqlSyntaxFile,
  type QueryDb,
  type QuerySyqlExecutionPlan,
  type QuerySyqlStatement,
  renderSyqlLogicalTemplate,
  SyqlFrontendError,
  serializeQueryIr,
  synthesizeDdl,
  toSyqlSemanticAst,
  validateSyqlProgram,
} from '../src';

interface Position {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

interface DiagnosticFixture {
  readonly code: string;
  readonly start: Position;
}

type FamilyKind =
  | 'lexical'
  | 'syntax'
  | 'semantic'
  | 'lowering'
  | 'formatter'
  | 'emitter';

interface Manifest {
  readonly $schema: string;
  readonly language: 'SYQL';
  readonly revision: 1;
  readonly fixtureSchemaRevision: 3;
  readonly sqliteProfile: '3.46.0';
  readonly families: readonly {
    readonly kind: FamilyKind;
    readonly path: string;
  }[];
}

interface LexicalFixture {
  readonly $schema: string;
  readonly revision: 1;
  readonly cases: readonly {
    readonly name: string;
    readonly source: string;
    readonly tokens: readonly {
      readonly kind: string;
      readonly text: string;
      readonly start: Position;
      readonly end: Position;
    }[];
  }[];
  readonly invalid: readonly {
    readonly name: string;
    readonly source: string;
    readonly diagnostic: DiagnosticFixture;
  }[];
}

interface SyntaxFixture {
  readonly $schema: string;
  readonly revision: 1;
  readonly cases: readonly {
    readonly name: string;
    readonly source: string;
    readonly ast: unknown;
  }[];
  readonly invalid: readonly {
    readonly name: string;
    readonly source: string;
    readonly diagnostic: DiagnosticFixture;
  }[];
}

interface FixtureType {
  readonly base: string;
  readonly nullable: boolean;
}

interface SemanticFixture {
  readonly $schema: string;
  readonly revision: 1;
  readonly cases: readonly {
    readonly name: string;
    readonly entry: string;
    readonly sources: Readonly<Record<string, string>>;
    readonly queries: readonly {
      readonly name: string;
      readonly inputs: readonly {
        readonly kind: 'value' | 'range' | 'group';
        readonly name: string;
        readonly optional: boolean;
        readonly type?: FixtureType;
        readonly members?: readonly {
          readonly name: string;
          readonly type: FixtureType;
        }[];
      }[];
      readonly conditions: readonly (readonly string[])[];
      readonly renderedSqlContains: readonly string[];
    }[];
  }[];
  readonly invalid: readonly {
    readonly name: string;
    readonly entry: string;
    readonly sources: Readonly<Record<string, string>>;
    readonly code: string;
    readonly start: Position;
  }[];
}

interface LoweringExecution {
  readonly name: string;
  readonly active: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly sort: string;
  readonly limit: number;
  readonly ids: readonly string[];
}

interface LoweringFixture {
  readonly $schema: string;
  readonly revision: 1;
  readonly cases: readonly {
    readonly name: string;
    readonly source: string;
    readonly selectedBackend: 'neutralize' | 'variants';
    readonly activationControls: readonly string[];
    readonly neutralizedStatements: number;
    readonly enumeratedStatements: number;
    readonly queryIrVersion: 3;
    readonly publicInputKinds: readonly string[];
    readonly identity: readonly string[];
    readonly coverage: readonly {
      readonly table: string;
      readonly variable: string;
      readonly units: readonly string[];
    }[];
    readonly requiredSql: readonly string[];
    readonly forbiddenSql: readonly string[];
    readonly executions: readonly LoweringExecution[];
  }[];
  readonly invalid: readonly {
    readonly name: string;
    readonly source: string;
    readonly code: string;
  }[];
}

interface FormatterFixture {
  readonly $schema: string;
  readonly revision: 1;
  readonly cases: readonly {
    readonly name: string;
    readonly input: string;
    readonly output: string;
  }[];
}

interface EmitterFixture {
  readonly $schema: string;
  readonly revision: 1;
  readonly cases: readonly {
    readonly name: string;
    readonly source: string;
    readonly required: Readonly<
      Record<'ts' | 'swift' | 'kotlin' | 'dart' | 'rust', readonly string[]>
    >;
  }[];
}

const IR: IrDocument = {
  irVersion: 1,
  schemaVersion: 1,
  schemaVersions: [{ version: 1, migrations: ['0001'] }],
  tables: [
    {
      name: 'todos',
      primaryKey: 'id',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'status', type: 'string', nullable: true },
        { name: 'created_at', type: 'integer', nullable: false },
        { name: 'assignee_id', type: 'string', nullable: true },
      ],
      scopes: [
        { pattern: 'list:{list_id}', variable: 'list_id', column: 'list_id' },
      ],
      indexes: [],
      ftsIndexes: [],
      extensions: {},
    },
  ],
  subscriptions: [],
  extensions: {},
};

const root = resolve(import.meta.dir, '..', '..', '..', 'spec', 'syql');
const manifestPath = resolve(root, 'manifest.json');
const manifest = readJson<Manifest>(manifestPath);

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function family(kind: FamilyKind): string {
  const item = manifest.families.find((candidate) => candidate.kind === kind);
  if (item === undefined) throw new Error(`missing ${kind} fixture family`);
  return resolve(root, item.path);
}

function frontendError(run: () => unknown): SyqlFrontendError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SyqlFrontendError);
    return error as SyqlFrontendError;
  }
  throw new Error('expected a SyqlFrontendError');
}

function program(
  caseRoot: string,
  entry: string,
  sources: Readonly<Record<string, string>>,
) {
  const absoluteSources = new Map(
    Object.entries(sources).map(([name, source]) => [
      resolve(caseRoot, name),
      source,
    ]),
  );
  return analyzeSyqlSemantics(
    buildSyqlModuleGraph(caseRoot, [entry], (file) =>
      absoluteSources.get(file),
    ),
  );
}

function fixtureDatabase(): {
  readonly sqlite: Database;
  readonly db: QueryDb;
} {
  const sqlite = new Database(':memory:');
  sqlite.run(synthesizeDdl(IR));
  sqlite.run(`
    insert into todos (id, list_id, status, created_at, assignee_id) values
      ('t1', 'l1', null,   100, null),
      ('t2', 'l1', 'open', 200, 'u1'),
      ('t3', 'l1', 'done', 300, null),
      ('t4', 'l1', 'open', 400, 'u2'),
      ('t5', 'l2', 'open', 500, null)
  `);
  return {
    sqlite,
    db: {
      analyze(sql: string) {
        const statement = sqlite.prepare(sql);
        try {
          const columnNames = statement.columnNames;
          (statement as unknown as { all: () => unknown[] }).all();
          const declaredTypes = (
            statement as unknown as { declaredTypes: (string | null)[] }
          ).declaredTypes;
          const paramsCount = (statement as unknown as { paramsCount: number })
            .paramsCount;
          return { columnNames, declaredTypes, paramsCount };
        } finally {
          statement.finalize();
        }
      },
    },
  };
}

function statementFor(
  plan: QuerySyqlExecutionPlan,
  fixture: LoweringExecution,
): QuerySyqlStatement {
  const active = new Set(fixture.active);
  const mask = plan.activationControls.reduce(
    (value, control, index) =>
      active.has(control) ? value | (2 ** index) : value,
    0,
  );
  const statement = plan.statements.find(
    (candidate) =>
      candidate.sortProfile === fixture.sort &&
      (plan.backend === 'neutralize' || candidate.activationMask === mask),
  );
  if (statement === undefined) throw new Error('fixture statement not found');
  return statement;
}

function execute(
  sqlite: Database,
  plan: QuerySyqlExecutionPlan,
  fixture: LoweringExecution,
): readonly string[] {
  const active = new Set(fixture.active);
  const statement = statementFor(plan, fixture);
  const binds = statement.binds.map((bind) => {
    if (bind.kind === 'condition-active') {
      return bind.controls.every((control) => active.has(control)) ? 1 : 0;
    }
    if (bind.kind === 'limit') return fixture.limit;
    if (bind.kind === 'value') return fixture.values[bind.input] ?? null;
    const group = fixture.values[bind.input];
    return typeof group === 'object' && group !== null
      ? ((group as Record<string, unknown>)[bind.member] ?? null)
      : null;
  });
  const handle = sqlite.prepare(statement.positionalSql);
  try {
    const rows = (
      handle as unknown as {
        all(...values: unknown[]): { readonly id: string }[];
      }
    ).all(...binds);
    return rows.map((row) => row.id);
  } finally {
    handle.finalize();
  }
}

describe('normative SYQL revision-1 conformance fixtures', () => {
  test('manifest and every declared schema target are present', () => {
    expect(manifest).toMatchObject({
      language: 'SYQL',
      revision: 1,
      fixtureSchemaRevision: 3,
      sqliteProfile: '3.46.0',
    });
    expect(existsSync(resolve(dirname(manifestPath), manifest.$schema))).toBe(
      true,
    );
    expect(manifest.families.map((item) => item.kind)).toEqual([
      'lexical',
      'syntax',
      'semantic',
      'lowering',
      'formatter',
      'emitter',
    ]);
    expect(existsSync(resolve(root, 'schema/query-ir.schema.json'))).toBe(true);

    for (const item of manifest.families) {
      const fixturePath = resolve(root, item.path);
      expect(existsSync(fixturePath)).toBe(true);
      const fixture = readJson<{ readonly $schema: string }>(fixturePath);
      expect(existsSync(resolve(dirname(fixturePath), fixture.$schema))).toBe(
        true,
      );
    }
  });

  test('lexical vectors pin exact tokens, text, spans, and diagnostics', () => {
    const fixture = readJson<LexicalFixture>(family('lexical'));
    expect(fixture.revision).toBe(1);

    for (const item of fixture.cases) {
      const tokens = lexSyqlSource(`${item.name}.syql`, item.source);
      expect(
        tokens.map((token) => ({
          kind: token.kind,
          text: token.text,
          start: token.span.start,
          end: token.span.end,
        })) as unknown,
      ).toEqual(item.tokens);
      expect(tokens.map((token) => token.text).join('')).toBe(item.source);
    }

    for (const item of fixture.invalid) {
      const error = frontendError(() =>
        lexSyqlSource(`${item.name}.syql`, item.source),
      );
      expect({ code: error.code, start: error.span.start }).toEqual(
        item.diagnostic,
      );
    }
  });

  test('syntax vectors pin semantic ASTs and primary diagnostics', () => {
    const fixture = readJson<SyntaxFixture>(family('syntax'));
    expect(fixture.revision).toBe(1);

    for (const item of fixture.cases) {
      const parsed = parseSyqlSyntaxFile(`${item.name}.syql`, item.source);
      expect(toSyqlSemanticAst(parsed) as unknown).toEqual(item.ast);
    }

    for (const item of fixture.invalid) {
      const error = frontendError(() =>
        parseSyqlSyntaxFile(`${item.name}.syql`, item.source),
      );
      expect({ code: error.code, start: error.span.start }).toEqual(
        item.diagnostic,
      );
    }
  });

  test('semantic vectors pin imports, public inputs, control flow, and errors', () => {
    const fixture = readJson<SemanticFixture>(family('semantic'));
    expect(fixture.revision).toBe(1);

    for (const item of fixture.cases) {
      const analyzed = program(
        resolve('/virtual/syql-conformance', item.name),
        item.entry,
        item.sources,
      );
      expect(analyzed.queries).toHaveLength(item.queries.length);
      for (const [index, expected] of item.queries.entries()) {
        const query = analyzed.queries[index];
        expect(query?.declaration.name).toBe(expected.name);
        const inputs = query?.inputs.map((input) => {
          const parameter = input.parameter;
          if (parameter.kind === 'value') {
            const type = input.type;
            return {
              kind: parameter.kind,
              name: parameter.name,
              optional: parameter.optional,
              ...(type === undefined
                ? {}
                : { type: { base: type.base, nullable: type.nullable } }),
            };
          }
          if (parameter.kind === 'range') {
            const type = query.bindTypes.get(
              `__syqlRangeStart_${parameter.name}`,
            );
            return {
              kind: parameter.kind,
              name: parameter.name,
              optional: parameter.optional,
              ...(type === undefined
                ? {}
                : { type: { base: type.base, nullable: type.nullable } }),
            };
          }
          return {
            kind: parameter.kind,
            name: parameter.name,
            optional: parameter.optional,
            members: parameter.members.map((member) => {
              const type = query.bindTypes.get(member.name);
              if (type === undefined) throw new Error('missing group type');
              return {
                name: member.name,
                type: { base: type.base, nullable: type.nullable },
              };
            }),
          };
        });
        expect(inputs as unknown).toEqual(expected.inputs);
        expect(
          query?.conditions.map((condition) => condition.controls) as unknown,
        ).toEqual(expected.conditions);
        const rendered = renderSyqlLogicalTemplate(query?.template ?? []);
        for (const text of expected.renderedSqlContains) {
          expect(rendered).toContain(text);
        }
      }
    }

    for (const item of fixture.invalid) {
      const error = frontendError(() =>
        program(
          resolve('/virtual/syql-conformance', item.name),
          item.entry,
          item.sources,
        ),
      );
      expect(error.code).toBe(item.code);
      expect(error.span.start).toEqual(item.start);
    }
  });

  test('lowering vectors pin QueryIR and execute both physical backends', () => {
    const fixture = readJson<LoweringFixture>(family('lowering'));
    expect(fixture.revision).toBe(1);

    for (const item of fixture.cases) {
      const { sqlite, db } = fixtureDatabase();
      try {
        const semantic = program(
          resolve('/virtual/syql-conformance', item.name),
          'query.syql',
          { 'query.syql': item.source },
        );
        const query = validateSyqlProgram(semantic, IR, db, {
          naming: 'camel',
          targets: ['ts'],
          backend: 'auto',
        }).queries[0];
        if (query === undefined) throw new Error('fixture query not found');
        const lowered = lowerSyqlQuery(query, IR, db, {
          naming: 'camel',
          targets: ['ts'],
          backend: 'auto',
        });

        expect(lowered.selected.backend).toBe(item.selectedBackend);
        expect(lowered.selected.activationControls).toEqual(
          item.activationControls,
        );
        expect(lowered.neutralized.statements).toHaveLength(
          item.neutralizedStatements,
        );
        expect(lowered.enumerated?.statements).toHaveLength(
          item.enumeratedStatements,
        );
        const selectedSql = lowered.selected.statements.map(
          (statement) => statement.sql,
        );
        for (const text of item.requiredSql) {
          expect(selectedSql.some((sql) => sql.includes(text))).toBe(true);
        }
        for (const text of item.forbiddenSql) {
          expect(selectedSql.every((sql) => !sql.includes(text))).toBe(true);
        }
        const queryIr = JSON.parse(serializeQueryIr([lowered.analysis])) as {
          readonly queryIrVersion: number;
        };
        expect(queryIr.queryIrVersion).toBe(item.queryIrVersion);
        expect(
          lowered.analysis.syql?.inputs.map((input) => input.kind) as unknown,
        ).toEqual(item.publicInputKinds);
        expect(lowered.analysis.syql?.identity).toEqual(item.identity);
        expect(
          lowered.analysis.reactive.coverage.map((coverage) => ({
            table: coverage.table,
            variable: coverage.variable,
            units: coverage.units,
          })) as unknown,
        ).toEqual(item.coverage);

        if (lowered.enumerated === undefined) {
          throw new Error('fixture enumeration unavailable');
        }
        for (const execution of item.executions) {
          const neutralized = execute(sqlite, lowered.neutralized, execution);
          const enumerated = execute(sqlite, lowered.enumerated, execution);
          expect(neutralized).toEqual(execution.ids);
          expect(enumerated).toEqual(execution.ids);
        }
      } finally {
        sqlite.close();
      }
    }

    for (const item of fixture.invalid) {
      const { sqlite, db } = fixtureDatabase();
      try {
        const semantic = program(
          resolve('/virtual/syql-conformance', item.name),
          'query.syql',
          { 'query.syql': item.source },
        );
        const error = frontendError(() =>
          validateSyqlProgram(semantic, IR, db, {
            naming: 'camel',
            targets: ['ts'],
          }),
        );
        expect(error.code).toBe(item.code);
      } finally {
        sqlite.close();
      }
    }
  });

  test('formatter vectors are exact, semantic-preserving, and idempotent', () => {
    const fixture = readJson<FormatterFixture>(family('formatter'));
    expect(fixture.revision).toBe(1);
    for (const item of fixture.cases) {
      const file = `${item.name}.syql`;
      const output = formatSyql(file, item.input);
      expect(output).toBe(item.output);
      expect(formatSyql(file, output)).toBe(output);
      // formatSyql performs its own AST-equivalence check before returning.
      expect(() => parseSyqlSyntaxFile(file, output)).not.toThrow();
    }
  });

  test('emitter vectors pin equivalent revision-1 public contracts', () => {
    const fixture = readJson<EmitterFixture>(family('emitter'));
    expect(fixture.revision).toBe(1);
    for (const item of fixture.cases) {
      const { sqlite, db } = fixtureDatabase();
      try {
        const semantic = program(
          resolve('/virtual/syql-conformance', item.name),
          'query.syql',
          { 'query.syql': item.source },
        );
        const validated = validateSyqlProgram(semantic, IR, db, {
          naming: 'camel',
          targets: ['ts', 'swift', 'kotlin', 'dart', 'rust'],
          backend: 'auto',
        }).queries[0];
        if (validated === undefined) throw new Error('fixture query missing');
        const query = lowerSyqlQuery(validated, IR, db, {
          naming: 'camel',
          targets: ['ts', 'swift', 'kotlin', 'dart', 'rust'],
          backend: 'auto',
        }).analysis;
        const outputs = {
          ts: emitQueriesModule([query], 'sha256:fixture', 1),
          swift: emitQueriesSwiftModule(
            [query],
            'sha256:fixture',
            1,
            'FixtureSchema',
          ),
          kotlin: emitQueriesKotlinModule(
            [query],
            'sha256:fixture',
            1,
            'dev.syncular.fixture',
            'FixtureSchema',
          ),
          dart: emitQueriesDartModule([query], 'sha256:fixture', 1),
          rust: emitQueriesRustModule([query], 'sha256:fixture', 1),
        };
        expect(() =>
          new Bun.Transpiler({ loader: 'ts' }).transformSync(outputs.ts),
        ).not.toThrow();
        for (const target of [
          'ts',
          'swift',
          'kotlin',
          'dart',
          'rust',
        ] as const) {
          for (const snippet of item.required[target]) {
            expect(outputs[target]).toContain(snippet);
          }
          expect(outputs[target]).toContain(
            query.syql?.plan.statements[0]?.positionalSql as string,
          );
        }
      } finally {
        sqlite.close();
      }
    }
  });
});
