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
    ],
    targets: [
        .binaryTarget(
            name: "SyncularFFI",
            path: "Syncular.xcframework"
        ),
        .target(
            name: "Syncular",
            dependencies: ["SyncularFFI"],
            path: "Sources"
        ),
    ]
)
