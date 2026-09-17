// swift-tools-version:5.9
//
// SyncularSwift — an idiomatic Swift wrapper over the syncular-ffi C-ABI native
// core (the five functions in rust/ffi.h). This is a SEPARATE SwiftPM package,
// isolated from the main workspaces exactly like bindings/tauri: it never joins
// `bun run check` / the main cargo gate. Its own gate is `./check.sh`.
//
// Binary linkage — two consumption modes (documented in README.md):
//
//   1. LOCAL DEV (this package's tests): the native core is built by
//      `rust/scripts/build-native.sh` (or `check.sh`, which builds it) and
//      copied to `vendor/`. The `Syncular` target links it via linker search
//      paths pointing at `vendor/`, and the loader finds it at runtime through
//      the same directory (`DYLD_LIBRARY_PATH`, set by check.sh). No Xcode
//      required — a Command-Line-Tools mac builds and links the mac dylib.
//
//   2. RELEASE (a consuming app): swap the `Syncular` target's linkage for the
//      `Syncular.xcframework` that build-native.sh assembles on a full-Xcode
//      machine (iOS device + simulator + macOS slices). Add it as a
//      `.binaryTarget` and drop the `linkerSettings` below. The README carries
//      the exact recipe; this Package.swift keeps the linker-path mode so the
//      hermetic offline tests run on any mac.
import PackageDescription

// The vendored native core, spelled as a path rather than as `-L vendor
// -lsyncular`. This package's own product archive is `libSyncular.a`, which the
// linker name-resolves for `-lsyncular` on a case-insensitive volume, and the
// automatic product search paths precede `vendor/` on the link line. That
// collision links the Swift wrapper archive instead of the C core and fails
// with undefined `_syncular_client_*` / `_syncular_free_string` symbols.
#if os(macOS)
let vendoredCore = "vendor/libsyncular.dylib"
#else
let vendoredCore = "vendor/libsyncular.so"
#endif

let package = Package(
    name: "Syncular",
    platforms: [
        .macOS(.v12),
        .iOS(.v14),
    ],
    products: [
        .library(name: "Syncular", targets: ["Syncular"]),
    ],
    targets: [
        // The C shim: the ffi.h header exposed as a Clang module.
        .target(
            name: "CSyncularFFI"
        ),
        // The idiomatic Swift wrapper. Links the vendored native core
        // (local-dev mode). unsafeFlags are permitted because this package is
        // only ever built by its own check.sh / a consuming app that knows its
        // linkage — it is not a registry dependency of anything.
        .target(
            name: "Syncular",
            dependencies: ["CSyncularFFI"],
            linkerSettings: [
                .unsafeFlags([vendoredCore])
            ]
        ),
        .testTarget(
            name: "SyncularTests",
            dependencies: ["Syncular"]
        ),
    ]
)
