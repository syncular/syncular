import { expect, test } from 'bun:test';
import { defineAuthorityReads } from '@syncular/client/authority';
import { createTauriSyncClient, type TauriApi } from '../src/index';
import { createTauriAuthoritySyncClient } from '../src/authority';

test('ordinary native bridge excludes the authority method; explicit bridge decodes the read and keeps preflight', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const coverage = [
    {
      table: 'authority',
      base: { variable: 'actor_id' },
      unit: 'a',
      state: 'complete' as const,
    },
  ];
  const tauri: TauriApi = {
    invoke: async <T>(_command: string, args?: Record<string, unknown>) => {
      const request = args?.command as {
        method: string;
        params: Record<string, unknown>;
      };
      calls.push(request);
      return {
        result:
          request.method === 'authorityRead'
            ? {
                revision: '18446744073709551615',
                results: [
                  {
                    query: 'actorFlags',
                    rows: [{ id: 'a', flags: { $bigint: '42' } }],
                    coverage,
                    complete: true,
                  },
                ],
              }
            : {},
      } as T;
    },
    channel: () => ({ toJSON: () => '__CHANNEL__:1' }),
  };
  const ordinary = await createTauriSyncClient({ schema: {}, tauri });
  expect('authorityRead' in ordinary).toBe(false);
  await ordinary.close();
  const client = await createTauriAuthoritySyncClient({
    schema: {},
    tauri,
    securityPreflight: true,
    transportGate: 'closed',
    authorityReads: defineAuthorityReads([
      {
        name: 'actorFlags',
        sql: 'SELECT id, flags FROM authority WHERE actor_id = ?',
        bind: ['actorId'],
        params: [{ name: 'actorId', type: 'string', nullable: false }],
        coverage: [
          { table: 'authority', variable: 'actor_id', units: ['actorId'] },
        ],
        reads: { authority: ['actor_id', 'flags', 'id'] },
        resultColumns: [
          { name: 'id', type: 'string', nullable: false },
          { name: 'flags', type: 'integer', nullable: false },
        ],
      },
    ]),
  });
  expect(
    calls.find((call) => call.params?.authorityReads)?.params.authorityReads,
  ).toMatchObject([{ name: 'actorFlags', bind: ['actorId'] }]);
  const requests = [{ query: 'actorFlags', params: { actorId: 'a' } }];
  expect(await client.authorityRead(requests)).toEqual({
    revision: 18446744073709551615n,
    results: [
      {
        query: 'actorFlags',
        rows: [{ id: 'a', flags: 42n }],
        coverage,
        complete: true,
      },
    ],
  });
  expect(calls.at(-1)).toEqual({
    method: 'authorityRead',
    params: { requests },
  });
  await expect(client.query('SELECT id FROM authority')).rejects.toMatchObject({
    code: 'client.security_preflight_required',
  });
  await expect(
    Reflect.apply(client.authorityRead, client, [requests, {}]),
  ).rejects.toMatchObject({ code: 'client.authority_read_forbidden' });
  expect(calls.filter((call) => call.method === 'authorityRead')).toHaveLength(
    1,
  );
  await client.close();
  await expect(client.authorityRead(requests)).rejects.toMatchObject({
    code: 'client.closed',
  });
});
