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

    func testCommandBuilderOmitsBoeAndDebugArgumentsForRegularLaunch() {
        let settings = LauncherSettings(
            agent: .gemini,
            environment: .pre,
            boeEnvironmentName: "ignored_boe",
            aampHost: URL(string: "https://example.com")!,
            debugMode: false,
            launcherVersion: "0.1.0-dev.138",
            checkForUpdatesOnLaunch: true,
            startAtLogin: false
        )

        let arguments = LauncherCommandBuilder.arguments(for: settings)

        XCTAssertEqual(arguments, [
            "--agent", "gemini",
            "--env", "pre",
            "--aamp-host", "https://example.com"
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

    func testExitZeroBeforeReadinessTransitionsToError() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        exit 0
        """)
        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let terminalState = expectation(description: "terminal state")
        var observed: [RuntimeState] = []

        try process.start(script: fixture.script, settings: .defaults) { state in
            observed.append(state)
            if case .error = state {
                terminalState.fulfill()
            } else if state == .stopped {
                terminalState.fulfill()
            }
        }

        wait(for: [terminalState], timeout: 2)

        XCTAssertTrue(observed.contains { state in
            if case .error = state {
                return true
            }
            return false
        })
        XCTAssertFalse(observed.contains(.stopped))
    }

    func testLateReadinessMarkerAfterStartupTimeoutDoesNotTransitionToRunning() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        sleep 0.6
        printf 'bridge.task_runtime.running\\n'
        sleep 30
        """)
        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 0.2)
        let timeoutError = expectation(description: "startup timeout")
        let lateRunning = expectation(description: "late running")
        lateRunning.isInverted = true
        var didTimeout = false

        try process.start(script: fixture.script, settings: .defaults) { state in
            if case .error = state {
                didTimeout = true
                timeoutError.fulfill()
            } else if state == .running && didTimeout {
                lateRunning.fulfill()
            }
        }

        wait(for: [timeoutError], timeout: 2)
        wait(for: [lateRunning], timeout: 1.2)
        process.stop()
    }

    func testBridgeLogMarkerTransitionsToRunning() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        sleep 30
        """)
        try FileManager.default.createDirectory(
            at: fixture.paths.aampFeishuBridgeRoot,
            withIntermediateDirectories: true
        )
        let bridgeLog = fixture.paths.aampFeishuBridgeRoot.appendingPathComponent("bridge.log")
        try Data("booting\\n".utf8).write(to: bridgeLog)

        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let expectation = expectation(description: "running from bridge log")

        try process.start(script: fixture.script, settings: .defaults) { state in
            if state == .running {
                expectation.fulfill()
            }
        }

        try FileHandle(forWritingTo: bridgeLog).closeAfterWriting("bridge.task_runtime.running\n")

        wait(for: [expectation], timeout: 3)
        process.stop()
    }

    func testExistingBridgeLogMarkerIsIgnoredUntilNewContentArrives() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        sleep 30
        """)
        try FileManager.default.createDirectory(
            at: fixture.paths.aampFeishuBridgeRoot,
            withIntermediateDirectories: true
        )
        let bridgeLog = fixture.paths.aampFeishuBridgeRoot.appendingPathComponent("bridge.log")
        try Data("bridge.task_runtime.running\n".utf8).write(to: bridgeLog)

        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let staleRunning = expectation(description: "stale bridge marker ignored")
        staleRunning.isInverted = true
        let appendedRunning = expectation(description: "appended bridge marker")
        var didAppend = false

        try process.start(script: fixture.script, settings: .defaults) { state in
            if state == .running && didAppend {
                appendedRunning.fulfill()
            } else if state == .running {
                staleRunning.fulfill()
            }
        }

        wait(for: [staleRunning], timeout: 0.7)
        didAppend = true
        try FileHandle(forWritingTo: bridgeLog).closeAfterWriting("[feishu ws] connected\n")

        wait(for: [appendedRunning], timeout: 3)
        process.stop()
    }

    func testBridgeLogReadsAppendedContentFromAllCandidates() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        sleep 30
        """)
        try FileManager.default.createDirectory(
            at: fixture.paths.aampFeishuBridgeRoot,
            withIntermediateDirectories: true
        )
        let activeLog = fixture.paths.aampFeishuBridgeRoot.appendingPathComponent("active.log")
        let secondaryLog = fixture.paths.aampFeishuBridgeRoot.appendingPathComponent("secondary.log")
        try Data("active boot\n".utf8).write(to: activeLog)
        try Data("secondary boot\n".utf8).write(to: secondaryLog)

        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let running = expectation(description: "running from secondary bridge log")

        try process.start(script: fixture.script, settings: .defaults) { state in
            if state == .running {
                running.fulfill()
            }
        }

        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.4))
        try FileHandle(forWritingTo: secondaryLog).closeAfterWriting("bridge.task_runtime.running\n")
        try FileHandle(forWritingTo: activeLog).closeAfterWriting("still booting\n")

        wait(for: [running], timeout: 3)
        process.stop()
    }

    func testSplitUTF8ReadinessMarkerTransitionsToRunning() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        printf '\\345\\267'
        sleep 0.2
        printf '\\262接入飞书任务，可以开始对话 & 派发任务\\n'
        sleep 30
        """)
        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let running = expectation(description: "running from split utf8 marker")

        try process.start(script: fixture.script, settings: .defaults) { state in
            if state == .running {
                running.fulfill()
            }
        }

        wait(for: [running], timeout: 3)
        process.stop()
    }

    func testRapidRestartDoesNotLetOldTerminationClearNewProcess() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        sleep 0.1
        exit 0
        """)
        let secondScript = fixture.script.deletingLastPathComponent().appendingPathComponent("second-bootstrap.sh")
        try Data("""
        #!/usr/bin/env bash
        set -euo pipefail
        sleep 0.2
        printf 'bridge.task_runtime.running\\n'
        sleep 30
        """.utf8).write(to: secondScript)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: secondScript.path)

        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let secondRunning = expectation(description: "second run reaches running")
        var sawSecondStart = false

        try process.start(script: fixture.script, settings: .defaults) { _ in }

        waitUntil("first process exits before restart", timeout: 2) {
            process.isRunning == false
        }

        try process.start(script: secondScript, settings: .defaults) { state in
            if state == .starting {
                sawSecondStart = true
            } else if state == .running && sawSecondStart {
                secondRunning.fulfill()
            }
        }

        wait(for: [secondRunning], timeout: 3)
        process.stop()
    }

    func testStdoutAndStderrAreWrittenToRunLogs() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        printf 'stdout payload\\n'
        printf 'stderr payload\\n' >&2
        printf 'bridge.task_runtime.running\\n'
        sleep 30
        """)
        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let running = expectation(description: "running state")

        try process.start(script: fixture.script, settings: .defaults) { state in
            if state == .running {
                running.fulfill()
            }
        }

        wait(for: [running], timeout: 3)

        waitUntil("stdout and stderr logs are written", timeout: 2) {
            guard let contents = try? self.runLogContents(in: fixture.paths) else {
                return false
            }
            return contents.stdout.contains("stdout payload")
                && contents.stderr.contains("stderr payload")
        }

        process.stop()
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

    private func waitUntil(
        _ description: String,
        timeout: TimeInterval,
        pollInterval: TimeInterval = 0.05,
        condition: () -> Bool
    ) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() {
                return
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(pollInterval))
        }

        XCTAssertTrue(condition(), description)
    }

    private func runLogContents(in paths: AppPaths) throws -> (stdout: String, stderr: String) {
        let runDirectories = try FileManager.default.contentsOfDirectory(
            at: paths.appRunRoot,
            includingPropertiesForKeys: nil
        )
        let runDirectory = try XCTUnwrap(runDirectories.first)
        let stdout = try String(contentsOf: runDirectory.appendingPathComponent("stdout.log"), encoding: .utf8)
        let stderr = try String(contentsOf: runDirectory.appendingPathComponent("stderr.log"), encoding: .utf8)
        return (stdout, stderr)
    }
}

private extension FileHandle {
    func closeAfterWriting(_ text: String) throws {
        defer {
            try? close()
        }
        seekToEndOfFile()
        try write(contentsOf: Data(text.utf8))
    }
}
