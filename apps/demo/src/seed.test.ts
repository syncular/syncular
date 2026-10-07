import { expect, test } from 'bun:test';
import { buildSqliteImage } from '@syncular/server/sqlite';
import {
  ensureSyncServerReady,
  MemorySegmentStore,
  seedMutations,
  SqliteServerStorage,
  type SyncServerConfig,
} from '@syncular/server';
import { DEMO_PARTITION, resolveBoardScopes, SEED_ACTOR } from './access';
import {
  BOARD_COLUMNS,
  releaseBoardSeed,
  releaseBoardSeedMutations,
} from './seed';
import { schema } from './syncular.generated';

test('the seed is deterministic and internally consistent', () => {
  const { boards, members, labels, cards, card_labels, comments } =
    releaseBoardSeed;
  expect([
    boards.length,
    members.length,
    labels.length,
    cards.length,
    comments.length,
  ]).toEqual([2, 6, 12, 24, 12]);
  const ids = new Set([...members, ...labels, ...cards].map((row) => row.id));
  for (const card of cards) {
    expect(BOARD_COLUMNS).toContain(
      card.columnId as (typeof BOARD_COLUMNS)[number],
    );
    if (card.assigneeId !== null) expect(ids.has(card.assigneeId)).toBe(true);
  }
  for (const link of card_labels) {
    expect(ids.has(link.cardId) && ids.has(link.labelId)).toBe(true);
    expect(link.labelId.startsWith(`l-${link.boardId}-`)).toBe(true);
  }
  for (const comment of comments)
    expect(ids.has(comment.cardId) && ids.has(comment.authorId)).toBe(true);
  // Every column of every board holds cards, so group-by output is never sparse.
  for (const board of boards) {
    for (const column of BOARD_COLUMNS) {
      expect(
        cards.some(
          (card) => card.boardId === board.id && card.columnId === column,
        ),
      ).toBe(true);
    }
  }
  expect(releaseBoardSeedMutations()).toEqual(releaseBoardSeedMutations());
});

test('an actor sees exactly the boards it has a membership row on', async () => {
  const storage = new SqliteServerStorage(':memory:');
  const config: SyncServerConfig = {
    schema,
    storage,
    segments: new MemorySegmentStore(),
    sqliteImageBuilder: buildSqliteImage,
    resolveScopes: (args) => resolveBoardScopes(storage, args),
  };
  await ensureSyncServerReady(config);
  await seedMutations(
    config,
    { partition: DEMO_PARTITION, actorId: SEED_ACTOR },
    releaseBoardSeedMutations(),
  );
  const scopes = (actorId: string) =>
    resolveBoardScopes(storage, { partition: DEMO_PARTITION, actorId });
  expect(await scopes('ada')).toEqual({ board_id: ['web', 'mobile'] });
  expect(await scopes('ben')).toEqual({ board_id: ['mobile'] });
  expect(await scopes(SEED_ACTOR)).toEqual({ board_id: ['*'] });
});
