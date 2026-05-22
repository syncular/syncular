import {
  resolveUrlFromBase,
  type SyncAuthLeaseIssueRequest,
  type SyncAuthLeaseIssueResponse,
} from '@syncular/core';
import type { SyncularAuthHeaders, SyncularAuthLeaseRecord } from './types';

export async function issueSyncularAuthLease(args: {
  baseUrl: string;
  headers: SyncularAuthHeaders;
  request: SyncAuthLeaseIssueRequest;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<SyncularAuthLeaseRecord> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const headers = new Headers(args.headers);
  headers.set('accept', 'application/json');
  headers.set('content-type', 'application/json');

  const response = await fetchImpl(
    resolveUrlFromBase(args.baseUrl, 'auth-leases/issue'),
    {
      method: 'POST',
      headers,
      body: JSON.stringify(args.request),
    }
  );
  if (!response.ok) {
    throw await authLeaseIssueHttpError(response);
  }

  return syncularAuthLeaseRecordFromIssueResponse(
    assertAuthLeaseIssueResponse(await response.json()),
    args.nowMs
  );
}

function syncularAuthLeaseRecordFromIssueResponse(
  response: SyncAuthLeaseIssueResponse,
  nowMs = Date.now()
): SyncularAuthLeaseRecord {
  return {
    leaseId: response.payload.leaseId,
    kid: response.protectedHeader.kid,
    actorId: response.payload.actorId,
    issuedAtMs: response.payload.issuedAtMs,
    notBeforeMs: response.payload.notBeforeMs,
    expiresAtMs: response.payload.expiresAtMs,
    schemaVersion: response.payload.schemaVersion,
    payloadJson: JSON.stringify(response.payload),
    token: response.token,
    status: 'active',
    lastValidationError: null,
    createdAtMs: response.payload.issuedAtMs,
    updatedAtMs: Math.trunc(nowMs),
  };
}

async function authLeaseIssueHttpError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => '');
  return new Error(
    `Syncular auth lease issue failed with HTTP ${response.status}: ${body}`
  );
}

function assertAuthLeaseIssueResponse(
  value: unknown
): SyncAuthLeaseIssueResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('Syncular auth lease issue returned invalid JSON');
  }
  const response = value as Partial<SyncAuthLeaseIssueResponse>;
  const payload = response.payload as
    | Partial<SyncAuthLeaseIssueResponse['payload']>
    | undefined;
  const protectedHeader = response.protectedHeader as
    | Partial<SyncAuthLeaseIssueResponse['protectedHeader']>
    | undefined;
  if (
    response.ok !== true ||
    typeof response.token !== 'string' ||
    !payload ||
    typeof payload.leaseId !== 'string' ||
    typeof payload.actorId !== 'string' ||
    typeof payload.issuedAtMs !== 'number' ||
    typeof payload.notBeforeMs !== 'number' ||
    typeof payload.expiresAtMs !== 'number' ||
    typeof payload.schemaVersion !== 'number' ||
    !protectedHeader ||
    typeof protectedHeader.kid !== 'string'
  ) {
    throw new Error('Syncular auth lease issue returned an invalid lease');
  }
  return response as SyncAuthLeaseIssueResponse;
}
