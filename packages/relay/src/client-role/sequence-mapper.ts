/**
 * @syncular/relay - Sequence Mapper
 *
 * Tracks the mapping between relay's local commit_seq
 * and the main server's global commit_seq.
 */

import { type Kysely, sql } from 'kysely';
import type { RelayDatabase, RelaySequenceMapStatus } from '../schema';

/**
 * Sequence mapping entry.
 */
export interface SequenceMapping {
  localCommitSeq: number;
  mainCommitSeq: number | null;
  status: RelaySequenceMapStatus;
}

/**
 * Sequence mapper for tracking local to main commit sequence mappings.
 */
export class SequenceMapper<DB extends RelayDatabase = RelayDatabase> {
  private readonly db: Kysely<DB>;

  constructor(options: { db: Kysely<DB> }) {
    this.db = options.db;
  }

  /**
   * Create a pending mapping for a local commit that will be forwarded.
   */
  async createPendingMapping(localCommitSeq: number): Promise<void> {
    const now = Date.now();
    await sql`
      insert into ${sql.table('relay_sequence_map')} (
        local_commit_seq,
        main_commit_seq,
        status,
        created_at,
        updated_at
      )
      values (${localCommitSeq}, ${null}, 'pending', ${now}, ${now})
      on conflict (local_commit_seq) do nothing
    `.execute(this.db);
  }

  /**
   * Mark a mapping as forwarded with the main server's commit_seq.
   */
  async markForwarded(
    localCommitSeq: number,
    mainCommitSeq: number
  ): Promise<void> {
    const now = Date.now();
    await sql`
      update ${sql.table('relay_sequence_map')}
      set
        main_commit_seq = ${mainCommitSeq},
        status = 'forwarded',
        updated_at = ${now}
      where local_commit_seq = ${localCommitSeq}
    `.execute(this.db);
  }

  /**
   * Mark a mapping as confirmed (main server acknowledged).
   */
  async markConfirmed(localCommitSeq: number): Promise<void> {
    const now = Date.now();
    await sql`
      update ${sql.table('relay_sequence_map')}
      set status = 'confirmed', updated_at = ${now}
      where local_commit_seq = ${localCommitSeq}
    `.execute(this.db);
  }

  /**
   * Get the mapping for a local commit sequence.
   */
  async getMapping(localCommitSeq: number): Promise<SequenceMapping | null> {
    const rowResult = await sql<{
      local_commit_seq: number;
      main_commit_seq: number | null;
      status: RelaySequenceMapStatus;
    }>`
      select local_commit_seq, main_commit_seq, status
      from ${sql.table('relay_sequence_map')}
      where local_commit_seq = ${localCommitSeq}
      limit 1
    `.execute(this.db);
    const row = rowResult.rows[0];

    if (!row) return null;

    return {
      localCommitSeq: row.local_commit_seq,
      mainCommitSeq: row.main_commit_seq,
      status: row.status,
    };
  }

  /**
   * Get the local commit sequence for a main server commit sequence.
   */
  async getLocalCommitSeq(mainCommitSeq: number): Promise<number | null> {
    const rowResult = await sql<{ local_commit_seq: number }>`
      select local_commit_seq
      from ${sql.table('relay_sequence_map')}
      where main_commit_seq = ${mainCommitSeq}
      limit 1
    `.execute(this.db);

    return rowResult.rows[0]?.local_commit_seq ?? null;
  }

  /**
   * Get all pending mappings (commits not yet forwarded).
   */
  async getPendingMappings(): Promise<SequenceMapping[]> {
    const rowsResult = await sql<{
      local_commit_seq: number;
      main_commit_seq: number | null;
      status: RelaySequenceMapStatus;
    }>`
      select local_commit_seq, main_commit_seq, status
      from ${sql.table('relay_sequence_map')}
      where status = 'pending'
      order by local_commit_seq asc
    `.execute(this.db);
    const rows = rowsResult.rows;

    return rows.map((row) => ({
      localCommitSeq: row.local_commit_seq,
      mainCommitSeq: row.main_commit_seq,
      status: row.status,
    }));
  }

  /**
   * Create a mapping for commits pulled from main (assigned new local commit_seq).
   *
   * These mappings go directly to 'confirmed' status since they came from main.
   */
  async createConfirmedMapping(
    localCommitSeq: number,
    mainCommitSeq: number
  ): Promise<void> {
    const now = Date.now();
    await sql`
      insert into ${sql.table('relay_sequence_map')} (
        local_commit_seq,
        main_commit_seq,
        status,
        created_at,
        updated_at
      )
      values (
        ${localCommitSeq},
        ${mainCommitSeq},
        'confirmed',
        ${now},
        ${now}
      )
      on conflict (local_commit_seq)
      do update set
        main_commit_seq = ${mainCommitSeq},
        status = 'confirmed',
        updated_at = ${now}
    `.execute(this.db);
  }

  /**
   * Delete confirmed/forwarded sequence mappings older than the given age.
   * Keeps pending mappings (they haven't been forwarded yet).
   */
  async pruneOldMappings(maxAgeMs: number): Promise<number> {
    const threshold = Date.now() - maxAgeMs;
    const result = await sql`
      delete from ${sql.table('relay_sequence_map')}
      where status in ('confirmed', 'forwarded')
      and updated_at < ${threshold}
    `.execute(this.db);

    return Number(result.numAffectedRows ?? 0);
  }

  /**
   * Get the highest main_commit_seq we've seen (for tracking pull cursor).
   */
  async getHighestMainCommitSeq(): Promise<number> {
    const rowResult = await sql<{ max_seq: number | null }>`
      select max(main_commit_seq) as max_seq
      from ${sql.table('relay_sequence_map')}
      where main_commit_seq is not null
      limit 1
    `.execute(this.db);

    return rowResult.rows[0]?.max_seq ?? 0;
  }
}
