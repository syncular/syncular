import { describe, expect, test } from 'bun:test';
import { formatSyql, parseSyqlSyntaxFile, toSyqlSemanticAst } from '../src';

const MESSY = `-- lead
import { visible as usable, matches } from "./predicates.syql";
query listTodos( listId,status?: string,range?: { start: integer,end: integer },openOnly: bool = false ){SELECT id,"odd name",title||'  x  ' AS label FROM todos WHERE todos.list_id=:listId AND when(status){status IS :status} AND when(range,openOnly){created_at BETWEEN :start AND :end}order by sortBy default newest {newest: created_at DESC,id DESC; oldest: created_at ASC,id ASC;}limit pageSize default 50 max 200;}
predicate local(value: string){title = :value /* keep */}`;

const CANONICAL = `-- lead
import { visible as usable, matches } from "./predicates.syql";

query listTodos(
  listId,
  status?: string,
  range?: { start: integer, end: integer },
  openOnly: bool = false,
) {
  select id, "odd name", title || '  x  ' as label
  from todos
  where todos.list_id = :listId
    and when(status) {
      status is :status
    }
    and when(range, openOnly) {
      created_at between :start and :end
    }
  order by sortBy default newest {
    newest: created_at desc, id desc;
    oldest: created_at asc, id asc;
  }
  limit pageSize default 50 max 200;
}

predicate local(value: string) {
  title = :value /* keep */
}
`;

describe('revision-1 formatSyql', () => {
  test('formats every container section from the lossless token stream', () => {
    expect(formatSyql('x.syql', MESSY)).toBe(CANONICAL);
  });

  test('is byte-idempotent', () => {
    const once = formatSyql('x.syql', MESSY);
    expect(formatSyql('x.syql', once)).toBe(once);
  });

  test('preserves the semantic AST, atomic tokens, and comment order', () => {
    const formatted = formatSyql('x.syql', MESSY);
    const before = toSyqlSemanticAst(parseSyqlSyntaxFile('x.syql', MESSY));
    const after = toSyqlSemanticAst(parseSyqlSyntaxFile('x.syql', formatted));
    expect(after.imports).toEqual(before.imports);
    expect(after.declarations.map((declaration) => declaration.kind)).toEqual([
      'query',
      'predicate',
    ]);
    expect(after.declarations[0]).toMatchObject({
      kind: 'query',
      sort: { defaultProfile: 'newest' },
      limit: { control: 'pageSize', defaultSize: 50, maxSize: 200 },
    });
    expect(formatted).toContain('"odd name"');
    expect(formatted).toContain("'  x  '");
    expect(formatted.indexOf('-- lead')).toBeLessThan(
      formatted.indexOf('/* keep */'),
    );
  });

  test('refuses invalid and prototype syntax', () => {
    expect(() => formatSyql('x.syql', 'query broken( {')).toThrow();
    expect(() => formatSyql('x.syql', 'fragment old(x) { id = :x }')).toThrow();
  });

  test('preserves every SQLite atomic operator and literal', () => {
    const out = formatSyql(
      'x.syql',
      `query q(a, b) {  select id from todos where x >= :a and y <> 2 and z != 3 and w <= 4 and title like '%' || :b || '%' and payload = x'CAFE' ; }`,
    );
    for (const spelling of [
      'x >= :a',
      'y <> 2',
      'z != 3',
      'w <= 4',
      "'%' || :b || '%'",
      "x'CAFE'",
    ]) {
      expect(out).toContain(spelling);
    }
  });
});
