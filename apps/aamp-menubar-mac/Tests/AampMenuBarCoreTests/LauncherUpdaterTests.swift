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

    func testPrefersReleaseOverPrereleaseWithSameCoreVersion() throws {
        let metadata = Data("""
        {
          "versions": {
            "0.1.0-dev.999": { "dist": { "tarball": "https://example.com/dev.tgz" } },
            "0.1.0": { "dist": { "tarball": "https://example.com/release.tgz" } }
          }
        }
        """.utf8)

        let update = try LauncherUpdater.newerVersion(from: metadata, currentVersion: "0.1.0-dev.999")

        XCTAssertEqual(update?.version, "0.1.0")
        XCTAssertEqual(update?.tarballURL.absoluteString, "https://example.com/release.tgz")
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

    func testThrowsInvalidMetadataForInvalidJSON() {
        XCTAssertThrowsError(try LauncherUpdater.newerVersion(from: Data("{".utf8), currentVersion: "0.1.0-dev.138")) { error in
            assertInvalidMetadata(error)
        }
    }

    func testThrowsInvalidMetadataForInvalidTarballURL() {
        let metadata = Data("""
        {
          "versions": {
            "0.1.0-dev.139": { "dist": { "tarball": "not-a-url" } }
          }
        }
        """.utf8)

        XCTAssertThrowsError(try LauncherUpdater.newerVersion(from: metadata, currentVersion: "0.1.0-dev.138")) { error in
            assertInvalidMetadata(error)
        }
    }

    private func assertInvalidMetadata(_ error: Error, file: StaticString = #filePath, line: UInt = #line) {
        guard let updaterError = error as? LauncherUpdaterError else {
            XCTFail("Expected LauncherUpdaterError.invalidMetadata, got \(error)", file: file, line: line)
            return
        }
        guard case .invalidMetadata = updaterError else {
            XCTFail("Expected LauncherUpdaterError.invalidMetadata, got \(updaterError)", file: file, line: line)
            return
        }
    }
}
