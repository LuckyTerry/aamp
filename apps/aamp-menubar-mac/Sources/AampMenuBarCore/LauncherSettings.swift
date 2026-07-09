import Foundation

public enum AgentKind: String, CaseIterable, Codable, Equatable {
    case codex
    case cursor
    case claude
    case gemini
    case codem
}

public enum AampEnvironment: String, CaseIterable, Codable, Equatable {
    case online
    case pre
    case boe
}

public struct LauncherSettings: Codable, Equatable {
    public static let bundledLauncherVersion = "0.1.0-dev.138"

    public var agent: AgentKind
    public var environment: AampEnvironment
    public var boeEnvironmentName: String
    public var aampHost: URL
    public var debugMode: Bool
    public var launcherVersion: String
    public var checkForUpdatesOnLaunch: Bool
    public var startAtLogin: Bool

    public init(
        agent: AgentKind,
        environment: AampEnvironment,
        boeEnvironmentName: String,
        aampHost: URL,
        debugMode: Bool,
        launcherVersion: String,
        checkForUpdatesOnLaunch: Bool,
        startAtLogin: Bool
    ) {
        self.agent = agent
        self.environment = environment
        self.boeEnvironmentName = boeEnvironmentName
        self.aampHost = aampHost
        self.debugMode = debugMode
        self.launcherVersion = launcherVersion
        self.checkForUpdatesOnLaunch = checkForUpdatesOnLaunch
        self.startAtLogin = startAtLogin
    }

    public static var defaults: LauncherSettings {
        LauncherSettings(
            agent: .codex,
            environment: .online,
            boeEnvironmentName: "boe_task_event",
            aampHost: URL(string: "https://meshmail.ai")!,
            debugMode: true,
            launcherVersion: bundledLauncherVersion,
            checkForUpdatesOnLaunch: true,
            startAtLogin: false
        )
    }
}
