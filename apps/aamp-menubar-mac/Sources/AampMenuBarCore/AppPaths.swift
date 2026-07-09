import Foundation

public struct AppPaths: Equatable {
    public let homeDirectory: URL
    public let applicationSupportDirectory: URL

    public init(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        applicationSupportDirectory: URL? = nil
    ) {
        self.homeDirectory = homeDirectory
        if let applicationSupportDirectory {
            self.applicationSupportDirectory = applicationSupportDirectory
        } else {
            self.applicationSupportDirectory = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first ?? homeDirectory.appendingPathComponent("Library/Application Support", isDirectory: true)
        }
    }

    public var appRoot: URL {
        applicationSupportDirectory.appendingPathComponent("AAMP Menu Bar", isDirectory: true)
    }

    public var launcherRoot: URL {
        appRoot.appendingPathComponent("launcher", isDirectory: true)
    }

    public var cachedLauncherRoot: URL {
        launcherRoot.appendingPathComponent("cached", isDirectory: true)
    }

    public var activeLauncherMetadata: URL {
        launcherRoot.appendingPathComponent("active.json")
    }

    public var appRunRoot: URL {
        appRoot.appendingPathComponent("runs", isDirectory: true)
    }

    public var aampLogRoot: URL {
        homeDirectory.appendingPathComponent(".aamp/logs", isDirectory: true)
    }

    public var aampFeishuBridgeRoot: URL {
        homeDirectory.appendingPathComponent(".aamp/feishu-bridge", isDirectory: true)
    }

    public var aampLatestLogSymlink: URL {
        aampLogRoot.appendingPathComponent("latest", isDirectory: true)
    }

    public var aampLogsBinary: URL {
        homeDirectory.appendingPathComponent(".aamp/bin/aamp-logs")
    }
}
