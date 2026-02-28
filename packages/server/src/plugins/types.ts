import type { SyncOperation } from '@syncular/core';
import type {
  ApplyOperationResult,
  ServerApplyOperationContext,
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

export interface SyncServerPushPlugin<
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
}

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
