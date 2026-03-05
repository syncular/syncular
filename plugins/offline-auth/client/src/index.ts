import type {
  SyncIdentityBase,
  SyncAuthErrorContext,
  SyncAuthLifecycle,
  SyncAuthRetryContext,
} from '@syncular/core';

export type MaybePromise<T> = T | Promise<T>;

export interface OfflineAuthStorage {
  getItem(key: string): MaybePromise<string | null>;
  setItem(key: string, value: string): MaybePromise<void>;
  removeItem(key: string): MaybePromise<void>;
}

export interface OfflineSubjectIdentity extends SyncIdentityBase {
  teamId?: string | null;
}

export interface OfflineAuthCachedValue<TValue> {
  value: TValue;
  savedAtMs: number;
  expiresAtMs: number | null;
}

export interface OfflineAuthState<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
> {
  version: typeof OFFLINE_AUTH_STATE_VERSION;
  session: OfflineAuthCachedValue<TSession> | null;
  identity: OfflineAuthCachedValue<TIdentity> | null;
  lastActorId: string | null;
}

export interface OfflineAuthStateCodec<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
> {
  parseSession(value: unknown): TSession | null;
  parseIdentity(value: unknown): TIdentity | null;
}

export interface LoadOfflineAuthStateOptions<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
> {
  storage: OfflineAuthStorage;
  codec: OfflineAuthStateCodec<TSession, TIdentity>;
  storageKey?: string;
}

export interface SaveOfflineAuthStateOptions {
  storage: OfflineAuthStorage;
  storageKey?: string;
}

export interface CreateSessionCacheEntryOptions<TSession> {
  nowMs?: number;
  skewMs?: number;
  allowMissingExpiry?: boolean;
  getExpiresAtMs?: (session: TSession) => number | null | undefined;
  getJwt?: (session: TSession) => string | null | undefined;
}

export interface CreateIdentityCacheEntryOptions<TIdentity> {
  nowMs?: number;
  getExpiresAtMs?: (identity: TIdentity) => number | null | undefined;
}

export interface PersistOnlineSessionOptions<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
> extends CreateSessionCacheEntryOptions<TSession> {
  state: OfflineAuthState<TSession, TIdentity>;
  session: TSession | null;
  getSessionActorId: (session: TSession) => string | null | undefined;
  deriveIdentity?: (session: TSession) => TIdentity | null | undefined;
  getIdentityExpiresAtMs?: (identity: TIdentity) => number | null | undefined;
}

export interface PersistOfflineIdentityOptions<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
> extends CreateIdentityCacheEntryOptions<TIdentity> {
  state: OfflineAuthState<TSession, TIdentity>;
  identity: TIdentity | null;
}

export interface ResolveOfflineAuthSubjectOptions<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
> {
  state: OfflineAuthState<TSession, TIdentity>;
  nowMs?: number;
  skewMs?: number;
  getSessionActorId: (session: TSession) => string | null | undefined;
  getSessionTeamId?: (session: TSession) => string | null | undefined;
  getIdentityActorId?: (identity: TIdentity) => string | null | undefined;
  getIdentityTeamId?: (identity: TIdentity) => string | null | undefined;
}

export type OfflineAuthSubjectSource =
  | 'online-session'
  | 'offline-identity'
  | 'last-actor'
  | 'none';

export interface OfflineResolvedSubject<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
> {
  source: OfflineAuthSubjectSource;
  actorId: string | null;
  teamId: string | null;
  isOffline: boolean;
  session: OfflineAuthCachedValue<TSession> | null;
  identity: OfflineAuthCachedValue<TIdentity> | null;
}

export interface TokenRetryContext extends SyncAuthRetryContext {
  previousToken: string | null;
  nextToken: string | null;
}

export interface CreateTokenLifecycleBridgeOptions {
  resolveToken: () => MaybePromise<string | null | undefined>;
  refreshToken?: (
    context: SyncAuthErrorContext
  ) => MaybePromise<string | null | undefined>;
  onAuthExpired?: (context: SyncAuthErrorContext) => MaybePromise<void>;
  retryWithFreshToken?: (context: TokenRetryContext) => MaybePromise<boolean>;
}

export interface TokenLifecycleBridge {
  resolveToken: () => Promise<string | null>;
  getAuthorizationHeaders: () => Promise<Record<string, string>>;
  getRealtimeParams: (paramName?: string) => Promise<Record<string, string>>;
  authLifecycle: SyncAuthLifecycle;
}

export interface OfflineLockPolicyOptions {
  now?: () => number;
  initiallyLocked?: boolean;
  maxFailedAttempts?: number;
  cooldownMs?: number;
  idleTimeoutMs?: number;
}

export interface OfflineLockState {
  isLocked: boolean;
  failedAttempts: number;
  blockedUntilMs: number | null;
  lastActivityAtMs: number;
}

type OfflineLockEventBase = {
  nowMs?: number;
};

export type OfflineLockEvent =
  | ({ type: 'lock' } & OfflineLockEventBase)
  | ({ type: 'unlock' } & OfflineLockEventBase)
  | ({ type: 'activity' } & OfflineLockEventBase)
  | ({ type: 'failed-unlock' } & OfflineLockEventBase)
  | ({ type: 'reset-failures' } & OfflineLockEventBase)
  | ({ type: 'tick' } & OfflineLockEventBase);

export type OfflineUnlockFailureReason = 'blocked' | 'rejected';

export interface OfflineUnlockResult {
  ok: boolean;
  reason: OfflineUnlockFailureReason | null;
  state: OfflineLockState;
}

export interface AttemptOfflineUnlockArgs {
  state: OfflineLockState;
  verify: () => boolean;
  options?: OfflineLockPolicyOptions;
  nowMs?: number;
}

export interface AttemptOfflineUnlockAsyncArgs {
  state: OfflineLockState;
  verify: () => MaybePromise<boolean>;
  options?: OfflineLockPolicyOptions;
  nowMs?: number;
}

export interface OfflineLockController {
  getState(): OfflineLockState;
  replaceState(nextState: OfflineLockState): OfflineLockState;
  dispatch(event: OfflineLockEvent): OfflineLockState;
  lock(): OfflineLockState;
  forceUnlock(): OfflineUnlockResult;
  recordActivity(): OfflineLockState;
  recordFailedUnlock(): OfflineLockState;
  resetFailures(): OfflineLockState;
  evaluateIdleTimeout(): OfflineLockState;
  attemptUnlock(verify: () => boolean): OfflineUnlockResult;
  attemptUnlockAsync(verify: () => MaybePromise<boolean>): Promise<OfflineUnlockResult>;
}

export const OFFLINE_AUTH_STATE_VERSION = 1;
export const DEFAULT_OFFLINE_AUTH_STORAGE_KEY = 'syncular-offline-auth-v1';
export const DEFAULT_EXPIRY_SKEW_MS = 30_000;
export const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
export const DEFAULT_LOCK_COOLDOWN_MS = 30_000;

interface NormalizedLockPolicy {
  now: () => number;
  maxFailedAttempts: number;
  cooldownMs: number;
  idleTimeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function readNullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = readFiniteNumber(value);
  if (parsed === null) return undefined;
  return parsed;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNullableTrimmedString(value: unknown): string | null | undefined {
  if (value === null) return null;
  const parsed = readTrimmedString(value);
  if (parsed === null) return undefined;
  return parsed;
}

function parseCachedValue<TValue>(
  value: unknown,
  parseValue: (value: unknown) => TValue | null
): OfflineAuthCachedValue<TValue> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return null;

  const parsedValue = parseValue(value.value);
  if (parsedValue === null) return null;

  const savedAtMs = readFiniteNumber(value.savedAtMs);
  if (savedAtMs === null) return null;

  const expiresAtMs = readNullableFiniteNumber(value.expiresAtMs);
  if (expiresAtMs === undefined) return null;

  return {
    value: parsedValue,
    savedAtMs,
    expiresAtMs,
  };
}

function toNowMs(
  nowMs: number | undefined,
  now: (() => number) | undefined
): number {
  if (typeof nowMs === 'number' && Number.isFinite(nowMs)) {
    return nowMs;
  }
  if (now) {
    return now();
  }
  return Date.now();
}

function normalizeLockPolicy(
  options: OfflineLockPolicyOptions | undefined
): NormalizedLockPolicy {
  const maxFailedAttempts = Math.max(
    1,
    Math.floor(options?.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS)
  );
  const cooldownMs = Math.max(
    0,
    Math.floor(options?.cooldownMs ?? DEFAULT_LOCK_COOLDOWN_MS)
  );
  const idleTimeoutMs = Math.max(0, Math.floor(options?.idleTimeoutMs ?? 0));

  return {
    now: options?.now ?? (() => Date.now()),
    maxFailedAttempts,
    cooldownMs,
    idleTimeoutMs,
  };
}

function normalizeLockStateForTime(
  state: OfflineLockState,
  nowMs: number
): OfflineLockState {
  if (state.blockedUntilMs === null) return state;
  if (state.blockedUntilMs > nowMs) return state;

  return {
    ...state,
    blockedUntilMs: null,
    failedAttempts: 0,
  };
}

function decodeBase64UrlSegment(segment: string): string | null {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const base64 = `${normalized}${padding}`;

  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(base64, 'base64').toString('utf8');
    }

    if (typeof atob === 'function') {
      return atob(base64);
    }
  } catch {
    return null;
  }

  return null;
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split('.');
  if (segments.length < 2) return null;

  const payloadSegment = segments[1];
  if (!payloadSegment) return null;

  const decoded = decodeBase64UrlSegment(payloadSegment);
  if (!decoded) return null;

  try {
    const parsed: unknown = JSON.parse(decoded);
    if (!isRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createWebStorageAdapter(storage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}): OfflineAuthStorage {
  return {
    getItem(key) {
      return storage.getItem(key);
    },
    setItem(key, value) {
      storage.setItem(key, value);
    },
    removeItem(key) {
      storage.removeItem(key);
    },
  };
}

export function createMemoryStorageAdapter(
  initialEntries?: Record<string, string>
): OfflineAuthStorage {
  const state = new Map<string, string>(Object.entries(initialEntries ?? {}));

  return {
    getItem(key) {
      return state.get(key) ?? null;
    },
    setItem(key, value) {
      state.set(key, value);
    },
    removeItem(key) {
      state.delete(key);
    },
  };
}

export function isOfflineSubjectIdentity(
  value: unknown
): value is OfflineSubjectIdentity {
  if (!isRecord(value)) return false;
  const actorId = readTrimmedString(value.actorId);
  if (!actorId) return false;

  const teamId = value.teamId;
  if (teamId === undefined || teamId === null) return true;
  return readTrimmedString(teamId) !== null;
}

export function createEmptyOfflineAuthState<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
>(): OfflineAuthState<TSession, TIdentity> {
  return {
    version: OFFLINE_AUTH_STATE_VERSION,
    session: null,
    identity: null,
    lastActorId: null,
  };
}

export async function loadOfflineAuthState<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
>(
  options: LoadOfflineAuthStateOptions<TSession, TIdentity>
): Promise<OfflineAuthState<TSession, TIdentity>> {
  const storageKey = options.storageKey ?? DEFAULT_OFFLINE_AUTH_STORAGE_KEY;
  const fallback = createEmptyOfflineAuthState<TSession, TIdentity>();

  let rawValue: string | null = null;
  try {
    rawValue = await options.storage.getItem(storageKey);
  } catch {
    return fallback;
  }

  if (!rawValue) {
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return fallback;
  }

  if (!isRecord(parsed)) {
    return fallback;
  }

  const version = readFiniteNumber(parsed.version);
  if (version !== OFFLINE_AUTH_STATE_VERSION) {
    return fallback;
  }

  const session = parseCachedValue(parsed.session, options.codec.parseSession);
  const identity = parseCachedValue(
    parsed.identity,
    options.codec.parseIdentity
  );
  const lastActorId = readNullableTrimmedString(parsed.lastActorId);

  return {
    version: OFFLINE_AUTH_STATE_VERSION,
    session,
    identity,
    lastActorId: lastActorId ?? null,
  };
}

export async function saveOfflineAuthState<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
>(
  state: OfflineAuthState<TSession, TIdentity>,
  options: SaveOfflineAuthStateOptions
): Promise<void> {
  const storageKey = options.storageKey ?? DEFAULT_OFFLINE_AUTH_STORAGE_KEY;
  const payload = JSON.stringify(state);
  await options.storage.setItem(storageKey, payload);
}

export async function removeOfflineAuthState(
  options: SaveOfflineAuthStateOptions
): Promise<void> {
  const storageKey = options.storageKey ?? DEFAULT_OFFLINE_AUTH_STORAGE_KEY;
  await options.storage.removeItem(storageKey);
}

export function getJwtExpiryMs(token: string): number | null {
  const payload = parseJwtPayload(token);
  if (!payload) return null;

  const exp = readFiniteNumber(payload.exp);
  if (exp === null) return null;

  return exp * 1000;
}

export function isExpiryElapsed(args: {
  expiresAtMs: number | null | undefined;
  nowMs?: number;
  skewMs?: number;
}): boolean {
  if (args.expiresAtMs === null) return false;
  if (args.expiresAtMs === undefined) return true;
  if (!Number.isFinite(args.expiresAtMs)) return true;

  const nowMs = toNowMs(args.nowMs, undefined);
  const skewMs = Math.max(0, args.skewMs ?? DEFAULT_EXPIRY_SKEW_MS);

  return args.expiresAtMs <= nowMs + skewMs;
}

export function isCachedValueExpired<TValue>(
  cachedValue: OfflineAuthCachedValue<TValue>,
  options?: {
    nowMs?: number;
    skewMs?: number;
  }
): boolean {
  return isExpiryElapsed({
    expiresAtMs: cachedValue.expiresAtMs,
    nowMs: options?.nowMs,
    skewMs: options?.skewMs,
  });
}

export function createSessionCacheEntry<TSession>(
  session: TSession,
  options?: CreateSessionCacheEntryOptions<TSession>
): OfflineAuthCachedValue<TSession> | null {
  const nowMs = toNowMs(options?.nowMs, undefined);
  const explicitExpiry = options?.getExpiresAtMs?.(session);
  const jwtExpiry = options?.getJwt
    ? getJwtExpiryMs(options.getJwt(session) ?? '')
    : null;

  const expiresAtMs = explicitExpiry ?? jwtExpiry;

  if (expiresAtMs === null || expiresAtMs === undefined) {
    if (!options?.allowMissingExpiry) {
      return null;
    }

    return {
      value: session,
      savedAtMs: nowMs,
      expiresAtMs: null,
    };
  }

  const skewMs = Math.max(0, options?.skewMs ?? DEFAULT_EXPIRY_SKEW_MS);
  if (expiresAtMs <= nowMs + skewMs) {
    return null;
  }

  return {
    value: session,
    savedAtMs: nowMs,
    expiresAtMs,
  };
}

export function createIdentityCacheEntry<TIdentity>(
  identity: TIdentity,
  options?: CreateIdentityCacheEntryOptions<TIdentity>
): OfflineAuthCachedValue<TIdentity> {
  const nowMs = toNowMs(options?.nowMs, undefined);
  const expiresAtMs = options?.getExpiresAtMs?.(identity) ?? null;

  return {
    value: identity,
    savedAtMs: nowMs,
    expiresAtMs,
  };
}

export function persistOnlineSession<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
>(
  options: PersistOnlineSessionOptions<TSession, TIdentity>
): OfflineAuthState<TSession, TIdentity> {
  if (!options.session) {
    return clearOfflineAuthState(options.state);
  }

  const sessionEntry = createSessionCacheEntry(options.session, {
    nowMs: options.nowMs,
    skewMs: options.skewMs,
    allowMissingExpiry: options.allowMissingExpiry,
    getExpiresAtMs: options.getExpiresAtMs,
    getJwt: options.getJwt,
  });

  const actorId = readTrimmedString(options.getSessionActorId(options.session));

  let nextIdentity = options.state.identity;
  if (options.deriveIdentity) {
    const derivedIdentity = options.deriveIdentity(options.session);
    if (derivedIdentity) {
      nextIdentity = createIdentityCacheEntry(derivedIdentity, {
        nowMs: options.nowMs,
        getExpiresAtMs: options.getIdentityExpiresAtMs,
      });
    } else {
      nextIdentity = null;
    }
  }

  return {
    ...options.state,
    session: sessionEntry,
    identity: nextIdentity,
    lastActorId: actorId ?? options.state.lastActorId,
  };
}

export function persistOfflineIdentity<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
>(
  options: PersistOfflineIdentityOptions<TSession, TIdentity>
): OfflineAuthState<TSession, TIdentity> {
  if (!options.identity) {
    return {
      ...options.state,
      identity: null,
    };
  }

  const identityEntry = createIdentityCacheEntry(options.identity, {
    nowMs: options.nowMs,
    getExpiresAtMs: options.getExpiresAtMs,
  });

  const actorId = readTrimmedString(options.identity.actorId);

  return {
    ...options.state,
    identity: identityEntry,
    lastActorId: actorId ?? options.state.lastActorId,
  };
}

export function setOfflineAuthLastActorId<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
>(
  state: OfflineAuthState<TSession, TIdentity>,
  actorId: string | null
): OfflineAuthState<TSession, TIdentity> {
  return {
    ...state,
    lastActorId: readTrimmedString(actorId) ?? null,
  };
}

export function clearOfflineAuthState<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
>(
  state: OfflineAuthState<TSession, TIdentity>,
  options?: {
    preserveLastActorId?: boolean;
  }
): OfflineAuthState<TSession, TIdentity> {
  return {
    version: OFFLINE_AUTH_STATE_VERSION,
    session: null,
    identity: null,
    lastActorId: options?.preserveLastActorId ? state.lastActorId : null,
  };
}

export function resolveOfflineAuthSubject<
  TSession,
  TIdentity extends OfflineSubjectIdentity,
>(
  options: ResolveOfflineAuthSubjectOptions<TSession, TIdentity>
): OfflineResolvedSubject<TSession, TIdentity> {
  const nowMs = toNowMs(options.nowMs, undefined);
  const skewMs = Math.max(0, options.skewMs ?? DEFAULT_EXPIRY_SKEW_MS);

  const session =
    options.state.session &&
    !isCachedValueExpired(options.state.session, { nowMs, skewMs })
      ? options.state.session
      : null;

  if (session) {
    const actorId = readTrimmedString(options.getSessionActorId(session.value));
    if (actorId) {
      const teamId = options.getSessionTeamId
        ? readTrimmedString(options.getSessionTeamId(session.value))
        : null;

      return {
        source: 'online-session',
        actorId,
        teamId,
        isOffline: false,
        session,
        identity: null,
      };
    }
  }

  const identity =
    options.state.identity &&
    !isCachedValueExpired(options.state.identity, { nowMs, skewMs })
      ? options.state.identity
      : null;

  if (identity) {
    const actorId = options.getIdentityActorId
      ? readTrimmedString(options.getIdentityActorId(identity.value))
      : readTrimmedString(identity.value.actorId);

    if (actorId) {
      const rawTeamId = options.getIdentityTeamId
        ? options.getIdentityTeamId(identity.value)
        : identity.value.teamId;

      const teamId =
        rawTeamId === null || rawTeamId === undefined
          ? null
          : readTrimmedString(rawTeamId);

      return {
        source: 'offline-identity',
        actorId,
        teamId,
        isOffline: true,
        session: null,
        identity,
      };
    }
  }

  const lastActorId = readTrimmedString(options.state.lastActorId);
  if (lastActorId) {
    return {
      source: 'last-actor',
      actorId: lastActorId,
      teamId: null,
      isOffline: true,
      session: null,
      identity: null,
    };
  }

  return {
    source: 'none',
    actorId: null,
    teamId: null,
    isOffline: true,
    session: null,
    identity: null,
  };
}

export function createBearerAuthHeaders(
  token: string | null | undefined
): Record<string, string> {
  const resolved = readTrimmedString(token);
  if (!resolved) return {};
  return {
    Authorization: `Bearer ${resolved}`,
  };
}

export function createTokenLifecycleBridge(
  options: CreateTokenLifecycleBridgeOptions
): TokenLifecycleBridge {
  let latestToken: string | null = null;
  let latestRefreshTokens: {
    previousToken: string | null;
    nextToken: string | null;
  } | null = null;
  let refreshInFlight: Promise<boolean> | null = null;

  const resolveToken = async (): Promise<string | null> => {
    const token = readTrimmedString(await options.resolveToken());
    latestToken = token;
    return token;
  };

  const runRefresh = async (
    context: SyncAuthErrorContext
  ): Promise<boolean> => {
    const previousToken = latestToken;
    const refreshTokenResolver = options.refreshToken ?? options.resolveToken;
    const nextToken = readTrimmedString(await refreshTokenResolver(context));

    latestToken = nextToken;
    latestRefreshTokens = {
      previousToken,
      nextToken,
    };

    return Boolean(nextToken) && nextToken !== previousToken;
  };

  const authLifecycle: SyncAuthLifecycle = {
    onAuthExpired: options.onAuthExpired,
    refreshToken: async (context) => {
      if (!refreshInFlight) {
        refreshInFlight = runRefresh(context).finally(() => {
          refreshInFlight = null;
        });
      }

      return refreshInFlight;
    },
    retryWithFreshToken: async (context) => {
      const previousToken = latestRefreshTokens?.previousToken ?? latestToken;
      const nextToken = latestRefreshTokens?.nextToken ?? latestToken;

      if (options.retryWithFreshToken) {
        return options.retryWithFreshToken({
          ...context,
          previousToken,
          nextToken,
        });
      }

      return context.refreshResult;
    },
  };

  return {
    resolveToken,
    getAuthorizationHeaders: async () => {
      const token = await resolveToken();
      return createBearerAuthHeaders(token);
    },
    getRealtimeParams: async (paramName = 'token') => {
      const token = await resolveToken();
      if (!token) return {};
      return {
        [paramName]: token,
      };
    },
    authLifecycle,
  };
}

export function createOfflineLockState(
  options?: OfflineLockPolicyOptions
): OfflineLockState {
  const policy = normalizeLockPolicy(options);
  const nowMs = policy.now();

  return {
    isLocked: options?.initiallyLocked ?? false,
    failedAttempts: 0,
    blockedUntilMs: null,
    lastActivityAtMs: nowMs,
  };
}

export function isOfflineLockBlocked(
  state: OfflineLockState,
  nowMs = Date.now()
): boolean {
  return state.blockedUntilMs !== null && state.blockedUntilMs > nowMs;
}

export function applyOfflineLockEvent(
  state: OfflineLockState,
  event: OfflineLockEvent,
  options?: OfflineLockPolicyOptions
): OfflineLockState {
  const policy = normalizeLockPolicy(options);
  const nowMs = toNowMs(event.nowMs, policy.now);
  const normalized = normalizeLockStateForTime(state, nowMs);

  if (event.type === 'lock') {
    return {
      ...normalized,
      isLocked: true,
      lastActivityAtMs: nowMs,
    };
  }

  if (event.type === 'unlock') {
    if (isOfflineLockBlocked(normalized, nowMs)) {
      return {
        ...normalized,
        isLocked: true,
        lastActivityAtMs: nowMs,
      };
    }

    return {
      ...normalized,
      isLocked: false,
      failedAttempts: 0,
      blockedUntilMs: null,
      lastActivityAtMs: nowMs,
    };
  }

  if (event.type === 'activity') {
    return {
      ...normalized,
      lastActivityAtMs: nowMs,
    };
  }

  if (event.type === 'reset-failures') {
    return {
      ...normalized,
      failedAttempts: 0,
      blockedUntilMs: null,
      lastActivityAtMs: nowMs,
    };
  }

  if (event.type === 'failed-unlock') {
    if (isOfflineLockBlocked(normalized, nowMs)) {
      return {
        ...normalized,
        isLocked: true,
        lastActivityAtMs: nowMs,
      };
    }

    const failedAttempts = normalized.failedAttempts + 1;

    if (failedAttempts >= policy.maxFailedAttempts) {
      const blockedUntilMs = nowMs + policy.cooldownMs;
      return {
        ...normalized,
        isLocked: true,
        failedAttempts,
        blockedUntilMs,
        lastActivityAtMs: nowMs,
      };
    }

    return {
      ...normalized,
      isLocked: true,
      failedAttempts,
      blockedUntilMs: null,
      lastActivityAtMs: nowMs,
    };
  }

  if (
    policy.idleTimeoutMs > 0 &&
    !normalized.isLocked &&
    nowMs - normalized.lastActivityAtMs >= policy.idleTimeoutMs
  ) {
    return {
      ...normalized,
      isLocked: true,
      lastActivityAtMs: nowMs,
    };
  }

  return normalized;
}

export function attemptOfflineUnlock(
  args: AttemptOfflineUnlockArgs
): OfflineUnlockResult {
  const policy = normalizeLockPolicy(args.options);
  const nowMs = toNowMs(args.nowMs, policy.now);
  const normalized = normalizeLockStateForTime(args.state, nowMs);

  if (isOfflineLockBlocked(normalized, nowMs)) {
    return {
      ok: false,
      reason: 'blocked',
      state: {
        ...normalized,
        isLocked: true,
      },
    };
  }

  if (args.verify()) {
    const state = applyOfflineLockEvent(
      normalized,
      { type: 'unlock', nowMs },
      policy
    );
    return {
      ok: true,
      reason: null,
      state,
    };
  }

  const state = applyOfflineLockEvent(
    normalized,
    { type: 'failed-unlock', nowMs },
    policy
  );

  return {
    ok: false,
    reason: isOfflineLockBlocked(state, nowMs) ? 'blocked' : 'rejected',
    state,
  };
}

export async function attemptOfflineUnlockAsync(
  args: AttemptOfflineUnlockAsyncArgs
): Promise<OfflineUnlockResult> {
  const policy = normalizeLockPolicy(args.options);
  const nowMs = toNowMs(args.nowMs, policy.now);
  const normalized = normalizeLockStateForTime(args.state, nowMs);

  if (isOfflineLockBlocked(normalized, nowMs)) {
    return {
      ok: false,
      reason: 'blocked',
      state: {
        ...normalized,
        isLocked: true,
      },
    };
  }

  if (await args.verify()) {
    const state = applyOfflineLockEvent(
      normalized,
      { type: 'unlock', nowMs },
      policy
    );
    return {
      ok: true,
      reason: null,
      state,
    };
  }

  const state = applyOfflineLockEvent(
    normalized,
    { type: 'failed-unlock', nowMs },
    policy
  );

  return {
    ok: false,
    reason: isOfflineLockBlocked(state, nowMs) ? 'blocked' : 'rejected',
    state,
  };
}

export function createOfflineLockController(
  options?: OfflineLockPolicyOptions
): OfflineLockController {
  const policy = normalizeLockPolicy(options);
  let state = createOfflineLockState(policy);

  const dispatch = (event: OfflineLockEvent): OfflineLockState => {
    state = applyOfflineLockEvent(state, event, policy);
    return state;
  };

  return {
    getState() {
      return state;
    },
    replaceState(nextState) {
      state = nextState;
      return state;
    },
    dispatch,
    lock() {
      return dispatch({ type: 'lock' });
    },
    forceUnlock() {
      const nextState = dispatch({ type: 'unlock' });
      if (nextState.isLocked) {
        return {
          ok: false,
          reason: 'blocked',
          state: nextState,
        };
      }

      return {
        ok: true,
        reason: null,
        state: nextState,
      };
    },
    recordActivity() {
      return dispatch({ type: 'activity' });
    },
    recordFailedUnlock() {
      return dispatch({ type: 'failed-unlock' });
    },
    resetFailures() {
      return dispatch({ type: 'reset-failures' });
    },
    evaluateIdleTimeout() {
      return dispatch({ type: 'tick' });
    },
    attemptUnlock(verify) {
      const result = attemptOfflineUnlock({
        state,
        verify,
        options: policy,
      });
      state = result.state;
      return result;
    },
    async attemptUnlockAsync(verify) {
      const result = await attemptOfflineUnlockAsync({
        state,
        verify,
        options: policy,
      });
      state = result.state;
      return result;
    },
  };
}
