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
import {
  REMOTE_COMMAND_CLIENT_ID_PREFIX,
  RESOLVER_OUTAGE,
  touchAuthenticatedPartition,
} from './context';
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
  readonly resultColumns: readonly {
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
  readonly clientId: string;
  readonly operationId: string;
  readonly requestId: string;
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
  return rows.map((row) => {
    const normalized: Record<string, unknown> = Object.create(null);
    for (const column of columns) {
      const value = row[column.name];
      if (value === undefined || (value === null && !column.nullable)) {
        throw syncError(
          'operation.query_failed',
          'registered query returned a missing or invalid null value',
        );
      }
      if (value === null) {
        normalized[column.name] = null;
        continue;
      }
      switch (column.type) {
        case 'integer': {
          const integer =
            typeof value === 'bigint'
              ? Number(value)
              : typeof value === 'string' && /^-?(?:0|[1-9][0-9]*)$/.test(value)
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
          {
            const float =
              typeof value === 'string' &&
              /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(
                value,
              )
                ? Number(value)
                : value;
            if (typeof float !== 'number' || !Number.isFinite(float)) {
              throw syncError(
                'operation.query_failed',
                'registered query returned an invalid float',
              );
            }
            normalized[column.name] = float;
          }
          break;
        case 'boolean':
          if (typeof value === 'number' && Number.isFinite(value)) {
            normalized[column.name] = value !== 0;
          } else if (typeof value !== 'boolean') {
            throw syncError(
              'operation.query_failed',
              'registered query returned an invalid boolean',
            );
          }
          break;
        case 'json': {
          const json =
            typeof value === 'string' ? value : JSON.stringify(value);
          if (json === undefined) {
            throw syncError(
              'operation.query_failed',
              'registered query returned invalid JSON',
            );
          }
          JSON.parse(json);
          normalized[column.name] = json;
          break;
        }
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
      if (!(column.name in normalized)) normalized[column.name] = value;
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
    descriptor.id.length === 0 ||
    new Set(descriptor.tables).size !== descriptor.tables.length ||
    !Array.isArray(descriptor.resultColumns) ||
    descriptor.resultColumns.length === 0 ||
    new Set(descriptor.resultColumns.map((column) => column.name)).size !==
      descriptor.resultColumns.length
  ) {
    throw new Error(
      'remote query requires a non-empty id and unique tables and result columns',
    );
  }
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
      const schema = compileSchema(ctx.schema);
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
        const coverageByTable = new Map<string, RemoteQueryCoverage>();
        for (const entry of coverage) {
          if (
            coverageByTable.has(entry.base.table) ||
            !descriptor.tables.includes(entry.base.table)
          ) {
            throw syncError(
              'operation.invalid_request',
              'scoped remote query has invalid generated scope coverage',
            );
          }
          coverageByTable.set(entry.base.table, entry);
        }
        if (descriptor.tables.some((table) => !coverageByTable.has(table))) {
          throw syncError(
            'operation.invalid_request',
            'scoped remote query lacks complete generated scope coverage',
          );
        }
        for (const entry of coverage) {
          const table = schema.tables.get(entry.base.table);
          const fixedScopes = entry.base.fixedScopes ?? {};
          const coveredVariables = new Set([
            entry.base.variable,
            ...Object.keys(fixedScopes),
          ]);
          if (
            table === undefined ||
            Object.prototype.hasOwnProperty.call(
              fixedScopes,
              entry.base.variable,
            ) ||
            coveredVariables.size !== table.declaredVariables.size ||
            [...table.declaredVariables].some(
              (variable) => !coveredVariables.has(variable),
            )
          ) {
            throw syncError(
              'operation.invalid_request',
              'scoped remote query lacks complete generated scope coverage',
            );
          }
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
          for (const [variable, values] of Object.entries(fixedScopes)) {
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
      let rows;
      try {
        rows = normalizeQueryRows(result.rows, descriptor.resultColumns);
      } catch (error) {
        if (error instanceof SyncError) throw error;
        throw syncError(
          'operation.query_failed',
          'registered query result decoding failed',
        );
      }
      return {
        revision: 1,
        kind: 'query',
        operationId: descriptor.id,
        rows,
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
  clientId: string,
  operationId: string,
  requestId: string,
): RemoteCommandContext {
  return {
    actorId: ctx.actorId,
    partition: ctx.partition,
    clientId,
    operationId,
    requestId,
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
  if (descriptor.id.length === 0) {
    throw new Error('remote command id must be non-empty');
  }
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
        JSON.stringify(['remote-command', ctx.actorId, clientId]),
        JSON.stringify([descriptor.id, requestId]),
        async (tx) =>
          commandOperations(
            await options.run(
              commandContext(
                ctx,
                tx,
                resolved,
                schema,
                clientId,
                descriptor.id,
                requestId,
              ),
              input,
            ),
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
      if (operation.id.length === 0 || this.#operations.has(operation.id)) {
        throw new Error('remote operation ids must be non-empty and unique');
      }
      this.#operations.set(operation.id, operation);
    }
  }

  get(id: string): RegisteredRemoteOperation | undefined {
    return this.#operations.get(id);
  }
}

function encodeRemoteOperationError(
  error: unknown,
  fallbackCode: 'operation.invalid_request' | 'operation.execution_failed',
): Uint8Array {
  const sync =
    error instanceof SyncError
      ? error
      : syncError(
          fallbackCode,
          fallbackCode === 'operation.invalid_request'
            ? 'invalid remote operation request'
            : 'registered remote operation failed',
        );
  return encodeRemoteOperationResponse({
    revision: 1,
    kind: 'error',
    code: sync.code,
    message: sync.message,
    retryable: sync.retryable,
  });
}

export async function handleRemoteOperation(
  bytes: Uint8Array,
  ctx: SyncRequestContext,
  registry: RemoteOperationRegistry,
): Promise<Uint8Array> {
  let request;
  try {
    request = decodeRemoteOperationRequest(bytes);
    if (
      typeof request !== 'object' ||
      request === null ||
      request.revision !== 1 ||
      (request.kind !== 'query' && request.kind !== 'command') ||
      typeof request.clientId !== 'string' ||
      typeof request.operationId !== 'string' ||
      request.clientId.length === 0 ||
      request.operationId.length === 0
    ) {
      throw syncError('operation.invalid_request');
    }
  } catch (error) {
    return encodeRemoteOperationError(error, 'operation.invalid_request');
  }
  try {
    await touchAuthenticatedPartition(ctx);
    if (request.clientId.startsWith(REMOTE_COMMAND_CLIENT_ID_PREFIX)) {
      throw syncError(
        'sync.invalid_client_id',
        'clientId uses a reserved server-command namespace (§1.5)',
      );
    }
    const clientRecord = await ctx.storage.getClientRecord(
      ctx.partition,
      request.clientId,
    );
    if (clientRecord !== undefined && clientRecord.actorId !== ctx.actorId) {
      throw syncError(
        'sync.invalid_client_id',
        'clientId is bound to a different actor in this partition (§1.5)',
      );
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
    return encodeRemoteOperationError(error, 'operation.execution_failed');
  }
}
