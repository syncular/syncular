// swift-tools-version:5.9
//
// The syncular Swift todo demo — proves the SyncularClient wrapper drives a
// real app end-to-end against a real server. TWO executables share one
// integration (TodoKit):
//
//   • TodoUI  — a SwiftUI macOS WINDOW (NSApplication + NSHostingView), the
//               headline demo. It compiles, links, and presents a real window
//               on a Command-Line-Tools-only mac — no full Xcode needed.
//   • todo    — a terminal app (readLine loop) that drives the same store from
//               stdin, so it scripts deterministically (the CI smoke + the
//               local end-to-end sync proof pipe commands into it).
//
// Linkage mirrors the wrapper's local-dev mode: the native-transport
// libsyncular is vendored into this package's vendor/ (check.sh builds it),
// and both executables link it via a -L search path; the loader finds it at
// runtime through DYLD_LIBRARY_PATH=vendor (set by check.sh / the run recipe).
// A shipping .app would instead consume the Syncular.xcframework binaryTarget
// (see the swift bindings README) — the app code is identical either way.
import PackageDescription

let linkVendoredCore: [LinkerSetting] = [
    .unsafeFlags(["-L", "vendor", "-lsyncular"])
]

let package = Package(
    name: "SyncularTodoExample",
    platforms: [
        .macOS(.v13),
    ],
    dependencies: [
        // The Swift bindings package one level up.
        .package(path: ".."),
    ],
    targets: [
        // The shared syncular integration — the ~30-line surface both apps use.
        .target(
            name: "TodoKit",
            dependencies: [.product(name: "Syncular", package: "swift")]
        ),
        // The SwiftUI window app.
        .executableTarget(
            name: "TodoUI",
            dependencies: ["TodoKit", .product(name: "Syncular", package: "swift")],
            linkerSettings: linkVendoredCore
        ),
        // The terminal app.
        .executableTarget(
            name: "todo",
            dependencies: ["TodoKit", .product(name: "Syncular", package: "swift")],
            linkerSettings: linkVendoredCore
        ),
    ]
)
