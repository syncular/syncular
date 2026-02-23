import type { SyncBlobDb, SyncCoreDb } from '@syncular/server';
import type { ClientDb } from '../client/types.generated';

export interface ServerDb extends SyncCoreDb, SyncBlobDb, ClientDb {}
