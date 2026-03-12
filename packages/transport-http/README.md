# @syncular/transport-http

HTTP transport for Syncular using a typed OpenAPI client. Used by `@syncular/client` for push/pull sync, and by optional features like `@syncular/client-plugin-blob` for blob upload/download flows.

## Install

```bash
npm install @syncular/transport-http
```

## Usage

```ts
import { createHttpTransport } from '@syncular/transport-http';

const transport = createHttpTransport({
  baseUrl: 'https://api.example.com',
  getHeaders: () => ({ Authorization: `Bearer ${token}` }),
  authLifecycle: {
    onAuthExpired: ({ operation, status }) => {
      console.warn('Auth expired', operation, status);
    },
    refreshToken: async () => auth.refreshToken(),
    retryWithFreshToken: ({ refreshResult }) => refreshResult,
  },
});
```

## React Native / Expo

Use the built-in React Native preset instead of manually tuning transport
capabilities for Hermes / Expo:

```ts
import { createReactNativeHttpTransport } from '@syncular/transport-http';

const transport = createReactNativeHttpTransport({
  baseUrl: 'https://api.example.com',
  getHeaders: () => ({ Authorization: `Bearer ${token}` }),
});
```

This preset enables:

- byte-based snapshot chunk fetches instead of `ReadableStream`
- buffered gzip decompression fallback
- per-subscription bootstrap commits
- materialized snapshot application preferred for mobile runtimes

## Documentation

- How sync works (push/pull): https://syncular.dev/docs/introduction/architecture
- API reference: https://syncular.dev/docs/api/postSync

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
