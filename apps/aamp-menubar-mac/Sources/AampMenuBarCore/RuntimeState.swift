import Foundation

public enum RuntimeState: Equatable {
    case stopped
    case starting
    case running
    case error(String)

    public var menuTitle: String {
        switch self {
        case .stopped: return "AAMP: Stopped"
        case .starting: return "AAMP: Starting"
        case .running: return "AAMP: Running"
        case .error: return "AAMP: Error"
        }
    }
}

public struct ReadinessDetector {
    private let readinessMarkers = [
        "已接入飞书任务，可以开始对话 & 派发任务",
        "bridge.task_runtime.running",
        "[feishu] listener started",
        "[feishu ws] connected"
    ]

    public init() {}

    public mutating func observe(line: String) -> Bool {
        readinessMarkers.contains { line.contains($0) }
    }
}
