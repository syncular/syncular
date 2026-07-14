import { describe, expect, test } from 'bun:test';
import { basename, resolve } from 'node:path';
import {
  buildSyqlModuleGraph,
  lexSyqlSource,
  parseSyqlSyntaxFile,
  SyqlFrontendError,
  type SyqlToken,
} from '../src';

function significant(tokens: readonly SyqlToken[]): readonly SyqlToken[] {
  return tokens.filter(
    (token) =>
      token.kind !== 'whitespace' &&
      token.kind !== 'line-comment' &&
      token.kind !== 'block-comment' &&
      token.kind !== 'eof',
  );
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

describe('revision-1 SYQL lexer', () => {
  test('is lossless and preserves SQL atomic-token contents', () => {
    const source = [
      '\ufeffquery lexical(listId) {',
      '  sql {',
      `    select 'a  b; :ghost { }', "or""der", \`back\`\`tick\`, [where {], X'CAFE'`,
      '    from todos -- :comment } ;',
      '    where list_id = :listId /* @fake(:x) { ; } */',
      "      and payload ->> '$.name' != 'x'",
      '  }',
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
      tokens.filter((token) => token.kind === 'bind').map((t) => t.text),
    ).toEqual([':listId']);
    expect(
      tokens
        .filter((token) => token.kind === 'quoted-identifier')
        .map((token) => token.text),
    ).toEqual(['"or""der"', '`back``tick`', '[where {]']);
    expect(tokens.find((token) => token.kind === 'string')?.text).toBe(
      "'a  b; :ghost { }'",
    );
    expect(tokens.find((token) => token.kind === 'blob')?.text).toBe("X'CAFE'");
    expect(tokens.some((token) => token.text === '->>')).toBe(true);
  });

  test('keeps a line-comment newline outside the comment token', () => {
    const tokens = lexSyqlSource(
      'comment.syql',
      'query q() { sql { select 1 -- keep extent\nfrom todos } }',
    );
    const commentIndex = tokens.findIndex(
      (token) => token.kind === 'line-comment',
    );
    expect(tokens[commentIndex]?.text).toBe('-- keep extent');
    expect(tokens[commentIndex + 1]?.kind).toBe('whitespace');
    expect(tokens[commentIndex + 1]?.text).toStartWith('\n');
    expect(significant(tokens).some((token) => token.text === 'from')).toBe(
      true,
    );
  });

  test('tracks CRLF lines and Unicode-scalar columns', () => {
    const tokens = lexSyqlSource('position.syql', 'a\r\n😀x');
    const identifiers = tokens.filter((token) => token.kind === 'identifier');
    expect(identifiers[0]?.span).toMatchObject({
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 1, line: 1, column: 2 },
    });
    expect(identifiers[1]?.text).toBe('😀x');
    expect(identifiers[1]?.span).toMatchObject({
      start: { offset: 3, line: 2, column: 1 },
      end: { offset: 6, line: 2, column: 3 },
    });
  });

  test('uses JSON string rules for an import path without changing SQL quotes', () => {
    const source =
      'import { visible } from "./quote\\"name.syql";\n' +
      'query q() { sql { select "a\\" from todos } }';
    const tokens = lexSyqlSource('imports.syql', source);
    expect(tokens.find((token) => token.kind === 'import-path')?.text).toBe(
      '"./quote\\"name.syql"',
    );
    expect(
      tokens
        .filter((token) => token.kind === 'quoted-identifier')
        .map((t) => t.text),
    ).toEqual(['"a\\"']);
  });

  test('recognizes the SQLite 3.46 numeric/operator surface losslessly', () => {
    const source =
      'query q() { sql { select 1_000, 0xCA_FE, .5e+2, a<<2, b<>3 from todos } }';
    const tokens = lexSyqlSource('numbers.syql', source);
    expect(
      tokens.filter((token) => token.kind === 'number').map((t) => t.text),
    ).toEqual(['1_000', '0xCA_FE', '.5e+2', '2', '3']);
    expect(
      tokens.filter((token) => token.kind === 'operator').map((t) => t.text),
    ).toEqual(['<<', '<>']);
  });

  test('reports stable, source-spanned unterminated-token errors', () => {
    const stringError = frontendError(() =>
      lexSyqlSource('bad.syql', "query q() { sql { select 'nope } }"),
    );
    expect(stringError.code).toBe('SYQL1001_UNTERMINATED_STRING');
    expect(stringError.span.start).toMatchObject({ line: 1, column: 26 });

    const commentError = frontendError(() =>
      lexSyqlSource('bad.syql', '/* nope'),
    );
    expect(commentError.code).toBe('SYQL1003_UNTERMINATED_COMMENT');
    expect(commentError.span.start).toMatchObject({ line: 1, column: 1 });
  });
});

describe('revision-1 SYQL container parser', () => {
  test('parses imports, typed inputs, atomic groups, sections, and exact SQL', () => {
    const source = `
import {
  visibleTodos,
} from "./shared/todos.syql";

predicate matchesTitle(q: string) {
  title like '%' || :q || '%  exact'
}

query listTodos(
  listId,
  status?: string | null,
  range?(lowerBound: integer, upperBound: integer),
  q?,
  unassigned?: switch,
) {
  sql {
    select id, title, created_at
    from todos
    where @cover(todos.list_id = :listId)
      and @visibleTodos()
      and when(status) { status is :status }
      and when(range) { created_at between :lowerBound and :upperBound }
      and when(q) { @matchesTitle(:q) }
      and when(unassigned) { assignee_id is null }
  }

  sort sortBy default newest {
    newest { created_at desc, id desc }
    oldest { created_at asc, id asc }
  }

  page pageSize default 50 max 200;
  identity by id;
}
`;
    const file = parseSyqlSyntaxFile('todos.syql', source);

    expect(file.imports).toHaveLength(1);
    expect(file.imports[0]).toMatchObject({
      items: [{ imported: 'visibleTodos', local: 'visibleTodos' }],
      path: './shared/todos.syql',
    });
    expect(file.predicates[0]).toMatchObject({
      name: 'matchesTitle',
      parameters: [{ name: 'q', type: { base: 'string', nullable: false } }],
    });
    expect(file.predicates[0]?.body.text).toContain("'%  exact'");

    const query = file.queries[0];
    expect(query?.name).toBe('listTodos');
    expect(query?.parameters).toMatchObject([
      { kind: 'value', name: 'listId', optional: false },
      {
        kind: 'value',
        name: 'status',
        optional: true,
        type: { base: 'string', nullable: true },
      },
      {
        kind: 'group',
        name: 'range',
        optional: true,
        members: [
          {
            name: 'lowerBound',
            type: { base: 'integer', nullable: false },
          },
          {
            name: 'upperBound',
            type: { base: 'integer', nullable: false },
          },
        ],
      },
      { kind: 'value', name: 'q', optional: true },
      { kind: 'switch', name: 'unassigned', optional: true },
    ]);
    expect(query?.sql.body.text).toContain(
      'and when(range) { created_at between :lowerBound and :upperBound }',
    );
    expect(query?.sort).toMatchObject({
      control: 'sortBy',
      defaultProfile: 'newest',
      profiles: [{ name: 'newest' }, { name: 'oldest' }],
    });
    expect(query?.page).toMatchObject({
      control: 'pageSize',
      defaultSize: 50,
      maxSize: 200,
    });
    expect(query?.identity?.fields).toEqual(['id']);
    expect(
      query?.sql.body.tokens
        .filter((token) => token.kind === 'bind')
        .map((token) => token.text),
    ).toEqual([':listId', ':status', ':lowerBound', ':upperBound', ':q']);
  });

  test('decodes JSON import paths and preserves the original path token', () => {
    const source =
      'import { visible } from "./quote\\"name.syql";\n' +
      'query q() { sql { select id from todos } }';
    const file = parseSyqlSyntaxFile('x.syql', source);
    expect(file.imports[0]?.path).toBe('./quote"name.syql');
    expect(
      file.tokens.find((token) => token.kind === 'import-path')?.text,
    ).toBe('"./quote\\"name.syql"');
  });

  test('rejects duplicate imported predicates even when aliases differ', () => {
    const error = frontendError(() =>
      parseSyqlSyntaxFile(
        'duplicate-import.syql',
        'import { visible as first, visible as second } from "./shared.syql";',
      ),
    );
    expect(error.code).toBe('SYQL2004_DUPLICATE_NAME');
    expect(error.message).toContain('duplicate imported predicate "visible"');
  });

  test('accepts semicolons and bind-shaped text only inside atomic SQL tokens', () => {
    const file = parseSyqlSyntaxFile(
      'atomic.syql',
      `query q() { sql { select '; :ghost' as value from todos -- ; :comment
      where id = :real } }`,
    );
    expect(
      file.queries[0]?.sql.body.tokens
        .filter((token) => token.kind === 'bind')
        .map((token) => token.text),
    ).toEqual([':real']);
  });

  test('rejects the prototype grammar instead of selecting a compatibility mode', () => {
    const error = frontendError(() =>
      parseSyqlSyntaxFile(
        'old.syql',
        'query q(status?) { select id from todos where status = :status }',
      ),
    );
    expect(error.code).toBe('SYQL2008_INVALID_MEMBER');
    expect(error.message).toContain('must begin with exactly one sql');
  });

  test('rejects reserved/duplicate names and non-atomic group shapes', () => {
    expect(
      frontendError(() =>
        parseSyqlSyntaxFile(
          'bad.syql',
          'query when() { sql { select id from todos } }',
        ),
      ).code,
    ).toBe('SYQL2003_RESERVED_NAME');

    expect(
      frontendError(() =>
        parseSyqlSyntaxFile(
          'bad.syql',
          'query q(id, cursor?(id, other)) { sql { select id from todos } }',
        ),
      ).code,
    ).toBe('SYQL2004_DUPLICATE_NAME');

    const groupError = frontendError(() =>
      parseSyqlSyntaxFile(
        'bad.syql',
        'query q(cursor?(id)) { sql { select id from todos } }',
      ),
    );
    expect(groupError.code).toBe('SYQL2011_INVALID_PARAMETER');
    expect(groupError.message).toContain('at least two members');
  });

  test('requires the exact optional switch form', () => {
    const error = frontendError(() =>
      parseSyqlSyntaxFile(
        'bad.syql',
        'query q(enabled: switch) { sql { select id from todos } }',
      ),
    );
    expect(error.code).toBe('SYQL2011_INVALID_PARAMETER');
    expect(error.message).toContain('enabled?: switch');
  });

  test('enforces section order and mandatory terminators', () => {
    const orderError = frontendError(() =>
      parseSyqlSyntaxFile(
        'bad.syql',
        `query q() {
          sql { select id from todos }
          identity by id;
          page pageSize default 10 max 20;
        }`,
      ),
    );
    expect(orderError.code).toBe('SYQL2008_INVALID_MEMBER');
    expect(orderError.message).toContain('out-of-order');

    const terminatorError = frontendError(() =>
      parseSyqlSyntaxFile(
        'bad.syql',
        `query q() {
          sql { select id from todos }
          identity by id
        }`,
      ),
    );
    expect(terminatorError.code).toBe('SYQL2001_EXPECTED_TOKEN');
    expect(terminatorError.message).toContain('expected ";"');
  });

  test('rejects real template semicolons without touching string/comment text', () => {
    const error = frontendError(() =>
      parseSyqlSyntaxFile(
        'bad.syql',
        'query q() { sql { select id from todos; } }',
      ),
    );
    expect(error.code).toBe('SYQL2007_FORBIDDEN_SEMICOLON');
  });

  test('validates static page bounds before they enter IR', () => {
    for (const page of [
      'default 0 max 10',
      'default 11 max 10',
      'default 1 max 2147483648',
    ]) {
      const error = frontendError(() =>
        parseSyqlSyntaxFile(
          'bad.syql',
          `query q() { sql { select id from todos } page size ${page}; }`,
        ),
      );
      expect(error.code).toBe('SYQL2010_INVALID_PAGE_RANGE');
    }

    const fraction = frontendError(() =>
      parseSyqlSyntaxFile(
        'bad.syql',
        'query q() { sql { select id from todos } page size default 1.5 max 10; }',
      ),
    );
    expect(fraction.code).toBe('SYQL2009_INVALID_INTEGER');
  });

  test('rejects a sort default which has no profile', () => {
    const error = frontendError(() =>
      parseSyqlSyntaxFile(
        'bad.syql',
        `query q() {
          sql { select id from todos }
          sort sortBy default missing { newest { id desc } }
        }`,
      ),
    );
    expect(error.code).toBe('SYQL2008_INVALID_MEMBER');
    expect(error.message).toContain('is not declared');
  });

  test('requires imports to precede declarations', () => {
    const error = frontendError(() =>
      parseSyqlSyntaxFile(
        'bad.syql',
        `predicate local() { id is not null }
         import { shared } from "./shared.syql";`,
      ),
    );
    expect(error.code).toBe('SYQL2008_INVALID_MEMBER');
    expect(error.message).toContain('imports must precede');
  });
});

describe('revision-1 SYQL embedded template parser', () => {
  test('builds lossless predicate-call, when, scope, and cover nodes', () => {
    const source = `
predicate matchesStatus(status: string) {
  status = :status and note != '@scope(fake.id = :fake)'
}

query q(listId, status?, left, right) {
  sql {
    select id from todos
    where @cover(todos.list_id = :listId)
      and @scope(todos.id in (:left, :right,))
      and when(status,) { @matchesStatus(:status) }
  }
}
`;
    const file = parseSyqlSyntaxFile('embedded.syql', source);
    const predicate = file.predicates[0];
    expect(predicate?.body.tree.nodes.map((node) => node.kind)).toEqual([
      'raw',
    ]);

    const template = file.queries[0]?.sql.body;
    expect(template?.tree.nodes.map((node) => node.kind)).toEqual([
      'raw',
      'cover',
      'raw',
      'scope',
      'raw',
      'when',
      'raw',
    ]);
    expect(
      template?.tree.nodes
        .flatMap((node) => node.tokens)
        .map((token) => token.text)
        .join(''),
    ).toBe(template?.text);

    const cover = template?.tree.nodes.find((node) => node.kind === 'cover');
    expect(cover?.kind).toBe('cover');
    if (cover?.kind === 'cover') {
      expect(cover.bindings).toMatchObject([
        {
          column: { qualifier: 'todos', name: 'list_id' },
          operator: 'equal',
          values: [{ name: 'listId' }],
        },
      ]);
    }

    const scope = template?.tree.nodes.find((node) => node.kind === 'scope');
    expect(scope?.kind).toBe('scope');
    if (scope?.kind === 'scope') {
      expect(scope.bindings[0]).toMatchObject({
        column: { qualifier: 'todos', name: 'id' },
        operator: 'in',
        values: [{ name: 'left' }, { name: 'right' }],
      });
    }

    const conditional = template?.tree.nodes.find(
      (node) => node.kind === 'when',
    );
    expect(conditional?.kind).toBe('when');
    if (conditional?.kind === 'when') {
      expect(conditional.controls).toEqual(['status']);
      expect(conditional.body.nodes.map((node) => node.kind)).toEqual([
        'raw',
        'predicate-call',
        'raw',
      ]);
      const call = conditional.body.nodes.find(
        (node) => node.kind === 'predicate-call',
      );
      expect(call).toMatchObject({
        kind: 'predicate-call',
        name: 'matchesStatus',
        arguments: [{ name: 'status' }],
      });
    }
  });

  test('does not discover embedded nodes inside atomic SQL tokens or comments', () => {
    const file = parseSyqlSyntaxFile(
      'atomic-tree.syql',
      `query q(real) { sql {
        select '@fake(:ghost) when(nope) { x }' as value
        from todos /* @scope(fake.id = :ghost) */
        where id = :real
      } }`,
    );
    expect(
      file.queries[0]?.sql.body.tree.nodes.map((node) => node.kind),
    ).toEqual(['raw']);
  });

  test('enforces node-specific template contexts', () => {
    const cases: readonly [string, string][] = [
      [
        'predicate bad(value) { when(value) { id = :value } }',
        'SYQL3006_FORBIDDEN_TEMPLATE_NODE',
      ],
      [
        `query q(id, status?) { sql {
          select id from todos where when(status) { @scope(todos.id = :id) }
        } }`,
        'SYQL3006_FORBIDDEN_TEMPLATE_NODE',
      ],
      [
        `query q() {
          sql { select id from todos }
          sort sortBy default byId { byId { id + :offset } }
        }`,
        'SYQL3006_FORBIDDEN_TEMPLATE_NODE',
      ],
    ];
    for (const [source, code] of cases) {
      expect(
        frontendError(() => parseSyqlSyntaxFile('bad.syql', source)).code,
      ).toBe(code);
    }
  });

  test('rejects non-authoritative SQLite parameter forms and malformed nodes', () => {
    const cases: readonly [string, string][] = [
      [
        'query q(snakeCase) { sql { select :snake_case from todos } }',
        'SYQL3002_INVALID_BIND',
      ],
      [
        'query q() { sql { select ?1 from todos } }',
        'SYQL3008_FORBIDDEN_PARAMETER_FORM',
      ],
      [
        'query q() { sql { select $value from todos } }',
        'SYQL3008_FORBIDDEN_PARAMETER_FORM',
      ],
      [
        'query q(id) { sql { select id from todos where @cover() } }',
        'SYQL3005_INVALID_REACTIVE_DIRECTIVE',
      ],
      [
        `query q(id, status?) { sql {
          select id from todos where when(status, status) { id = :id }
        } }`,
        'SYQL3004_INVALID_WHEN',
      ],
      [
        `query q(left, right) { sql {
          select id from todos where @scope(todos.id in (:left, :left))
        } }`,
        'SYQL3005_INVALID_REACTIVE_DIRECTIVE',
      ],
      [
        'query q(id) { sql { select id from todos where @visible(id) } }',
        'SYQL3002_INVALID_BIND',
      ],
      [
        'query q() { sql { select id from todos where { id = 1 } } }',
        'SYQL3007_UNEXPECTED_BRACE',
      ],
    ];
    for (const [source, code] of cases) {
      expect(
        frontendError(() => parseSyqlSyntaxFile('bad.syql', source)).code,
      ).toBe(code);
    }
  });
});

describe('revision-1 SYQL module graph', () => {
  const root = resolve('/virtual/syql');

  function graph(
    entries: readonly string[],
    sources: Readonly<Record<string, string>>,
  ) {
    const files = new Map(
      Object.entries(sources).map(([file, source]) => [
        resolve(root, file),
        source,
      ]),
    );
    return buildSyqlModuleGraph(root, entries, (file) => files.get(file));
  }

  test('resolves predicate libraries in dependency-first order', () => {
    const result = graph(['main.syql'], {
      'base.syql': 'predicate active() { deleted = 0 }',
      'shared.syql': `
        import { active } from "./base.syql";
        predicate visible() { @active() and archived_at is null }
      `,
      'main.syql': `
        import { visible as canSee } from "./shared.syql";
        query listTodos() {
          sql { select id from todos where @canSee() }
        }
      `,
    });

    expect(result.modules.map((module) => basename(module.file))).toEqual([
      'base.syql',
      'shared.syql',
      'main.syql',
    ]);
    expect(result.edges).toHaveLength(2);
    expect(
      result.moduleByPath.get(resolve(root, 'shared.syql'))?.predicates[0]
        ?.name,
    ).toBe('visible');
  });

  test('rejects root escapes and missing modules at the importing declaration', () => {
    const outside = frontendError(() =>
      graph(['main.syql'], {
        'main.syql':
          'import { visible } from "../outside.syql"; query q() { sql { select 1 } }',
      }),
    );
    expect(outside.code).toBe('SYQL4001_IMPORT_OUTSIDE_ROOT');
    expect(outside.span.file).toBe(resolve(root, 'main.syql'));

    const missing = frontendError(() =>
      graph(['main.syql'], {
        'main.syql':
          'import { visible } from "./missing.syql"; query q() { sql { select 1 } }',
      }),
    );
    expect(missing.code).toBe('SYQL4002_MODULE_NOT_FOUND');
    expect(missing.span.file).toBe(resolve(root, 'main.syql'));
  });

  test('reports the complete import cycle', () => {
    const error = frontendError(() =>
      graph(['a.syql'], {
        'a.syql':
          'import { fromB } from "./b.syql"; predicate fromA() { id = 1 }',
        'b.syql':
          'import { fromC } from "./c.syql"; predicate fromB() { id = 1 }',
        'c.syql':
          'import { fromA } from "./a.syql"; predicate fromC() { id = 1 }',
      }),
    );
    expect(error.code).toBe('SYQL4003_IMPORT_CYCLE');
    expect(error.message).toContain('a.syql -> b.syql -> c.syql -> a.syql');
  });

  test('requires imports to name predicates and rejects repeat targets', () => {
    const unknown = frontendError(() =>
      graph(['main.syql'], {
        'shared.syql': 'query visible() { sql { select 1 } }',
        'main.syql':
          'import { visible } from "./shared.syql"; query q() { sql { select 1 } }',
      }),
    );
    expect(unknown.code).toBe('SYQL4004_UNKNOWN_PREDICATE');

    const duplicate = frontendError(() =>
      graph(['main.syql'], {
        'shared.syql': 'predicate visible() { id = 1 }',
        'main.syql': `
          import { visible as first } from "./shared.syql";
          import { visible as second } from "./shared.syql";
          query q() { sql { select 1 } }
        `,
      }),
    );
    expect(duplicate.code).toBe('SYQL4005_DUPLICATE_IMPORT_TARGET');
  });

  test('rejects duplicate query API names across reachable modules', () => {
    const error = frontendError(() =>
      graph(['one.syql', 'two.syql'], {
        'one.syql': 'query duplicate() { sql { select 1 } }',
        'two.syql': 'query duplicate() { sql { select 2 } }',
      }),
    );
    expect(error.code).toBe('SYQL4006_DUPLICATE_QUERY');
  });
});
