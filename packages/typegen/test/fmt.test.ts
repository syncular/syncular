/**
 * `syncular fmt` (§10/§12): one canonical style — lowercase keywords, one
 * clause per line, WHERE conjuncts and-prefixed. Idempotent, and
 * semantics-preserving by construction (output re-parses to the same
 * declarations and lowers to the same SQL).
 */
import { describe, expect, test } from 'bun:test';
import { formatSyql, lowerSyqlBody, parseSyqlFile } from '../src';

const MESSY = `-- Keep me: a leading comment.
query listTodos( listId ,status?,   from+to? , unassigned?:flag )   orderBy position|created_at   default position   limit max 200 default 50 {
  SELECT id,title,   done FROM todos WHERE list_id=:listId AND status = :status
    AND created_at BETWEEN :from AND :to and if (:unassigned) { assignee_id IS NULL } ORDER
    BY position
}

fragment visibleIn(l){ list_id = :l AND archived_at IS NULL }
`;

describe('formatSyql', () => {
  test('canonical output: lowercase keywords, clause-per-line, knob lines', () => {
    // (The body ORDER BY + orderBy knob conflict is a GENERATE-time check;
    // fmt formats anything that parses.)
    const out = formatSyql('x.syql', MESSY);
    expect(out).toBe(`-- Keep me: a leading comment.
query listTodos(listId, status?, from+to?, unassigned?: flag)
  orderBy position | created_at default position
  limit max 200 default 50
{
  select id, title, done
  from todos
  where list_id = :listId
    and status = :status
    and created_at between :from and :to
    and if (:unassigned) { assignee_id is null }
  order by position
}

fragment visibleIn(l) {
  list_id = :l and archived_at is null
}
`);
  });

  test('idempotent', () => {
    const once = formatSyql('x.syql', MESSY);
    expect(formatSyql('x.syql', once)).toBe(once);
  });

  test('semantics-preserving: formatted source lowers identically', () => {
    const before = parseSyqlFile('x.syql', MESSY);
    const after = parseSyqlFile('x.syql', formatSyql('x.syql', MESSY));
    const fragBefore = new Map(before.fragments.map((f) => [f.name, f]));
    const fragAfter = new Map(after.fragments.map((f) => [f.name, f]));
    for (const [i, decl] of before.queries.entries()) {
      const declAfter = after.queries[i];
      if (declAfter === undefined) throw new Error('lost a query');
      const a = lowerSyqlBody(decl, fragBefore, 'x');
      const b = lowerSyqlBody(declAfter, fragAfter, 'x');
      // fmt normalizes case/whitespace; the lowered statements must be
      // token-identical beyond that.
      const canon = (sql: string): string =>
        sql.toLowerCase().replace(/\s+/g, '');
      expect(canon(b.sql)).toBe(canon(a.sql));
      expect([...b.paramInfo.keys()]).toEqual([...a.paramInfo.keys()]);
    }
  });

  test('unparseable input fails loud (fmt never mangles broken files)', () => {
    expect(() => formatSyql('x.syql', 'query broken( {')).toThrow();
  });

  test('multi-char operators survive verbatim (||, >=, <=, <>, !=)', () => {
    const out = formatSyql(
      'x.syql',
      `query q(a, b?) { select id from t where x >= :a and y <> 2 and z != 3 and w <= 4 and title like '%' || :b || '%' }`,
    );
    expect(out).toContain('x >= :a');
    expect(out).toContain('y <> 2');
    expect(out).toContain('z != 3');
    expect(out).toContain('w <= 4');
    expect(out).toContain("'%' || :b || '%'");
  });
});
