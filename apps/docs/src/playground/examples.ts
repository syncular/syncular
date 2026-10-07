// The playground compiles against the Release board model of the hosted
// demo (apps/demo): the same generated IR and the same seed rows, so a
// query here returns the cards, people, and labels the demo shows.
import boardIrJson from '../../../demo/syncular.ir.json';
import { releaseBoardSeedMutations } from '../../../demo/src/seed';
import type {
  IrColumnType,
  IrDocument,
  IrReference,
} from '../../../../packages/typegen/src/ir';
import type { PlaygroundParams } from './runtime';

const COLUMN_TYPES: readonly IrColumnType[] = [
  'string',
  'integer',
  'float',
  'boolean',
  'json',
  'bytes',
  'blob_ref',
  'crdt',
];
const ON_DELETE: readonly IrReference['onDelete'][] = [
  'RESTRICT',
  'CASCADE',
  'SET NULL',
];

function member<T extends string>(allowed: readonly T[], value: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`demo IR carries unknown value ${JSON.stringify(value)}`);
  }
  return found;
}

// JSON imports widen literal unions to `string`, and the IR file omits the
// additive arrays a table does not declare; restore both. Subscription
// templates play no part in SYQL compilation.
export const BOARD_SCHEMA: IrDocument = {
  ...boardIrJson,
  subscriptions: [],
  tables: boardIrJson.tables.map((table) => ({
    ...table,
    columns: table.columns.map((column) => ({
      ...column,
      type: member(COLUMN_TYPES, column.type),
    })),
    references:
      'references' in table
        ? table.references.map((reference) => ({
            ...reference,
            onDelete: member(ON_DELETE, reference.onDelete),
          }))
        : [],
    indexes: 'indexes' in table ? table.indexes : [],
    ftsIndexes: [],
  })),
};

export const BOARD_SEED = releaseBoardSeedMutations();

export const EXAMPLE_GROUPS = [
  { id: 'basics', title: 'Basics' },
  { id: 'optional', title: 'Optional filters' },
  { id: 'joins', title: 'Joins' },
  { id: 'aggregates', title: 'Aggregates' },
  { id: 'ranking', title: 'Ranking and windows' },
  { id: 'sync', title: 'Sync coverage' },
  { id: 'errors', title: 'Errors that fail closed' },
] as const;

export interface PlaygroundExample {
  readonly id: string;
  readonly group: (typeof EXAMPLE_GROUPS)[number]['id'];
  readonly title: string;
  /** One line under the title in the gallery and the toolbar. */
  readonly description: string;
  readonly source: string;
  /** Inputs the Run tab starts from. */
  readonly params?: PlaygroundParams;
  /** The diagnostic code a deliberate error example fails with. */
  readonly fails?: string;
}

export const PLAYGROUND_EXAMPLES: readonly PlaygroundExample[] = [
  {
    id: 'column-cards',
    group: 'basics',
    title: 'Cards in a column',
    description: 'Two required inputs, a typed projection, and the row key.',
    params: { boardId: 'web', columnId: 'doing' },
    source: `query columnCards(boardId, columnId) {
  select id, title, estimate, assignee_id, position
  from cards
  where cards.board_id = :boardId
    and cards.column_id = :columnId
  order by position, id;
}`,
  },
  {
    id: 'predicate',
    group: 'basics',
    title: 'Reusable predicate',
    description:
      'A local predicate expands hygienically into the WHERE clause.',
    params: { boardId: 'web', term: 'fix' },
    source: `predicate titleMatches(term: string) {
  title like '%' || :term || '%'
}

query searchCards(boardId, term: string) {
  select id, title, column_id
  from cards
  where cards.board_id = :boardId
    and titleMatches(:term)
  order by created_at_ms desc, id desc;
}`,
  },
  {
    id: 'sort-limit',
    group: 'basics',
    title: 'Sort profiles and a bounded limit',
    description:
      'One physical statement per sort profile; the limit stays a bind.',
    params: { boardId: 'mobile', sortBy: 'largest', pageSize: 5 },
    source: `query boardCards(boardId) {
  select id, title, estimate, created_at_ms
  from cards
  where cards.board_id = :boardId
  order by sortBy default newest {
    newest: created_at_ms desc, id desc;
    largest: estimate desc, id asc;
    title: title collate nocase asc, id asc;
  }
  limit pageSize default 10 max 50;
}`,
  },
  {
    id: 'optional',
    group: 'optional',
    title: 'Optional filters',
    description:
      'Optional values, a nullable presence, a range, and a default-false flag.',
    params: { boardId: 'web', unassigned: true },
    source: `query findCards(
  boardId,
  columnId?: string,
  assigneeId?: string | null,
  created?,
  unassigned: bool = false,
) {
  select id, title, column_id, assignee_id, created_at_ms
  from cards
  where cards.board_id = :boardId
    and when(columnId) column_id = :columnId
    and when(assigneeId) assignee_id is :assigneeId
    and when(created) created_at_ms between :created
    and when(unassigned) assignee_id is null
  order by created_at_ms desc, id desc;
}`,
  },
  {
    id: 'record',
    group: 'optional',
    title: 'Optional record',
    description: 'A record input is absent or present with every member.',
    params: { boardId: 'web', bounds: { low: 3, high: 5 } },
    source: `query cardsByEstimate(
  boardId,
  bounds?: { low: integer, high: integer },
) {
  select id, title, estimate
  from cards
  where cards.board_id = :boardId
    and when(bounds) {
      estimate >= :low
      and estimate <= :high
    }
  order by estimate desc, id asc;
}`,
  },
  {
    id: 'subquery-filter',
    group: 'optional',
    title: 'Optional subquery filter',
    description:
      'One control gives two variants; the subquery table invalidates table-wide.',
    params: { boardId: 'mobile', labelId: 'l-mobile-bug' },
    source: `query labelledCards(boardId, labelId?: string) {
  select id, title, column_id
  from cards
  where cards.board_id = :boardId
    and when(labelId) id in (
      select card_id from card_labels
      where card_labels.label_id = :labelId
    )
  order by id;
}`,
  },
  {
    id: 'assignee-join',
    group: 'joins',
    title: 'Cards with their assignee',
    description:
      'A LEFT JOIN makes every joined column nullable in the row type.',
    params: { boardId: 'web' },
    source: `query cardsWithAssignee(boardId) {
  select cards.id, cards.title, cards.column_id, members.name as assignee
  from cards
  left join members on members.id = cards.assignee_id
  where cards.board_id = :boardId
  order by cards.column_id, cards.position, cards.id;
}`,
  },
  {
    id: 'label-join',
    group: 'joins',
    title: 'Cards carrying a label',
    description: 'Two inner joins through card_labels to filter by label name.',
    params: { boardId: 'web', label: 'perf' },
    source: `query cardsWithLabel(boardId, label: string) {
  select cards.id, cards.title, cards.column_id, labels.name as label
  from cards
  join card_labels on card_labels.card_id = cards.id
  join labels on labels.id = card_labels.label_id
  where cards.board_id = :boardId
    and labels.name = :label
  order by cards.created_at_ms desc, cards.id desc;
}`,
  },
  {
    id: 'comment-thread',
    group: 'joins',
    title: 'Comment thread with authors',
    description: 'Comments of one card, joined to the member who wrote each.',
    params: { boardId: 'mobile', cardId: 'c-mobile-17' },
    source: `query cardComments(boardId, cardId) {
  select comments.id, members.name as author, comments.body,
    comments.created_at_ms
  from comments
  join members on members.id = comments.author_id
  where comments.board_id = :boardId
    and comments.card_id = :cardId
  order by comments.created_at_ms, comments.id;
}`,
  },
  {
    id: 'column-totals',
    group: 'aggregates',
    title: 'Cards and points per column',
    description: 'GROUP BY with count and sum; grouped rows carry no row key.',
    params: { boardId: 'web' },
    source: `query columnTotals(boardId) {
  select column_id, count(*) as cards, sum(estimate) as points
  from cards
  where cards.board_id = :boardId
  group by column_id
  order by column_id;
}`,
  },
  {
    id: 'assignee-load',
    group: 'aggregates',
    title: 'Open points per assignee',
    description:
      'An optional HAVING conjunct keeps only assignees above a threshold.',
    params: { boardId: 'mobile', minPoints: 5 },
    source: `query assigneeLoad(boardId, minPoints?: integer) {
  select members.name, count(cards.id) as cards,
    sum(cards.estimate) as points
  from cards
  join members on members.id = cards.assignee_id
  where cards.board_id = :boardId
    and cards.column_id <> 'done'
  group by members.id, members.name
  having when(minPoints) sum(cards.estimate) >= :minPoints
  order by points desc, members.name;
}`,
  },
  {
    id: 'label-usage',
    group: 'aggregates',
    title: 'Cards per label',
    description: 'A LEFT JOIN with count() keeps labels that no card carries.',
    params: { boardId: 'mobile' },
    source: `query labelUsage(boardId) {
  select labels.name, labels.color, count(card_labels.id) as cards
  from labels
  left join card_labels on card_labels.label_id = labels.id
  where labels.board_id = :boardId
  group by labels.id, labels.name, labels.color
  order by cards desc, labels.name;
}`,
  },
  {
    id: 'top-estimates',
    group: 'ranking',
    title: 'Largest cards (ranked top-N)',
    description:
      'A CTE keeps the first five narrow rows; the outer scope reads the wide row.',
    params: { boardId: 'web' },
    source: `query largestCards(boardId) {
  with ranked as (
    select id, estimate
    from cards
    where cards.board_id = :boardId
    order by estimate desc, id
    limit 5
  )
  select ranked.id, cards.title, cards.column_id, ranked.estimate
  from ranked
  cross join cards on cards.id = ranked.id
  where cards.board_id = :boardId
  order by ranked.estimate desc, ranked.id;
}`,
  },
  {
    id: 'rank-in-column',
    group: 'ranking',
    title: 'Rank by estimate per column',
    description:
      'A correlated count computes the rank that a window function would.',
    params: { boardId: 'web' },
    source: `query columnRanks(boardId) {
  select c.id, c.title, c.column_id, c.estimate,
    (
      select count(*) from cards as bigger
      where bigger.board_id = c.board_id
        and bigger.column_id = c.column_id
        and bigger.estimate > c.estimate
    ) + 1 as rank_in_column
  from cards as c
  where c.board_id = :boardId
  order by c.column_id, rank_in_column, c.id;
}`,
  },
  {
    id: 'window-function',
    group: 'ranking',
    title: 'Window functions are rejected',
    description:
      'rank() over (...) fails until the compiler can prove a stable order.',
    fails: 'SYQL6003_NONDETERMINISTIC_SQL',
    source: `query columnRanks(boardId) {
  select id, title, column_id, estimate,
    rank() over (partition by column_id order by estimate desc) as rank
  from cards
  where cards.board_id = :boardId
  order by column_id, rank, id;
}`,
  },
  {
    id: 'sync-board',
    group: 'sync',
    title: 'Sync one board',
    description: 'The required board_id equality proves download coverage.',
    params: { boardId: 'mobile' },
    source: `sync query boardCards(boardId) {
  select id, board_id, column_id, title, estimate
  from cards
  where cards.board_id = :boardId
  order by column_id, position, id;
}`,
  },
  {
    id: 'sync-join',
    group: 'sync',
    title: 'Coverage through a join',
    description:
      'The ON equality on board_id carries the proof to the joined comments.',
    params: { boardId: 'web' },
    source: `sync query cardsWithComments(boardId) {
  select cards.id, cards.title, comments.body
  from cards
  left join comments
    on comments.card_id = cards.id
    and comments.board_id = cards.board_id
  where cards.board_id = :boardId
  order by cards.id, comments.created_at_ms;
}`,
  },
  {
    id: 'sync-in',
    group: 'sync',
    title: 'Two boards with IN',
    description: 'An IN list of required binds covers one unit per board.',
    params: { first: 'web', second: 'mobile' },
    source: `sync query twoBoards(first, second) {
  select id, board_id, title, column_id
  from cards
  where cards.board_id in (:first, :second)
  order by board_id, column_id, position, id;
}`,
  },
  {
    id: 'sync-unscoped',
    group: 'errors',
    title: 'Sync query without a scope proof',
    description:
      'Coverage needs a required board_id predicate; a column filter is not one.',
    fails: 'SYQL6005_INVALID_SYNC_QUERY',
    source: `sync query doingCards(columnId) {
  select id, title
  from cards
  where cards.column_id = :columnId
  order by id;
}`,
  },
  {
    id: 'sync-or',
    group: 'errors',
    title: 'Scope proof under OR',
    description: 'A board_id equality inside OR proves nothing, so sync fails.',
    fails: 'SYQL6005_INVALID_SYNC_QUERY',
    source: `sync query eitherBoard(first, second) {
  select id, title
  from cards
  where cards.board_id = :first or cards.board_id = :second
  order by id;
}`,
  },
  {
    id: 'sync-comma-join',
    group: 'errors',
    title: 'Comma join in a sync query',
    description: 'Coverage proofs need an explicit JOIN ... ON relation.',
    fails: 'SYQL6002_INVALID_SQL',
    source: `sync query cardsAndMembers(boardId) {
  select cards.id, members.name
  from cards, members
  where cards.board_id = :boardId
    and members.board_id = :boardId
    and members.id = cards.assignee_id
  order by cards.id;
}`,
  },
  {
    id: 'unguarded-optional',
    group: 'errors',
    title: 'Optional bind outside when',
    description:
      'Every optional bind must sit under a when() that controls it.',
    fails: 'SYQL5009_MISSING_DOMINANCE',
    source: `query cardsInColumn(boardId, columnId?: string) {
  select id, title
  from cards
  where cards.board_id = :boardId
    and column_id = :columnId
  order by id;
}`,
  },
  {
    id: 'nondeterministic',
    group: 'errors',
    title: 'random() is rejected',
    description: 'Nondeterministic SQL cannot keep a reactive result stable.',
    fails: 'SYQL6003_NONDETERMINISTIC_SQL',
    source: `query shuffledCards(boardId) {
  select id, title
  from cards
  where cards.board_id = :boardId
  order by random();
}`,
  },
  {
    id: 'unknown-column',
    group: 'errors',
    title: 'Unknown column',
    description:
      'SQLite prepares every query against the schema at compile time.',
    fails: 'SYQL6002_INVALID_SQL',
    source: `query cardPoints(boardId) {
  select id, title, points
  from cards
  where cards.board_id = :boardId
  order by id;
}`,
  },
];
