import Darwin
import Foundation

public enum LauncherProcessError: Error, LocalizedError {
    case alreadyRunning
    case scriptMissing(URL)

    public var errorDescription: String? {
        switch self {
        case .alreadyRunning:
            return "Launcher process is already running"
        case .scriptMissing(let url):
            return "Launcher script is missing at \(url.path)"
        }
    }
}

public enum LauncherCommandBuilder {
    public static func arguments(for settings: LauncherSettings) -> [String] {
        var arguments = [
            "--agent", settings.agent.rawValue,
            "--env", settings.environment.rawValue,
            "--aamp-host", settings.aampHost.absoluteString
        ]

        if settings.environment == .boe {
            arguments.append(contentsOf: ["--boe-env-name", settings.boeEnvironmentName])
        }

        if settings.debugMode {
            arguments.append("--debug")
        }

        return arguments
    }
}

public final class LauncherProcess: @unchecked Sendable {
    private enum Stream {
        case stdout
        case stderr
    }

    private struct BridgeLogReadState {
        var offset: UInt64
        var buffer = Data()
    }

    private let paths: AppPaths
    private let startupTimeout: TimeInterval
    private let fileManager: FileManager
    private let queue = DispatchQueue(label: "aamp.menu-bar.launcher-process")

    private var process: Process?
    private var detector = ReadinessDetector()
    private var stateHandler: ((RuntimeState) -> Void)?
    private var startupTimer: DispatchSourceTimer?
    private var isStopping = false
    private var hasReportedRunning = false
    private var hasFailedStartup = false
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var stdoutLogURL: URL?
    private var stderrLogURL: URL?
    private var stdoutBuffer = Data()
    private var stderrBuffer = Data()
    private var bridgeLogTimer: DispatchSourceTimer?
    private var bridgeLogStates: [URL: BridgeLogReadState] = [:]
    private var bridgeLogCandidateCache: [URL] = []
    private var bridgeLogPollTicks = 0
    private let bridgeLogCandidateRefreshTickInterval = 8

    public init(paths: AppPaths, startupTimeout: TimeInterval = 180, fileManager: FileManager = .default) {
        self.paths = paths
        self.startupTimeout = startupTimeout
        self.fileManager = fileManager
    }

    public var isRunning: Bool {
        queue.sync {
            process?.isRunning == true
        }
    }

    public func start(
        script: URL,
        settings: LauncherSettings,
        onStateChange: @escaping (RuntimeState) -> Void
    ) throws {
        try queue.sync {
            guard process == nil || process?.isRunning == false else {
                throw LauncherProcessError.alreadyRunning
            }

            guard fileManager.fileExists(atPath: script.path) else {
                throw LauncherProcessError.scriptMissing(script)
            }

            let runDirectory = try createRunDirectory()
            let stdout = Pipe()
            let stderr = Pipe()
            let stdoutLog = runDirectory.appendingPathComponent("stdout.log")
            let stderrLog = runDirectory.appendingPathComponent("stderr.log")
            fileManager.createFile(atPath: stdoutLog.path, contents: nil)
            fileManager.createFile(atPath: stderrLog.path, contents: nil)

            let launchedProcess = Process()
            launchedProcess.executableURL = URL(fileURLWithPath: "/bin/bash")
            launchedProcess.arguments = [script.path] + LauncherCommandBuilder.arguments(for: settings)
            launchedProcess.standardOutput = stdout
            launchedProcess.standardError = stderr
            launchedProcess.terminationHandler = { [weak self, processQueue = queue] terminatedProcess in
                guard let owner = self else {
                    return
                }

                processQueue.async { [owner, terminatedProcess] in
                    owner.handleTermination(terminatedProcess)
                }
            }

            stateHandler = onStateChange
            detector = ReadinessDetector()
            isStopping = false
            hasReportedRunning = false
            hasFailedStartup = false
            stdoutPipe = stdout
            stderrPipe = stderr
            stdoutLogURL = stdoutLog
            stderrLogURL = stderrLog
            stdoutBuffer = Data()
            stderrBuffer = Data()
            bridgeLogStates = [:]
            bridgeLogCandidateCache = []
            bridgeLogPollTicks = 0
            process = launchedProcess

            observe(pipe: stdout, stream: .stdout)
            observe(pipe: stderr, stream: .stderr)

            emit(.starting)

            do {
                try launchedProcess.run()
            } catch {
                cleanupIO()
                process = nil
                stateHandler = nil
                throw error
            }

            startTimeout()
            startBridgeLogObservation()
        }
    }

    public func stop() {
        queue.async {
            self.stopLocked()
        }
    }

    private func stopLocked() {
        guard let process else {
            emit(.stopped)
            return
        }

        cancelStartupTimer()

        guard process.isRunning else {
            cleanupIO()
            self.process = nil
            isStopping = false
            emit(.stopped)
            return
        }

        isStopping = true
        let pid = pid_t(process.processIdentifier)
        kill(pid, SIGTERM)
        queue.asyncAfter(deadline: .now() + 15) { [weak self] in
            self?.forceKillIfNeeded(pid: pid)
        }
    }

    private func forceKillIfNeeded(pid: pid_t) {
        guard let process, process.isRunning else {
            return
        }

        guard pid_t(process.processIdentifier) == pid else {
            return
        }

        kill(pid, SIGKILL)
    }

    private func handleTermination(_ terminatedProcess: Process) {
        guard process === terminatedProcess else {
            return
        }

        cancelStartupTimer()
        flushBuffer(for: .stdout)
        flushBuffer(for: .stderr)
        cleanupIO()

        let didRequestStop = isStopping
        let didBecomeReady = hasReportedRunning
        let status = terminatedProcess.terminationStatus

        if didRequestStop {
            emit(.stopped)
            hasFailedStartup = false
        } else if status != 0 {
            hasFailedStartup = true
            emit(.error("Launcher exited with status \(status)"))
        } else if didBecomeReady {
            emit(.stopped)
            hasFailedStartup = false
        } else {
            hasFailedStartup = true
            emit(.error("Launcher exited before becoming ready with status \(status)"))
        }

        isStopping = false
        hasReportedRunning = false
        process = nil
    }

    private func createRunDirectory() throws -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd'T'HHmmss"
        let runID = "\(formatter.string(from: Date()))-\(ProcessInfo.processInfo.processIdentifier)"
        let directory = paths.appRunRoot.appendingPathComponent(runID, isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func observe(pipe: Pipe, stream: Stream) {
        let handle = pipe.fileHandleForReading
        handle.readabilityHandler = { [weak self] readableHandle in
            guard let owner = self else {
                readableHandle.readabilityHandler = nil
                return
            }

            let data = readableHandle.availableData
            if data.isEmpty {
                readableHandle.readabilityHandler = nil
            }

            owner.queue.async { [owner, data, stream] in
                owner.handleReadableData(data, for: stream)
            }
        }
    }

    private func handleReadableData(_ data: Data, for stream: Stream) {
        guard !data.isEmpty else {
            flushBuffer(for: stream)
            return
        }

        append(data, for: stream)
        accumulate(data, for: stream)
    }

    private func append(_ data: Data, for stream: Stream) {
        guard let logURL = logURL(for: stream) else {
            return
        }

        guard let handle = try? FileHandle(forWritingTo: logURL) else {
            return
        }

        handle.seekToEndOfFile()
        try? handle.write(contentsOf: data)
        try? handle.close()
    }

    private func accumulate(_ data: Data, for stream: Stream) {
        switch stream {
        case .stdout:
            stdoutBuffer.append(data)
            consumeBuffer(for: .stdout)
        case .stderr:
            stderrBuffer.append(data)
            consumeBuffer(for: .stderr)
        }
    }

    private func consumeBuffer(for stream: Stream) {
        switch stream {
        case .stdout:
            consumeLines(from: &stdoutBuffer)
        case .stderr:
            consumeLines(from: &stderrBuffer)
        }
    }

    private func flushBuffer(for stream: Stream) {
        switch stream {
        case .stdout:
            flushLineBuffer(&stdoutBuffer)
        case .stderr:
            flushLineBuffer(&stderrBuffer)
        }
    }

    private func consumeLines(from buffer: inout Data) {
        while let newlineIndex = buffer.firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
            let newlineByte = buffer[newlineIndex]
            let lineData = Data(buffer[..<newlineIndex])
            let removeEnd = buffer.index(after: newlineIndex)
            buffer.removeSubrange(buffer.startIndex..<removeEnd)
            if newlineByte == 0x0D, buffer.first == 0x0A {
                buffer.removeFirst()
            }
            observeLine(String(decoding: lineData, as: UTF8.self))
        }
    }

    private func flushLineBuffer(_ buffer: inout Data) {
        guard !buffer.isEmpty else {
            return
        }

        let lineData = buffer
        buffer.removeAll(keepingCapacity: true)
        observeLine(String(decoding: lineData, as: UTF8.self))
    }

    private func observeLine(_ line: String) {
        guard process != nil, !isStopping, !hasReportedRunning, !hasFailedStartup else {
            return
        }

        if detector.observe(line: line) {
            hasReportedRunning = true
            cancelStartupTimer()
            cancelBridgeLogObservation()
            emit(.running)
        }
    }

    private func startTimeout() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + startupTimeout)
        timer.setEventHandler { [weak self] in
            self?.handleStartupTimeout()
        }
        startupTimer = timer
        timer.resume()
    }

    private func handleStartupTimeout() {
        startupTimer = nil
        guard hasReportedRunning == false, process?.isRunning == true else {
            return
        }

        hasFailedStartup = true
        cancelBridgeLogObservation()
        emit(.error("Launcher did not become ready within \(Int(startupTimeout)) seconds"))
    }

    private func cancelStartupTimer() {
        startupTimer?.cancel()
        startupTimer = nil
    }

    private func cleanupIO() {
        cancelBridgeLogObservation()
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        stdoutPipe = nil
        stderrPipe = nil
        stdoutLogURL = nil
        stderrLogURL = nil
        stdoutBuffer = Data()
        stderrBuffer = Data()
        bridgeLogStates = [:]
        bridgeLogCandidateCache = []
        bridgeLogPollTicks = 0
    }

    private func startBridgeLogObservation() {
        refreshBridgeLogCandidates(snapshotExistingContent: true)

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self] in
            self?.pollBridgeLog()
        }
        bridgeLogTimer = timer
        timer.resume()
    }

    private func cancelBridgeLogObservation() {
        bridgeLogTimer?.cancel()
        bridgeLogTimer = nil
    }

    private func pollBridgeLog() {
        guard process != nil, !isStopping, !hasReportedRunning, !hasFailedStartup else {
            return
        }

        bridgeLogPollTicks += 1
        if bridgeLogPollTicks >= bridgeLogCandidateRefreshTickInterval {
            bridgeLogPollTicks = 0
            refreshBridgeLogCandidates(snapshotExistingContent: false)
        }

        for url in bridgeLogCandidateCache {
            guard process != nil, !isStopping, !hasReportedRunning, !hasFailedStartup else {
                return
            }
            pollBridgeLog(at: url)
        }
    }

    private func pollBridgeLog(at url: URL) {
        guard fileManager.isReadableFile(atPath: url.path),
              let fileSize = sizeOfFile(at: url) else {
            return
        }

        var state = bridgeLogStates[url] ?? BridgeLogReadState(offset: 0)

        if state.offset > fileSize {
            state = BridgeLogReadState(offset: 0)
        }

        let offset = state.offset
        guard offset < fileSize else {
            bridgeLogStates[url] = state
            return
        }

        guard let handle = try? FileHandle(forReadingFrom: url) else {
            bridgeLogStates[url] = state
            return
        }

        defer { try? handle.close() }

        do {
            try handle.seek(toOffset: offset)
            guard let data = try handle.readToEnd(), !data.isEmpty else {
                return
            }
            state.offset = offset + UInt64(data.count)
            bridgeLogStates[url] = state
            handleBridgeLogData(data, from: url)
        } catch {
            bridgeLogStates[url] = state
            return
        }
    }

    private func handleBridgeLogData(_ data: Data, from url: URL) {
        var state = bridgeLogStates[url] ?? BridgeLogReadState(offset: 0)
        state.buffer.append(data)
        consumeLines(from: &state.buffer)
        if !state.buffer.isEmpty {
            observeLine(String(decoding: state.buffer, as: UTF8.self))
        }
        bridgeLogStates[url] = state
    }

    private func refreshBridgeLogCandidates(snapshotExistingContent: Bool) {
        let candidates = bridgeLogCandidates()
        bridgeLogCandidateCache = candidates

        for url in candidates where bridgeLogStates[url] == nil {
            let offset = snapshotExistingContent ? (sizeOfFile(at: url) ?? 0) : 0
            bridgeLogStates[url] = BridgeLogReadState(offset: offset)
        }
    }

    private func bridgeLogCandidates() -> [URL] {
        var seen = Set<URL>()
        var urls: [URL] = []

        func appendCandidate(_ url: URL) {
            guard seen.insert(url).inserted else {
                return
            }
            urls.append(url)
        }

        func appendCandidates(_ candidates: [URL]) {
            for url in candidates {
                appendCandidate(url)
            }
        }

        appendCandidate(paths.aampLatestLogSymlink.appendingPathComponent("feishu-bridge.jsonl"))
        appendCandidates(contentsOfBridgeLogs(in: paths.aampFeishuBridgeRoot))

        return urls
    }

    private func contentsOfBridgeLogs(in root: URL) -> [URL] {
        guard let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsPackageDescendants]
        ) else {
            return []
        }

        var urls: [URL] = []

        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey])
            guard values?.isRegularFile == true else {
                continue
            }

            let name = url.lastPathComponent.lowercased()
            guard name == "feishu-bridge.jsonl" || name.hasSuffix(".log") || name.hasSuffix(".jsonl") else {
                continue
            }

            urls.append(url)
        }

        return urls
    }

    private func sizeOfFile(at url: URL) -> UInt64? {
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber else {
            return nil
        }

        return size.uint64Value
    }

    private func logURL(for stream: Stream) -> URL? {
        switch stream {
        case .stdout:
            return stdoutLogURL
        case .stderr:
            return stderrLogURL
        }
    }

    private func emit(_ state: RuntimeState) {
        let handler = stateHandler
        let workItem = DispatchWorkItem {
            handler?(state)
        }
        DispatchQueue.main.async(execute: workItem)
    }
}
