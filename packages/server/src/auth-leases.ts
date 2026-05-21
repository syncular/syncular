import {
  collectScopeVars,
  type ScopeValues,
  type StoredScopes,
  SYNC_AUTH_LEASE_ALG_ES256,
  SYNC_AUTH_LEASE_CODE_EXPIRED,
  SYNC_AUTH_LEASE_CODE_INVALID,
  SYNC_AUTH_LEASE_CODE_SCHEMA_MISMATCH,
  SYNC_AUTH_LEASE_CODE_SCOPE_MISMATCH,
  SYNC_AUTH_LEASE_CODE_SCOPE_REVOKED,
  SYNC_AUTH_LEASE_PROTOCOL_VERSION,
  SYNC_AUTH_LEASE_TYP,
  SYNC_AUTH_LEASE_VERSION,
  type SyncAuthLeaseCapabilities,
  type SyncAuthLeaseIssueRequest,
  type SyncAuthLeaseIssueResponse,
  type SyncAuthLeasePayload,
  SyncAuthLeasePayloadSchema,
  type SyncAuthLeaseProtectedHeader,
  type SyncOperation,
  type SyncOperationResult,
} from '@syncular/core';
import { type Kysely, sql } from 'kysely';
import type { DbExecutor } from './dialect/types';
import type { ServerHandlerCollection } from './handlers';
import type { ServerTableHandler, SyncServerAuth } from './handlers/types';
import type { SyncCoreDb } from './schema';
import { resolveEffectiveScopesForSubscriptions } from './subscriptions';
import type { ScopeCacheBackend } from './subscriptions/cache';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface AuthLeaseSignedToken {
  ok: true;
  token: string;
  protectedHeader: SyncAuthLeaseProtectedHeader;
  payload: SyncAuthLeasePayload;
}

export interface AuthLeaseSigningInput {
  protectedHeader: SyncAuthLeaseProtectedHeader;
  payload: SyncAuthLeasePayload;
  signingInput: string;
}

export type AuthLeaseSigner = (
  input: AuthLeaseSigningInput
) => Promise<Uint8Array>;

export interface AuthLeaseIssueOptions<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
> {
  db: Kysely<DB>;
  auth: Auth;
  handlers: ServerHandlerCollection<DB, Auth>;
  request: SyncAuthLeaseIssueRequest;
  issuer: string;
  audience: string;
  kid: string;
  signer: AuthLeaseSigner;
  capabilities?: SyncAuthLeaseCapabilities;
  maxClockSkewMs?: number;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  nowMs?: () => number;
  leaseId?: () => string;
  scopeCache?: ScopeCacheBackend;
  subject?: (
    auth: Auth
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface AuthLeaseVerificationSuccess {
  ok: true;
  protectedHeader: SyncAuthLeaseProtectedHeader;
  payload: SyncAuthLeasePayload;
}

export interface AuthLeaseVerificationFailure {
  ok: false;
  code: string;
  message: string;
  leaseId?: string;
  kid?: string;
  expiresAtMs?: number;
}

export type AuthLeaseVerificationResult =
  | AuthLeaseVerificationSuccess
  | AuthLeaseVerificationFailure;

export interface VerifyAuthLeaseTokenOptions {
  token: string;
  publicKey: CryptoKey;
  nowMs?: number;
  expectedIssuer?: string;
  expectedAudience?: string;
  expectedSchemaVersion?: number;
}

export interface ValidateAuthLeaseOperationOptions<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
> {
  db: DbExecutor<DB>;
  auth: Auth;
  handler: ServerTableHandler<DB, Auth>;
  payload: SyncAuthLeasePayload;
  operation: SyncOperation;
  opIndex: number;
}

export async function issueAuthLease<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(
  options: AuthLeaseIssueOptions<DB, Auth>
): Promise<SyncAuthLeaseIssueResponse | null> {
  const nowMs = options.nowMs?.() ?? Date.now();
  const defaultTtlMs = positiveIntegerOrDefault(
    options.defaultTtlMs,
    15 * 60 * 1000
  );
  const maxTtlMs = positiveIntegerOrDefault(options.maxTtlMs, defaultTtlMs);
  const requestedTtlMs = positiveIntegerOrDefault(
    options.request.ttlMs,
    defaultTtlMs
  );
  const ttlMs = Math.min(requestedTtlMs, maxTtlMs);
  const requestedSubscriptions = options.request.scopes.map((scope) => ({
    id: scope.subscriptionId,
    table: scope.table,
    scopes: scope.values,
    params: {},
    cursor: -1,
    crdtStateVectors: [],
  }));
  const resolved = await resolveEffectiveScopesForSubscriptions({
    db: options.db,
    auth: options.auth,
    handlers: options.handlers,
    scopeCache: options.scopeCache,
    subscriptions: requestedSubscriptions,
  });
  const scopes = resolved
    .filter((subscription) => subscription.status === 'active')
    .map((subscription) => {
      const requested = options.request.scopes.find(
        (scope) => scope.subscriptionId === subscription.id
      );
      return {
        subscriptionId: subscription.id,
        table: subscription.table,
        values: subscription.scopes,
        operations: requested?.operations ?? [],
      };
    })
    .filter((scope) => scope.operations.length > 0);

  if (scopes.length === 0) {
    return null;
  }

  const payload: SyncAuthLeasePayload = {
    version: SYNC_AUTH_LEASE_VERSION,
    leaseId: options.leaseId?.() ?? randomLeaseId(),
    issuer: options.issuer,
    audience: options.audience,
    actorId: options.auth.actorId,
    subject: (await options.subject?.(options.auth)) ?? {},
    schemaVersion: options.request.schemaVersion,
    protocolVersion: SYNC_AUTH_LEASE_PROTOCOL_VERSION,
    issuedAtMs: nowMs,
    notBeforeMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    maxClockSkewMs: Math.max(0, options.maxClockSkewMs ?? 30_000),
    scopes,
    capabilities: options.capabilities ?? {
      allowBlobs: false,
      allowCrdt: false,
      allowEncryptedFields: false,
    },
  };

  return signAuthLeaseToken({
    kid: options.kid,
    payload,
    signer: options.signer,
  });
}

export async function signAuthLeaseToken(args: {
  kid: string;
  payload: SyncAuthLeasePayload;
  signer: AuthLeaseSigner;
}): Promise<AuthLeaseSignedToken> {
  const protectedHeader: SyncAuthLeaseProtectedHeader = {
    alg: SYNC_AUTH_LEASE_ALG_ES256,
    kid: args.kid,
    typ: SYNC_AUTH_LEASE_TYP,
  };
  const payload = SyncAuthLeasePayloadSchema.parse(args.payload);
  const signingInput = `${encodeJsonSegment(protectedHeader)}.${encodeJsonSegment(
    payload
  )}`;
  const signature = await args.signer({
    protectedHeader,
    payload,
    signingInput,
  });
  return {
    ok: true,
    token: `${signingInput}.${base64UrlEncode(signature)}`,
    protectedHeader,
    payload,
  };
}

export function createWebCryptoEs256AuthLeaseSigner(args: {
  privateKey: CryptoKey;
}): AuthLeaseSigner {
  return async ({ signingInput }) =>
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        args.privateKey,
        textEncoder.encode(signingInput)
      )
    );
}

export async function verifyAuthLeaseToken(
  options: VerifyAuthLeaseTokenOptions
): Promise<AuthLeaseVerificationResult> {
  const parts = options.token.split('.');
  if (parts.length !== 3) {
    return rejected(
      SYNC_AUTH_LEASE_CODE_INVALID,
      'auth lease token must have three JWS segments'
    );
  }

  const protectedHeader = decodeJsonSegment<SyncAuthLeaseProtectedHeader>(
    parts[0]!
  );
  if (
    !protectedHeader ||
    protectedHeader.alg !== SYNC_AUTH_LEASE_ALG_ES256 ||
    protectedHeader.typ !== SYNC_AUTH_LEASE_TYP
  ) {
    return rejected(
      SYNC_AUTH_LEASE_CODE_INVALID,
      'auth lease token has unsupported protected header'
    );
  }

  const signature = base64UrlDecode(parts[2]!);
  if (!signature) {
    return rejected(
      SYNC_AUTH_LEASE_CODE_INVALID,
      'auth lease signature segment is invalid'
    );
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    options.publicKey,
    toBufferSource(signature),
    textEncoder.encode(signingInput)
  );
  if (!verified) {
    return rejected(
      SYNC_AUTH_LEASE_CODE_INVALID,
      'auth lease signature verification failed',
      { kid: protectedHeader.kid }
    );
  }

  const rawPayload = decodeJsonSegment<unknown>(parts[1]!);
  const parsedPayload = SyncAuthLeasePayloadSchema.safeParse(rawPayload);
  if (!parsedPayload.success) {
    return rejected(
      SYNC_AUTH_LEASE_CODE_INVALID,
      'auth lease payload is invalid',
      {
        kid: protectedHeader.kid,
      }
    );
  }
  const payload = parsedPayload.data;
  if (
    options.expectedIssuer !== undefined &&
    payload.issuer !== options.expectedIssuer
  ) {
    return rejected(
      SYNC_AUTH_LEASE_CODE_INVALID,
      'auth lease issuer mismatch',
      {
        leaseId: payload.leaseId,
        kid: protectedHeader.kid,
      }
    );
  }
  if (
    options.expectedAudience !== undefined &&
    payload.audience !== options.expectedAudience
  ) {
    return rejected(
      SYNC_AUTH_LEASE_CODE_INVALID,
      'auth lease audience mismatch',
      {
        leaseId: payload.leaseId,
        kid: protectedHeader.kid,
      }
    );
  }
  if (
    options.expectedSchemaVersion !== undefined &&
    payload.schemaVersion !== options.expectedSchemaVersion
  ) {
    return rejected(
      SYNC_AUTH_LEASE_CODE_SCHEMA_MISMATCH,
      'auth lease schema version mismatch',
      { leaseId: payload.leaseId, kid: protectedHeader.kid }
    );
  }

  const nowMs = options.nowMs ?? Date.now();
  const skewMs = Math.max(0, payload.maxClockSkewMs);
  if (nowMs + skewMs < payload.notBeforeMs) {
    return rejected(
      SYNC_AUTH_LEASE_CODE_INVALID,
      'auth lease is not valid yet',
      {
        leaseId: payload.leaseId,
        kid: protectedHeader.kid,
      }
    );
  }
  if (nowMs - skewMs > payload.expiresAtMs) {
    return rejected(SYNC_AUTH_LEASE_CODE_EXPIRED, 'auth lease is expired', {
      leaseId: payload.leaseId,
      kid: protectedHeader.kid,
      expiresAtMs: payload.expiresAtMs,
    });
  }

  return { ok: true, protectedHeader, payload };
}

export function authLeaseCoversOperation(args: {
  payload: SyncAuthLeasePayload;
  table: string;
  op: string;
  scopes: ScopeValues;
}): AuthLeaseVerificationFailure | null {
  const leaseScope = args.payload.scopes.find(
    (scope) =>
      scope.table === args.table &&
      scope.operations.some((operation) => operation === args.op)
  );
  if (!leaseScope) {
    return rejected(
      SYNC_AUTH_LEASE_CODE_SCOPE_MISMATCH,
      'auth lease does not cover operation table or type',
      { leaseId: args.payload.leaseId }
    );
  }
  for (const [key, value] of Object.entries(args.scopes)) {
    if (!scopeValueCovers(leaseScope.values[key], value)) {
      return rejected(
        SYNC_AUTH_LEASE_CODE_SCOPE_MISMATCH,
        'auth lease does not cover scope',
        {
          leaseId: args.payload.leaseId,
        }
      );
    }
  }
  return null;
}

export async function validateAuthLeaseOperation<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(
  options: ValidateAuthLeaseOperationOptions<DB, Auth>
): Promise<SyncOperationResult | null> {
  const requiredScopeKeys = Array.from(
    collectScopeVars(options.handler.scopePatterns)
  );
  const extracted = await extractOperationScopes({
    db: options.db,
    handler: options.handler,
    operation: options.operation,
  });
  const requiresScopeValues =
    requiredScopeKeys.length > 0 && extracted.rowExistsOrWillBeWritten;
  if (
    requiresScopeValues &&
    requiredScopeKeys.some(
      (key) =>
        typeof extracted.scopes[key] !== 'string' ||
        extracted.scopes[key].length === 0
    )
  ) {
    return authLeaseOperationError({
      opIndex: options.opIndex,
      code: SYNC_AUTH_LEASE_CODE_SCOPE_MISMATCH,
      error: 'Auth lease operation scopes could not be extracted',
    });
  }

  const leaseCoverage = authLeaseCoversOperation({
    payload: options.payload,
    table: options.operation.table,
    op: options.operation.op,
    scopes: extracted.scopes,
  });
  if (leaseCoverage) {
    return authLeaseOperationError({
      opIndex: options.opIndex,
      code: leaseCoverage.code,
      error: leaseCoverage.message,
    });
  }

  if (requiresScopeValues) {
    let currentScopes: ScopeValues;
    try {
      currentScopes = await options.handler.resolveScopes({
        db: options.db,
        actorId: options.auth.actorId,
        auth: options.auth,
      });
    } catch {
      return authLeaseOperationError({
        opIndex: options.opIndex,
        code: SYNC_AUTH_LEASE_CODE_SCOPE_REVOKED,
        error: 'Auth lease scopes could not be resolved for replay',
      });
    }

    if (
      !storedScopesCoveredByScopeValues({
        storedScopes: extracted.scopes,
        allowedScopes: currentScopes,
        requiredScopeKeys,
      })
    ) {
      return authLeaseOperationError({
        opIndex: options.opIndex,
        code: SYNC_AUTH_LEASE_CODE_SCOPE_REVOKED,
        error: 'Auth lease scope is no longer authorized',
      });
    }
  }

  return null;
}

async function extractOperationScopes<
  DB extends SyncCoreDb,
  Auth extends SyncServerAuth,
>(args: {
  db: DbExecutor<DB>;
  handler: ServerTableHandler<DB, Auth>;
  operation: SyncOperation;
}): Promise<{ scopes: StoredScopes; rowExistsOrWillBeWritten: boolean }> {
  const existingRow = await readExistingRow({
    db: args.db,
    table: args.operation.table,
    primaryKeyColumn: args.handler.primaryKeyColumn ?? 'id',
    rowId: args.operation.row_id,
  });

  if (existingRow) {
    return {
      scopes: args.handler.extractScopes(existingRow),
      rowExistsOrWillBeWritten: true,
    };
  }

  if (args.operation.op === 'delete') {
    return { scopes: {}, rowExistsOrWillBeWritten: false };
  }

  const payloadRecord =
    args.operation.payload &&
    typeof args.operation.payload === 'object' &&
    !Array.isArray(args.operation.payload)
      ? args.operation.payload
      : {};
  return {
    scopes: args.handler.extractScopes({
      ...payloadRecord,
      [args.handler.primaryKeyColumn ?? 'id']: args.operation.row_id,
    }),
    rowExistsOrWillBeWritten: true,
  };
}

async function readExistingRow<DB extends SyncCoreDb>(args: {
  db: DbExecutor<DB>;
  table: string;
  primaryKeyColumn: string;
  rowId: string;
}): Promise<Record<string, unknown> | null> {
  const result = await sql<Record<string, unknown>>`
    SELECT *
    FROM ${sql.table(args.table)}
    WHERE ${sql.ref(args.primaryKeyColumn)} = ${args.rowId}
    LIMIT 1
  `.execute(args.db);
  return result.rows[0] ?? null;
}

function storedScopesCoveredByScopeValues(args: {
  storedScopes: StoredScopes;
  allowedScopes: ScopeValues;
  requiredScopeKeys: readonly string[];
}): boolean {
  for (const key of args.requiredScopeKeys) {
    const storedValue = args.storedScopes[key];
    if (typeof storedValue !== 'string' || storedValue.length === 0) {
      return false;
    }
    if (!scopeValueCovers(args.allowedScopes[key], storedValue)) {
      return false;
    }
  }
  return true;
}

function authLeaseOperationError(args: {
  opIndex: number;
  code: string;
  error: string;
}): SyncOperationResult {
  return {
    opIndex: args.opIndex,
    status: 'error',
    error: args.error,
    code: args.code,
    retriable: false,
  };
}

function scopeValueCovers(
  leaseValue: ScopeValues[string] | undefined,
  requestedValue: ScopeValues[string]
): boolean {
  if (leaseValue === undefined) return false;
  const leaseValues = Array.isArray(leaseValue) ? leaseValue : [leaseValue];
  const requestedValues = Array.isArray(requestedValue)
    ? requestedValue
    : [requestedValue];
  if (leaseValues.includes('*')) return true;
  return requestedValues.every((value) => leaseValues.includes(value));
}

function positiveIntegerOrDefault(
  value: number | undefined,
  defaultValue: number
): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : defaultValue;
}

function randomLeaseId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `lease_${crypto.randomUUID()}`;
  }
  return `lease_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2)}`;
}

function encodeJsonSegment(value: unknown): string {
  return base64UrlEncode(textEncoder.encode(JSON.stringify(value)));
}

function decodeJsonSegment<T>(segment: string): T | null {
  const bytes = base64UrlDecode(segment);
  if (!bytes) return null;
  try {
    return JSON.parse(textDecoder.decode(bytes)) as T;
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '='
  );
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned;
}

function rejected(
  code: string,
  message: string,
  details: Omit<AuthLeaseVerificationFailure, 'ok' | 'code' | 'message'> = {}
): AuthLeaseVerificationFailure {
  return {
    ok: false,
    code,
    message,
    ...details,
  };
}
