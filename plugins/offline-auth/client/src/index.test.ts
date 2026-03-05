import { describe, expect, it } from 'bun:test';
import {
  applyOfflineLockEvent,
  attemptOfflineUnlock,
  attemptOfflineUnlockAsync,
  createMemoryStorageAdapter,
  createSessionCacheEntry,
  createTokenLifecycleBridge,
  getJwtExpiryMs,
  loadOfflineAuthState,
  type OfflineAuthState,
  type OfflineAuthStateCodec,
  type OfflineSubjectIdentity,
  persistOfflineIdentity,
  persistOnlineSession,
  resolveOfflineAuthSubject,
  saveOfflineAuthState,
} from './index';

type DemoSession = {
  actorId: string;
  teamId: string | null;
  token: string;
  expiresAtMs: number;
};

type DemoIdentity = OfflineSubjectIdentity & {
  email: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNullableString(value: unknown): string | null {
  if (value === null) return null;
  return readString(value);
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

const demoCodec: OfflineAuthStateCodec<DemoSession, DemoIdentity> = {
  parseSession(value) {
    if (!isRecord(value)) return null;
    const actorId = readString(value.actorId);
    const teamId = readNullableString(value.teamId);
    const token = readString(value.token);
    const expiresAtMs = readFiniteNumber(value.expiresAtMs);

    if (!actorId || teamId === undefined || !token || expiresAtMs === null) {
      return null;
    }

    return {
      actorId,
      teamId,
      token,
      expiresAtMs,
    };
  },
  parseIdentity(value) {
    if (!isRecord(value)) return null;
    const actorId = readString(value.actorId);
    const teamId = readNullableString(value.teamId);
    const email = readString(value.email);

    if (!actorId || teamId === undefined || !email) {
      return null;
    }

    return {
      actorId,
      teamId,
      email,
    };
  },
};

function encodeJwtWithExp(expSeconds: number): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' })
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString(
    'base64url'
  );
  return `${header}.${payload}.`;
}

describe('@syncular/client-plugin-offline-auth', () => {
  it('extracts JWT exp timestamp from token payload', () => {
    const expirySeconds = Math.floor(Date.now() / 1000) + 3600;
    const token = encodeJwtWithExp(expirySeconds);

    expect(getJwtExpiryMs(token)).toBe(expirySeconds * 1000);
    expect(getJwtExpiryMs('not-a-jwt')).toBeNull();
  });

  it('builds session cache entries from explicit expiry and rejects expired sessions', () => {
    const nowMs = 1_700_000_000_000;
    const fresh = createSessionCacheEntry(
      {
        actorId: 'u1',
        teamId: 't1',
        token: 'token',
        expiresAtMs: nowMs + 10_000,
      },
      {
        nowMs,
        skewMs: 500,
        getExpiresAtMs: (session) => session.expiresAtMs,
      }
    );

    const expired = createSessionCacheEntry(
      {
        actorId: 'u1',
        teamId: 't1',
        token: 'token',
        expiresAtMs: nowMs + 200,
      },
      {
        nowMs,
        skewMs: 500,
        getExpiresAtMs: (session) => session.expiresAtMs,
      }
    );

    expect(fresh?.expiresAtMs).toBe(nowMs + 10_000);
    expect(expired).toBeNull();
  });

  it('persists and reloads typed offline auth state', async () => {
    const storage = createMemoryStorageAdapter();
    const nowMs = 1_700_000_000_000;

    let state: OfflineAuthState<DemoSession, DemoIdentity> = {
      version: 1,
      session: null,
      identity: null,
      lastActorId: null,
    };

    state = persistOnlineSession({
      state,
      session: {
        actorId: 'user-1',
        teamId: 'team-1',
        token: 'jwt-1',
        expiresAtMs: nowMs + 60_000,
      },
      nowMs,
      getSessionActorId: (session) => session.actorId,
      getExpiresAtMs: (session) => session.expiresAtMs,
      deriveIdentity: (session) => ({
        actorId: session.actorId,
        teamId: session.teamId,
        email: 'user-1@example.com',
      }),
    });

    state = persistOfflineIdentity({
      state,
      identity: {
        actorId: 'user-1',
        teamId: 'team-1',
        email: 'user-1@example.com',
      },
      nowMs,
    });

    await saveOfflineAuthState(state, { storage });

    const loaded = await loadOfflineAuthState({
      storage,
      codec: demoCodec,
    });

    expect(loaded.session?.value.actorId).toBe('user-1');
    expect(loaded.identity?.value.email).toBe('user-1@example.com');
    expect(loaded.lastActorId).toBe('user-1');
  });

  it('resolves subject with precedence online session -> offline identity -> last actor', () => {
    const nowMs = 1_700_000_000_000;

    const onlineResolved = resolveOfflineAuthSubject({
      state: {
        version: 1,
        session: {
          value: {
            actorId: 'online-user',
            teamId: 'team-1',
            token: 'jwt',
            expiresAtMs: nowMs + 20_000,
          },
          savedAtMs: nowMs,
          expiresAtMs: nowMs + 20_000,
        },
        identity: {
          value: {
            actorId: 'offline-user',
            teamId: 'team-2',
            email: 'offline@example.com',
          },
          savedAtMs: nowMs,
          expiresAtMs: null,
        },
        lastActorId: 'legacy-user',
      },
      nowMs,
      skewMs: 0,
      getSessionActorId: (session) => session.actorId,
      getSessionTeamId: (session) => session.teamId,
    });

    const offlineResolved = resolveOfflineAuthSubject({
      state: {
        version: 1,
        session: {
          value: {
            actorId: 'online-user',
            teamId: 'team-1',
            token: 'jwt',
            expiresAtMs: nowMs - 1,
          },
          savedAtMs: nowMs,
          expiresAtMs: nowMs - 1,
        },
        identity: {
          value: {
            actorId: 'offline-user',
            teamId: 'team-2',
            email: 'offline@example.com',
          },
          savedAtMs: nowMs,
          expiresAtMs: null,
        },
        lastActorId: 'legacy-user',
      },
      nowMs,
      skewMs: 0,
      getSessionActorId: (session) => session.actorId,
    });

    const fallbackResolved = resolveOfflineAuthSubject({
      state: {
        version: 1,
        session: null,
        identity: null,
        lastActorId: 'legacy-user',
      },
      nowMs,
      getSessionActorId: () => null,
    });

    expect(onlineResolved.source).toBe('online-session');
    expect(onlineResolved.actorId).toBe('online-user');
    expect(offlineResolved.source).toBe('offline-identity');
    expect(offlineResolved.actorId).toBe('offline-user');
    expect(fallbackResolved.source).toBe('last-actor');
    expect(fallbackResolved.actorId).toBe('legacy-user');
  });

  it('clears offline identity and last actor when online session is removed', () => {
    const state: OfflineAuthState<DemoSession, DemoIdentity> = {
      version: 1,
      session: {
        value: {
          actorId: 'user-1',
          teamId: 'team-1',
          token: 'jwt',
          expiresAtMs: 1_700_000_010_000,
        },
        savedAtMs: 1_700_000_000_000,
        expiresAtMs: 1_700_000_010_000,
      },
      identity: {
        value: {
          actorId: 'user-1',
          teamId: 'team-1',
          email: 'user-1@example.com',
        },
        savedAtMs: 1_700_000_000_000,
        expiresAtMs: null,
      },
      lastActorId: 'user-1',
    };

    const cleared = persistOnlineSession({
      state,
      session: null,
      getSessionActorId: (session) => session.actorId,
    });

    expect(cleared).toEqual({
      version: 1,
      session: null,
      identity: null,
      lastActorId: null,
    });
  });

  it('creates token lifecycle bridge with single-flight refresh and custom retry', async () => {
    let token = 'initial';
    let refreshCalls = 0;

    const bridge = createTokenLifecycleBridge({
      resolveToken: async () => token,
      refreshToken: async () => {
        refreshCalls += 1;
        token = refreshCalls === 1 ? 'refreshed' : token;
        return token;
      },
      retryWithFreshToken: ({ refreshResult, previousToken, nextToken }) => {
        return refreshResult && previousToken !== nextToken;
      },
    });

    const headersBefore = await bridge.getAuthorizationHeaders();
    expect(headersBefore.Authorization).toBe('Bearer initial');

    const refreshA = bridge.authLifecycle.refreshToken?.({
      operation: 'sync',
      status: 401,
    });
    const refreshB = bridge.authLifecycle.refreshToken?.({
      operation: 'sync',
      status: 401,
    });

    expect(await Promise.all([refreshA, refreshB])).toEqual([true, true]);
    expect(refreshCalls).toBe(1);

    const shouldRetry = await bridge.authLifecycle.retryWithFreshToken?.({
      operation: 'sync',
      status: 401,
      refreshResult: true,
    });

    expect(shouldRetry).toBe(true);
  });

  it('applies lock policy with failed attempts, cooldown, and idle locking', () => {
    let nowMs = 1_700_000_000_000;
    const options = {
      now: () => nowMs,
      maxFailedAttempts: 2,
      cooldownMs: 10_000,
      idleTimeoutMs: 5_000,
    };

    const state = {
      isLocked: true,
      failedAttempts: 0,
      blockedUntilMs: null,
      lastActivityAtMs: nowMs,
    };

    const firstFailure = attemptOfflineUnlock({
      state,
      verify: () => false,
      options,
      nowMs,
    });
    expect(firstFailure.ok).toBe(false);
    expect(firstFailure.reason).toBe('rejected');

    const secondFailure = attemptOfflineUnlock({
      state: firstFailure.state,
      verify: () => false,
      options,
      nowMs,
    });
    expect(secondFailure.ok).toBe(false);
    expect(secondFailure.reason).toBe('blocked');

    const blockedAttempt = attemptOfflineUnlock({
      state: secondFailure.state,
      verify: () => true,
      options,
      nowMs,
    });
    expect(blockedAttempt.ok).toBe(false);
    expect(blockedAttempt.reason).toBe('blocked');

    nowMs += 10_001;
    const unlockAfterCooldown = attemptOfflineUnlock({
      state: secondFailure.state,
      verify: () => true,
      options,
      nowMs,
    });

    expect(unlockAfterCooldown.ok).toBe(true);
    expect(unlockAfterCooldown.state.isLocked).toBe(false);

    const active = applyOfflineLockEvent(
      unlockAfterCooldown.state,
      { type: 'activity', nowMs },
      options
    );

    const idleLocked = applyOfflineLockEvent(
      active,
      { type: 'tick', nowMs: nowMs + 5_001 },
      options
    );

    expect(idleLocked.isLocked).toBe(true);
  });

  it('supports async unlock verification for app-managed PIN checks', async () => {
    const nowMs = 1_700_000_000_000;
    const state = {
      isLocked: true,
      failedAttempts: 0,
      blockedUntilMs: null,
      lastActivityAtMs: nowMs,
    };

    const result = await attemptOfflineUnlockAsync({
      state,
      verify: async () => true,
      options: { now: () => nowMs },
      nowMs,
    });

    expect(result.ok).toBe(true);
    expect(result.state.isLocked).toBe(false);
  });
});
