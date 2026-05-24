import type {
  ScopeValues,
  SyncChange,
  SyncCrdtStateVectorHint,
  SyncOperation,
} from '@syncular/core';
import type {
  ApplyOperationResult,
  ServerApplyOperationContext,
  ServerContext,
  ServerTableHandler,
  SyncServerAuth,
} from '../handlers/types';
import type { SyncCoreDb } from '../schema';

/**
 * Plugin priority levels for server push hooks.
 * Lower numbers execute first.
 */
export const ServerPushPluginPriority = {
  /** CRDT payload transforms should run early. */
  CRDT: 40,
  /** Default priority for general plugins. */
  DEFAULT: 50,
  /** Logging/telemetry should run last. */
  TELEMETRY: 100,
} as const;

export interface ServerPushPluginBeforeApplyArgs<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  ctx: ServerApplyOperationContext<DB, Auth>;
  tableHandler: ServerTableHandler<DB, Auth>;
  op: SyncOperation;
  opIndex: number;
}

export interface ServerPushPluginAfterApplyArgs<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  ctx: ServerApplyOperationContext<DB, Auth>;
  tableHandler: ServerTableHandler<DB, Auth>;
  op: SyncOperation;
  opIndex: number;
  applied: ApplyOperationResult;
}

export interface ServerPullPluginTransformChangesArgs<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  ctx: ServerContext<DB, Auth>;
  tableHandler: ServerTableHandler<DB, Auth>;
  subscription: {
    id: string;
    table: string;
    scopes: ScopeValues;
    params: Record<string, unknown> | undefined;
    cursor: number;
    crdtStateVectors: readonly SyncCrdtStateVectorHint[];
  };
  changes: readonly SyncChange[];
}

export interface SyncServerPlugin<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  name: string;

  /**
   * Plugin priority for execution order. Lower numbers execute first.
   * @default ServerPushPluginPriority.DEFAULT (50)
   */
  priority?: number;

  /**
   * Called right before a table handler applies an operation.
   * Use this to transform payloads (for example CRDT envelopes).
   */
  beforeApplyOperation?(
    args: ServerPushPluginBeforeApplyArgs<DB, Auth>
  ): Promise<SyncOperation> | SyncOperation;

  /**
   * Called after a table handler applies an operation.
   * Use this to transform emitted changes / conflict rows.
   */
  afterApplyOperation?(
    args: ServerPushPluginAfterApplyArgs<DB, Auth>
  ): Promise<ApplyOperationResult> | ApplyOperationResult;

  /**
   * Called while building an incremental pull response for a single
   * subscription/table, before wire integrity is calculated.
   *
   * Use this for scoped, protocol-level row payload transforms such as sending
   * a CRDT update envelope instead of a full document state when the client
   * advertised an applicable state vector.
   */
  transformPullChanges?(
    args: ServerPullPluginTransformChangesArgs<DB, Auth>
  ): Promise<readonly SyncChange[]> | readonly SyncChange[];
}

export type SyncServerPushPlugin<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> = SyncServerPlugin<DB, Auth>;

export type SyncServerPullPlugin<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> = SyncServerPlugin<DB, Auth>;

export function sortServerPushPlugins<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  plugins: readonly SyncServerPushPlugin<DB, Auth>[] | undefined
): SyncServerPushPlugin<DB, Auth>[] {
  if (!plugins || plugins.length === 0) return [];

  return plugins
    .map((plugin, index) => ({ plugin, index }))
    .sort((a, b) => {
      const aPriority = a.plugin.priority ?? ServerPushPluginPriority.DEFAULT;
      const bPriority = b.plugin.priority ?? ServerPushPluginPriority.DEFAULT;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return a.index - b.index;
    })
    .map((entry) => entry.plugin);
}

export function sortServerPullPlugins<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  plugins: readonly SyncServerPullPlugin<DB, Auth>[] | undefined
): SyncServerPullPlugin<DB, Auth>[] {
  return sortServerPushPlugins(plugins);
}
