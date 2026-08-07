import {
  decodeRow,
  decodeRemoteOperationRequest,
  encodeRow,
  encodeRemoteOperationResponse,
  type PushOperation,
  type RemoteOperationResponse,
  type RowValue,
  type ScopeMap,
} from '@syncular/core';
import type { SyncRequestContext } from './context';
import { RESOLVER_OUTAGE } from './context';
import { SyncError, syncError } from './errors';
import { processPushOperationsWithTrace } from './push';
import { compileSchema } from './schema';
import { authorizeWrite, type ResolvedScopes } from './scopes';
import type { AuthoritativeQueryValue } from './storage';
import type { StorageTransaction } from './storage';
import { toValidateRow, type ValidateRow } from './validate';

export interface RemoteQueryDependency {
  readonly table: string;
  readonly scopeKeys?: readonly string[];
}

export interface RemoteQueryCoverage {
  readonly base: {
    readonly table: string;
    readonly variable: string;
    readonly fixedScopes?: Readonly<Record<string, readonly string[]>>;
  };
  readonly units: readonly string[];
}

/** Structural subset implemented by generated NamedQuery descriptors. */
export interface AuthoritativeQueryDescriptor<Params = undefined> {
  readonly id: string;
  readonly hasParams: boolean;
  readonly sql: string;
  readonly tables: readonly string[];
  readonly resultColumns?: readonly {
    readonly name: string;
    readonly type:
      | 'string'
      | 'integer'
      | 'float'
      | 'boolean'
      | 'json'
      | 'bytes'
      | 'blob_ref'
      | 'crdt';
    readonly nullable: boolean;
  }[];
  readonly bind: (params: Params) => readonly AuthoritativeQueryValue[];
  readonly sqlFor?: (params: Params) => string;
  readonly dependencies: (params: Params) => readonly RemoteQueryDependency[];
  readonly coverage: (params: Params) => readonly RemoteQueryCoverage[];
}

export interface RemoteOperationAuthContext {
  readonly actorId: string;
  readonly partition: string;
  readonly clientId: string;
}

export type RegisteredRemoteQuery = {
  readonly kind: 'query';
  readonly id: string;
  readonly tables: readonly string[];
  readonly run: (
    ctx: SyncRequestContext,
    clientId: string,
    params: unknown,
  ) => Promise<RemoteOperationResponse>;
};

export interface RemoteCommandDescriptor<Input = undefined> {
  readonly id: string;
  readonly __input?: Input;
}

export type CommandMutation =
  | {
      readonly table: string;
      readonly op: 'upsert';
      readonly values: Readonly<Record<string, RowValue>>;
    }
  | {
      readonly table: string;
      readonly op: 'delete';
      readonly rowId: string;
    };

export interface RemoteCommandContext {
  readonly actorId: string;
  readonly partition: string;
  getRow(table: string, rowId: string): Promise<ValidateRow | undefined>;
}

export interface RemoteCommandOptions<Input> {
  readonly authorize: (
    context: RemoteOperationAuthContext,
    input: Input,
  ) => boolean | Promise<boolean>;
  readonly run: (
    context: RemoteCommandContext,
    input: Input,
  ) => readonly CommandMutation[] | Promise<readonly CommandMutation[]>;
}

export type RegisteredRemoteCommand = {
  readonly kind: 'command';
  readonly id: string;
  readonly run: (
    ctx: SyncRequestContext,
    clientId: string,
    requestId: string,
    params: unknown,
  ) => Promise<RemoteOperationResponse>;
};

export type RegisteredRemoteOperation =
  | RegisteredRemoteQuery
  | RegisteredRemoteCommand;

type RemoteQueryAccess<Params> =
  | { readonly access: 'scoped' }
  | {
      readonly access: 'privileged';
      readonly authorize: (
        context: RemoteOperationAuthContext,
        params: Params,
      ) => boolean | Promise<boolean>;
    };

export interface RemoteQueryOptions<Params> {
  readonly maxRows: number;
  readonly auth: RemoteQueryAccess<Params>;
}

function scopeAllowed(
  allowed: ScopeMap,
  variable: string,
  value: string,
): boolean {
  const values = allowed[variable];
  return (
    values !== undefined && (values.includes('*') || values.includes(value))
  );
}

function normalizeQueryRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  columns: AuthoritativeQueryDescriptor<unknown>['resultColumns'],
): readonly Readonly<Record<string, unknown>>[] {
  if (columns === undefined) return rows;
  return rows.map((row) => {
    const normalized: Record<string, unknown> = { ...row };
    for (const column of columns) {
      const value = row[column.name];
      if (value === null || value === undefined) continue;
      switch (column.type) {
        case 'integer': {
          const integer =
            typeof value === 'bigint' || typeof value === 'string'
              ? Number(value)
              : value;
          if (typeof integer !== 'number' || !Number.isSafeInteger(integer)) {
            throw syncError(
              'operation.query_failed',
              'registered query returned an invalid integer',
            );
          }
          normalized[column.name] = integer;
          break;
        }
        case 'float':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw syncError(
              'operation.query_failed',
              'registered query returned an invalid float',
            );
          }
          break;
        case 'boolean':
          if (typeof value === 'number') normalized[column.name] = value !== 0;
          else if (typeof value !== 'boolean') {
            throw syncError(
              'operation.query_failed',
              'registered query returned an invalid boolean',
            );
          }
          break;
        case 'json':
          if (typeof value !== 'string') {
            normalized[column.name] = JSON.stringify(value);
          }
          break;
        case 'bytes':
        case 'crdt': {
          const bytes =
            value instanceof Uint8Array
              ? value
              : value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : Array.isArray(value) &&
                    value.every(
                      (entry) =>
                        typeof entry === 'number' &&
                        Number.isInteger(entry) &&
                        entry >= 0 &&
                        entry <= 255,
                    )
                  ? new Uint8Array(value)
                  : undefined;
          if (bytes === undefined) {
            throw syncError(
              'operation.query_failed',
              'registered query returned invalid bytes',
            );
          }
          normalized[column.name] = bytes;
          break;
        }
        case 'string':
        case 'blob_ref':
          if (typeof value !== 'string') {
            throw syncError(
              'operation.query_failed',
              'registered query returned an invalid string',
            );
          }
          break;
      }
    }
    return normalized;
  });
}

/** Register one generated named query as an authoritative remote operation. */
export function registerRemoteQuery<Params>(
  descriptor: AuthoritativeQueryDescriptor<Params>,
  options: RemoteQueryOptions<Params>,
): RegisteredRemoteQuery {
  if (
    !Number.isSafeInteger(options.maxRows) ||
    options.maxRows < 1 ||
    options.maxRows > 10_000
  ) {
    throw new Error('remote query maxRows must be an integer from 1 to 10,000');
  }
  return {
    kind: 'query',
    id: descriptor.id,
    tables: descriptor.tables,
    run: async (ctx, clientId, rawParams) => {
      const params = rawParams as Params;
      if (options.auth.access === 'scoped') {
        const allowed = await ctx.resolveScopes({
          partition: ctx.partition,
          actorId: ctx.actorId,
          clientId,
        });
        if (allowed === RESOLVER_OUTAGE) {
          throw syncError(
            'operation.forbidden',
            'live scope authorization is unavailable for this query',
          );
        }
        const coverage = descriptor.coverage(params);
        const coveredTables = new Set(
          coverage.map((entry) => entry.base.table),
        );
        if (descriptor.tables.some((table) => !coveredTables.has(table))) {
          throw syncError(
            'operation.invalid_request',
            'scoped remote query lacks complete generated scope coverage',
          );
        }
        for (const entry of coverage) {
          if (entry.units.length === 0) {
            throw syncError(
              'operation.invalid_request',
              'scoped remote query has an empty scope unit',
            );
          }
          for (const value of entry.units) {
            if (!scopeAllowed(allowed, entry.base.variable, value)) {
              throw syncError('operation.forbidden');
            }
          }
          for (const [variable, values] of Object.entries(
            entry.base.fixedScopes ?? {},
          )) {
            if (
              values.length === 0 ||
              values.some((value) => !scopeAllowed(allowed, variable, value))
            ) {
              throw syncError('operation.forbidden');
            }
          }
        }
      } else if (
        !(await options.auth.authorize(
          { actorId: ctx.actorId, partition: ctx.partition, clientId },
          params,
        ))
      ) {
        throw syncError('operation.forbidden');
      }
      if (ctx.storage.queryAuthoritative === undefined) {
        throw syncError(
          'operation.storage_unsupported',
          'configured storage does not implement authoritative queries',
        );
      }
      const schema = compileSchema(ctx.schema);
      await ctx.storage.ensureSchema(schema);
      const selectedSql = descriptor.sqlFor?.(params) ?? descriptor.sql;
      let result;
      try {
        result = await ctx.storage.queryAuthoritative(ctx.partition, {
          sql: `SELECT * FROM (${selectedSql}) AS "_syncular_registered_query" LIMIT ?`,
          params: [...descriptor.bind(params), options.maxRows + 1],
          tables: descriptor.tables,
        });
      } catch (error) {
        if (error instanceof SyncError) throw error;
        throw syncError(
          'operation.query_failed',
          'registered query execution failed',
        );
      }
      if (result.rows.length > options.maxRows) {
        throw syncError('operation.result_too_large');
      }
      return {
        revision: 1,
        kind: 'query',
        operationId: descriptor.id,
        rows: normalizeQueryRows(result.rows, descriptor.resultColumns),
        maxCommitSeq: result.maxCommitSeq,
      };
    },
  };
}

/** A typed client/server identity for a server-authoritative command. */
export function remoteCommand<Input = undefined>(
  id: string,
): RemoteCommandDescriptor<Input> {
  if (id.length === 0) throw new Error('remote command id must be non-empty');
  return { id };
}

function commandOperations(
  mutations: readonly CommandMutation[],
  schema: ReturnType<typeof compileSchema>,
): PushOperation[] {
  if (mutations.length === 0) {
    throw syncError(
      'operation.invalid_request',
      'authoritative command produced no mutations',
    );
  }
  return mutations.map((mutation) => {
    const table = schema.tables.get(mutation.table);
    if (table === undefined) {
      throw syncError(
        'operation.invalid_request',
        'command targets an unknown table',
      );
    }
    if (mutation.op === 'delete') {
      if (mutation.rowId.length === 0) {
        throw syncError(
          'operation.invalid_request',
          'command delete rowId is empty',
        );
      }
      return { table: table.name, rowId: mutation.rowId, op: 'delete' };
    }
    const supplied = new Set(Object.keys(mutation.values));
    for (const name of supplied) {
      if (!table.columnIndex.has(name)) {
        throw syncError(
          'operation.invalid_request',
          'command upsert has an unknown column',
        );
      }
    }
    const values = table.columns.map((column) => {
      if (!supplied.has(column.name)) {
        throw syncError(
          'operation.invalid_request',
          'command upsert must provide a full row',
        );
      }
      return mutation.values[column.name] ?? null;
    });
    const rowId = values[table.primaryKeyIndex];
    if (typeof rowId !== 'string' || rowId.length === 0) {
      throw syncError(
        'operation.invalid_request',
        'command upsert requires a non-empty string primary key',
      );
    }
    return {
      table: table.name,
      rowId,
      op: 'upsert',
      payload: encodeRow(table.columns, values),
    };
  });
}

function commandContext(
  ctx: SyncRequestContext,
  tx: StorageTransaction,
  resolved: ResolvedScopes,
  schema: ReturnType<typeof compileSchema>,
): RemoteCommandContext {
  return {
    actorId: ctx.actorId,
    partition: ctx.partition,
    getRow: async (tableName, rowId) => {
      const table = schema.tables.get(tableName);
      if (table === undefined) {
        throw syncError(
          'operation.invalid_request',
          'command read targets an unknown table',
        );
      }
      const stored = await tx.getRow(tableName, rowId);
      if (
        stored === undefined ||
        !authorizeWrite(table, stored.scopes, resolved)
      ) {
        return undefined;
      }
      return toValidateRow(
        table.columns,
        decodeRow(table.columns, stored.payload),
      );
    },
  };
}

/** Register custom command code that plans one ordinary Syncular commit. */
export function registerRemoteCommand<Input>(
  descriptor: RemoteCommandDescriptor<Input>,
  options: RemoteCommandOptions<Input>,
): RegisteredRemoteCommand {
  return {
    kind: 'command',
    id: descriptor.id,
    run: async (ctx, clientId, requestId, rawInput) => {
      const input = rawInput as Input;
      if (
        !(await options.authorize(
          { actorId: ctx.actorId, partition: ctx.partition, clientId },
          input,
        ))
      ) {
        throw syncError('operation.forbidden');
      }
      const allowed = await ctx.resolveScopes({
        partition: ctx.partition,
        actorId: ctx.actorId,
        clientId,
      });
      if (allowed === RESOLVER_OUTAGE) {
        throw syncError(
          'operation.forbidden',
          'live scope authorization is unavailable for this command',
        );
      }
      const resolved: ResolvedScopes = { ok: true, allowed };
      const schema = compileSchema(ctx.schema);
      await ctx.storage.ensureSchema(schema);
      const processed = await processPushOperationsWithTrace(
        ctx,
        schema,
        resolved,
        `command:${clientId}`,
        `${descriptor.id}:${requestId}`,
        async (tx) =>
          commandOperations(
            await options.run(commandContext(ctx, tx, resolved, schema), input),
            schema,
          ),
      );
      return {
        revision: 1,
        kind: 'command',
        operationId: descriptor.id,
        requestId,
        status: processed.frame.status,
        ...(processed.frame.commitSeq !== undefined
          ? { commitSeq: processed.frame.commitSeq }
          : {}),
        results: processed.frame.results,
      };
    },
  };
}

export class RemoteOperationRegistry {
  readonly #operations = new Map<string, RegisteredRemoteOperation>();

  constructor(operations: readonly RegisteredRemoteOperation[]) {
    for (const operation of operations) {
      if (this.#operations.has(operation.id)) {
        throw new Error('duplicate remote operation id');
      }
      this.#operations.set(operation.id, operation);
    }
  }

  get(id: string): RegisteredRemoteOperation | undefined {
    return this.#operations.get(id);
  }
}

export async function handleRemoteOperation(
  bytes: Uint8Array,
  ctx: SyncRequestContext,
  registry: RemoteOperationRegistry,
): Promise<Uint8Array> {
  try {
    const request = decodeRemoteOperationRequest(bytes);
    if (
      request.revision !== 1 ||
      (request.kind !== 'query' && request.kind !== 'command') ||
      typeof request.clientId !== 'string' ||
      typeof request.operationId !== 'string' ||
      request.clientId.length === 0 ||
      request.operationId.length === 0
    ) {
      throw syncError('operation.invalid_request');
    }
    if (
      request.kind === 'command' &&
      (typeof request.requestId !== 'string' || request.requestId.length === 0)
    ) {
      throw syncError('operation.invalid_request');
    }
    const operation = registry.get(request.operationId);
    if (operation === undefined) {
      throw syncError('operation.unknown');
    }
    if (request.kind === 'query') {
      if (operation.kind !== 'query') throw syncError('operation.unknown');
      return encodeRemoteOperationResponse(
        await operation.run(ctx, request.clientId, request.params),
      );
    }
    if (operation.kind !== 'command') throw syncError('operation.unknown');
    return encodeRemoteOperationResponse(
      await operation.run(
        ctx,
        request.clientId,
        request.requestId,
        request.params,
      ),
    );
  } catch (error) {
    const sync =
      error instanceof SyncError
        ? error
        : syncError(
            'operation.invalid_request',
            'invalid remote operation request',
          );
    return encodeRemoteOperationResponse({
      revision: 1,
      kind: 'error',
      code: sync.code,
      message: sync.message,
      retryable: sync.retryable,
    });
  }
}
