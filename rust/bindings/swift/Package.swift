// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Syncular",
    platforms: [
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "Syncular",
            targets: ["Syncular"]
        ),
        .library(
            name: "SyncularUI",
            targets: ["SyncularUI"]
        ),
    ],
    targets: [
        .binaryTarget(
            name: "SyncularFFI",
            path: "Syncular.xcframework"
        ),
        .target(
            name: "Syncular",
            dependencies: ["SyncularFFI"],
            path: "Sources/BoltFFI"
        ),
        .target(
            name: "SyncularUI",
            dependencies: ["Syncular"],
            path: "Sources/SyncularUI"
        ),
    ]
)
