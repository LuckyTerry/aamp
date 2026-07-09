import XCTest
import Foundation
@testable import AampMenuBarCore

final class AppPathsTests: XCTestCase {
    func testPathsUseApplicationSupportRoot() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("AAMP Menu Bar Tests")
            .appendingPathComponent(UUID().uuidString)
        let home = root.appendingPathComponent("home")
        let appSupport = root.appendingPathComponent("Application Support")

        let paths = AppPaths(homeDirectory: home, applicationSupportDirectory: appSupport)

        XCTAssertEqual(paths.appRoot, appSupport.appendingPathComponent("AAMP Menu Bar", isDirectory: true))
        XCTAssertEqual(paths.cachedLauncherRoot, paths.appRoot.appendingPathComponent("launcher/cached", isDirectory: true))
        XCTAssertEqual(paths.activeLauncherMetadata, paths.appRoot.appendingPathComponent("launcher/active.json"))
        XCTAssertEqual(paths.appRunRoot, paths.appRoot.appendingPathComponent("runs", isDirectory: true))
        XCTAssertEqual(paths.aampLogRoot, home.appendingPathComponent(".aamp/logs", isDirectory: true))
        XCTAssertEqual(paths.aampLogsBinary, home.appendingPathComponent(".aamp/bin/aamp-logs"))
    }
}
