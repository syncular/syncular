# Platform specifics (Swift)

Reference for the Swift wrapper's linkage, threading, transport policy, and error surface.

::meta{for="Swift developers shipping or debugging a build" time="6 minutes"}

## Package and platforms

| Item | Value |
|---|---|
| Package | `Syncular` (SwiftPM tools 5.9), products: library `Syncular` |
| Minimum OS | macOS 12, iOS 14 |
| Targets | `CSyncularFFI` (Clang module over the header), `Syncular` (wrapper) |
| Header | `Sources/CSyncularFFI/include/syncular_ffi.h`, byte-identical to `rust/ffi.h`; `./check.sh` fails on drift |
| Package gate | `./check.sh`: header check, lean dylib build, `swift build`, `swift test` |
| CI | The Swift gate runs locally only; it needs a macOS runner |

A Command-Line-Tools-only Mac builds and tests the macOS slice. Only the xcframework build needs full Xcode. `Package.swift` links the vendored dylib by path, not `-lsyncular`, because `-lsyncular` resolves to the package's own `libSyncular.a` on a case-insensitive volume and fails with undefined `_syncular_client_*` symbols.

## Threading

| Work | Where it runs |
|---|---|
| Commands | One private serial queue, `syncular.command`, from any calling thread |
| Event poll | `syncular.poll`, 25 ms `poll_event` waits |
| Event delivery | `deliveryQueue` (`.main` by default) |

The core is thread-affine, which the serial queue satisfies. Never call the C functions directly.

## Transport policy

`SyncularConfig` carries the native transport bounds. `nil` leaves a bound off.

| Field | Type | Effect |
|---|---|---|
| `requestTimeoutMs` | `UInt64?` | End-to-end deadline for one HTTP request; expiry returns `transport.timeout` |
| `roundDeadlineMs` | `UInt64?` | One deadline for a whole sync round; expiry returns `transport.timeout` |
| `maxRequestBytes` | `UInt64?` | Larger request bodies fail with `transport.request_too_large` before any I/O |
| `maxResponseBytes` | `UInt64?` | Larger decoded responses fail with `transport.response_too_large` |
| `redirects` | `String?` | `"deny"` (default) or `"follow"`; `"follow"` applies only to a request with no headers |

The wrapper sends each bound as an exact `UInt64` (`JSONValue.unsigned`). An invalid policy fails construction. [Rust: Platform specifics](/platform-rust-specifics/#native-transport-policy) gives the full semantics, including the WebSocket handshake rule.

## Errors and results

`SyncularError` carries a stable `code` and a `message`. The initializer throws `client.failed` when `syncular_client_new` returns NULL: a malformed config, or a `baseUrl` on a core built without `native-transport`. A command after `close()` throws `client.closed`. A reply the wrapper cannot decode throws `client.invalid_host_response`.

## JSON values

`JSONValue` is the wrapper's JSON model: `.null`, `.bool`, `.number(Double)`, `.unsigned(UInt64)`, `.string`, `.array`, `.object`. Bytes travel as `{"$bytes": "<lowercase-hex>"}`. `statusSnapshot()` and other snapshot methods return a `JSONValue`; index it with `status["leaseState"]`.

## Example app

[`bindings/swift/example`](https://github.com/syncular/syncular/tree/main/bindings/swift/example) holds a SwiftUI macOS window (`TodoUI`) and a terminal app (`todo`) over one 30-line store. Both run against the quickstart server; set `SYNCULAR_URL` and `DYLD_LIBRARY_PATH` as its README describes.
