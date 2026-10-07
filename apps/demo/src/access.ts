/**
 * Release board authorization, shared by the Bun dev server and the
 * embedded server worker. An actor may see a board exactly while a
 * `members` row `m-{board}-{actor}` exists, so granting or revoking a board
 * is an ordinary write that travels through the commit log. Revoking a
 * membership revokes the actor's per-board subscriptions on their next
 * round, and the client purges that board's rows (SPEC §3.3).
 */
import type { ResolveScopesArgs, ServerStorage } from '@syncular/server';
import { releaseBoardSeed } from './seed';

export const DEMO_PARTITION = 'demo';

/** The server operator that seeds the boards; allowed every board. */
export const SEED_ACTOR = 'operator';

/** The two signed-in people: the laptop is Ada (lead), the phone is Ben. */
export const DEMO_ACTORS = ['ada', 'ben'] as const;

export function isDemoActor(
  value: string | null | undefined,
): value is (typeof DEMO_ACTORS)[number] {
  return DEMO_ACTORS.some((actor) => actor === value);
}

export async function resolveBoardScopes(
  storage: ServerStorage,
  { partition, actorId }: ResolveScopesArgs,
): Promise<{ board_id: string[] }> {
  if (actorId === SEED_ACTOR) return { board_id: ['*'] };
  const boards: string[] = [];
  for (const board of releaseBoardSeed.boards) {
    const membership = await storage.getRow(
      partition,
      'members',
      `m-${board.id}-${actorId}`,
    );
    if (membership !== undefined) boards.push(board.id);
  }
  return { board_id: boards };
}
