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
        // The idiomatic Swift wrapper. Links libsyncular from `vendor/` via
        // search paths (local-dev mode). unsafeFlags are permitted because this
        // package is only ever built by its own check.sh / a consuming app that
        // knows its linkage — it is not a registry dependency of anything.
        .target(
            name: "Syncular",
            dependencies: ["CSyncularFFI"],
            linkerSettings: [
                .unsafeFlags([
                    "-L", "vendor",
                    "-lsyncular",
                ])
            ]
        ),
        .testTarget(
            name: "SyncularTests",
            dependencies: ["Syncular"]
        ),
    ]
)
