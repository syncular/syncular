/**
 * Integration feature tests - Specialized scenarios x single combo
 *
 * Tests advanced sync features (subscriptions, compaction, relations,
 * e2ee, proxy) over real HTTP transport using pglite+bun-sqlite.
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
  runActorIsolation,
  runCrossScopePullRejected,
  runNarrowedScopes,
  runPushToUnauthorizedScope,
} from '../scenarios/auth-enforcement.scenario';
import {
  runCompactionPullScenario,
  runCompactionScenario,
  runPruneByAgeScenario,
} from '../scenarios/compaction.scenario';
import { runE2eeScenario } from '../scenarios/e2ee.scenario';
import {
  runOfflineWithConcurrentChanges,
  runOfflineWritesSyncOnReconnect,
  runOutboxRetryAfterFailure,
} from '../scenarios/offline-resilience.scenario';
import { runProxyScenario } from '../scenarios/proxy.scenario';
import {
  runCascadeConstraintScenario,
  runRelationsScenario,
} from '../scenarios/relations.scenario';
import { runSnapshotChunksScenario } from '../scenarios/snapshot-chunks.scenario';
import {
  runAddSubscriptionScenario,
  runCursorAheadScenario,
  runDedupeScenario,
  runForcedBootstrapAfterPruneScenario,
  runSubscriptionScenario,
} from '../scenarios/subscription.scenario';

// Feature tests run against a single combo (pglite server + bun-sqlite client)
const serverDialect = 'pglite' as const;
const clientDialect = 'bun-sqlite' as const;

describe('integration: features', () => {
  let server: IntegrationServer;
  let clients: IntegrationClient[];
  const userId = 'test-user';
  const clientId = 'test-client';

  beforeEach(async () => {
    server = await createIntegrationServer(serverDialect);
    clients = [];

    // Create initial client
    const client = await createIntegrationClient(clientDialect, server, {
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
      const client = await createIntegrationClient(clientDialect, server, {
        actorId: opts?.actorId ?? userId,
        clientId: opts?.clientId ?? `client-${clients.length}`,
      });
      clients.push(client);
      return client;
    },
  });

  // Subscription scenarios
  describe('subscriptions', () => {
    it('bootstraps, pushes, pulls with scope isolation', async () => {
      await runSubscriptionScenario(getCtx());
    });

    it('adds subscription without resetting existing', async () => {
      await runAddSubscriptionScenario(getCtx());
    });

    it('dedupes hot rows in incremental pulls', async () => {
      await runDedupeScenario(getCtx());
    });

    it('forces bootstrap after prune', async () => {
      await runForcedBootstrapAfterPruneScenario(getCtx());
    });

    it('forces bootstrap when cursor is ahead of server', async () => {
      await runCursorAheadScenario(getCtx());
    });
  });

  // Compaction scenarios
  describe('compaction', () => {
    it('compacts intermediate history for old commits', async () => {
      await runCompactionScenario(getCtx());
    });

    it('pull advances past compacted empty commits', async () => {
      await runCompactionPullScenario(getCtx());
    });

    it('prunes by age even if watermark is stuck', async () => {
      await runPruneByAgeScenario(getCtx());
    });
  });

  // Snapshot chunks
  describe('snapshot chunks', () => {
    it('bootstraps via snapshot chunks over HTTP', async () => {
      await runSnapshotChunksScenario(getCtx());
    });
  });

  // Relations
  describe('relations', () => {
    it('syncs parent-child entities (projects+tasks)', async () => {
      await runRelationsScenario(getCtx());
    });

    it('enforces cascade constraints', async () => {
      await runCascadeConstraintScenario(getCtx());
    });
  });

  // E2EE
  describe('e2ee', () => {
    it('encrypts on push and decrypts on pull', async () => {
      await runE2eeScenario(getCtx());
    });
  });

  // Proxy
  describe('proxy', () => {
    it('detects mutations and executes proxy queries', async () => {
      await runProxyScenario(getCtx());
    });
  });

  // Offline resilience
  describe('offline resilience', () => {
    it('offline writes sync on reconnect', async () => {
      await runOfflineWritesSyncOnReconnect(getCtx());
    });

    it('offline writes with concurrent server changes', async () => {
      await runOfflineWithConcurrentChanges(getCtx());
    });

    it('outbox retries after failure', async () => {
      await runOutboxRetryAfterFailure(getCtx());
    });
  });

  // Auth enforcement
  describe('auth enforcement', () => {
    it('cross-scope pull returns only authorized data', async () => {
      await runCrossScopePullRejected(getCtx());
    });

    it('narrowed scopes filter correctly', async () => {
      await runNarrowedScopes(getCtx());
    });

    it('push to unauthorized scope is isolated', async () => {
      await runPushToUnauthorizedScope(getCtx());
    });

    it('different actors have isolated data views', async () => {
      await runActorIsolation(getCtx());
    });
  });
});
