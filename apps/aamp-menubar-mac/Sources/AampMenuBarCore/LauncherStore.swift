import Foundation

public enum LauncherScriptSource: String, Codable, Equatable {
    case bundled
    case cached
}

public struct LauncherScript: Equatable {
    public let version: String
    public let url: URL
    public let source: LauncherScriptSource
}

public enum LauncherStoreError: Error, Equatable, LocalizedError {
    case bundledScriptMissing(URL)
    case invalidScript
    case cachedVersionMissing(String)
    case invalidCachedVersion(String)

    public var errorDescription: String? {
        switch self {
        case .bundledScriptMissing(let url):
            return "Bundled launcher script is missing at \(url.path)"
        case .invalidScript:
            return "Launcher script did not pass validation"
        case .cachedVersionMissing(let version):
            return "Cached launcher version \(version) is missing"
        case .invalidCachedVersion(let version):
            return "Cached launcher version \"\(version)\" is invalid"
        }
    }
}

public final class LauncherStore {
    private struct ActiveMetadata: Codable {
        let version: String
    }

    private let paths: AppPaths
    private let bundledScriptURL: URL
    private let fileManager: FileManager
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let maxValidationBytes = 1024
    private let scriptFileName = "aamp-feishu-task-agent-bootstrap.sh"
    private static let cachedLauncherVersionCharacterSet = {
        var set = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        set.insert(charactersIn: "._-")
        return set
    }()

    public init(paths: AppPaths, bundledScriptURL: URL, fileManager: FileManager = .default) {
        self.paths = paths
        self.bundledScriptURL = bundledScriptURL
        self.fileManager = fileManager
    }

    public func activeScript() throws -> LauncherScript {
        if let version = try? activeCachedVersion(),
           let cached = try? cachedScript(version: version),
           isValidScript(at: cached.url) {
            return cached
        }

        guard fileManager.fileExists(atPath: bundledScriptURL.path) else {
            throw LauncherStoreError.bundledScriptMissing(bundledScriptURL)
        }
        guard isValidScript(at: bundledScriptURL) else {
            throw LauncherStoreError.invalidScript
        }
        return LauncherScript(
            version: LauncherSettings.bundledLauncherVersion,
            url: bundledScriptURL,
            source: .bundled
        )
    }

    @discardableResult
    public func installCachedScript(version: String, data: Data) throws -> LauncherScript {
        try validateCachedVersion(version)
        guard isValidScript(data: data) else {
            throw LauncherStoreError.invalidScript
        }
        let versionRoot = paths.cachedLauncherRoot.appendingPathComponent(version, isDirectory: true)
        try fileManager.createDirectory(at: versionRoot, withIntermediateDirectories: true)
        let scriptURL = versionRoot.appendingPathComponent(scriptFileName)
        try data.write(to: scriptURL, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)
        return LauncherScript(version: version, url: scriptURL, source: .cached)
    }

    public func activateCachedVersion(_ version: String) throws {
        try validateCachedVersion(version)
        let script = try cachedScript(version: version)
        guard isValidScript(at: script.url) else {
            throw LauncherStoreError.invalidScript
        }
        try fileManager.createDirectory(at: paths.launcherRoot, withIntermediateDirectories: true)
        let data = try encoder.encode(ActiveMetadata(version: version))
        try data.write(to: paths.activeLauncherMetadata, options: .atomic)
    }

    private func activeCachedVersion() throws -> String? {
        guard fileManager.fileExists(atPath: paths.activeLauncherMetadata.path) else {
            return nil
        }
        let data = try Data(contentsOf: paths.activeLauncherMetadata)
        return try decoder.decode(ActiveMetadata.self, from: data).version
    }

    private func cachedScript(version: String) throws -> LauncherScript {
        try validateCachedVersion(version)
        let scriptURL = paths.cachedLauncherRoot
            .appendingPathComponent(version, isDirectory: true)
            .appendingPathComponent(scriptFileName)
        guard fileManager.fileExists(atPath: scriptURL.path) else {
            throw LauncherStoreError.cachedVersionMissing(version)
        }
        return LauncherScript(version: version, url: scriptURL, source: .cached)
    }

    private func isValidScript(at url: URL) -> Bool {
        guard let data = try? Data(contentsOf: url) else {
            return false
        }
        return isValidScript(data: data)
    }

    private func isValidScript(data: Data) -> Bool {
        guard !data.isEmpty,
              let _ = String(data: data, encoding: .utf8),
              let header = String(data: data.prefix(maxValidationBytes), encoding: .utf8)
        else {
            return false
        }
        guard header.hasPrefix("#!/usr/bin/env bash") || header.hasPrefix("#!/bin/bash") else {
            return false
        }
        return header.contains("set -euo pipefail")
    }

    private func validateCachedVersion(_ version: String) throws {
        guard isValidCachedVersion(version) else {
            throw LauncherStoreError.invalidCachedVersion(version)
        }
    }

    private func isValidCachedVersion(_ version: String) -> Bool {
        guard !version.isEmpty else {
            return false
        }
        guard version != "." && version != ".." else {
            return false
        }
        return version.unicodeScalars.allSatisfy { scalar in
            Self.cachedLauncherVersionCharacterSet.contains(scalar)
        }
    }
}
