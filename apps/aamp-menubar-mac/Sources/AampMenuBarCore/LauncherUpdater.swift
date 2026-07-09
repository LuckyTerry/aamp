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
    private struct SemVer: Comparable {
        struct PrereleaseIdentifier: Comparable, Equatable {
            enum Kind: Equatable {
                case numeric(Int)
                case alpha(String)
            }

            let kind: Kind

            static func < (lhs: PrereleaseIdentifier, rhs: PrereleaseIdentifier) -> Bool {
                switch (lhs.kind, rhs.kind) {
                case (.numeric(let left), .numeric(let right)):
                    return left < right
                case (.numeric, .alpha):
                    return true
                case (.alpha, .numeric):
                    return false
                case (.alpha(let left), .alpha(let right)):
                    return left < right
                }
            }
        }

        let major: Int
        let minor: Int
        let patch: Int
        let prerelease: [PrereleaseIdentifier]

        static func < (lhs: SemVer, rhs: SemVer) -> Bool {
            if lhs.major != rhs.major { return lhs.major < rhs.major }
            if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
            if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }

            switch (lhs.prerelease.isEmpty, rhs.prerelease.isEmpty) {
            case (true, true):
                return false
            case (true, false):
                return false
            case (false, true):
                return true
            case (false, false):
                for index in 0..<min(lhs.prerelease.count, rhs.prerelease.count) {
                    let left = lhs.prerelease[index]
                    let right = rhs.prerelease[index]
                    if left == right {
                        continue
                    }
                    return left < right
                }
                return lhs.prerelease.count < rhs.prerelease.count
            }
        }
    }

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
        let parsedCurrentVersion = try parseVersion(currentVersion)
        let parsedMetadata: NpmMetadata
        do {
            parsedMetadata = try JSONDecoder().decode(NpmMetadata.self, from: metadata)
        } catch {
            throw LauncherUpdaterError.invalidMetadata
        }

        var newest: (version: String, metadata: NpmMetadata.Version, parsed: SemVer)?
        for (version, versionMetadata) in parsedMetadata.versions {
            let parsedVersion = try parseVersion(version)
            guard parsedVersion > parsedCurrentVersion else {
                continue
            }
            if let newest, newest.parsed >= parsedVersion {
                continue
            }
            newest = (version: version, metadata: versionMetadata, parsed: parsedVersion)
        }

        guard let newest else {
            return nil
        }

        guard let tarballURL = validatedTarballURL(newest.metadata.dist.tarball) else {
            throw LauncherUpdaterError.invalidMetadata
        }
        return LauncherUpdate(version: newest.version, tarballURL: tarballURL)
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

    private static func parseVersion(_ version: String) throws -> SemVer {
        guard let parsed = parseVersionIfPossible(version) else {
            throw LauncherUpdaterError.invalidMetadata
        }
        return parsed
    }

    private static func parseVersionIfPossible(_ version: String) -> SemVer? {
        let coreAndBuild = version.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
        guard coreAndBuild.count == 1 || coreAndBuild.count == 2 else {
            return nil
        }
        if coreAndBuild.count == 2, parseIdentifierList(coreAndBuild[1]) == nil {
            return nil
        }

        let coreAndPrerelease = coreAndBuild[0].split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard coreAndPrerelease.count == 1 || coreAndPrerelease.count == 2 else {
            return nil
        }

        let coreComponents = coreAndPrerelease[0].split(separator: ".", omittingEmptySubsequences: false)
        guard coreComponents.count == 3,
              let major = parseNumericIdentifier(coreComponents[0]),
              let minor = parseNumericIdentifier(coreComponents[1]),
              let patch = parseNumericIdentifier(coreComponents[2]) else {
            return nil
        }

        let prerelease: [SemVer.PrereleaseIdentifier]
        if coreAndPrerelease.count == 2 {
            guard let identifiers = parsePrereleaseIdentifiers(coreAndPrerelease[1]) else {
                return nil
            }
            prerelease = identifiers
        } else {
            prerelease = []
        }

        return SemVer(major: major, minor: minor, patch: patch, prerelease: prerelease)
    }

    private static func parsePrereleaseIdentifiers(_ prerelease: Substring) -> [SemVer.PrereleaseIdentifier]? {
        guard let identifiers = parseIdentifierList(prerelease) else {
            return nil
        }

        var parsed: [SemVer.PrereleaseIdentifier] = []
        parsed.reserveCapacity(identifiers.count)
        for identifier in identifiers {
            guard !identifier.isEmpty else {
                return nil
            }
            if identifier.allSatisfy({ $0.isNumber }) {
                guard let value = Int(identifier) else {
                    return nil
                }
                parsed.append(.init(kind: .numeric(value)))
            } else {
                parsed.append(.init(kind: .alpha(String(identifier))))
            }
        }
        return parsed
    }

    private static func parseIdentifierList(_ value: Substring) -> [Substring]? {
        let identifiers = value.split(separator: ".", omittingEmptySubsequences: false)
        guard !identifiers.isEmpty else {
            return nil
        }
        for identifier in identifiers {
            guard !identifier.isEmpty, identifier.allSatisfy({ $0.isNumber || $0.isLetter || $0 == "-" }) else {
                return nil
            }
        }
        return identifiers
    }

    private static func parseNumericIdentifier(_ value: Substring) -> Int? {
        guard !value.isEmpty, value.allSatisfy({ $0.isNumber }) else {
            return nil
        }
        return Int(value)
    }

    private static func validatedTarballURL(_ string: String) -> URL? {
        guard let components = URLComponents(string: string),
              let scheme = components.scheme, !scheme.isEmpty,
              let host = components.host, !host.isEmpty,
              let url = components.url else {
            return nil
        }
        return url
    }
}
