import { collectScopeVars, type ScopeValues } from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import type { ServerTableHandler, SyncServerAuth } from '../handlers/types';
import { rowScopesAllowed } from '../helpers/scope-authorization';
import type { SyncCoreDb } from '../schema';

export type ScopedBlobAccessDecisionReason =
  | 'allowed'
  | 'handler_missing'
  | 'missing_reference'
  | 'resolve_scopes_failed'
  | 'scope_denied';

export interface ScopedBlobAccessDecision {
  actorId: string;
  partitionId: string;
  hash: string;
  allowed: boolean;
  reason: ScopedBlobAccessDecisionReason;
  table?: string;
  column?: string;
  rowId?: string;
}

export interface ScopedBlobReferenceTable {
  table: string;
  blobColumns: readonly string[];
  /**
   * Optional column that must match the requested Syncular route partition.
   * Use this when one reference table stores grants for multiple partitions.
   */
  partitionColumn?: string;
  primaryKeyColumn?: string;
  candidateLimit?: number;
}

export interface CreateScopedBlobAccessCheckerOptions<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
> {
  db: Kysely<DB>;
  handlers: readonly ServerTableHandler<DB, Auth>[];
  references: readonly ScopedBlobReferenceTable[];
  candidateLimit?: number;
  onDecision?: (decision: ScopedBlobAccessDecision) => void;
}

export interface ScopedBlobAccessRequest<Auth extends SyncServerAuth> {
  actorId: string;
  partitionId: string;
  hash: string;
  auth?: Auth;
}

export function createScopedBlobAccessChecker<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  options: CreateScopedBlobAccessCheckerOptions<DB, Auth>
): (request: ScopedBlobAccessRequest<Auth>) => Promise<boolean> {
  const decide = createScopedBlobAccessDecisionChecker(options);
  return async (request) => {
    const decision = await decide(request);
    return decision.allowed;
  };
}

export function createScopedBlobAccessDecisionChecker<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth = SyncServerAuth,
>(
  options: CreateScopedBlobAccessCheckerOptions<DB, Auth>
): (
  request: ScopedBlobAccessRequest<Auth>
) => Promise<ScopedBlobAccessDecision> {
  const handlersByTable = new Map(
    options.handlers.map((handler) => [handler.table, handler])
  );
  const candidateLimit = options.candidateLimit ?? 100;

  const finish = (
    decision: ScopedBlobAccessDecision
  ): ScopedBlobAccessDecision => {
    options.onDecision?.(decision);
    return decision;
  };

  return async (request) => {
    let deniedDecision: ScopedBlobAccessDecision | null = null;
    let configurationDecision: ScopedBlobAccessDecision | null = null;

    for (const reference of options.references) {
      if (reference.blobColumns.length === 0) continue;

      const rows = await readBlobReferenceCandidateRows({
        db: options.db,
        table: reference.table,
        columns: reference.blobColumns,
        hash: request.hash,
        partitionId: request.partitionId,
        partitionColumn: reference.partitionColumn,
        limit: reference.candidateLimit ?? candidateLimit,
      });
      if (rows.length === 0) {
        continue;
      }

      const handler = handlersByTable.get(reference.table);
      if (!handler) {
        configurationDecision ??= {
          ...request,
          allowed: false,
          reason: 'handler_missing',
          table: reference.table,
        };
        continue;
      }

      const allowedScopes = await resolveBlobAccessScopes({
        db: options.db,
        handler,
        request,
      });
      if (!allowedScopes.ok) {
        configurationDecision ??= {
          ...request,
          allowed: false,
          reason: 'resolve_scopes_failed',
          table: reference.table,
        };
        continue;
      }

      const requiredScopeKeys = Array.from(
        collectScopeVars(handler.scopePatterns)
      );
      for (const row of rows) {
        const matchedColumn = reference.blobColumns.find((column) =>
          blobColumnMatchesHash(row[column], request.hash)
        );
        if (!matchedColumn) continue;

        const rowScopes = handler.extractScopes(row);
        if (
          !rowScopesAllowed({
            rowScopes,
            allowedScopes: allowedScopes.scopes,
            requiredScopeKeys,
          })
        ) {
          deniedDecision ??= {
            ...request,
            allowed: false,
            reason: 'scope_denied',
            table: reference.table,
            column: matchedColumn,
            rowId: readRowId(
              row,
              reference.primaryKeyColumn ?? handler.primaryKeyColumn
            ),
          };
          continue;
        }

        return finish({
          ...request,
          allowed: true,
          reason: 'allowed',
          table: reference.table,
          column: matchedColumn,
          rowId: readRowId(
            row,
            reference.primaryKeyColumn ?? handler.primaryKeyColumn
          ),
        });
      }
    }

    return finish(
      deniedDecision ??
        configurationDecision ?? {
          ...request,
          allowed: false,
          reason: 'missing_reference',
        }
    );
  };
}

async function resolveBlobAccessScopes<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(args: {
  db: Kysely<DB>;
  handler: ServerTableHandler<DB, Auth>;
  request: ScopedBlobAccessRequest<Auth>;
}): Promise<{ ok: true; scopes: ScopeValues } | { ok: false }> {
  try {
    const scopes = await args.handler.resolveScopes({
      db: args.db,
      actorId: args.request.actorId,
      auth:
        args.request.auth ??
        ({
          actorId: args.request.actorId,
          partitionId: args.request.partitionId,
        } as Auth),
    });
    return { ok: true, scopes };
  } catch {
    return { ok: false };
  }
}

async function readBlobReferenceCandidateRows<DB extends SyncCoreDb>(args: {
  db: Kysely<DB>;
  table: string;
  columns: readonly string[];
  hash: string;
  partitionId: string;
  partitionColumn?: string;
  limit: number;
}): Promise<Record<string, unknown>[]> {
  const pattern = `%${args.hash}%`;
  const predicates = args.columns.map(
    (column) => sql`${sql.ref(column)} like ${pattern}`
  );
  const partitionPredicate = args.partitionColumn
    ? sql` and ${sql.ref(args.partitionColumn)} = ${args.partitionId}`
    : sql``;
  const result = await sql<Record<string, unknown>>`
    select *
    from ${sql.table(args.table)}
    where (${sql.join(predicates, sql` or `)})${partitionPredicate}
    limit ${args.limit}
  `.execute(args.db);
  return result.rows;
}

function readRowId(
  row: Record<string, unknown>,
  primaryKeyColumn: string | undefined
): string | undefined {
  const column = primaryKeyColumn ?? 'id';
  const value = row[column];
  return value === null || value === undefined ? undefined : String(value);
}

function blobColumnMatchesHash(value: unknown, hash: string): boolean {
  const parsed = parseMaybeJson(value);
  if (isBlobRefHash(parsed, hash)) return true;
  if (Array.isArray(parsed)) {
    return parsed.some((entry) => isBlobRefHash(parseMaybeJson(entry), hash));
  }
  return false;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isBlobRefHash(value: unknown, hash: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (value as { hash?: unknown }).hash === hash;
}
