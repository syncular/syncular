# @syncular/client-plugin-offline-auth

Provider-agnostic offline auth primitives for JavaScript runtimes.

This package intentionally does **not** implement OAuth/provider flows. It gives you reusable building blocks for:

- Offline session + identity cache shape
- JWT/expiry checks
- Offline subject resolution (online session -> offline identity -> last actor)
- Bearer token/auth lifecycle bridge for Syncular transports
- Local lock policy state machine (framework-agnostic)

Behavior defaults are fail-closed:

- Calling `persistOnlineSession({ session: null, ... })` clears cached session, cached offline identity, and last actor.
- Lock APIs expose `forceUnlock()` for explicit unlock bypass and `attemptUnlock(verify)` / `attemptUnlockAsync(verify)` for app-managed PIN/passcode checks.

## Install

```bash
npm install @syncular/client-plugin-offline-auth
```

## JavaScript primitives

```ts
import {
  createMemoryStorageAdapter,
  loadOfflineAuthState,
  persistOnlineSession,
  resolveOfflineAuthSubject,
} from '@syncular/client-plugin-offline-auth';

const storage = createMemoryStorageAdapter();
const state = await loadOfflineAuthState({
  storage,
  codec: {
    parseSession: (value) => (typeof value === 'object' && value ? value : null),
    parseIdentity: (value) =>
      typeof value === 'object' && value && 'actorId' in value ? value : null,
  },
});

const next = persistOnlineSession({
  state,
  session,
  getSessionActorId: (s) => s.user.id,
  getExpiresAtMs: (s) => s.expiresAtMs,
  deriveIdentity: (s) => ({ actorId: s.user.id, teamId: s.teamId }),
});

const subject = resolveOfflineAuthSubject({
  state: next,
  getSessionActorId: (s) => s.user.id,
  getSessionTeamId: (s) => s.teamId,
});
```

## Transport token/auth lifecycle bridge

```ts
import { createTokenLifecycleBridge } from '@syncular/client-plugin-offline-auth';

const tokenBridge = createTokenLifecycleBridge({
  resolveToken: async () => authState.state.session?.value.sessionJwt ?? null,
});

const transport = createWebSocketTransport({
  baseUrl: '/api',
  getHeaders: tokenBridge.getAuthorizationHeaders,
  getRealtimeParams: tokenBridge.getRealtimeParams,
  authLifecycle: tokenBridge.authLifecycle,
});
```

For React hooks, install and import from `@syncular/client-plugin-offline-auth-react`.

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
