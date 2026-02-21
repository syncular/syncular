/**
 * @syncular/relay - Pull Engine
 *
 * Pulls changes from the main server and stores them locally
 * on the relay for local clients to access.
 */

import type {
  ScopeValues,
  SyncCommit,
  SyncPullResponse,
  SyncSubscriptionRequest,
  SyncTransport,
} from '@syncular/core';
import type {
  ServerHandlerCollection,
  ServerSyncDialect,
  SyncServerAuth,
} from '@syncular/server';
import { pushCommit } from '@syncular/server';
import { type Kysely, sql } from 'kysely';
import type { RelayRealtime } from '../realtime';
import type { RelayDatabase } from '../schema';
import type { SequenceMapper } from './sequence-mapper';

type RelayAuth = SyncServerAuth;

/**
 * Pull engine options.
 */
export interface PullEngineOptions<DB extends RelayDatabase = RelayDatabase> {
  db: Kysely<DB>;
  dialect: ServerSyncDialect;
  transport: SyncTransport;
  clientId: string;
  /** Tables to subscribe to */
  tables: string[];
  /** Scope values for subscriptions */
  scopes: ScopeValues;
  handlers: ServerHandlerCollection<DB, RelayAuth>;
  sequenceMapper: SequenceMapper<DB>;
  realtime: RelayRealtime;
  intervalMs?: number;
  onError?: (error: Error) => void;
  onPullComplete?: () => Promise<void>;
}

/**
 * Pull engine for receiving changes from the main server.
 */
export class PullEngine<DB extends RelayDatabase = RelayDatabase> {
  private readonly db: Kysely<DB>;
  private readonly dialect: ServerSyncDialect;
  private readonly transport: SyncTransport;
  private readonly clientId: string;
  private readonly tables: string[];
  private readonly scopes: ScopeValues;
  private readonly handlers: ServerHandlerCollection<DB, RelayAuth>;
  private readonly sequenceMapper: SequenceMapper<DB>;
  private readonly realtime: RelayRealtime;
  private readonly intervalMs: number;
  private readonly onError?: (error: Error) => void;
  private readonly onPullComplete?: () => Promise<void>;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cursors = new Map<string, number>();

  constructor(options: PullEngineOptions<DB>) {
    this.db = options.db;
    this.dialect = options.dialect;
    this.transport = options.transport;
    this.clientId = options.clientId;
    this.tables = options.tables;
    this.scopes = options.scopes;
    this.handlers = options.handlers;
    this.sequenceMapper = options.sequenceMapper;
    this.realtime = options.realtime;
    this.intervalMs = options.intervalMs ?? 10000;
    this.onError = options.onError;
    this.onPullComplete = options.onPullComplete;
  }

  /**
   * Start the pull engine loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loadCursors()
      .catch((error) => {
        this.onError?.(
          error instanceof Error ? error : new Error(String(error))
        );
      })
      .finally(() => {
        if (this.running) {
          this.scheduleNext(0);
        }
      });
  }

  /**
   * Stop the pull engine.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Pull once (for manual/testing use).
   */
  async pullOnce(): Promise<boolean> {
    return this.processOne();
  }

  private async loadCursors(): Promise<void> {
    try {
      // Load cursors from config
      const rowResult = await sql<{ value_json: string }>`
        select value_json
        from ${sql.table('relay_config')}
        where key = 'main_cursors'
        limit 1
      `.execute(this.db);
      const row = rowResult.rows[0];

      if (row?.value_json) {
        const parsed = JSON.parse(row.value_json);
        if (typeof parsed === 'object' && parsed !== null) {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'number') {
              this.cursors.set(key, value);
            }
          }
        }
      }
    } catch {
      // Ignore - start from scratch
    }
  }

  private async saveCursors(): Promise<void> {
    const cursorObj: Record<string, number> = {};
    for (const [key, value] of this.cursors) {
      cursorObj[key] = value;
    }

    const valueJson = JSON.stringify(cursorObj);
    await sql`
      insert into ${sql.table('relay_config')} (key, value_json)
      values ('main_cursors', ${valueJson})
      on conflict (key)
      do update set value_json = ${valueJson}
    `.execute(this.db);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) return;

    this.timer = setTimeout(async () => {
      this.timer = null;

      try {
        const pulled = await this.processOne();
        // If we pulled something, immediately try again
        const nextDelay = pulled ? 0 : this.intervalMs;
        this.scheduleNext(nextDelay);
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
        this.scheduleNext(this.intervalMs);
      }
    }, delayMs);
  }

  private async processOne(): Promise<boolean> {
    // Build subscriptions for each table
    const subscriptionRequests: SyncSubscriptionRequest[] = this.tables.map(
      (table) => ({
        id: table,
        table,
        scopes: this.scopes,
        cursor: this.cursors.get(table) ?? -1,
      })
    );

    let response: SyncPullResponse;
    try {
      const combined = await this.transport.sync({
        clientId: this.clientId,
        pull: {
          subscriptions: subscriptionRequests,
          limitCommits: 100,
        },
      });
      if (!combined.pull) {
        return false;
      }
      response = combined.pull;
    } catch {
      // Network error - will retry
      return false;
    }

    if (!response.ok) {
      return false;
    }

    let hasChanges = false;
    const affectedTables = new Set<string>();

    for (const sub of response.subscriptions) {
      if (sub.status !== 'active') continue;

      const table = sub.id;

      // Process commits
      let canAdvanceCursor = true;
      for (const commit of sub.commits) {
        const outcome = await this.applyCommitLocally(commit, table);
        if (outcome === 'applied') {
          hasChanges = true;
          affectedTables.add(table);
        }
        if (outcome === 'rejected') {
          canAdvanceCursor = false;
          break;
        }
      }

      // Update cursor
      if (
        canAdvanceCursor &&
        sub.nextCursor > (this.cursors.get(table) ?? -1)
      ) {
        this.cursors.set(table, sub.nextCursor);
      }
    }

    // Save updated cursors
    await this.saveCursors();

    // Notify local clients if we have changes
    if (hasChanges && affectedTables.size > 0) {
      const maxCursor = await this.dialect.readMaxCommitSeq(this.db);
      this.realtime.notifyScopeKeys(Array.from(affectedTables), maxCursor);
    }

    // Trigger rate-limited prune after successful pull
    await this.onPullComplete?.();

    return hasChanges;
  }

  /**
   * Apply a commit from main server locally.
   *
   * This re-applies the commit through the local table handlers
   * to ensure proper indexing and scope assignment.
   */
  private async applyCommitLocally(
    commit: SyncCommit,
    table: string
  ): Promise<'applied' | 'cached' | 'rejected'> {
    if (commit.changes.length === 0) return 'cached';

    // Convert changes to operations
    const operations = commit.changes.map((change) => ({
      table: change.table,
      row_id: change.row_id,
      op: change.op,
      payload: change.row_json as Record<string, unknown> | null,
    }));

    // Generate a unique commit ID for this relay instance
    const relayCommitId = `main:${commit.commitSeq}:${table}`;

    // Push through local handler
    const result = await pushCommit({
      db: this.db,
      dialect: this.dialect,
      handlers: this.handlers,
      auth: { actorId: commit.actorId },
      request: {
        clientId: `relay:${this.clientId}`,
        clientCommitId: relayCommitId,
        operations,
        schemaVersion: 1,
      },
    });

    if (
      result.response.ok === true &&
      result.response.status === 'applied' &&
      typeof result.response.commitSeq === 'number'
    ) {
      // Record sequence mapping
      await this.sequenceMapper.createConfirmedMapping(
        result.response.commitSeq,
        commit.commitSeq
      );
      return 'applied';
    }

    // Already applied (cached) - that's fine
    if (result.response.status === 'cached') {
      return 'cached';
    }

    // Rejected - this shouldn't happen for pulls from main
    // Do not advance cursor; signal error so caller can react.
    const error = new Error(
      `Relay: Failed to apply commit ${commit.commitSeq} locally (status=${result.response.status})`
    );
    console.warn(
      `Relay: Failed to apply commit ${commit.commitSeq} locally:`,
      result.response
    );
    this.onError?.(error);
    return 'rejected';
  }
}
