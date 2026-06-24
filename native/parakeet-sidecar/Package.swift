// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "parakeet-sidecar",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "parakeet-sidecar",
            path: "Sources/parakeet-sidecar",
            swiftSettings: [
                .unsafeFlags(["-Ounchecked"], .when(configuration: .release))
            ]
        )
    ]
)
