import type {
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '@syncular/core';

export interface SyncClientPluginContext {
  actorId: string;
  clientId: string;
}

/**
 * Plugin priority levels for ordering execution.
 * Lower numbers execute first.
 */
export const PluginPriority = {
  /** Compression should run early (before encryption) */
  COMPRESSION: 10,
  /** Encryption should run after compression but before transport */
  ENCRYPTION: 20,
  /** Default priority for general plugins */
  DEFAULT: 50,
  /** Logging/telemetry should run last */
  TELEMETRY: 100,
} as const;

export interface SyncClientPlugin {
  name: string;

  /**
   * Plugin priority for ordering. Lower numbers execute first.
   * @default PluginPriority.DEFAULT (50)
   */
  priority?: number;

  /**
   * Called before sending a push request to the server.
   * Use this for client-side encryption, payload shaping, etc.
   */
  beforePush?(
    ctx: SyncClientPluginContext,
    request: SyncPushRequest
  ): Promise<SyncPushRequest> | SyncPushRequest;

  /**
   * Called after receiving a push response from the server.
   * Receives both the request and the response to allow opIndex correlation.
   */
  afterPush?(
    ctx: SyncClientPluginContext,
    args: { request: SyncPushRequest; response: SyncPushResponse }
  ): Promise<SyncPushResponse> | SyncPushResponse;

  /**
   * Called after receiving a pull response from the server (and after any
   * snapshot chunk materialization), but before applying it to the local DB.
   */
  afterPull?(
    ctx: SyncClientPluginContext,
    args: { request: SyncPullRequest; response: SyncPullResponse }
  ): Promise<SyncPullResponse> | SyncPullResponse;
}
