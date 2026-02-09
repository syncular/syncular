/**
 * Shared client DB types for runtime sync scenarios.
 */

import type { SyncClientDb } from '@syncular/client';

export interface RuntimeClientDb extends SyncClientDb {
  tasks: {
    id: string;
    title: string;
    completed: number;
    user_id: string;
    project_id: string;
    server_version: number;
  };
}
