import { expect, test } from 'bun:test';
import { defineAuthorityReads } from '@syncular/client/authority';
import { createTauriSyncClient, type TauriApi } from '../src/index';
import { createTauriAuthoritySyncClient } from '../src/authority';

test('ordinary native bridge excludes the authority method; explicit bridge preserves decoding and preflight', async () => {
  const calls: string[] = [];
  const tauri: TauriApi = {
    invoke: async <T>(_command: string, args?: Record<string, unknown>) => {
      const request = args?.command as {
        method: string;
        params: Record<string, unknown>;
      };
      calls.push(request.method);
      return {
        result:
          request.method === 'authoritySnapshot'
            ? {
                revision: '7',
                complete: true,
                tables: [
                  {
                    table: 'authority',
                    rows: [
                      {
                        values: {
                          id: 'a',
                          flags: { $bigint: '42' },
                          _sync_version: 7,
                        },
                        version: 7,
                        hasLocalIntent: false,
                      },
                    ],
                  },
                ],
              }
            : {},
      } as T;
    },
    listen: async () => () => {},
  };
  const ordinary = await createTauriSyncClient({ schema: {}, tauri });
  expect('authoritySnapshot' in ordinary).toBe(false);
  await ordinary.close();
  const client = await createTauriAuthoritySyncClient({
    schema: {},
    tauri,
    securityPreflight: true,
    transportEnabled: false,
    authorityReads: defineAuthorityReads([
      { table: 'authority', columns: ['id'], scopes: { actor_id: ['a'] } },
    ]),
  });
  expect(await client.authoritySnapshot()).toMatchObject({
    revision: 7n,
    tables: [{ rows: [{ values: { id: 'a', flags: 42n } }] }],
  });
  await expect(client.query('SELECT id FROM authority')).rejects.toMatchObject({
    code: 'client.security_preflight_required',
  });
  await expect(
    Reflect.apply(client.authoritySnapshot, client, [{}]),
  ).rejects.toMatchObject({ code: 'client.authority_read_forbidden' });
  expect(calls.filter((method) => method === 'authoritySnapshot')).toHaveLength(
    1,
  );
  await client.close();
  await expect(client.authoritySnapshot()).rejects.toMatchObject({
    code: 'client.closed',
  });
});
