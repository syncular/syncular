/**
 * POST /auth-leases/issue
 */

import {
  ErrorResponseSchema,
  SyncAuthLeaseIssueRequestSchema,
  type SyncAuthLeaseIssueResponse,
  SyncAuthLeaseIssueResponseSchema,
} from '@syncular/core';
import type { SqlFamily, SyncCoreDb } from '@syncular/server';
import {
  InvalidSubscriptionScopeError,
  issueAuthLease,
} from '@syncular/server';
import { describeRoute, resolver } from 'hono-openapi';
import { syncError } from '../errors';
import { syncValidator as zValidator } from '../validation';
import type { SyncRoutesContext } from './context';
import type { SyncAuthResult } from './shared';

export function registerAuthLeaseRoutes<
  DB extends SyncCoreDb = SyncCoreDb,
  Auth extends SyncAuthResult = SyncAuthResult,
  F extends SqlFamily = SqlFamily,
>(ctx: SyncRoutesContext<DB, Auth, F>): void {
  const { routes, authLeaseRoutesConfig, getAuth, options, handlerRegistry } =
    ctx;

  // -------------------------------------------------------------------------
  // POST /auth-leases/issue
  // -------------------------------------------------------------------------

  if (authLeaseRoutesConfig && authLeaseRoutesConfig.enabled !== false) {
    routes.post(
      '/auth-leases/issue',
      describeRoute({
        tags: ['sync'],
        summary: 'Issue an offline auth lease',
        description:
          'Issues a bounded signed auth lease for offline intent capture. The lease does not bypass current request auth or table-handler authorization on replay.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        responses: {
          200: {
            description: 'Issued auth lease',
            content: {
              'application/json': {
                schema: resolver(SyncAuthLeaseIssueResponseSchema),
              },
            },
          },
          401: {
            description: 'Unauthenticated',
            content: {
              'application/json': { schema: resolver(ErrorResponseSchema) },
            },
          },
          403: {
            description: 'Requested lease scopes are not allowed',
            content: {
              'application/json': { schema: resolver(ErrorResponseSchema) },
            },
          },
        },
      }),
      zValidator('json', SyncAuthLeaseIssueRequestSchema),
      async (c) => {
        const auth = await getAuth(c);
        if (!auth) return syncError(c, 401, 'sync.auth_required');

        const request = c.req.valid('json');
        let issued: SyncAuthLeaseIssueResponse | null;
        try {
          issued = await issueAuthLease({
            db: options.db,
            auth,
            handlers: handlerRegistry,
            scopeCache: options.scopeCache,
            request,
            issuer: authLeaseRoutesConfig.issuer,
            audience: authLeaseRoutesConfig.audience,
            kid: authLeaseRoutesConfig.kid,
            signer: authLeaseRoutesConfig.signer,
            capabilities: authLeaseRoutesConfig.capabilities,
            defaultTtlMs: authLeaseRoutesConfig.ttlMs,
            maxTtlMs: authLeaseRoutesConfig.maxTtlMs,
            maxClockSkewMs: authLeaseRoutesConfig.maxClockSkewMs,
            nowMs: authLeaseRoutesConfig.nowMs,
            leaseId: authLeaseRoutesConfig.leaseId,
            subject: authLeaseRoutesConfig.subject,
          });
        } catch (error) {
          if (error instanceof InvalidSubscriptionScopeError) {
            return syncError(c, 400, 'sync.invalid_request', error.message);
          }
          throw error;
        }

        if (!issued) {
          return syncError(
            c,
            403,
            'sync.auth_lease_scope_mismatch',
            'Requested auth lease scopes are not allowed'
          );
        }

        return c.json(issued, 200);
      }
    );
  }
}
