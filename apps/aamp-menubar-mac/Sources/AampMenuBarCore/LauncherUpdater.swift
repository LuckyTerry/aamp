import Foundation

public struct LauncherUpdate: Equatable {
    public let version: String
    public let tarballURL: URL
}

public enum LauncherUpdaterError: Error, LocalizedError {
    case invalidMetadata
    case tarExtractionFailed(String)
    case emptyBootstrap

    public var errorDescription: String? {
        switch self {
        case .invalidMetadata:
            return "Could not parse npm package metadata"
        case .tarExtractionFailed(let output):
            return "Could not extract bootstrap script from tarball: \(output)"
        case .emptyBootstrap:
            return "Extracted bootstrap script was empty"
        }
    }
}

public final class LauncherUpdater {
    private struct NpmMetadata: Decodable {
        struct Version: Decodable {
            struct Dist: Decodable {
                let tarball: String
            }
            let dist: Dist
        }
        let versions: [String: Version]
    }

    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public static func newerVersion(from metadata: Data, currentVersion: String) throws -> LauncherUpdate? {
        let parsed = try JSONDecoder().decode(NpmMetadata.self, from: metadata)
        let newer = parsed.versions.keys
            .filter { compareVersions($0, currentVersion) == .orderedDescending }
            .sorted { compareVersions($0, $1) == .orderedDescending }
            .first
        guard let newer,
              let tarball = parsed.versions[newer]?.dist.tarball,
              let url = URL(string: tarball)
        else {
            return nil
        }
        return LauncherUpdate(version: newer, tarballURL: url)
    }

    public static func extractBootstrap(fromTarball tarball: URL) throws -> Data {
        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-xzO", "-f", tarball.path, "package/bootstrap/aamp-feishu-task-agent-bootstrap.sh"]
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()

        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        if process.terminationStatus != 0 {
            let errorOutput = String(decoding: stderr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            throw LauncherUpdaterError.tarExtractionFailed(errorOutput)
        }
        guard !data.isEmpty else {
            throw LauncherUpdaterError.emptyBootstrap
        }
        return data
    }

    public func fetchMetadata() async throws -> Data {
        let url = URL(string: "https://registry.npmjs.org/@zengxingyuan/aamp-feishu-task-agent")!
        let (data, _) = try await session.data(from: url)
        return data
    }

    public func downloadAndInstall(version: String, tarballURL: URL, store: LauncherStore) async throws -> LauncherScript {
        let (tarballData, _) = try await session.data(from: tarballURL)
        let tempRoot = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("AAMPMenuBarUpdater", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempRoot, withIntermediateDirectories: true)
        let tarball = tempRoot.appendingPathComponent("package.tgz")
        try tarballData.write(to: tarball, options: .atomic)
        let scriptData = try Self.extractBootstrap(fromTarball: tarball)
        return try store.installCachedScript(version: version, data: scriptData)
    }

    private static func compareVersions(_ left: String, _ right: String) -> ComparisonResult {
        let leftParts = tokenize(left)
        let rightParts = tokenize(right)
        for index in 0..<max(leftParts.count, rightParts.count) {
            let l = index < leftParts.count ? leftParts[index] : 0
            let r = index < rightParts.count ? rightParts[index] : 0
            if l < r { return .orderedAscending }
            if l > r { return .orderedDescending }
        }
        return .orderedSame
    }

    private static func tokenize(_ version: String) -> [Int] {
        version
            .split { character in
                !(character.isNumber)
            }
            .map { Int($0) ?? 0 }
    }
}
