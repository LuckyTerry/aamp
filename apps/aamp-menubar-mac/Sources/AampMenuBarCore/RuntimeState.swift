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
