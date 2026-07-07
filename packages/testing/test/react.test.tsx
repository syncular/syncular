/**
 * The React helper: `syncWrapper` mounts a Syncular hook against a test
 * client and the hook re-runs when the test drives a mutation through the
 * real choke point. Proves the documented mounting pattern end to end.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ClientSchema } from '@syncular/client';
import { useRawSql } from '@syncular/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createTestSync, type TestSync } from '../src/index';
import { syncWrapper } from '../src/react';
import { installHappyDom } from './setup';

installHappyDom();

const SCHEMA: ClientSchema = {
  version: 1,
  tables: [
    {
      name: 'notes',
      columns: [
        { name: 'id', type: 'string', nullable: false },
        { name: 'list_id', type: 'string', nullable: false },
        { name: 'body', type: 'string', nullable: false },
      ],
      primaryKey: 'id',
      scopes: ['list:{list_id}'],
    },
  ],
};

let sync: TestSync | undefined;
afterEach(async () => {
  await sync?.dispose();
  sync = undefined;
  document.body.innerHTML = '';
});

describe('syncWrapper', () => {
  test('a hook mounted against a test client re-runs on a local mutate', async () => {
    sync = await createTestSync({ schema: SCHEMA });
    const client = await sync.client('a');
    client.api.subscribe({
      id: 's',
      table: 'notes',
      scopes: { list_id: ['x'] },
    });
    await client.sync();

    const { result } = renderHook(
      () => useRawSql('SELECT id, body FROM notes ORDER BY id'),
      { wrapper: syncWrapper(client) },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toHaveLength(0);

    await act(async () => {
      client.api.mutate([
        {
          table: 'notes',
          op: 'upsert',
          values: { id: 'n1', list_id: 'x', body: 'hi' },
        },
      ]);
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect((result.current.rows[0] as { body: string }).body).toBe('hi');
  });
});
