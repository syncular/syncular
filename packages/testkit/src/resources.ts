import type { SyncClientDb } from '@syncular/client';
import type { SyncCoreDb } from '@syncular/server';
import {
  type AsyncDisposableResource,
  createAsyncDisposableResource,
  type ResourceRunner,
  withAsyncDisposableFactory,
} from './disposable';
import {
  type CreateEngineTestClientOptions,
  type CreateSyncFixtureOptions,
  type CreateTestClientOptions,
  createEngineTestClient,
  createSyncFixture,
  createTestClient,
  createTestServer,
  createTestSqliteServer,
  type EngineTestClient,
  type ServerDialect,
  type SyncFixture,
  type TestClient,
  type TestClientDialect,
  type TestServer,
  type TestSqliteDbDialect,
} from './fixtures';
import {
  type CreateHttpClientFixtureOptions,
  type CreateHttpServerFixtureOptions,
  createHttpClientFixture,
  createHttpServerFixture,
  type HttpClientFixture,
  type HttpServerFixture,
} from './http-fixtures';

export async function createTestServerResource(
  serverDialect: ServerDialect
): Promise<AsyncDisposableResource<TestServer>> {
  const server = await createTestServer(serverDialect);
  return createAsyncDisposableResource(server, () => server.destroy());
}

export async function withTestServer<TResult>(
  serverDialect: ServerDialect,
  run: ResourceRunner<TestServer, TResult>
): Promise<TResult> {
  return withAsyncDisposableFactory(
    () => createTestServerResource(serverDialect),
    run
  );
}

export async function createTestSqliteServerResource(
  dialect: TestSqliteDbDialect
): Promise<AsyncDisposableResource<TestServer>> {
  const server = await createTestSqliteServer(dialect);
  return createAsyncDisposableResource(server, () => server.destroy());
}

export async function withTestSqliteServer<TResult>(
  dialect: TestSqliteDbDialect,
  run: ResourceRunner<TestServer, TResult>
): Promise<TResult> {
  return withAsyncDisposableFactory(
    () => createTestSqliteServerResource(dialect),
    run
  );
}

export async function createTestClientResource(
  clientDialect: TestClientDialect,
  server: TestServer,
  options: CreateTestClientOptions
): Promise<AsyncDisposableResource<TestClient>> {
  const client = await createTestClient(clientDialect, server, options);
  return createAsyncDisposableResource(client, () => client.destroy());
}

export async function withTestClient<TResult>(
  clientDialect: TestClientDialect,
  server: TestServer,
  options: CreateTestClientOptions,
  run: ResourceRunner<TestClient, TResult>
): Promise<TResult> {
  return withAsyncDisposableFactory(
    () => createTestClientResource(clientDialect, server, options),
    run
  );
}

export async function createEngineTestClientResource(
  server: TestServer,
  options: CreateEngineTestClientOptions
): Promise<AsyncDisposableResource<EngineTestClient>> {
  const client = await createEngineTestClient(server, options);
  return createAsyncDisposableResource(client, () => client.destroy());
}

export async function withEngineTestClient<TResult>(
  server: TestServer,
  options: CreateEngineTestClientOptions,
  run: ResourceRunner<EngineTestClient, TResult>
): Promise<TResult> {
  return withAsyncDisposableFactory(
    () => createEngineTestClientResource(server, options),
    run
  );
}

export async function createSyncFixtureResource(
  options: CreateSyncFixtureOptions
): Promise<AsyncDisposableResource<SyncFixture>> {
  const fixture = await createSyncFixture(options);
  return createAsyncDisposableResource(fixture, () => fixture.destroyAll());
}

export async function withSyncFixture<TResult>(
  options: CreateSyncFixtureOptions,
  run: ResourceRunner<SyncFixture, TResult>
): Promise<TResult> {
  return withAsyncDisposableFactory(
    () => createSyncFixtureResource(options),
    run
  );
}

export async function createHttpServerFixtureResource<DB extends SyncCoreDb>(
  options: CreateHttpServerFixtureOptions<DB>
): Promise<AsyncDisposableResource<HttpServerFixture<DB>>> {
  const fixture = await createHttpServerFixture(options);
  return createAsyncDisposableResource(fixture, () => fixture.destroy());
}

export async function withHttpServerFixture<DB extends SyncCoreDb, TResult>(
  options: CreateHttpServerFixtureOptions<DB>,
  run: ResourceRunner<HttpServerFixture<DB>, TResult>
): Promise<TResult> {
  return withAsyncDisposableFactory(
    () => createHttpServerFixtureResource(options),
    run
  );
}

export async function createHttpClientFixtureResource<DB extends SyncClientDb>(
  options: CreateHttpClientFixtureOptions<DB>
): Promise<AsyncDisposableResource<HttpClientFixture<DB>>> {
  const fixture = await createHttpClientFixture(options);
  return createAsyncDisposableResource(fixture, () => fixture.destroy());
}

export async function withHttpClientFixture<DB extends SyncClientDb, TResult>(
  options: CreateHttpClientFixtureOptions<DB>,
  run: ResourceRunner<HttpClientFixture<DB>, TResult>
): Promise<TResult> {
  return withAsyncDisposableFactory(
    () => createHttpClientFixtureResource(options),
    run
  );
}

export interface EngineSessionResourceOptions {
  start?: boolean;
}

export async function createEngineSessionResource(
  client: EngineTestClient,
  options: EngineSessionResourceOptions = {}
): Promise<AsyncDisposableResource<EngineTestClient>> {
  if (options.start ?? true) {
    await client.startEngine();
  }

  return createAsyncDisposableResource(client, () => {
    client.stopEngine();
  });
}

export async function withEngineSession<TResult>(
  client: EngineTestClient,
  run: ResourceRunner<EngineTestClient, TResult>,
  options: EngineSessionResourceOptions = {}
): Promise<TResult> {
  return withAsyncDisposableFactory(
    () => createEngineSessionResource(client, options),
    run
  );
}
