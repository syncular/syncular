/**
 * Integration load tests - Extreme load scenarios.
 *
 * Run with: bun --cwd tests/integration test __tests__/load.test.ts
 */

import { afterEach, beforeEach, describe, it } from 'bun:test';
import {
  createIntegrationClient,
  createIntegrationServer,
  type IntegrationClient,
  type IntegrationServer,
  type ScenarioContext,
} from '../harness';
import {
  runExtremeLoadScenario,
  runIdempotencyScenario,
  runParallelPushScenario,
} from '../scenarios/extreme-load.scenario';

describe('integration: load', () => {
  let server: IntegrationServer;
  let clients: IntegrationClient[];
  const userId = 'test-user';
  const clientId = 'test-client';

  beforeEach(async () => {
    server = await createIntegrationServer('pglite');
    clients = [];

    const client = await createIntegrationClient('bun-sqlite', server, {
      actorId: userId,
      clientId,
    });
    clients.push(client);
  });

  afterEach(async () => {
    for (const client of clients) {
      await client.destroy();
    }
    await server.destroy();
  });

  const getCtx = (): ScenarioContext => ({
    server,
    clients,
    userId,
    clientId,
    createClient: async (opts) => {
      const client = await createIntegrationClient('bun-sqlite', server, {
        actorId: opts?.actorId ?? userId,
        clientId: opts?.clientId ?? `client-${clients.length}`,
      });
      clients.push(client);
      return client;
    },
  });

  it('bootstraps 10K rows over HTTP', async () => {
    await runExtremeLoadScenario(getCtx());
  }, 120_000);

  it('handles 10 clients pushing 100 commits each in parallel', async () => {
    await runParallelPushScenario(getCtx());
  }, 60_000);

  it('handles 100 retries of same commit (idempotency)', async () => {
    await runIdempotencyScenario(getCtx());
  });
});
