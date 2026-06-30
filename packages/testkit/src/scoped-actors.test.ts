import { describe, expect, it } from 'bun:test';
import { createHttpServerFixture } from './http-fixtures';
import {
  createProjectScopedTasksHandler,
  createProjectScopedTasksSubscription,
  createProjectScopedTaskUpsertOperation,
  ensureProjectScopedTasksTable,
  type ProjectScopedTasksDb,
} from './project-scoped-tasks';
import {
  createProjectMembership,
  createProjectScopedActorHeaders,
  createProjectScopedTestActor,
} from './scoped-actors';
import { createSyncCombinedRequest } from './sync-builders';
import { postSyncCombinedRequest } from './sync-http';

describe('project-scoped actor helpers', () => {
  it('creates deterministic actor headers and project membership maps', () => {
    const actor = createProjectScopedTestActor({
      actorId: 'user-a',
      projectId: 'campaign-a',
      partitionId: 'tenant-a',
    });
    const secondProject = createProjectScopedTestActor({
      actorId: 'user-a',
      projectId: 'campaign-b',
    });

    expect(createProjectScopedActorHeaders(actor)).toEqual({
      'x-actor-id': 'user-a',
      'x-project-id': 'campaign-a',
      'x-partition-id': 'tenant-a',
    });
    expect(createProjectMembership([actor, secondProject])).toEqual({
      'user-a': ['campaign-a', 'campaign-b'],
    });
  });

  it('denies project writes and pulls outside explicit membership', async () => {
    const actor = createProjectScopedTestActor({
      actorId: 'user-a',
      projectId: 'campaign-a',
    });
    const otherProject = createProjectScopedTestActor({
      actorId: 'user-b',
      projectId: 'campaign-b',
    });
    const server = await createHttpServerFixture<ProjectScopedTasksDb>({
      serverDialect: 'sqlite',
      createTables: ensureProjectScopedTasksTable,
      handlers: [
        createProjectScopedTasksHandler({
          projectsByActor: createProjectMembership([actor, otherProject]),
        }),
      ],
      authenticate: async (c) => {
        const actorId = c.req.header('x-actor-id');
        return actorId ? { actorId } : null;
      },
    });

    try {
      const allowed = await postSyncCombinedRequest({
        fetch,
        url: `${server.baseUrl}/sync`,
        actorId: actor.actorId,
        body: createSyncCombinedRequest({
          clientId: 'client-allowed',
          push: {
            commits: [
              {
                clientCommitId: 'commit-allowed',
                schemaVersion: 1,
                operations: [
                  createProjectScopedTaskUpsertOperation({
                    taskId: 'task-allowed',
                    title: 'Allowed',
                    projectId: actor.projectId,
                  }),
                ],
              },
            ],
          },
        }),
      });
      expect(allowed.json.push?.commits[0]?.results[0]).toMatchObject({
        status: 'applied',
      });

      const deniedWrite = await postSyncCombinedRequest({
        fetch,
        url: `${server.baseUrl}/sync`,
        actorId: actor.actorId,
        body: createSyncCombinedRequest({
          clientId: 'client-denied',
          push: {
            commits: [
              {
                clientCommitId: 'commit-denied',
                schemaVersion: 1,
                operations: [
                  createProjectScopedTaskUpsertOperation({
                    taskId: 'task-denied',
                    title: 'Denied',
                    projectId: otherProject.projectId,
                  }),
                ],
              },
            ],
          },
        }),
      });
      expect(deniedWrite.json.push?.commits[0]?.results[0]).toMatchObject({
        status: 'error',
        code: 'sync.forbidden',
      });

      const deniedPull = await postSyncCombinedRequest({
        fetch,
        url: `${server.baseUrl}/sync`,
        actorId: actor.actorId,
        body: createSyncCombinedRequest({
          clientId: 'client-pull-denied',
          pull: {
            schemaVersion: 1,
            limitCommits: 50,
            subscriptions: [
              createProjectScopedTasksSubscription({
                id: 'foreign-project',
                userId: actor.actorId,
                projectId: otherProject.projectId,
              }),
            ],
          },
        }),
      });
      expect(deniedPull.json.pull?.subscriptions[0]).toMatchObject({
        id: 'foreign-project',
        status: 'revoked',
      });
    } finally {
      await server.destroy();
    }
  });
});
