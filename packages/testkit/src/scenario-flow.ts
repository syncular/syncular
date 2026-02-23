import {
  type ClientHandlerCollection,
  enqueueOutboxCommit,
  type SyncClientDb,
  type SyncOnceOptions,
  type SyncOnceResult,
  type SyncPullOnceOptions,
  type SyncPullResponse,
  type SyncPushOnceOptions,
  type SyncPushOnceResult,
  syncOnce,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import type {
  SyncCombinedRequest,
  SyncCombinedResponse,
  SyncTransport,
} from '@syncular/core';
import type { Kysely } from 'kysely';

export interface ScenarioFlowClient<DB extends SyncClientDb> {
  db: Kysely<DB>;
  transport: SyncTransport;
  handlers: ClientHandlerCollection<DB>;
  clientId: string;
  actorId?: string;
}

export interface PushThenPullOptions<DB extends SyncClientDb> {
  enqueue?: Parameters<typeof enqueueOutboxCommit<DB>>[1];
  push?: Omit<SyncPushOnceOptions, 'clientId' | 'actorId'>;
  pull: Omit<SyncPullOnceOptions, 'clientId' | 'actorId'>;
}

export interface PushThenPullResult<DB extends SyncClientDb> {
  enqueueResult?: { id: string; clientCommitId: string };
  pushResult: SyncPushOnceResult;
  pullResult: SyncPullResponse;
  client: ScenarioFlowClient<DB>;
}

export interface ScenarioFlow<DB extends SyncClientDb> {
  client: ScenarioFlowClient<DB>;
  enqueue: (
    args: Parameters<typeof enqueueOutboxCommit<DB>>[1]
  ) => Promise<{ id: string; clientCommitId: string }>;
  push: (
    options?: Omit<SyncPushOnceOptions, 'clientId' | 'actorId'>
  ) => Promise<SyncPushOnceResult>;
  pull: (
    options: Omit<SyncPullOnceOptions, 'clientId' | 'actorId'>
  ) => Promise<SyncPullResponse>;
  sync: (
    options: Omit<SyncOnceOptions, 'clientId' | 'actorId'>
  ) => Promise<SyncOnceResult>;
  transportSync: (
    request: Omit<SyncCombinedRequest, 'clientId'>
  ) => Promise<SyncCombinedResponse>;
  pushThenPull: (
    options: PushThenPullOptions<DB>
  ) => Promise<PushThenPullResult<DB>>;
}

function withClientIdentity<
  DB extends SyncClientDb,
  T extends Record<string, unknown>,
>(
  values: T,
  client: ScenarioFlowClient<DB>
): T & { clientId: string; actorId?: string } {
  return {
    ...values,
    clientId: client.clientId,
    ...(client.actorId ? { actorId: client.actorId } : {}),
  };
}

export function createScenarioFlow<DB extends SyncClientDb>(
  client: ScenarioFlowClient<DB>
): ScenarioFlow<DB> {
  const enqueue: ScenarioFlow<DB>['enqueue'] = (args) =>
    enqueueOutboxCommit(client.db, args);

  const push: ScenarioFlow<DB>['push'] = (options) =>
    syncPushOnce(
      client.db,
      client.transport,
      withClientIdentity(options ?? {}, client)
    );

  const pull: ScenarioFlow<DB>['pull'] = (options) =>
    syncPullOnce(
      client.db,
      client.transport,
      client.handlers,
      withClientIdentity(options, client)
    );

  const sync: ScenarioFlow<DB>['sync'] = (options) =>
    syncOnce(
      client.db,
      client.transport,
      client.handlers,
      withClientIdentity(options, client)
    );

  const transportSync: ScenarioFlow<DB>['transportSync'] = (request) =>
    client.transport.sync({ clientId: client.clientId, ...request });

  const pushThenPull: ScenarioFlow<DB>['pushThenPull'] = async (options) => {
    const enqueueResult = options.enqueue
      ? await enqueueOutboxCommit(client.db, options.enqueue)
      : undefined;

    const pushResult = await push(options.push);
    const pullResult = await pull(options.pull);

    return {
      enqueueResult,
      pushResult,
      pullResult,
      client,
    };
  };

  return {
    client,
    enqueue,
    push,
    pull,
    sync,
    transportSync,
    pushThenPull,
  };
}

export async function runPushPullCycle<DB extends SyncClientDb>(
  client: ScenarioFlowClient<DB>,
  options: PushThenPullOptions<DB>
): Promise<PushThenPullResult<DB>> {
  return createScenarioFlow(client).pushThenPull(options);
}
