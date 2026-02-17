# @syncular/transport-ws

WebSocket transport for Syncular realtime wake-ups and presence.

WebSockets are used as a wake-up mechanism; data still flows over HTTP via `@syncular/transport-http` (clients pull after being notified).

## Install

```bash
npm install @syncular/transport-ws
```

## Usage

```ts
import { createWebSocketTransport } from '@syncular/transport-ws';

const transport = createWebSocketTransport({
  baseUrl: 'https://api.example.com',
  getHeaders: () => ({ Authorization: `Bearer ${token}` }),
  // In browsers, WebSocket auth is typically cookie-based (same-origin).
  // If needed, use getRealtimeParams to add non-sensitive query params.
});
```

## Documentation

- Realtime wake-ups: https://syncular.dev/docs/build/realtime
- Presence: https://syncular.dev/docs/build/presence

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
