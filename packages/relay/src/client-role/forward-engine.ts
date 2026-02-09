/**
 * @syncular/relay - Forward Engine
 *
 * Forwards commits from the relay's local outbox to the main server.
 * Preserves original client_id + client_commit_id for idempotency.
 */

import type {
  SyncOperation,
  SyncPushResponse,
  SyncTransport,
} from '@syncular/core';
import { randomId } from '@syncular/core';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type {
  ForwardConflictEntry,
  ForwardOutboxEntry,
  RelayDatabase,
  RelayForwardOutboxStatus,
} from '../schema';
import type { SequenceMapper } from './sequence-mapper';

/**
 * Forward engine options.
 */
export interface ForwardEngineOptions<
  DB extends RelayDatabase = RelayDatabase,
> {
  db: Kysely<DB>;
  transport: SyncTransport;
  clientId: string;
  sequenceMapper: SequenceMapper<DB>;
  retryIntervalMs?: number;
  onConflict?: (conflict: ForwardConflictEntry) => void;
  onError?: (error: Error) => void;
}

/**
 * Forward engine for sending local commits to the main server.
 */
export class ForwardEngine<DB extends RelayDatabase = RelayDatabase> {
  private readonly db: Kysely<DB>;
  private readonly transport: SyncTransport;
  private readonly clientId: string;
  private readonly sequenceMapper: SequenceMapper<DB>;
  private readonly retryIntervalMs: number;
  private readonly onConflict?: (conflict: ForwardConflictEntry) => void;
  private readonly onError?: (error: Error) => void;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: assigned in scheduleWakeUp and read in tick
  private wakeUpRequested = false;

  constructor(options: ForwardEngineOptions<DB>) {
    this.db = options.db;
    this.transport = options.transport;
    this.clientId = options.clientId;
    this.sequenceMapper = options.sequenceMapper;
    this.retryIntervalMs = options.retryIntervalMs ?? 5000;
    this.onConflict = options.onConflict;
    this.onError = options.onError;
  }

  /**
   * Start the forward engine loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  /**
   * Stop the forward engine.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Wake up the engine to process immediately.
   */
  wakeUp(): void {
    if (!this.running) return;
    this.wakeUpRequested = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext(0);
  }

  /**
   * Forward a single commit (for manual/testing use).
   */
  async forwardOnce(): Promise<boolean> {
    return this.processOne();
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) return;

    this.timer = setTimeout(async () => {
      this.timer = null;
      this.wakeUpRequested = false;

      try {
        const forwarded = await this.processOne();
        // If we forwarded something, immediately try again
        const nextDelay = forwarded ? 0 : this.retryIntervalMs;
        this.scheduleNext(nextDelay);
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
        this.scheduleNext(this.retryIntervalMs);
      }
    }, delayMs);
  }

  private async processOne(): Promise<boolean> {
    const next = await this.getNextSendable();
    if (!next) return false;

    await this.markSending(next.id);

    let response: SyncPushResponse;
    try {
      const combined = await this.transport.sync({
        clientId: next.client_id,
        push: {
          clientCommitId: next.client_commit_id,
          operations: next.operations,
          schemaVersion: next.schema_version,
        },
      });
      if (!combined.push) {
        throw new Error('Server returned no push response');
      }
      response = combined.push;
    } catch (err) {
      // Network error - mark as pending for retry
      await this.markPending(next.id, String(err));
      throw err;
    }

    const responseJson = JSON.stringify(response);

    if (response.status === 'applied' || response.status === 'cached') {
      const mainCommitSeq = response.commitSeq ?? null;

      // Update outbox entry
      await this.markForwarded(next.id, mainCommitSeq, responseJson);

      // Update sequence mapper
      if (mainCommitSeq != null) {
        await this.sequenceMapper.markForwarded(
          next.local_commit_seq,
          mainCommitSeq
        );
      }

      return true;
    }

    // Rejected - store conflict and mark as failed
    const conflict = await this.recordConflict(next, responseJson);
    await this.markFailed(next.id, 'REJECTED', responseJson);

    this.onConflict?.(conflict);

    return true;
  }

  private async getNextSendable(): Promise<ForwardOutboxEntry | null> {
    const staleThreshold = Date.now() - 30000;

    const rowResult = await sql<{
      id: string;
      local_commit_seq: number;
      client_id: string;
      client_commit_id: string;
      operations_json: string;
      schema_version: number;
      status: RelayForwardOutboxStatus;
      main_commit_seq: number | null;
      error: string | null;
      last_response_json: string | null;
      created_at: number;
      updated_at: number;
      attempt_count: number;
    }>`
      select
        id,
        local_commit_seq,
        client_id,
        client_commit_id,
        operations_json,
        schema_version,
        status,
        main_commit_seq,
        error,
        last_response_json,
        created_at,
        updated_at,
        attempt_count
      from ${sql.table('relay_forward_outbox')}
      where
        status = 'pending'
        or (status = 'forwarding' and updated_at < ${staleThreshold})
      order by created_at asc
      limit 1
    `.execute(this.db);
    const row = rowResult.rows[0];

    if (!row) return null;

    const operations =
      typeof row.operations_json === 'string'
        ? (JSON.parse(row.operations_json) as SyncOperation[])
        : (row.operations_json as SyncOperation[]);

    return {
      id: row.id,
      local_commit_seq: row.local_commit_seq,
      client_id: row.client_id,
      client_commit_id: row.client_commit_id,
      operations,
      schema_version: row.schema_version,
      status: row.status,
      main_commit_seq: row.main_commit_seq,
      error: row.error,
      created_at: row.created_at,
      updated_at: row.updated_at,
      attempt_count: row.attempt_count,
    };
  }

  private async markSending(id: string): Promise<void> {
    const now = Date.now();

    await sql`
      update ${sql.table('relay_forward_outbox')}
      set
        status = 'forwarding',
        updated_at = ${now},
        attempt_count = attempt_count + 1,
        error = ${null}
      where id = ${id}
    `.execute(this.db);
  }

  private async markPending(id: string, error: string): Promise<void> {
    const now = Date.now();

    await sql`
      update ${sql.table('relay_forward_outbox')}
      set status = 'pending', updated_at = ${now}, error = ${error}
      where id = ${id}
    `.execute(this.db);
  }

  private async markForwarded(
    id: string,
    mainCommitSeq: number | null,
    responseJson: string
  ): Promise<void> {
    const now = Date.now();

    await sql`
      update ${sql.table('relay_forward_outbox')}
      set
        status = 'forwarded',
        main_commit_seq = ${mainCommitSeq},
        updated_at = ${now},
        error = ${null},
        last_response_json = ${responseJson}
      where id = ${id}
    `.execute(this.db);
  }

  private async markFailed(
    id: string,
    error: string,
    responseJson: string
  ): Promise<void> {
    const now = Date.now();

    await sql`
      update ${sql.table('relay_forward_outbox')}
      set
        status = 'failed',
        updated_at = ${now},
        error = ${error},
        last_response_json = ${responseJson}
      where id = ${id}
    `.execute(this.db);
  }

  private async recordConflict(
    entry: ForwardOutboxEntry,
    responseJson: string
  ): Promise<ForwardConflictEntry> {
    const now = Date.now();
    const id = randomId();

    await sql`
      insert into ${sql.table('relay_forward_conflicts')} (
        id,
        local_commit_seq,
        client_id,
        client_commit_id,
        response_json,
        created_at,
        resolved_at
      )
      values (
        ${id},
        ${entry.local_commit_seq},
        ${entry.client_id},
        ${entry.client_commit_id},
        ${responseJson},
        ${now},
        ${null}
      )
    `.execute(this.db);

    return {
      id,
      local_commit_seq: entry.local_commit_seq,
      client_id: entry.client_id,
      client_commit_id: entry.client_commit_id,
      response: JSON.parse(responseJson),
      created_at: now,
      resolved_at: null,
    };
  }
}
