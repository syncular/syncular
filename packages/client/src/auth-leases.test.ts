import { describe, expect, it } from 'bun:test';
import { issueSyncularAuthLease } from './auth-leases';
import type { SyncularAppSchema } from './types';

describe('Syncular auth leases', () => {
  it('validates auth lease scopes against generated app schema before fetch', async () => {
    let fetchCount = 0;
    await expect(
      issueSyncularAuthLease({
        baseUrl: 'https://example.test/sync',
        headers: {},
        appSchema: authLeaseAppSchema,
        fetchImpl: (async () => {
          fetchCount += 1;
          return Response.json({});
        }) as typeof fetch,
        request: {
          schemaVersion: 8,
          scopes: [
            {
              subscriptionId: 'sub-notes',
              table: 'notes',
              values: { user_id: 'user-rust' },
              operations: ['upsert'],
            },
          ],
        },
      })
    ).rejects.toThrow('unknown generated table notes');
    expect(fetchCount).toBe(0);
  });

  it('validates auth lease responses against generated app schema before storing', async () => {
    await expect(
      issueSyncularAuthLease({
        baseUrl: 'https://example.test/sync',
        headers: {},
        appSchema: authLeaseAppSchema,
        fetchImpl: (async () =>
          Response.json({
            ok: true,
            token: 'signed-token',
            protectedHeader: {
              alg: 'ES256',
              kid: 'lease-key',
              typ: 'syncular-auth-lease+jws',
            },
            payload: {
              version: 1,
              leaseId: 'lease-1',
              issuer: 'syncular-test',
              audience: 'browser',
              actorId: 'user-rust',
              subject: {},
              schemaVersion: 7,
              protocolVersion: 1,
              issuedAtMs: 1,
              notBeforeMs: 1,
              expiresAtMs: 60_001,
              maxClockSkewMs: 30_000,
              scopes: [
                {
                  subscriptionId: 'sub-tasks',
                  table: 'tasks',
                  values: { user_id: 'user-rust' },
                  operations: ['upsert'],
                },
              ],
              capabilities: {
                allowBlobs: false,
                allowCrdt: false,
                allowEncryptedFields: false,
              },
            },
          })) as typeof fetch,
        request: {
          schemaVersion: 8,
          scopes: [
            {
              subscriptionId: 'sub-tasks',
              table: 'tasks',
              values: { user_id: 'user-rust' },
              operations: ['upsert'],
            },
          ],
        },
      })
    ).rejects.toThrow(
      'auth lease response schemaVersion 7 does not match request schemaVersion 8'
    );
  });

  it('requires generated required scopes in auth lease requests', async () => {
    let fetchCount = 0;
    await expect(
      issueSyncularAuthLease({
        baseUrl: 'https://example.test/sync',
        headers: {},
        appSchema: authLeaseAppSchema,
        fetchImpl: (async () => {
          fetchCount += 1;
          return Response.json({});
        }) as typeof fetch,
        request: {
          schemaVersion: 8,
          scopes: [
            {
              subscriptionId: 'sub-tasks',
              table: 'tasks',
              values: {},
              operations: ['upsert'],
            },
          ],
        },
      })
    ).rejects.toThrow('missing required generated scope user_id');
    expect(fetchCount).toBe(0);
  });
});

const authLeaseAppSchema: SyncularAppSchema = {
  schemaVersion: 8,
  migrations: [],
  tables: [
    {
      name: 'tasks',
      primaryKeyColumn: 'id',
      serverVersionColumn: 'server_version',
      softDeleteColumn: null,
      subscriptionId: 'sub-tasks',
      columns: [
        {
          name: 'id',
          typeFamily: 'text',
          notnullRequired: true,
          primaryKey: true,
        },
        {
          name: 'user_id',
          typeFamily: 'text',
          notnullRequired: true,
          primaryKey: false,
        },
        {
          name: 'server_version',
          typeFamily: 'integer',
          notnullRequired: true,
          primaryKey: false,
        },
      ],
      blobColumns: [],
      crdtYjsFields: [],
      encryptedFields: [],
      scopes: [
        {
          name: 'user_id',
          column: 'user_id',
          source: 'actorId',
          required: true,
        },
      ],
    },
  ],
};
