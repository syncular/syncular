import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createDatabase,
  SyncAuthLeaseIssueResponseSchema,
} from '@syncular/core';
import {
  createServerHandler,
  createWebCryptoEs256AuthLeaseSigner,
  ensureSyncSchema,
  type SyncCoreDb,
  signAuthLeaseToken,
  verifyAuthLeaseToken,
} from '@syncular/server';
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createBunSqliteDialect } from '../../../dialect-bun-sqlite/src';
import { createSqliteServerDialect } from '../../../server-dialect-sqlite/src';
import { createSyncRoutes } from '../routes';

interface TasksTable {
  id: string;
  user_id: string;
  title: string;
  server_version: number;
}

interface ServerDb extends SyncCoreDb {
  tasks: TasksTable;
}

interface ClientDb {
  tasks: TasksTable;
}

describe('auth lease routes', () => {
  let db: Kysely<ServerDb>;
  let keyPair: CryptoKeyPair;
  const dialect = createSqliteServerDialect();
  const nowMs = 1_779_360_000_000;

  beforeEach(async () => {
    db = createDatabase<ServerDb>({
      dialect: createBunSqliteDialect({ path: ':memory:' }),
      family: 'sqlite',
    });
    await ensureSyncSchema(db, dialect);
    await db.schema
      .createTable('tasks')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('server_version', 'integer', (col) =>
        col.notNull().defaultTo(0)
      )
      .execute();

    keyPair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;
  });

  afterEach(async () => {
    await db.destroy();
  });

  function createApp() {
    const tasksHandler = createServerHandler<ServerDb, ClientDb, 'tasks'>({
      table: 'tasks',
      scopes: ['user:{user_id}'],
      resolveScopes: async (ctx) => ({ user_id: [ctx.actorId] }),
    });
    const routes = createSyncRoutes({
      db,
      dialect,
      handlers: [tasksHandler],
      authenticate: async (c) => {
        const actorId = c.req.header('x-user-id');
        return actorId ? { actorId } : null;
      },
      authLeases: {
        issuer: 'syncular-test-server',
        audience: 'syncular-test-app',
        kid: 'lease-key-1',
        signer: createWebCryptoEs256AuthLeaseSigner({
          privateKey: keyPair.privateKey,
        }),
        publicKey: keyPair.publicKey,
        ttlMs: 60_000,
        maxTtlMs: 120_000,
        maxClockSkewMs: 5_000,
        nowMs: () => nowMs,
        leaseId: () => 'lease-test-1',
        capabilities: {
          allowBlobs: true,
          allowCrdt: true,
          allowEncryptedFields: true,
        },
      },
    });

    const app = new Hono();
    app.route('/sync', routes);
    return app;
  }

  it('issues a signed lease for the current actor effective scopes only', async () => {
    const response = await createApp().request(
      'http://localhost/sync/auth-leases/issue',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': 'u1',
        },
        body: JSON.stringify({
          schemaVersion: 7,
          ttlMs: 90_000,
          scopes: [
            {
              subscriptionId: 'sub-tasks',
              table: 'tasks',
              values: { user_id: ['u1', 'u2'] },
              operations: ['upsert', 'delete'],
            },
          ],
        }),
      }
    );

    expect(response.status).toBe(200);
    const body = SyncAuthLeaseIssueResponseSchema.parse(await response.json());
    expect(body.protectedHeader).toEqual({
      alg: 'ES256',
      kid: 'lease-key-1',
      typ: 'syncular-auth-lease+jws',
    });
    expect(body.payload).toMatchObject({
      leaseId: 'lease-test-1',
      issuer: 'syncular-test-server',
      audience: 'syncular-test-app',
      actorId: 'u1',
      schemaVersion: 7,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 90_000,
    });
    expect(body.payload.scopes).toEqual([
      {
        subscriptionId: 'sub-tasks',
        table: 'tasks',
        values: { user_id: ['u1'] },
        operations: ['upsert', 'delete'],
      },
    ]);

    const verified = await verifyAuthLeaseToken({
      token: body.token,
      publicKey: keyPair.publicKey,
      nowMs,
      expectedIssuer: 'syncular-test-server',
      expectedAudience: 'syncular-test-app',
      expectedSchemaVersion: 7,
    });
    expect(verified).toMatchObject({
      ok: true,
      payload: { leaseId: 'lease-test-1' },
    });

    const expired = await verifyAuthLeaseToken({
      token: body.token,
      publicKey: keyPair.publicKey,
      nowMs: nowMs + 90_000 + 5_001,
    });
    expect(expired).toMatchObject({
      ok: false,
      code: 'sync.auth_lease_expired',
      leaseId: 'lease-test-1',
    });
  });

  it('keeps lease issuing behind normal request auth', async () => {
    const response = await createApp().request(
      'http://localhost/sync/auth-leases/issue',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 7,
          scopes: [
            {
              subscriptionId: 'sub-tasks',
              table: 'tasks',
              values: { user_id: 'u1' },
              operations: ['upsert'],
            },
          ],
        }),
      }
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: 'sync.auth_required',
      recommendedAction: 'refreshAuth',
    });
  });

  it('rejects lease requests with no currently allowed scope', async () => {
    const response = await createApp().request(
      'http://localhost/sync/auth-leases/issue',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': 'u1',
        },
        body: JSON.stringify({
          schemaVersion: 7,
          scopes: [
            {
              subscriptionId: 'sub-tasks',
              table: 'tasks',
              values: { user_id: 'u2' },
              operations: ['upsert'],
            },
          ],
        }),
      }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'sync.auth_lease_scope_mismatch',
      recommendedAction: 'checkPermissions',
    });
  });

  it('rejects malformed lease scope requests with a stable sync error', async () => {
    const response = await createApp().request(
      'http://localhost/sync/auth-leases/issue',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': 'u1',
        },
        body: JSON.stringify({
          schemaVersion: 7,
          scopes: [
            {
              subscriptionId: 'sub-unknown',
              table: 'unknown_table',
              values: { user_id: 'u1' },
              operations: ['upsert'],
            },
          ],
        }),
      }
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'sync.invalid_request',
      recommendedAction: 'fixRequest',
    });
  });

  it('rejects pushed leased commits when the signed lease is expired', async () => {
    const signed = await signAuthLeaseToken({
      kid: 'lease-key-1',
      signer: createWebCryptoEs256AuthLeaseSigner({
        privateKey: keyPair.privateKey,
      }),
      payload: {
        version: 1,
        leaseId: 'lease-expired',
        issuer: 'syncular-test-server',
        audience: 'syncular-test-app',
        actorId: 'u1',
        subject: {},
        schemaVersion: 7,
        protocolVersion: 1,
        issuedAtMs: nowMs - 120_000,
        notBeforeMs: nowMs - 120_000,
        expiresAtMs: nowMs - 5_001,
        maxClockSkewMs: 5_000,
        scopes: [
          {
            subscriptionId: 'sub-tasks',
            table: 'tasks',
            values: { user_id: 'u1' },
            operations: ['upsert'],
          },
        ],
        capabilities: {
          allowBlobs: true,
          allowCrdt: true,
          allowEncryptedFields: true,
        },
      },
    });

    const response = await createApp().request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': 'u1',
      },
      body: JSON.stringify({
        clientId: 'client-lease-replay',
        push: {
          commits: [
            {
              clientCommitId: 'commit-expired-lease',
              schemaVersion: 7,
              authLease: {
                leaseId: 'lease-expired',
                leaseExpiresAtMs: nowMs - 5_001,
                leaseStatusAtEnqueue: 'active',
                leaseToken: signed.token,
              },
              operations: [
                {
                  table: 'tasks',
                  row_id: 'task-expired-lease',
                  op: 'upsert',
                  base_version: null,
                  payload: {
                    id: 'task-expired-lease',
                    user_id: 'u1',
                    title: 'should not apply',
                  },
                },
              ],
            },
          ],
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.push.commits[0]).toMatchObject({
      clientCommitId: 'commit-expired-lease',
      status: 'rejected',
      results: [
        {
          status: 'error',
          code: 'sync.auth_lease_expired',
          retriable: true,
        },
      ],
    });
    const task = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', 'task-expired-lease')
      .executeTakeFirst();
    expect(task).toBeUndefined();
  });
});
