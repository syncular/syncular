# @syncular/client-plugin-offline-auth-react

React hooks for `@syncular/client-plugin-offline-auth`.

Use this package when your app wants provider-agnostic offline auth state persistence and local lock policy wiring through React hooks.

## Install

```bash
npm install @syncular/client-plugin-offline-auth @syncular/client-plugin-offline-auth-react
```

## Example

```ts
import {
  useOfflineAuthState,
  useOfflineLockPolicy,
} from '@syncular/client-plugin-offline-auth-react';

const authState = useOfflineAuthState({
  storage,
  codec,
});

const lock = useOfflineLockPolicy({
  lockOnMount: true,
  idleTimeoutMs: 5 * 60_000,
  trackWindowActivity: true,
});

const result = await lock.attemptUnlockAsync(async () => verifyPinLocally());
if (result.ok) {
  // unlocked
}
```

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
