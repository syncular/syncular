# @syncular/client

Client-side sync engine for Syncular with offline-first support: local outbox, incremental push/pull, conflict detection, subscriptions/scopes, and optional blobs/plugins.

## Install

```bash
npm install @syncular/client
```

## Documentation

- Client setup: https://syncular.dev/docs/build/client-setup
- Subscriptions (partial sync): https://syncular.dev/docs/introduction/subscriptions
- Commits & conflicts: https://syncular.dev/docs/introduction/commits

## Notes

- Client subscriptions may declare `bootstrapPhase` to stage bootstrap work.
  Lower phases bootstrap first; later phases are deferred until earlier phases
  are ready, while already-ready subscriptions stay live.
- `client.getBootstrapStatus()` reports both the blocking phase readiness and
  the full per-phase bootstrap summary.

## Links

- GitHub: https://github.com/syncular/syncular
- Issues: https://github.com/syncular/syncular/issues

> Status: Alpha. APIs and storage layouts may change between releases.
