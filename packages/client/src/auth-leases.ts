import {
  resolveUrlFromBase,
  type SyncAuthLeaseIssueRequest,
  type SyncAuthLeaseIssueResponse,
} from '@syncular/core';
import type {
  SyncularAppSchema,
  SyncularAuthHeaders,
  SyncularAuthLeaseRecord,
} from './types';

export async function issueSyncularAuthLease(args: {
  baseUrl: string;
  headers: SyncularAuthHeaders;
  request: SyncAuthLeaseIssueRequest;
  appSchema?: SyncularAppSchema;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<SyncularAuthLeaseRecord> {
  if (args.appSchema) {
    validateSyncularAuthLeaseIssueRequestAgainstAppSchema(
      args.request,
      args.appSchema
    );
  }
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

  const issueResponse = assertAuthLeaseIssueResponse(await response.json());
  if (args.appSchema) {
    validateSyncularAuthLeaseIssueResponseAgainstAppSchema(
      issueResponse,
      args.request.schemaVersion,
      args.appSchema
    );
  }
  return syncularAuthLeaseRecordFromIssueResponse(issueResponse, args.nowMs);
}

function validateSyncularAuthLeaseIssueRequestAgainstAppSchema(
  request: SyncAuthLeaseIssueRequest,
  appSchema: SyncularAppSchema
): void {
  validateSyncularAuthLeaseSchemaVersion(
    request.schemaVersion,
    appSchema,
    'auth lease request'
  );
  if (request.ttlMs != null && request.ttlMs <= 0) {
    throw new Error('auth lease request ttlMs must be positive');
  }
  validateSyncularAuthLeaseScopesAgainstAppSchema(
    request.scopes,
    appSchema,
    'auth lease request'
  );
}

function validateSyncularAuthLeaseIssueResponseAgainstAppSchema(
  response: SyncAuthLeaseIssueResponse,
  requestSchemaVersion: number,
  appSchema: SyncularAppSchema
): void {
  if (response.payload.schemaVersion !== requestSchemaVersion) {
    throw new Error(
      `auth lease response schemaVersion ${response.payload.schemaVersion} does not match request schemaVersion ${requestSchemaVersion}`
    );
  }
  validateSyncularAuthLeaseSchemaVersion(
    response.payload.schemaVersion,
    appSchema,
    'auth lease payload'
  );
  validateSyncularAuthLeaseScopesAgainstAppSchema(
    response.payload.scopes,
    appSchema,
    'auth lease payload'
  );
}

type SyncularAuthLeaseScopeLike = SyncAuthLeaseIssueRequest['scopes'][number];

function validateSyncularAuthLeaseSchemaVersion(
  schemaVersion: number,
  appSchema: SyncularAppSchema,
  source: string
): void {
  if (schemaVersion === appSchema.schemaVersion) return;
  throw new Error(
    `${source} schemaVersion ${schemaVersion} does not match generated app schema version ${appSchema.schemaVersion}`
  );
}

function validateSyncularAuthLeaseScopesAgainstAppSchema(
  scopes: readonly SyncularAuthLeaseScopeLike[],
  appSchema: SyncularAppSchema,
  source: string
): void {
  if (scopes.length === 0) {
    throw new Error(
      `${source} must contain at least one generated table scope`
    );
  }
  for (const scope of scopes) {
    validateSyncularAuthLeaseScopeAgainstAppSchema(scope, appSchema, source);
  }
}

function validateSyncularAuthLeaseScopeAgainstAppSchema(
  scope: SyncularAuthLeaseScopeLike,
  appSchema: SyncularAppSchema,
  source: string
): void {
  if (scope.subscriptionId.trim() === '') {
    throw new Error(`${source} scope subscriptionId must not be empty`);
  }
  const tableName = scope.table.trim();
  if (tableName === '') {
    throw new Error(`${source} scope table must not be empty`);
  }
  const table = appSchema.tables.find((table) => table.name === tableName);
  if (!table) {
    throw new Error(
      `${source} scope references unknown generated table ${tableName}`
    );
  }
  if (scope.operations.length === 0) {
    throw new Error(
      `${source} scope for table ${tableName} must include at least one operation`
    );
  }
  for (const operation of scope.operations) {
    const operationName = operation as string;
    if (operationName !== 'upsert' && operationName !== 'delete') {
      throw new Error(
        `${source} scope for table ${tableName} references unsupported operation ${operationName}`
      );
    }
  }

  const scopeKeys = new Set(table.scopes.map((scope) => scope.name));
  for (const key of Object.keys(scope.values)) {
    if (!scopeKeys.has(key)) {
      throw new Error(
        `${source} scope for table ${tableName} references unknown generated scope ${key}`
      );
    }
  }
  for (const generatedScope of table.scopes) {
    if (generatedScope.required && !(generatedScope.name in scope.values)) {
      throw new Error(
        `${source} scope for table ${tableName} is missing required generated scope ${generatedScope.name}`
      );
    }
  }
  for (const [key, value] of Object.entries(scope.values)) {
    validateSyncularAuthLeaseScopeValue(source, tableName, key, value);
  }
}

function validateSyncularAuthLeaseScopeValue(
  source: string,
  table: string,
  key: string,
  value: unknown
): void {
  if (typeof value === 'string' && value.length > 0) return;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0)
  ) {
    return;
  }
  throw new Error(
    `${source} scope ${table}.${key} must be a non-empty string or non-empty string array`
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
