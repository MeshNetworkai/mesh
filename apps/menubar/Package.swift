// swift-tools-version: 5.9
// Mesh Node menu-bar app. Open this folder in Xcode (File > Open) or use the Makefile.
import PackageDescription

let package = Package(
    name: "MeshNode",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "MeshNode", targets: ["MeshNode"]),
        .library(name: "MeshNodeCore", targets: ["MeshNodeCore"]),
    ],
    targets: [
        // Pure Foundation: config/stats parsing, status derivation, formatting. No AppKit, so it
        // compiles and tests on Linux too.
        .target(
            name: "MeshNodeCore",
            path: "Sources/MeshNodeCore"
        ),
        // The SwiftUI MenuBarExtra app (macOS only).
        .executableTarget(
            name: "MeshNode",
            dependencies: ["MeshNodeCore"],
            path: "Sources/MeshNode"
        ),
        .testTarget(
            name: "MeshNodeCoreTests",
            dependencies: ["MeshNodeCore"],
            path: "Tests/MeshNodeCoreTests"
        ),
    ]
)
