import { describe, expect, test } from 'bun:test';
import { syqlCompletions } from '../src/playground/completions';
import { BOARD_SCHEMA } from '../src/playground/examples';

const schema = BOARD_SCHEMA;

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
  from ca|
}`),
    ).toContain('cards');

    expect(
      labels(`query q() {
  select cards.id from cards
  join me|
}`),
    ).toContain('members');
  });

  test('offers columns for tables and aliases with schema type details', () => {
    const qualified = complete(`query q() {
  select id from cards
  where cards.|
}`);
    expect(qualified.map((item) => item.label)).toContain('board_id');
    expect(qualified.find((item) => item.label === 'estimate')).toMatchObject({
      kind: 'column',
      detail: 'cards · integer',
    });

    expect(
      labels(`query q() {
  select t.| from cards as t;
}`),
    ).toContain('title');
  });

  test('offers public inputs and group members after a bind colon', () => {
    const found = complete(`query q(
  boardId,
  window?: { start: integer, end: integer },
) {
  select id from cards where board_id = :bo|
}`);
    expect(found.map((item) => item.label)).toEqual([
      'boardId',
      'start',
      'end',
    ]);
    expect(found[0]).toMatchObject({ kind: 'input', insertText: 'boardId' });
  });

  test('offers columns, inputs, qualifiers, and SYQL clause snippets in a query', () => {
    const found = labels(`query q(boardId) {
  select id from cards
  where |
}`);
    expect(found).toContain('board_id');
    expect(found).toContain('cards');
    expect(found).toContain(':boardId');
    expect(found).toContain('and when (…) …');
    expect(found).toContain('order by profiles …');
    expect(found).toContain('limit control …');
  });

  test('ignores table-looking text in comments and strings', () => {
    const found = labels(`query q() {
  -- from imaginary alias
  select 'join imaginary fake' from cards
  where |
}`);
    expect(found).toContain('title');
    expect(found).not.toContain('alias');
    expect(found).not.toContain('fake');
  });
});
