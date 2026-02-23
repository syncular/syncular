/**
 * Proxy scenario - Tests mutation detection and proxy query execution
 */

import { expect } from 'bun:test';
import {
  createProxyHandlerCollection,
  detectMutation,
  executeProxyQuery,
} from '@syncular/server';
import type { ScenarioContext } from '../harness/types';

export async function runProxyScenario(ctx: ScenarioContext): Promise<void> {
  const { server } = ctx;

  // Test mutation detection
  const insertMutation = detectMutation(
    "INSERT INTO tasks (id, title, completed, user_id, project_id, server_version) VALUES ('proxy-1', 'Proxy Task', 0, 'u1', 'p1', 1)"
  );
  expect(insertMutation).toBeDefined();
  expect(insertMutation?.tableName).toBe('tasks');
  expect(insertMutation?.operation).toBe('upsert');

  const updateMutation = detectMutation(
    "UPDATE tasks SET title = 'Updated' WHERE id = 'proxy-1'"
  );
  expect(updateMutation).toBeDefined();
  expect(updateMutation?.tableName).toBe('tasks');
  expect(updateMutation?.operation).toBe('upsert');

  const deleteMutation = detectMutation(
    "DELETE FROM tasks WHERE id = 'proxy-1'"
  );
  expect(deleteMutation).toBeDefined();
  expect(deleteMutation?.tableName).toBe('tasks');
  expect(deleteMutation?.operation).toBe('delete');

  const selectMutation = detectMutation('SELECT * FROM tasks');
  expect(selectMutation).toBeNull();

  // Test proxy query execution
  const proxyHandlers = createProxyHandlerCollection([
    {
      table: 'tasks',
      computeScopes: (row) => ({
        user_id: String(row.user_id ?? ''),
        project_id: String(row.project_id ?? ''),
      }),
    },
  ]);

  const result = await executeProxyQuery({
    db: server.db,
    dialect: server.dialect,
    handlers: proxyHandlers,
    ctx: { actorId: ctx.userId, clientId: ctx.clientId },
    sqlQuery:
      "INSERT INTO tasks (id, title, completed, user_id, project_id, server_version) VALUES ('proxy-1', 'Proxy Task', 0, '" +
      ctx.userId +
      "', 'p1', 1)",
    parameters: [],
  });

  expect(result.rowCount).toBeGreaterThanOrEqual(1);

  // Verify the row exists
  const row = await server.db
    .selectFrom('tasks')
    .selectAll()
    .where('id', '=', 'proxy-1')
    .executeTakeFirst();
  expect(row).toBeDefined();
  expect(row?.title).toBe('Proxy Task');
}
