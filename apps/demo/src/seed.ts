/**
 * The Release board sample data: ONE source for the sync lab (the Bun dev
 * server and the embedded server worker seed it through `seedMutations`)
 * and the SYQL playground in apps/docs (which loads the same rows into an
 * in-browser SQLite). Plain TypeScript with type-only imports, so any
 * workspace bundle can import it.
 *
 * Two boards (`web`, `mobile`), four people with one membership row per
 * board, six labels per board, 24 cards spread over the four columns, the
 * card-label links, and 12 comments. Ids and timestamps derive from a fixed
 * base, so every query over the seed returns the same output.
 *
 * Rows are keyed like the generated row types (camelCase); the generated
 * `schema` maps them to the snake_case SQL columns.
 */
import type {
  BoardsRow,
  CardLabelsRow,
  CardsRow,
  CommentsRow,
  LabelsRow,
  MembersRow,
} from './syncular.generated';

/** 2026-09-01T09:00:00Z: every seeded timestamp is an offset from it. */
export const SEED_BASE_MS = Date.UTC(2026, 8, 1, 9, 0, 0);
const HOUR_MS = 60 * 60 * 1000;

export const BOARD_COLUMNS = ['backlog', 'doing', 'review', 'done'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** The people behind the memberships; `id` is `members.user_id`. */
export const PEOPLE = [
  { id: 'ada', name: 'Ada', color: '#ffb000' },
  { id: 'ben', name: 'Ben', color: '#6fb3c0' },
  { id: 'chloe', name: 'Chloe', color: '#a9bf6e' },
  { id: 'dev', name: 'Dev', color: '#d98cf2' },
] as const;

const BOARDS: readonly BoardsRow[] = [
  { id: 'web', boardId: 'web', name: 'Web', color: '#ffb000' },
  { id: 'mobile', boardId: 'mobile', name: 'Mobile', color: '#6fb3c0' },
];

const MEMBERSHIPS: readonly (readonly [string, string, string])[] = [
  ['web', 'ada', 'lead'],
  ['web', 'chloe', 'engineer'],
  ['web', 'dev', 'designer'],
  ['mobile', 'ada', 'lead'],
  ['mobile', 'ben', 'engineer'],
  ['mobile', 'dev', 'designer'],
];

const MEMBERS: readonly MembersRow[] = MEMBERSHIPS.map(
  ([boardId, userId, role]) => {
    const person = PEOPLE.find((candidate) => candidate.id === userId);
    if (person === undefined) throw new Error(`seed names unknown ${userId}`);
    return {
      id: `m-${boardId}-${userId}`,
      boardId,
      userId,
      name: person.name,
      color: person.color,
      role,
    };
  },
);

const LABEL_COLORS = {
  bug: '#ff7a59',
  feature: '#a9bf6e',
  perf: '#ffb000',
  docs: '#9a948a',
  design: '#d98cf2',
  infra: '#6fb3c0',
} as const;
type LabelName = keyof typeof LABEL_COLORS;

const LABELS: readonly LabelsRow[] = BOARDS.flatMap((board) =>
  Object.entries(LABEL_COLORS).map(([name, color]) => ({
    id: `l-${board.id}-${name}`,
    boardId: board.id,
    name,
    color,
  })),
);

/** [board, column, title, assignee user or null, estimate, labels] */
const CARD_SPECS: readonly (readonly [
  string,
  BoardColumn,
  string,
  string | null,
  number,
  readonly LabelName[],
])[] = [
  [
    'web',
    'backlog',
    'Dark mode for the settings page',
    null,
    5,
    ['feature', 'design'],
  ],
  [
    'web',
    'backlog',
    'Lazy-load the analytics chart bundle',
    'chloe',
    3,
    ['perf'],
  ],
  ['web', 'backlog', 'Document the webhook retry policy', null, 2, ['docs']],
  ['web', 'backlog', 'Migrate CI runners to arm64', 'ada', 8, ['infra']],
  [
    'web',
    'doing',
    'Fix double submit on the checkout form',
    'chloe',
    2,
    ['bug'],
  ],
  ['web', 'doing', 'Redesign the empty states', 'dev', 5, ['design']],
  [
    'web',
    'doing',
    'Cache the pricing API responses',
    'ada',
    3,
    ['perf', 'infra'],
  ],
  [
    'web',
    'review',
    'Keyboard shortcuts for the board view',
    'chloe',
    5,
    ['feature'],
  ],
  ['web', 'review', 'Session expiry logs users out twice', 'ada', 1, ['bug']],
  [
    'web',
    'done',
    'Upgrade the bundler to the new major',
    'chloe',
    8,
    ['infra', 'perf'],
  ],
  ['web', 'done', 'Onboarding checklist copy', 'dev', 1, ['docs', 'design']],
  ['web', 'done', 'CSV export for invoices', 'ada', 5, ['feature']],
  [
    'mobile',
    'backlog',
    'Offline queue for photo uploads',
    'ben',
    8,
    ['feature'],
  ],
  ['mobile', 'backlog', 'Haptics on swipe actions', null, 2, ['design']],
  [
    'mobile',
    'backlog',
    'Crash on rotate in the media picker',
    null,
    3,
    ['bug'],
  ],
  ['mobile', 'doing', 'Push notification deep links', 'ben', 5, ['feature']],
  ['mobile', 'doing', 'Cold start under 800 ms', 'ada', 8, ['perf']],
  ['mobile', 'doing', 'New tab bar icons', 'dev', 3, ['design']],
  [
    'mobile',
    'review',
    'Pull to refresh stutters on long lists',
    'ben',
    3,
    ['bug', 'perf'],
  ],
  [
    'mobile',
    'review',
    'Release notes template for app stores',
    'ada',
    1,
    ['docs'],
  ],
  ['mobile', 'review', 'Fastlane lanes for beta builds', 'ben', 5, ['infra']],
  ['mobile', 'done', 'Biometric sign-in', 'ben', 8, ['feature']],
  ['mobile', 'done', 'Dynamic type audit', 'dev', 3, ['design', 'docs']],
  ['mobile', 'done', 'Fix keyboard covering the composer', 'ben', 2, ['bug']],
];

const CARDS: readonly CardsRow[] = CARD_SPECS.map(
  ([boardId, columnId, title, assignee, estimate], index) => {
    const before = CARD_SPECS.slice(0, index).filter(
      ([board, column]) => board === boardId && column === columnId,
    ).length;
    const createdAtMs = SEED_BASE_MS + index * 5 * HOUR_MS;
    return {
      id: `c-${boardId}-${String(index + 1).padStart(2, '0')}`,
      boardId,
      columnId,
      position: (before + 1) * 1000,
      title,
      assigneeId: assignee === null ? null : `m-${boardId}-${assignee}`,
      estimate,
      createdAtMs,
      updatedAtMs: createdAtMs + (index % 4) * HOUR_MS,
    };
  },
);

const CARD_LABELS: readonly CardLabelsRow[] = CARD_SPECS.flatMap(
  ([boardId, , , , , labels], index) => {
    const cardId = CARDS[index]?.id;
    if (cardId === undefined) throw new Error('seed card index out of range');
    return labels.map((label) => ({
      id: `${cardId}~${label}`,
      cardId,
      labelId: `l-${boardId}-${label}`,
      boardId,
    }));
  },
);

/** [card index (1-based), author user, body, hours after the card] */
const COMMENT_SPECS: readonly (readonly [number, string, string, number])[] = [
  [5, 'ada', 'Repro: double click on Pay with a slow network.', 2],
  [5, 'chloe', 'Disabling the button on submit fixes it; adding a test.', 6],
  [6, 'ada', 'Can we reuse the illustration set from the docs site?', 3],
  [7, 'chloe', 'Five minute TTL keeps prices fresh enough.', 4],
  [8, 'dev', 'Shortcut sheet opens with ?, mockup attached.', 1],
  [9, 'chloe', 'Two refresh timers race; one of them should go.', 2],
  [10, 'ada', 'Build time dropped from 94 s to 31 s.', 8],
  [16, 'ada', 'Links must open the right board even when signed out.', 2],
  [17, 'ben', 'Startup trace: 40 % of the time is font loading.', 5],
  [17, 'dev', 'Switching to the system font for the splash is fine.', 7],
  [19, 'dev', 'Only on devices with 120 Hz displays.', 3],
  [21, 'ada', 'Beta lane should bump the build number too.', 2],
];

const COMMENTS: readonly CommentsRow[] = COMMENT_SPECS.map(
  ([cardNumber, author, body, hours], index) => {
    const card = CARDS[cardNumber - 1];
    if (card === undefined) throw new Error('seed comment names no card');
    return {
      id: `cm-${String(index + 1).padStart(2, '0')}`,
      cardId: card.id,
      boardId: card.boardId,
      authorId: `m-${card.boardId}-${author}`,
      body,
      createdAtMs: card.createdAtMs + hours * HOUR_MS,
    };
  },
);

/** The typed seed rows, keyed by table, in bootstrap (parent-first) order. */
export const releaseBoardSeed = {
  boards: BOARDS,
  members: MEMBERS,
  labels: LABELS,
  cards: CARDS,
  card_labels: CARD_LABELS,
  comments: COMMENTS,
} as const;

/** Structurally a `SeedMutation` from `@syncular/server`. */
export interface ReleaseBoardSeedMutation {
  readonly table: keyof typeof releaseBoardSeed;
  readonly op: 'upsert';
  readonly values: Readonly<Record<string, unknown>>;
}

/** Every seed row as one upsert, parents first: one `seedMutations` commit. */
export function releaseBoardSeedMutations(): ReleaseBoardSeedMutation[] {
  const seed = releaseBoardSeed;
  return [
    ...seed.boards.map(
      (row) => ({ table: 'boards', op: 'upsert', values: { ...row } }) as const,
    ),
    ...seed.members.map(
      (row) =>
        ({ table: 'members', op: 'upsert', values: { ...row } }) as const,
    ),
    ...seed.labels.map(
      (row) => ({ table: 'labels', op: 'upsert', values: { ...row } }) as const,
    ),
    ...seed.cards.map(
      (row) => ({ table: 'cards', op: 'upsert', values: { ...row } }) as const,
    ),
    ...seed.card_labels.map(
      (row) =>
        ({ table: 'card_labels', op: 'upsert', values: { ...row } }) as const,
    ),
    ...seed.comments.map(
      (row) =>
        ({ table: 'comments', op: 'upsert', values: { ...row } }) as const,
    ),
  ];
}
