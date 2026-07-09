import XCTest
import Foundation
@testable import AampMenuBarCore

final class ReadinessDetectorTests: XCTestCase {
    func testSuccessMessageMarksRuntimeReady() {
        var detector = ReadinessDetector()

        XCTAssertFalse(detector.observe(line: "[aamp-one-click] 正在启动 codex 本地桥接..."))
        XCTAssertTrue(detector.observe(line: "🟢 codex 已接入飞书任务，可以开始对话 & 派发任务。"))
    }

    func testBridgeMarkersMarkRuntimeReady() {
        var detector = ReadinessDetector()

        XCTAssertTrue(detector.observe(line: "{\"message\":\"bridge.task_runtime.running\"}"))
        XCTAssertTrue(detector.observe(line: "[feishu] listener started"))
        XCTAssertTrue(detector.observe(line: "[feishu ws] connected"))
    }
}
