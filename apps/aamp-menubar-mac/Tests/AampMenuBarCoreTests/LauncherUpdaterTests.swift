import XCTest
import Foundation
@testable import AampMenuBarCore

final class LauncherUpdaterTests: XCTestCase {
    func testFindsNewerVersionFromNpmMetadata() throws {
        let metadata = Data("""
        {
          "versions": {
            "0.1.0-dev.138": { "dist": { "tarball": "https://example.com/138.tgz" } },
            "0.1.0-dev.139": { "dist": { "tarball": "https://example.com/139.tgz" } }
          }
        }
        """.utf8)

        let update = try LauncherUpdater.newerVersion(from: metadata, currentVersion: "0.1.0-dev.138")

        XCTAssertEqual(update?.version, "0.1.0-dev.139")
        XCTAssertEqual(update?.tarballURL.absoluteString, "https://example.com/139.tgz")
    }

    func testReturnsNilWhenCurrentVersionIsNewest() throws {
        let metadata = Data("""
        {
          "versions": {
            "0.1.0-dev.138": { "dist": { "tarball": "https://example.com/138.tgz" } }
          }
        }
        """.utf8)

        let update = try LauncherUpdater.newerVersion(from: metadata, currentVersion: "0.1.0-dev.138")

        XCTAssertNil(update)
    }

    func testExtractsBootstrapFromTarball() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("LauncherUpdaterTests")
            .appendingPathComponent(UUID().uuidString)
        let packageRoot = root.appendingPathComponent("package/bootstrap", isDirectory: true)
        try FileManager.default.createDirectory(at: packageRoot, withIntermediateDirectories: true)
        let script = packageRoot.appendingPathComponent("aamp-feishu-task-agent-bootstrap.sh")
        try Data("#!/usr/bin/env bash\nset -euo pipefail\nprintf 'ok\\n'\n".utf8).write(to: script)

        let tarball = root.appendingPathComponent("package.tgz")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-czf", tarball.path, "-C", root.path, "package"]
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)

        let data = try LauncherUpdater.extractBootstrap(fromTarball: tarball)

        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("set -euo pipefail"))
    }
}
