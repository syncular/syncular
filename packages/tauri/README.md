# @syncular/tauri

Tauri integration for the Syncular client.

Install the bridge together with its required Tauri JavaScript API peer:

```sh
bun add @syncular/tauri @tauri-apps/api
```

Reactive snapshots use the plugin's independent read-only SQLite path, so
local Tauri views remain responsive while the native client is syncing over
HTTP/WebSocket. Mutations, sync, and all durable writes remain serialized on
the single mutable core owner.

The bridge includes the native core's durable commit-outcome journal:
`commitOutcome`, `commitOutcomes`, and `resolveCommitOutcome`. Final results
and explicit conflict resolutions survive process restarts; active failures
are never silently removed by retention. Failed outcomes retain their complete
ordered local operation envelope for authorized aggregate recovery with the
same protected-storage and retention contract as the core client.

Part of [Syncular](https://syncular.dev) — an offline-first sync framework.
See the [Syncular repository](https://github.com/syncular/syncular) for docs.

## License

Apache-2.0
