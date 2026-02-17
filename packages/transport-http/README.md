# @syncular/transport-http

HTTP transport for Syncular using a typed OpenAPI client. Used by `@syncular/client` to push and pull commits, and to upload/download blobs.

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

## Documentation

- How sync works (push/pull): https://syncular.dev/docs/introduction/architecture
- API reference: https://syncular.dev/docs/api/postSync

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
