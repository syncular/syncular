/**
 * @syncular/demo - Client-side tasks table handler
 */

import { createClientHandler } from '@syncular/client';
import type { ClientDb } from '../types.generated';

export const tasksClientHandler = createClientHandler<ClientDb, 'tasks'>({
  table: 'tasks',
  scopes: ['user:{user_id}'],
});
