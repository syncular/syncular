/**
 * @syncular/demo - Server-side tasks table handler
 *
 * Simple task handler for demo purposes.
 * Scope: user:{user_id}
 */

import { createServerHandler } from '@syncular/server';
import type { ClientDb } from '../../client/types.generated';
import type { ServerDb } from '../db';

export const tasksServerHandler = createServerHandler<
  ServerDb,
  ClientDb,
  'tasks'
>({
  table: 'tasks',
  scopes: ['user:{user_id}'],
  resolveScopes: async (ctx) => ({
    user_id: ctx.actorId,
  }),
});
