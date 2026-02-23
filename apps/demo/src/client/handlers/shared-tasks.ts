/**
 * @syncular/demo - Client-side shared_tasks table handler
 */

import { createClientHandler } from '@syncular/client';
import type { ClientDb } from '../types.generated';

export const sharedTasksClientHandler = createClientHandler<
  ClientDb,
  'shared_tasks'
>({
  table: 'shared_tasks',
  scopes: ['share:{share_id}'],
});
