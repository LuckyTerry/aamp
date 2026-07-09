import XCTest
import Foundation
@testable import AampMenuBarCore

final class SettingsStoreTests: XCTestCase {
    func testDefaultsMatchOneClickLauncher() throws {
        let suiteName = "SettingsStoreTests.defaults.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = SettingsStore(defaults: defaults)
        let settings = store.load()

        XCTAssertEqual(settings.agent, .codex)
        XCTAssertEqual(settings.environment, .online)
        XCTAssertEqual(settings.boeEnvironmentName, "boe_task_event")
        XCTAssertEqual(settings.aampHost.absoluteString, "https://meshmail.ai")
        XCTAssertTrue(settings.debugMode)
        XCTAssertEqual(settings.launcherVersion, "0.1.0-dev.138")
    }

    func testSaveAndLoadRoundTrip() throws {
        let suiteName = "SettingsStoreTests.roundtrip.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = SettingsStore(defaults: defaults)
        let original = LauncherSettings(
            agent: .codem,
            environment: .boe,
            boeEnvironmentName: "boe_custom",
            aampHost: URL(string: "https://example.com")!,
            debugMode: false,
            launcherVersion: "0.1.0-dev.139",
            checkForUpdatesOnLaunch: false,
            startAtLogin: true
        )

        store.save(original)

        XCTAssertEqual(store.load(), original)
    }
}
