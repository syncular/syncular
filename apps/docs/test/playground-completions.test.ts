import { describe, expect, test } from 'bun:test';
import { syqlCompletions } from '../src/playground/completions';
import { PLAYGROUND_SCHEMAS } from '../src/playground/examples';

const schema = PLAYGROUND_SCHEMAS.todos;

function complete(markedSource: string) {
  const offset = markedSource.indexOf('|');
  if (offset < 0) throw new Error('completion fixture needs a | cursor');
  const source = markedSource.slice(0, offset) + markedSource.slice(offset + 1);
  return syqlCompletions(source, offset, schema);
}

function labels(markedSource: string): readonly string[] {
  return complete(markedSource).map((completion) => completion.label);
}

describe('SYQL playground completions', () => {
  test('offers declaration snippets at the top level', () => {
    expect(labels('|')).toEqual(['query …', 'sync query …', 'predicate …']);
  });

  test('offers schema tables after FROM and JOIN', () => {
    expect(
      labels(`query q() {
  select id
  from to|
}`),
    ).toContain('todos');

    expect(
      labels(`query q() {
  select todos.id from todos
  join to|
}`),
    ).toContain('todos');
  });

  test('offers columns for tables and aliases with schema type details', () => {
    const qualified = complete(`query q() {
  select id from todos
  where todos.|
}`);
    expect(qualified.map((item) => item.label)).toContain('list_id');
    expect(qualified.find((item) => item.label === 'done')).toMatchObject({
      kind: 'column',
      detail: 'todos · boolean',
    });

    expect(
      labels(`query q() {
  select t.| from todos as t;
}`),
    ).toContain('title');
  });

  test('offers public inputs and group members after a bind colon', () => {
    const found = complete(`query q(
  listId,
  window?: { start: integer, end: integer },
) {
  select id from todos where list_id = :li|
}`);
    expect(found.map((item) => item.label)).toEqual(['listId', 'start', 'end']);
    expect(found[0]).toMatchObject({ kind: 'input', insertText: 'listId' });
  });

  test('offers columns, inputs, qualifiers, and SYQL clause snippets in a query', () => {
    const found = labels(`query q(listId) {
  select id from todos
  where |
}`);
    expect(found).toContain('list_id');
    expect(found).toContain('todos');
    expect(found).toContain(':listId');
    expect(found).toContain('and when (…) …');
    expect(found).toContain('order by profiles …');
    expect(found).toContain('limit control …');
  });

  test('ignores table-looking text in comments and strings', () => {
    const found = labels(`query q() {
  -- from imaginary alias
  select 'join imaginary fake' from todos
  where |
}`);
    expect(found).toContain('title');
    expect(found).not.toContain('alias');
    expect(found).not.toContain('fake');
  });
});
