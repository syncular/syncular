/**
 * Database-less SSP2 producer (§6.10). It prepares and sends ordinary commits
 * through the existing push path without creating a local replica or outbox.
 */
import {
  decodeMessage,
  decodeRemoteOperationResponse,
  decodeRemoteOperationRealtimeMessage,
  encodeMessage,
  encodeRemoteOperationRequest,
  encodeRemoteOperationRealtimeMessage,
  encodeRow,
  type PushOperation,
  type PushOperationResult,
  type PushResultDetailsFrame,
  type PushResultFrame,
  type RemoteOperationResponse,
} from '@syncular/core';
import type { MutationInput } from './client';
import type { EncryptionConfig } from './encryption';
import { encryptRowValues } from './encryption';
import { ClientSyncError } from './errors';
import {
  compileClientSchema,
  type ClientSchema,
  recordToRowValues,
} from './schema';
import type { SyncTransport } from './transport';
import type {
  RemoteOperationRealtimeConnector,
  RemoteOperationRealtimeSocket,
  RemoteOperationTransport,
} from './transport';

export interface SyncRemoteClientConfig {
  /** Required only for ordinary row commits. */
  readonly schema?: ClientSchema;
  readonly clientId: string;
  /** Required only for ordinary row commits. */
  readonly transport?: SyncTransport;
  readonly operations?: RemoteOperationTransport;
  readonly operationRealtime?: RemoteOperationRealtimeConnector;
  readonly encryption?: EncryptionConfig;
  /** Acquired partition log epoch for restore-safe ordinary commits (§2.1). */
  readonly logEpoch?: string;
}

export interface RemoteCommitInput {
  /** Stable caller-owned idempotency identity for this logical commit. */
  readonly requestId: string;
  readonly mutations: readonly MutationInput[];
}

/**
 * Prepared bytes are the retry unit. Persist them when a process must retry
 * across restart, especially when encryption uses randomized nonces.
 */
export interface PreparedRemoteCommit {
  readonly requestId: string;
  readonly bytes: Uint8Array;
}

export interface RemoteCommitResult {
  readonly requestId: string;
  readonly status: PushResultFrame['status'];
  readonly commitSeq?: number;
  readonly results: readonly PushOperationResult[];
}

export interface RemoteQueryDescriptor<Row, Params = undefined> {
  readonly id: string;
  readonly mapRow: (row: Readonly<Record<string, unknown>>) => Row;
  readonly __row?: Row;
  readonly __params?: Params;
}

export interface RemoteQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly maxCommitSeq: number;
}

export interface RemoteQueryWatchHandlers<Row> {
  onSnapshot(result: RemoteQueryResult<Row>): void;
  onError?(error: ClientSyncError): void;
}

export interface RemoteCommandDescriptor<Input = undefined> {
  readonly id: string;
  readonly __input?: Input;
}

export function remoteCommand<Input = undefined>(
  id: string,
): RemoteCommandDescriptor<Input> {
  if (id.length === 0) throw invalid('remote command id must be non-empty');
  return { id };
}

export interface RemoteCommandResult {
  readonly requestId: string;
  readonly status: 'applied' | 'cached' | 'rejected';
  readonly commitSeq?: number;
  readonly results: readonly unknown[];
}

function invalid(message: string): ClientSyncError {
  return new ClientSyncError('sync.invalid_request', message);
}

function operationResponse(bytes: Uint8Array): RemoteOperationResponse {
  let response: RemoteOperationResponse;
  try {
    response = decodeRemoteOperationResponse(bytes);
  } catch {
    throw new ClientSyncError(
      'client.invalid_host_response',
      'remote operation response is malformed',
    );
  }
  if (
    typeof response !== 'object' ||
    response === null ||
    Array.isArray(response)
  ) {
    throw new ClientSyncError(
      'client.invalid_host_response',
      'remote operation response is malformed',
    );
  }
  if (response.revision !== 1) {
    throw new ClientSyncError(
      'client.invalid_host_response',
      'remote operation response has an unsupported revision',
    );
  }
  if (
    response.kind === 'error' &&
    (typeof response.code !== 'string' ||
      typeof response.message !== 'string' ||
      typeof response.retryable !== 'boolean')
  ) {
    throw new ClientSyncError(
      'client.invalid_host_response',
      'remote operation error response is malformed',
    );
  }
  if (
    response.kind === 'query' &&
    (typeof response.operationId !== 'string' ||
      !Array.isArray(response.rows) ||
      response.rows.some(
        (row) => typeof row !== 'object' || row === null || Array.isArray(row),
      ) ||
      !Number.isSafeInteger(response.maxCommitSeq) ||
      response.maxCommitSeq < 0)
  ) {
    throw new ClientSyncError(
      'client.invalid_host_response',
      'remote query response is malformed',
    );
  }
  if (
    response.kind === 'command' &&
    (typeof response.operationId !== 'string' ||
      typeof response.requestId !== 'string' ||
      !['applied', 'cached', 'rejected'].includes(response.status) ||
      !Array.isArray(response.results) ||
      (response.commitSeq !== undefined &&
        (!Number.isSafeInteger(response.commitSeq) || response.commitSeq < 1)))
  ) {
    throw new ClientSyncError(
      'client.invalid_host_response',
      'remote command response is malformed',
    );
  }
  if (
    response.kind !== 'error' &&
    response.kind !== 'query' &&
    response.kind !== 'command'
  ) {
    throw new ClientSyncError(
      'client.invalid_host_response',
      'remote operation response has an unknown kind',
    );
  }
  return response;
}

export class SyncRemoteClient {
  readonly #schema;
  readonly #clientId: string;
  readonly #transport: SyncTransport | undefined;
  readonly #operations: RemoteOperationTransport | undefined;
  readonly #operationRealtime: RemoteOperationRealtimeConnector | undefined;
  #operationSocket: RemoteOperationRealtimeSocket | undefined;
  #operationSocketPromise: Promise<RemoteOperationRealtimeSocket> | undefined;
  #operationSocketGeneration = 0;
  readonly #watches = new Map<
    string,
    {
      readonly operationId: string;
      readonly mapRow: (row: Readonly<Record<string, unknown>>) => unknown;
      readonly handlers: RemoteQueryWatchHandlers<unknown>;
    }
  >();
  readonly #encryption: EncryptionConfig | undefined;
  readonly #logEpoch: string | undefined;

  constructor(config: SyncRemoteClientConfig) {
    if (config.clientId.length === 0) {
      throw invalid('SyncRemoteClient clientId must be non-empty');
    }
    if (config.logEpoch !== undefined && config.logEpoch.length === 0) {
      throw invalid('SyncRemoteClient logEpoch must be non-empty');
    }
    this.#schema =
      config.schema === undefined
        ? undefined
        : compileClientSchema(config.schema);
    this.#clientId = config.clientId;
    this.#transport = config.transport;
    this.#operations = config.operations;
    this.#operationRealtime = config.operationRealtime;
    this.#encryption = config.encryption;
    this.#logEpoch = config.logEpoch;
  }

  async prepareCommit(input: RemoteCommitInput): Promise<PreparedRemoteCommit> {
    const schema = this.#schema;
    if (schema === undefined) {
      throw new ClientSyncError(
        'client.remote_schema_unconfigured',
        'SyncRemoteClient needs a schema to prepare ordinary commits',
      );
    }
    if (input.requestId.length === 0) {
      throw invalid('remote commit requestId must be non-empty');
    }
    if (input.mutations.length === 0) {
      throw new ClientSyncError(
        'sync.empty_commit',
        'a remote commit must carry at least one mutation (§6.1)',
      );
    }
    const operations: PushOperation[] = [];
    for (const mutation of input.mutations) {
      const table = schema.tables.get(mutation.table);
      if (table === undefined) {
        throw invalid('remote commit targets an unknown table');
      }
      if (mutation.op === 'delete') {
        if (mutation.rowId.length === 0) {
          throw invalid('remote delete rowId must be non-empty');
        }
        operations.push({
          table: mutation.table,
          rowId: mutation.rowId,
          op: 'delete',
          ...(mutation.baseVersion !== undefined
            ? { baseVersion: mutation.baseVersion }
            : {}),
        });
        continue;
      }
      let values = recordToRowValues(table, mutation.values);
      const rowId = values[table.primaryKeyIndex];
      if (typeof rowId !== 'string' || rowId.length === 0) {
        throw invalid('remote upsert requires a non-empty string primary key');
      }
      if (this.#encryption !== undefined && table.hasEncryptedColumns) {
        values = await encryptRowValues(this.#encryption, table, rowId, values);
      }
      operations.push({
        table: mutation.table,
        rowId,
        op: 'upsert',
        ...(mutation.baseVersion !== undefined
          ? { baseVersion: mutation.baseVersion }
          : {}),
        payload: encodeRow(table.columns, values),
      });
    }
    return {
      requestId: input.requestId,
      bytes: encodeMessage({
        wireVersion: this.#logEpoch === undefined ? 1 : 2,
        msgKind: 'request',
        frames: [
          {
            type: 'REQ_HEADER',
            clientId: this.#clientId,
            schemaVersion: schema.version,
            ...(this.#logEpoch !== undefined
              ? { logEpoch: this.#logEpoch }
              : {}),
          },
          {
            type: 'PUSH_COMMIT',
            clientCommitId: input.requestId,
            operations,
          },
        ],
      }),
    };
  }

  async sendCommit(
    prepared: PreparedRemoteCommit,
  ): Promise<RemoteCommitResult> {
    if (this.#transport === undefined) {
      throw new ClientSyncError(
        'client.remote_sync_unconfigured',
        'SyncRemoteClient has no sync transport for ordinary commits',
      );
    }
    const response = decodeMessage(await this.#transport(prepared.bytes));
    if (response.msgKind !== 'response') {
      throw new ClientSyncError(
        'client.invalid_host_response',
        'remote commit transport returned a non-response SSP2 message',
      );
    }
    const error = response.frames.find((frame) => frame.type === 'ERROR');
    if (error?.type === 'ERROR') {
      throw new ClientSyncError(error.code, error.message, error.retryable);
    }
    const result = response.frames.find(
      (frame): frame is PushResultFrame =>
        frame.type === 'PUSH_RESULT' &&
        frame.clientCommitId === prepared.requestId,
    );
    if (result === undefined) {
      throw new ClientSyncError(
        'client.invalid_host_response',
        'remote commit response carried no matching PUSH_RESULT',
      );
    }
    const details = response.frames.find(
      (frame): frame is PushResultDetailsFrame =>
        frame.type === 'PUSH_RESULT_DETAILS' &&
        frame.clientCommitId === prepared.requestId,
    );
    const detailsByIndex = new Map(
      details?.entries.map((entry) => [entry.opIndex, entry.details]) ?? [],
    );
    return {
      requestId: prepared.requestId,
      status: result.status,
      ...(result.commitSeq !== undefined
        ? { commitSeq: result.commitSeq }
        : {}),
      results: result.results.map((operation) => {
        if (operation.status !== 'error') return operation;
        const operationDetails = detailsByIndex.get(operation.opIndex);
        return operationDetails === undefined
          ? operation
          : { ...operation, details: operationDetails };
      }),
    };
  }

  async commit(input: RemoteCommitInput): Promise<RemoteCommitResult> {
    return this.sendCommit(await this.prepareCommit(input));
  }

  async query<Row, Params = undefined>(
    descriptor: RemoteQueryDescriptor<Row, Params>,
    params?: Params,
  ): Promise<RemoteQueryResult<Row>> {
    if (this.#operations === undefined) {
      throw new ClientSyncError(
        'client.remote_operations_unconfigured',
        'SyncRemoteClient has no remote operation transport',
      );
    }
    const response = operationResponse(
      await this.#operations(
        encodeRemoteOperationRequest({
          revision: 1,
          kind: 'query',
          clientId: this.#clientId,
          operationId: descriptor.id,
          params: params ?? null,
        }),
      ),
    );
    if (response.kind === 'error') {
      throw new ClientSyncError(
        response.code,
        response.message,
        response.retryable,
      );
    }
    if (response.kind !== 'query' || response.operationId !== descriptor.id) {
      throw new ClientSyncError(
        'client.invalid_host_response',
        'remote query returned a mismatched response',
      );
    }
    try {
      return {
        rows: response.rows.map((row) => descriptor.mapRow(row)),
        maxCommitSeq: response.maxCommitSeq,
      };
    } catch {
      throw new ClientSyncError(
        'client.invalid_host_response',
        'remote query row is malformed',
      );
    }
  }

  async command<Input = undefined>(
    descriptor: RemoteCommandDescriptor<Input>,
    requestId: string,
    input?: Input,
  ): Promise<RemoteCommandResult> {
    if (this.#operations === undefined) {
      throw new ClientSyncError(
        'client.remote_operations_unconfigured',
        'SyncRemoteClient has no remote operation transport',
      );
    }
    if (requestId.length === 0) {
      throw invalid('remote command requestId must be non-empty');
    }
    const response = operationResponse(
      await this.#operations(
        encodeRemoteOperationRequest({
          revision: 1,
          kind: 'command',
          clientId: this.#clientId,
          operationId: descriptor.id,
          requestId,
          params: input ?? null,
        }),
      ),
    );
    if (response.kind === 'error') {
      throw new ClientSyncError(
        response.code,
        response.message,
        response.retryable,
      );
    }
    if (
      response.kind !== 'command' ||
      response.operationId !== descriptor.id ||
      response.requestId !== requestId
    ) {
      throw new ClientSyncError(
        'client.invalid_host_response',
        'remote command returned a mismatched response',
      );
    }
    return {
      requestId,
      status: response.status,
      ...(response.commitSeq !== undefined
        ? { commitSeq: response.commitSeq }
        : {}),
      results: response.results,
    };
  }

  async watch<Row, Params = undefined>(
    descriptor: RemoteQueryDescriptor<Row, Params>,
    params: Params,
    handlers: RemoteQueryWatchHandlers<Row>,
  ): Promise<() => void> {
    if (this.#operationRealtime === undefined) {
      throw new ClientSyncError(
        'client.remote_realtime_unconfigured',
        'SyncRemoteClient has no remote operation realtime connector',
      );
    }
    const watchId = crypto.randomUUID();
    this.#watches.set(watchId, {
      operationId: descriptor.id,
      mapRow: descriptor.mapRow,
      handlers: handlers as RemoteQueryWatchHandlers<unknown>,
    });
    let socket: RemoteOperationRealtimeSocket;
    try {
      socket = await this.#operationRealtimeSocket();
    } catch (error) {
      this.#watches.delete(watchId);
      throw error;
    }
    if (!this.#watches.has(watchId)) {
      throw new ClientSyncError(
        'client.remote_realtime_cancelled',
        'remote operation watch was cancelled before registration',
      );
    }
    try {
      socket.send(
        encodeRemoteOperationRealtimeMessage({
          revision: 1,
          kind: 'watch',
          watchId,
          clientId: this.#clientId,
          operationId: descriptor.id,
          params: params ?? null,
        }),
      );
    } catch {
      const error = new ClientSyncError(
        'client.remote_realtime_closed',
        'remote operation realtime connection closed while registering a watch',
        true,
      );
      this.#disconnectOperationRealtime(
        this.#operationSocketGeneration,
        error,
        true,
      );
      throw error;
    }
    return () => {
      if (!this.#watches.delete(watchId)) return;
      try {
        this.#operationSocket?.send(
          encodeRemoteOperationRealtimeMessage({
            revision: 1,
            kind: 'unwatch',
            watchId,
          }),
        );
      } catch {
        this.#disconnectOperationRealtime(
          this.#operationSocketGeneration,
          new ClientSyncError(
            'client.remote_realtime_closed',
            'remote operation realtime connection closed while removing a watch',
            true,
          ),
          true,
        );
      }
    };
  }

  async #operationRealtimeSocket(): Promise<RemoteOperationRealtimeSocket> {
    if (this.#operationSocket !== undefined) return this.#operationSocket;
    if (this.#operationSocketPromise !== undefined) {
      return this.#operationSocketPromise;
    }
    const connector = this.#operationRealtime;
    if (connector === undefined) {
      throw new ClientSyncError(
        'client.remote_realtime_unconfigured',
        'SyncRemoteClient has no remote operation realtime connector',
      );
    }
    const generation = this.#operationSocketGeneration;
    const pending = Promise.resolve(
      connector({
        onMessage: (bytes) => {
          if (generation !== this.#operationSocketGeneration) return;
          let message;
          try {
            message = decodeRemoteOperationRealtimeMessage(bytes);
            if (
              typeof message !== 'object' ||
              message === null ||
              message.revision !== 1 ||
              (message.kind !== 'snapshot' && message.kind !== 'watch_error') ||
              typeof message.watchId !== 'string'
            ) {
              throw new Error('invalid remote operation realtime message');
            }
          } catch {
            this.#disconnectOperationRealtime(
              generation,
              new ClientSyncError(
                'client.invalid_host_response',
                'remote operation realtime message is malformed',
              ),
              true,
            );
            return;
          }
          const watch = this.#watches.get(message.watchId);
          if (watch === undefined) return;
          if (message.kind === 'watch_error') {
            if (
              typeof message.code !== 'string' ||
              typeof message.message !== 'string' ||
              typeof message.retryable !== 'boolean'
            ) {
              this.#disconnectOperationRealtime(
                generation,
                new ClientSyncError(
                  'client.invalid_host_response',
                  'remote operation watch error is malformed',
                ),
                true,
              );
              return;
            }
            try {
              watch.handlers.onError?.(
                new ClientSyncError(
                  message.code,
                  message.message,
                  message.retryable,
                ),
              );
            } catch {
              // An observer cannot alter the connection lifecycle.
            }
            return;
          }
          if (
            message.operationId !== watch.operationId ||
            !Array.isArray(message.rows) ||
            message.rows.some(
              (row) =>
                typeof row !== 'object' || row === null || Array.isArray(row),
            ) ||
            !Number.isSafeInteger(message.maxCommitSeq) ||
            message.maxCommitSeq < 0
          ) {
            this.#disconnectOperationRealtime(
              generation,
              new ClientSyncError(
                'client.invalid_host_response',
                'remote operation watch snapshot is malformed',
              ),
              true,
            );
            return;
          }
          let rows: unknown[];
          try {
            rows = message.rows.map(watch.mapRow);
          } catch {
            try {
              watch.handlers.onError?.(
                new ClientSyncError(
                  'client.invalid_host_response',
                  'remote operation watch row is malformed',
                ),
              );
            } catch {
              // An observer cannot alter the connection lifecycle.
            }
            return;
          }
          try {
            watch.handlers.onSnapshot({
              rows,
              maxCommitSeq: message.maxCommitSeq,
            });
          } catch {
            // An observer cannot alter the connection lifecycle.
          }
        },
        onClose: () => {
          this.#disconnectOperationRealtime(
            generation,
            new ClientSyncError(
              'client.remote_realtime_closed',
              'remote operation realtime connection closed',
              true,
            ),
            false,
          );
        },
      }),
    )
      .then((socket) => {
        if (generation !== this.#operationSocketGeneration) {
          try {
            socket.close();
          } catch {
            // The cancelled socket cannot affect the replacement generation.
          }
          throw new ClientSyncError(
            'client.remote_realtime_cancelled',
            'remote operation realtime connection was cancelled',
          );
        }
        this.#operationSocket = socket;
        return socket;
      })
      .finally(() => {
        if (this.#operationSocketPromise === pending) {
          this.#operationSocketPromise = undefined;
        }
      });
    this.#operationSocketPromise = pending;
    return pending;
  }

  #disconnectOperationRealtime(
    generation: number,
    error: ClientSyncError | undefined,
    closeSocket: boolean,
  ): void {
    if (generation !== this.#operationSocketGeneration) return;
    this.#operationSocketGeneration += 1;
    const socket = this.#operationSocket;
    this.#operationSocket = undefined;
    this.#operationSocketPromise = undefined;
    const watches = [...this.#watches.values()];
    this.#watches.clear();
    if (closeSocket) {
      try {
        socket?.close();
      } catch {
        // Local state is already disconnected.
      }
    }
    if (error === undefined) return;
    for (const watch of watches) {
      try {
        watch.handlers.onError?.(error);
      } catch {
        // An observer cannot alter the connection lifecycle.
      }
    }
  }

  close(): void {
    this.#disconnectOperationRealtime(
      this.#operationSocketGeneration,
      undefined,
      true,
    );
  }
}
