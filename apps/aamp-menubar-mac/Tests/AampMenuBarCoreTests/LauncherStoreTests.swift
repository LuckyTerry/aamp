import XCTest
import Foundation
@testable import AampMenuBarCore

final class LauncherStoreTests: XCTestCase {
    func testActiveScriptUsesBundledScriptWhenNoCacheExists() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)

        let script = try store.activeScript()

        XCTAssertEqual(script.version, LauncherSettings.bundledLauncherVersion)
        XCTAssertEqual(script.source, .bundled)
        XCTAssertEqual(script.url, fixture.bundledScript)
    }

    func testInstallingAndActivatingCachedScriptWinsOverBundledScript() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)
        let data = Data("#!/usr/bin/env bash\nset -euo pipefail\nprintf 'cached\\n'\n".utf8)

        let installed = try store.installCachedScript(version: "0.1.0-dev.139", data: data)
        try store.activateCachedVersion("0.1.0-dev.139")

        let active = try store.activeScript()
        XCTAssertEqual(installed.source, .cached)
        XCTAssertEqual(active.version, "0.1.0-dev.139")
        XCTAssertEqual(active.source, .cached)
        XCTAssertTrue(FileManager.default.fileExists(atPath: active.url.path))
        #if os(macOS)
        if let attributes = try? FileManager.default.attributesOfItem(atPath: installed.url.path),
           let permissions = attributes[.posixPermissions] as? NSNumber {
            XCTAssertEqual(permissions.intValue & 0o111, 0o111)
        } else {
            XCTFail("Failed to read file permissions for cached launcher")
        }
        #endif

        let activeMetadata = try Data(contentsOf: fixture.paths.activeLauncherMetadata)
        let json = try JSONSerialization.jsonObject(with: activeMetadata, options: [])
        let dict = try XCTUnwrap(json as? [String: Any])
        let activatedVersion = try XCTUnwrap(dict["version"] as? String)
        XCTAssertEqual(activatedVersion, "0.1.0-dev.139")
    }

    func testCorruptActiveMetadataFallsBackToBundledScript() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)
        let version = "0.1.0-dev.139"
        let cachedRoot = fixture.paths.cachedLauncherRoot.appendingPathComponent(version, isDirectory: true)
        try FileManager.default.createDirectory(at: cachedRoot, withIntermediateDirectories: true)
        try Data("#!/usr/bin/env bash\nset -euo pipefail\nprintf 'cached\\n'\n".utf8)
            .write(to: cachedRoot.appendingPathComponent("aamp-feishu-task-agent-bootstrap.sh"))
        try Data("{{invalid-json}".utf8).write(to: fixture.paths.activeLauncherMetadata)

        let active = try store.activeScript()
        XCTAssertEqual(active.source, .bundled)
        XCTAssertEqual(active.version, LauncherSettings.bundledLauncherVersion)
    }

    func testRejectsOnlyShebangScriptInstall() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)

        XCTAssertThrowsError(try store.installCachedScript(version: "0.1.0-dev.139", data: Data("#!/usr/bin/env bash\n".utf8)))
    }

    func testRejectsOnlySetEuoPipefailScriptInstall() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)

        XCTAssertThrowsError(try store.installCachedScript(version: "0.1.0-dev.139", data: Data("set -euo pipefail\n".utf8)))
    }

    func testInvalidCachedScriptFallsBackToBundledScript() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)
        let versionRoot = fixture.paths.cachedLauncherRoot.appendingPathComponent("bad", isDirectory: true)
        try FileManager.default.createDirectory(at: versionRoot, withIntermediateDirectories: true)
        try Data("not a shell script".utf8).write(to: versionRoot.appendingPathComponent("aamp-feishu-task-agent-bootstrap.sh"))
        try Data("{\"version\":\"bad\"}".utf8).write(to: fixture.paths.activeLauncherMetadata)

        let active = try store.activeScript()

        XCTAssertEqual(active.source, .bundled)
        XCTAssertEqual(active.version, LauncherSettings.bundledLauncherVersion)
    }

    func testRejectsEmptyScriptInstall() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)

        XCTAssertThrowsError(try store.installCachedScript(version: "0.1.0-dev.139", data: Data()))
    }

    private func makeFixture() throws -> (paths: AppPaths, bundledScript: URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("LauncherStoreTests")
            .appendingPathComponent(UUID().uuidString)
        let home = root.appendingPathComponent("home")
        let appSupport = root.appendingPathComponent("Application Support")
        let paths = AppPaths(homeDirectory: home, applicationSupportDirectory: appSupport)
        let bundledScript = root.appendingPathComponent("bundled.sh")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("#!/usr/bin/env bash\nset -euo pipefail\nprintf 'bundled\\n'\n".utf8).write(to: bundledScript)
        return (paths, bundledScript)
    }
}
