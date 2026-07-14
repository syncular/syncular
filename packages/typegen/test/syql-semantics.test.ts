import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  analyzeSyqlSemantics,
  buildSyqlModuleGraph,
  renderSyqlLogicalTemplate,
  SyqlFrontendError,
} from '../src';

const root = resolve('/virtual/syql-semantics');

function program(
  sources: Readonly<Record<string, string>>,
  entries?: string[],
) {
  const files = new Map(
    Object.entries(sources).map(([file, source]) => [
      resolve(root, file),
      source,
    ]),
  );
  const graph = buildSyqlModuleGraph(
    root,
    entries ?? Object.keys(sources),
    (file) => files.get(file),
  );
  return analyzeSyqlSemantics(graph);
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

describe('revision-1 SYQL semantic analysis', () => {
  test('expands imported predicates hygienically through nested calls', () => {
    const analyzed = program(
      {
        'shared.syql': `
          predicate matches(value: string) {
            note = ':value' /* :value remains text */ and title = :value
          }
          predicate visible(candidate: string) { @matches(:candidate) }
        `,
        'main.syql': `
          import { visible as canSee } from "./shared.syql";
          query list(q: string) {
            sql { select id from todos where @canSee(:q) }
          }
        `,
      },
      ['main.syql'],
    );
    const query = analyzed.queries[0];
    expect(query?.declaration.name).toBe('list');
    const sql = renderSyqlLogicalTemplate(query?.template ?? []);
    expect(sql).toContain("note = ':value' /* :value remains text */");
    expect(sql).toContain('title = :q');
    expect(sql).not.toContain('title = :value');
    expect(query?.template.some((node) => node.kind === 'predicate')).toBe(
      true,
    );
  });

  test('accepts acyclic predicate chains deeper than the prototype cap', () => {
    const predicates = Array.from({ length: 16 }, (_, index) =>
      index === 0
        ? 'predicate p0(value) { id = :value }'
        : `predicate p${index}(value) { @p${index - 1}(:value) }`,
    ).join('\n');
    const analyzed = program({
      'deep.syql': `${predicates}
        query deep(id) { sql { select id from todos where @p15(:id) } }`,
    });
    expect(analyzed.predicates).toHaveLength(16);
    expect(
      renderSyqlLogicalTemplate(analyzed.queries[0]?.template ?? []),
    ).toContain('id = :id');
  });

  test('reports unknown calls, arity mismatches, and complete call cycles', () => {
    const unknown = frontendError(() =>
      program({
        'bad.syql':
          'query q(id) { sql { select id from todos where @missing(:id) } }',
      }),
    );
    expect(unknown.code).toBe('SYQL5001_UNKNOWN_PREDICATE');

    const arity = frontendError(() =>
      program({
        'bad.syql': `
          predicate exact(id) { todos.id = :id }
          query q(id) { sql { select id from todos where @exact() } }
        `,
      }),
    );
    expect(arity.code).toBe('SYQL5003_PREDICATE_ARITY');

    const cycle = frontendError(() =>
      program({
        'bad.syql': `
          predicate first(id) { @second(:id) }
          predicate second(id) { @third(:id) }
          predicate third(id) { @first(:id) }
          query q(id) { sql { select id from todos where @first(:id) } }
        `,
      }),
    );
    expect(cycle.code).toBe('SYQL5002_PREDICATE_CYCLE');
    expect(cycle.message).toContain('first');
    expect(cycle.message).toContain('second');
    expect(cycle.message).toContain('third');
  });

  test('enforces closed predicate signatures and transitive parameter use', () => {
    const closed = frontendError(() =>
      program({
        'bad.syql': `
          predicate bad(id) { id = :ghost }
          query q(id) { sql { select id from todos where @bad(:id) } }
        `,
      }),
    );
    expect(closed.code).toBe('SYQL5004_CLOSED_PREDICATE');

    const unused = frontendError(() =>
      program({
        'bad.syql': `
          predicate ignored(value) { id = 1 }
          query q(id) { sql { select id from todos where @ignored(:id) } }
        `,
      }),
    );
    expect(unused.code).toBe('SYQL5005_UNUSED_PREDICATE_PARAMETER');
  });

  test('enforces authoritative binds and optional dominance', () => {
    const undeclared = frontendError(() =>
      program({
        'bad.syql':
          'query q(id) { sql { select id from todos where id = :ghost } }',
      }),
    );
    expect(undeclared.code).toBe('SYQL5006_UNDECLARED_BIND');

    const requiredUnused = frontendError(() =>
      program({
        'bad.syql': 'query q(id) { sql { select id from todos } }',
      }),
    );
    expect(requiredUnused.code).toBe('SYQL5007_UNUSED_INPUT');

    const undominated = frontendError(() =>
      program({
        'bad.syql': `query q(status?) {
          sql { select id from todos where status = :status }
        }`,
      }),
    );
    expect(undominated.code).toBe('SYQL5009_MISSING_DOMINANCE');

    const requiredControl = frontendError(() =>
      program({
        'bad.syql': `query q(status) {
          sql { select id from todos where when(status) { status = :status } }
        }`,
      }),
    );
    expect(requiredControl.code).toBe('SYQL5008_INVALID_CONTROL');

    const unusedControl = frontendError(() =>
      program({
        'bad.syql': `query q(status?) {
          sql { select id from todos where when(status) { id > 0 } }
        }`,
      }),
    );
    expect(unusedControl.code).toBe('SYQL5010_UNUSED_CONTROL');
  });

  test('preserves atomic groups and switch activation as logical controls', () => {
    const analyzed = program({
      'groups.syql': `query ranged(
        range?(start: integer, end: integer),
        includeArchived?: switch,
      ) {
        sql {
          select id from todos
          where when(range, includeArchived) {
            created_at between :start and :end
          }
        }
      }`,
    });
    expect(analyzed.queries[0]?.conditions).toHaveLength(1);
    expect(analyzed.queries[0]?.conditions[0]?.controls).toEqual([
      'range',
      'includeArchived',
    ]);
    expect(analyzed.queries[0]?.bindTypes.get('start')).toMatchObject({
      base: 'integer',
      nullable: false,
    });

    const partial = frontendError(() =>
      program({
        'bad.syql': `query ranged(range?(start, end)) {
          sql { select id from todos where when(range) { created_at >= :start } }
        }`,
      }),
    );
    expect(partial.code).toBe('SYQL5007_UNUSED_INPUT');
    expect(partial.message).toContain('end');
  });

  test('propagates predicate annotations and rejects incompatible actuals', () => {
    const inferred = program({
      'types.syql': `
        predicate byTitle(value: string) { title = :value }
        query q(title) { sql { select id from todos where @byTitle(:title) } }
      `,
    });
    expect(inferred.queries[0]?.inputs[0]?.type).toMatchObject({
      base: 'string',
      nullable: false,
    });

    const mismatch = frontendError(() =>
      program({
        'bad.syql': `
          predicate byTitle(value: string) { title = :value }
          query q(title: integer) {
            sql { select id from todos where @byTitle(:title) }
          }
        `,
      }),
    );
    expect(mismatch.code).toBe('SYQL5011_TYPE_CONFLICT');

    const nullableMismatch = frontendError(() =>
      program({
        'bad.syql': `
          predicate byTitle(value: string) { title = :value }
          query q(title: string | null) {
            sql { select id from todos where @byTitle(:title) }
          }
        `,
      }),
    );
    expect(nullableMismatch.code).toBe('SYQL5011_TYPE_CONFLICT');

    const conflict = frontendError(() =>
      program({
        'bad.syql': `
          predicate asText(value: string) { title = :value }
          predicate asNumber(value: integer) { priority = :value }
          query q(value) {
            sql { select id from todos where @asText(:value) and @asNumber(:value) }
          }
        `,
      }),
    );
    expect(conflict.code).toBe('SYQL5011_TYPE_CONFLICT');

    const libraryConflict = frontendError(() =>
      program({
        'bad.syql': `
          predicate asText(value: string) { title = :value }
          predicate broken(value: integer) { @asText(:value) }
        `,
      }),
    );
    expect(libraryConflict.code).toBe('SYQL5011_TYPE_CONFLICT');
  });
});
