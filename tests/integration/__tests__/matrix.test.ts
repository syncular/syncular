/**
 * Integration matrix tests - Core scenarios x all dialect combinations
 *
 * Tests fundamental sync operations over real HTTP transport across
 * all supported server/client dialect combinations.
 */

import { afterEach, beforeEach, describe, it } from 'bun:test';
import {
  createIntegrationClient,
  createIntegrationServer,
  getQuickCombinations,
  type IntegrationClient,
  type IntegrationServer,
  matrixCombinations,
  type ScenarioContext,
} from '../harness';
import { runBootstrapScenario } from '../scenarios/bootstrap.scenario';
import { runConflictScenario } from '../scenarios/conflict.scenario';
import { runLargeDatasetScenario } from '../scenarios/large-dataset.scenario';
import { runPushPullScenario } from '../scenarios/push-pull.scenario';

const combinations =
  process.env.MATRIX_FULL === 'true'
    ? matrixCombinations
    : getQuickCombinations();

describe('integration: matrix', () => {
  for (const combo of combinations) {
    describe(combo.name, () => {
      let server: IntegrationServer;
      let clients: IntegrationClient[];
      const userId = 'test-user';
      const clientId = 'test-client';

      beforeEach(async () => {
        server = await createIntegrationServer(combo.serverDialect);
        clients = [];

        const createClient = async (opts?: {
          actorId?: string;
          clientId?: string;
        }) => {
          const client = await createIntegrationClient(
            combo.clientDialect,
            server,
            {
              actorId: opts?.actorId ?? userId,
              clientId: opts?.clientId ?? `client-${clients.length}`,
            }
          );
          clients.push(client);
          return client;
        };

        // Create initial client
        await createClient({ actorId: userId, clientId });
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
          const client = await createIntegrationClient(
            combo.clientDialect,
            server,
            {
              actorId: opts?.actorId ?? userId,
              clientId: opts?.clientId ?? `client-${clients.length}`,
            }
          );
          clients.push(client);
          return client;
        },
      });

      it('bootstraps initial data over HTTP', async () => {
        await runBootstrapScenario(getCtx());
      });

      it('pushes and pulls changes over HTTP', async () => {
        await runPushPullScenario(getCtx());
      });

      it('detects conflicts over HTTP', async () => {
        await runConflictScenario(getCtx());
      });

      it('handles large datasets (1K rows) over HTTP', async () => {
        await runLargeDatasetScenario({ ...getCtx(), rowCount: 1000 });
      });
    });
  }
});
