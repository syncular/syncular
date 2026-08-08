/**
 * SQLite-backed auth-lease store over the shared synchronous driver.
 */
import type { ScopeMap } from '@syncular/core';
import type { LeaseIdFactory, LeaseRecord, LeaseStore } from './lease-store';
import {
  SqliteAdapterRequiredError,
  type SqliteDatabase,
} from './sqlite-driver';

function defaultLeaseId(): string {
  return `lease_${crypto.randomUUID()}`;
}

export class SqliteLeaseStore implements LeaseStore {
  readonly db: SqliteDatabase;
  readonly #newId: LeaseIdFactory;

  constructor(
    db: SqliteDatabase | string = ':memory:',
    options?: { readonly leaseId?: LeaseIdFactory },
  ) {
    if (typeof db === 'string') {
      throw new SqliteAdapterRequiredError();
    }
    this.db = db;
    this.#newId = options?.leaseId ?? defaultLeaseId;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_leases(
        partition TEXT NOT NULL, client_id TEXT NOT NULL,
        lease_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        allowed_scopes TEXT NOT NULL,
        issued_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (partition, client_id)
      );
      CREATE TABLE IF NOT EXISTS sync_lease_revocations(
        partition TEXT NOT NULL, lease_id TEXT NOT NULL,
        PRIMARY KEY (partition, lease_id)
      );
    `);
  }

  async get(
    partition: string,
    clientId: string,
  ): Promise<LeaseRecord | undefined> {
    const row = this.db
      .query<
        {
          lease_id: string;
          actor_id: string;
          allowed_scopes: string;
          issued_at_ms: number;
          expires_at_ms: number;
          revoked: number;
        },
        [string, string]
      >(
        `SELECT lease_id, actor_id, allowed_scopes, issued_at_ms,
                expires_at_ms, revoked
         FROM sync_leases WHERE partition=? AND client_id=?`,
      )
      .get(partition, clientId);
    if (row === null) return undefined;
    return {
      leaseId: row.lease_id,
      actorId: row.actor_id,
      allowedScopes: JSON.parse(row.allowed_scopes) as ScopeMap,
      issuedAtMs: row.issued_at_ms,
      expiresAtMs: row.expires_at_ms,
      revoked: row.revoked !== 0,
    };
  }

  #isRevoked(partition: string, leaseId: string): boolean {
    const row = this.db
      .query<{ n: number }, [string, string]>(
        'SELECT 1 AS n FROM sync_lease_revocations WHERE partition=? AND lease_id=?',
      )
      .get(partition, leaseId);
    return row !== null;
  }

  async issue(
    partition: string,
    clientId: string,
    actorId: string,
    allowedScopes: ScopeMap,
    nowMs: number,
    ttlMs: number,
  ): Promise<LeaseRecord> {
    const existing = await this.get(partition, clientId);
    const reuse =
      existing !== undefined &&
      existing.actorId === actorId &&
      !existing.revoked &&
      !this.#isRevoked(partition, existing.leaseId);
    const leaseId = reuse ? existing.leaseId : this.#newId();
    const record: LeaseRecord = {
      leaseId,
      actorId,
      allowedScopes,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
      revoked: false,
    };
    this.db
      .query(
        `INSERT INTO sync_leases(
          partition, client_id, lease_id, actor_id, allowed_scopes,
          issued_at_ms, expires_at_ms, revoked
        ) VALUES (?,?,?,?,?,?,?,0)
        ON CONFLICT(partition, client_id) DO UPDATE SET
          lease_id=excluded.lease_id, actor_id=excluded.actor_id,
          allowed_scopes=excluded.allowed_scopes,
          issued_at_ms=excluded.issued_at_ms,
          expires_at_ms=excluded.expires_at_ms, revoked=0`,
      )
      .run(
        partition,
        clientId,
        leaseId,
        actorId,
        JSON.stringify(allowedScopes),
        nowMs,
        record.expiresAtMs,
      );
    return record;
  }

  async revoke(partition: string, leaseId: string): Promise<void> {
    this.db
      .query(
        `INSERT OR IGNORE INTO sync_lease_revocations(partition, lease_id)
         VALUES (?,?)`,
      )
      .run(partition, leaseId);
    this.db
      .query(
        'UPDATE sync_leases SET revoked=1 WHERE partition=? AND lease_id=?',
      )
      .run(partition, leaseId);
  }
}
