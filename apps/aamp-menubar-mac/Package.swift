// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AampMenuBar",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(name: "AampMenuBarCore", targets: ["AampMenuBarCore"]),
        .executable(name: "AampMenuBar", targets: ["AampMenuBarApp"])
    ],
    targets: [
        .target(name: "AampMenuBarCore"),
        .executableTarget(
            name: "AampMenuBarApp",
            dependencies: ["AampMenuBarCore"],
            resources: [
                .copy("Resources")
            ]
        ),
        .testTarget(
            name: "AampMenuBarCoreTests",
            dependencies: ["AampMenuBarCore"]
        )
    ]
)
