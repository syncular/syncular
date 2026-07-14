import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  buildSyqlModuleGraph,
  lexSyqlSource,
  parseSyqlSyntaxFile,
  SyqlFrontendError,
} from '../src';

function frontendError(run: () => unknown): SyqlFrontendError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SyqlFrontendError);
    return error as SyqlFrontendError;
  }
  throw new Error('expected a SyqlFrontendError');
}

describe('SYQL lexer', () => {
  test('is lossless and preserves SQL atomic-token contents', () => {
    const source = [
      '\ufeffquery lexical(listId) {',
      `  select 'a  b; :ghost { }', "or""der", \`back\`\`tick\`, X'CAFE'`,
      '  from todos -- :comment } ;',
      '  where list_id = :listId /* fake(:x) { ; } */;',
      '}',
      '',
    ].join('\r\n');
    const tokens = lexSyqlSource('lexical.syql', source);
    expect(
      tokens
        .filter((token) => token.kind !== 'eof')
        .map((token) => token.text)
        .join(''),
    ).toBe(source);
    expect(
      tokens
        .filter((token) => token.kind === 'bind')
        .map((token) => token.text),
    ).toEqual([':listId']);
    expect(
      tokens
        .filter((token) => token.kind === 'quoted-identifier')
        .map((token) => token.text),
    ).toEqual(['"or""der"', '`back``tick`']);
    expect(tokens.find((token) => token.kind === 'blob')?.text).toBe("X'CAFE'");
  });

  test('tracks CRLF lines and Unicode-scalar columns', () => {
    const identifiers = lexSyqlSource('position.syql', 'a\r\n😀x').filter(
      (token) => token.kind === 'identifier',
    );
    expect(identifiers[1]?.span).toMatchObject({
      start: { offset: 3, line: 2, column: 1 },
      end: { offset: 6, line: 2, column: 3 },
    });
  });

  test('reports stable unterminated-token errors', () => {
    const error = frontendError(() => lexSyqlSource('bad.syql', "select 'x"));
    expect(error.code).toBe('SYQL1001_UNTERMINATED_STRING');
    expect(error.span.start).toMatchObject({ line: 1, column: 8 });
  });
});

describe('SYQL container parser', () => {
  test('parses the SQL-first query grammar and its typed controls', () => {
    const source = `
      import { matchesTitle } from "./predicates.syql";

      sync query listTodos(
        listId,
        status?: string | null,
        range?,
        window?: { start: integer, end: integer },
        unassigned: bool = false,
      ) by todos.list_id {
        select id, title, created_at
        from todos
        where todos.list_id = :listId
          and when(status) status is :status
          and when(range) created_at between :range
          and when(unassigned) assignee_id is null
          and when(window) created_at between :start and :end
          and when(status) matchesTitle(:status)
        order by sortBy default newest {
          newest: created_at desc, id desc;
          oldest: created_at asc, id asc;
        }
        limit pageSize default 50 max 200;
      }
    `;
    const file = parseSyqlSyntaxFile('todos.syql', source);
    const query = file.queries[0];
    expect(file.imports[0]?.path).toBe('./predicates.syql');
    expect(query?.sync).toBe(true);
    expect(query?.syncBy).toMatchObject({
      qualifier: 'todos',
      column: 'list_id',
    });
    expect(query?.parameters.map((parameter) => parameter.kind)).toEqual([
      'value',
      'value',
      'range',
      'group',
      'value',
    ]);
    expect(query?.parameters[4]).toMatchObject({
      kind: 'value',
      default: false,
      type: { base: 'boolean', nullable: false },
    });
    expect(query?.statement.text).toContain('created_at between :range');
    expect(
      query?.statement.tree.nodes.filter((node) => node.kind === 'when'),
    ).toHaveLength(5);
    expect(query?.sort?.profiles.map((profile) => profile.name)).toEqual([
      'newest',
      'oldest',
    ]);
    expect(query?.limit).toMatchObject({
      control: 'pageSize',
      defaultSize: 50,
      maxSize: 200,
    });
  });

  test('parses explicit presence and compound when bodies', () => {
    const file = parseSyqlSyntaxFile(
      'present.syql',
      `query q(status?: string | null, bounds?: { low, high }) {
        select id from todos
        where when(present(status)) status is :status
          and when(bounds) {
            position >= :low
            and position <= :high
          };
      }`,
    );
    const nodes = file.queries[0]?.statement.tree.nodes.filter(
      (node) => node.kind === 'when',
    );
    expect(nodes?.[0]).toMatchObject({
      controls: ['status'],
      explicitPresence: [true],
    });
    expect(nodes?.[1]).toMatchObject({ controls: ['bounds'] });
  });

  test('requires a terminating semicolon and rejects removed syntax', () => {
    expect(
      frontendError(() =>
        parseSyqlSyntaxFile('bad.syql', 'query q() { select 1 }'),
      ).code,
    ).toBe('SYQL2012_INVALID_QUERY_BODY');
    expect(
      frontendError(() =>
        parseSyqlSyntaxFile('bad.syql', 'query q() { sql { select 1 } }'),
      ).code,
    ).toBe('SYQL2012_INVALID_QUERY_BODY');
    expect(
      frontendError(() =>
        parseSyqlSyntaxFile(
          'bad.syql',
          'query q(id) { select id from todos where @scope(id = :id); }',
        ),
      ).code,
    ).toBe('SYQL3006_FORBIDDEN_TEMPLATE_NODE');
    expect(
      frontendError(() =>
        parseSyqlSyntaxFile(
          'bad.syql',
          'query q(enabled?: switch) { select 1; }',
        ),
      ).code,
    ).toBe('SYQL2011_INVALID_PARAMETER');
  });

  test('validates dynamic control declarations', () => {
    expect(
      frontendError(() =>
        parseSyqlSyntaxFile(
          'bad.syql',
          `query q() {
            select 1
            order by sortBy default missing { newest: id desc; };
          }`,
        ),
      ).code,
    ).toBe('SYQL2008_INVALID_MEMBER');
    expect(
      frontendError(() =>
        parseSyqlSyntaxFile(
          'bad.syql',
          'query q() { select 1 limit size default 0 max 20; }',
        ),
      ).code,
    ).toBe('SYQL2010_INVALID_PAGE_RANGE');
  });

  test('ends inferred range shorthand before a following plain conjunct', () => {
    const source = `query q(range?) {
      select id from todos
      where when(range) created_at between :range
        and done = 0;
    }`;
    const query = parseSyqlSyntaxFile('range.syql', source).queries[0];
    expect(query?.parameters[0]?.kind).toBe('range');
    const condition = query?.statement.tree.nodes.find(
      (node) => node.kind === 'when',
    );
    expect(condition?.kind).toBe('when');
    expect(condition?.span.end.offset).toBeLessThan(source.indexOf('and done'));

    const explicit = parseSyqlSyntaxFile(
      'explicit-range.syql',
      `query q(bounds: range<integer>) {
        select id from todos
        where created_at between :bounds and done = 0;
      }`,
    ).queries[0];
    expect(explicit?.parameters[0]?.kind).toBe('range');
  });
});

describe('SYQL module graph', () => {
  const root = resolve('/virtual/syql-modules');

  function graph(entries: readonly string[], sources: Record<string, string>) {
    const resolved = new Map(
      Object.entries(sources).map(([file, source]) => [
        resolve(root, file),
        source,
      ]),
    );
    return buildSyqlModuleGraph(root, entries, (file) => resolved.get(file));
  }

  test('resolves predicate libraries in dependency-first order', () => {
    const result = graph(['main.syql'], {
      'shared.syql': 'predicate visible(id) { id = :id }',
      'main.syql':
        'import { visible } from "./shared.syql"; query q(id) { select id from todos where visible(:id); }',
    });
    expect(
      result.modules.map((module) => module.file.split('/').at(-1)),
    ).toEqual(['shared.syql', 'main.syql']);
  });

  test('rejects missing modules, cycles, and duplicate query APIs', () => {
    expect(
      frontendError(() =>
        graph(['main.syql'], {
          'main.syql':
            'import { visible } from "./missing.syql"; query q() { select 1; }',
        }),
      ).code,
    ).toBe('SYQL4002_MODULE_NOT_FOUND');

    const cycle = frontendError(() =>
      graph(['one.syql'], {
        'one.syql':
          'import { two } from "./two.syql"; predicate one() { two() }',
        'two.syql':
          'import { one } from "./one.syql"; predicate two() { one() }',
      }),
    );
    expect(cycle.code).toBe('SYQL4003_IMPORT_CYCLE');

    expect(
      frontendError(() =>
        graph(['one.syql', 'two.syql'], {
          'one.syql': 'query duplicate() { select 1; }',
          'two.syql': 'query duplicate() { select 2; }',
        }),
      ).code,
    ).toBe('SYQL4006_DUPLICATE_QUERY');
  });
});
