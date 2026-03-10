// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ClaudeCrew",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ClaudeCrew",
            path: "Sources/ClaudeCrew"
        )
    ]
)
