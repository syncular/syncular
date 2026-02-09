/**
 * Relations scenario - Tests parent-child (projects+tasks) sync over HTTP
 */

import { expect } from 'bun:test';
import {
  enqueueOutboxCommit,
  syncPullOnce,
  syncPushOnce,
} from '@syncular/client';
import type { ScenarioContext } from '../harness/types';

export async function runRelationsScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  const subP1 = {
    id: 'sub-projects-p1',
    table: 'projects',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };
  const subTasksP1 = {
    id: 'sub-tasks-p1',
    table: 'tasks',
    scopes: { user_id: ctx.userId, project_id: 'p1' },
  };

  // Seed server with project and tasks
  await server.db
    .insertInto('projects')
    .values({
      id: 'p1',
      name: 'Project 1',
      owner_id: ctx.userId,
      server_version: 1,
    })
    .execute();

  await server.db
    .insertInto('tasks')
    .values([
      {
        id: 't1',
        title: 'Task 1',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
      {
        id: 't2',
        title: 'Task 2',
        completed: 0,
        user_id: ctx.userId,
        project_id: 'p1',
        server_version: 1,
      },
    ])
    .execute();

  // Bootstrap both
  const res = await syncPullOnce(client.db, client.transport, client.handlers, {
    clientId: client.clientId,
    subscriptions: [subP1, subTasksP1],
  });

  expect(
    res.subscriptions.find((s) => s.id === 'sub-projects-p1')?.bootstrap
  ).toBe(true);
  expect(
    res.subscriptions.find((s) => s.id === 'sub-tasks-p1')?.bootstrap
  ).toBe(true);

  // Verify projects synced
  const projects = await client.db.selectFrom('projects').selectAll().execute();
  expect(projects.length).toBe(1);
  expect(projects[0]?.id).toBe('p1');
  expect(projects[0]?.name).toBe('Project 1');

  // Verify tasks synced
  const tasks = await client.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(tasks.length).toBe(2);
  expect(tasks.map((t) => t.id)).toEqual(['t1', 't2']);

  // Create related entities in a single commit
  await enqueueOutboxCommit(client.db, {
    schemaVersion: 1,
    operations: [
      {
        table: 'tasks',
        row_id: 't3',
        op: 'upsert',
        payload: { title: 'Task 3', completed: 0, project_id: 'p1' },
        base_version: null,
      },
    ],
  });

  const pushRes = await syncPushOnce(client.db, client.transport, {
    clientId: client.clientId,
  });
  expect(pushRes.response?.status).toBe('applied');

  // Pull incremental
  const incRes = await syncPullOnce(
    client.db,
    client.transport,
    client.handlers,
    {
      clientId: client.clientId,
      subscriptions: [subP1, subTasksP1],
    }
  );

  expect(
    incRes.subscriptions.find((s) => s.id === 'sub-tasks-p1')?.bootstrap
  ).toBe(false);

  const updatedTasks = await client.db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('id', 'asc')
    .execute();
  expect(updatedTasks.length).toBe(3);
  expect(updatedTasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
}

export async function runCascadeConstraintScenario(
  ctx: ScenarioContext
): Promise<void> {
  const { server } = ctx;
  const client = ctx.clients[0]!;

  // Seed a project with tasks
  await server.db
    .insertInto('projects')
    .values({
      id: 'p1',
      name: 'Project 1',
      owner_id: ctx.userId,
      server_version: 1,
    })
    .execute();

  await server.db
    .insertInto('tasks')
    .values({
      id: 't1',
      title: 'Task 1',
      completed: 0,
      user_id: ctx.userId,
      project_id: 'p1',
      server_version: 1,
    })
    .execute();

  // Try to delete project that has tasks - should fail
  await enqueueOutboxCommit(client.db, {
    schemaVersion: 1,
    operations: [
      {
        table: 'projects',
        row_id: 'p1',
        op: 'delete',
        payload: {},
        base_version: null,
      },
    ],
  });

  const pushRes = await syncPushOnce(client.db, client.transport, {
    clientId: client.clientId,
  });
  expect(pushRes.response?.status).toBe('rejected');
}
