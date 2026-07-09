import XCTest
import Foundation
@testable import AampMenuBarCore

final class LauncherProcessTests: XCTestCase {
    func testCommandBuilderIncludesExpectedArguments() {
        let settings = LauncherSettings(
            agent: .codem,
            environment: .boe,
            boeEnvironmentName: "boe_custom",
            aampHost: URL(string: "https://meshmail.ai")!,
            debugMode: true,
            launcherVersion: "0.1.0-dev.138",
            checkForUpdatesOnLaunch: true,
            startAtLogin: false
        )

        let arguments = LauncherCommandBuilder.arguments(for: settings)

        XCTAssertEqual(arguments, [
            "--agent", "codem",
            "--env", "boe",
            "--aamp-host", "https://meshmail.ai",
            "--boe-env-name", "boe_custom",
            "--debug"
        ])
    }

    func testFakeBootstrapTransitionsToRunning() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        printf '🟢 codex 已接入飞书任务，可以开始对话 & 派发任务。\\n'
        sleep 30
        """)
        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let expectation = expectation(description: "running state")
        var observed: [RuntimeState] = []

        try process.start(script: fixture.script, settings: .defaults) { state in
            observed.append(state)
            if state == .running {
                expectation.fulfill()
            }
        }

        wait(for: [expectation], timeout: 5)
        process.stop()

        XCTAssertTrue(observed.contains(.starting))
        XCTAssertTrue(observed.contains(.running))
    }

    func testFakeBootstrapFailureTransitionsToError() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        printf 'boom\\n' >&2
        exit 3
        """)
        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let expectation = expectation(description: "error state")

        try process.start(script: fixture.script, settings: .defaults) { state in
            if case .error = state {
                expectation.fulfill()
            }
        }

        wait(for: [expectation], timeout: 5)
    }

    private func makeFixture(scriptBody: String) throws -> (paths: AppPaths, script: URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("LauncherProcessTests")
            .appendingPathComponent(UUID().uuidString)
        let home = root.appendingPathComponent("home")
        let appSupport = root.appendingPathComponent("Application Support")
        let paths = AppPaths(homeDirectory: home, applicationSupportDirectory: appSupport)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let script = root.appendingPathComponent("fake-bootstrap.sh")
        try Data(scriptBody.utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return (paths, script)
    }
}
