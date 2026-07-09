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
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var stdoutLogURL: URL?
    private var stderrLogURL: URL?
    private var stdoutBuffer = ""
    private var stderrBuffer = ""

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
            stdoutPipe = stdout
            stderrPipe = stderr
            stdoutLogURL = stdoutLog
            stderrLogURL = stderrLog
            stdoutBuffer = ""
            stderrBuffer = ""
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
        cancelStartupTimer()
        flushBuffer(for: .stdout)
        flushBuffer(for: .stderr)
        cleanupIO()

        let shouldEmitStopped = isStopping || terminatedProcess.terminationStatus == 0
        if shouldEmitStopped {
            emit(.stopped)
        } else {
            emit(.error("Launcher exited with status \(terminatedProcess.terminationStatus)"))
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

        guard let text = String(data: data, encoding: .utf8) else {
            return
        }

        append(text, for: stream)
        accumulate(text, for: stream)
    }

    private func append(_ text: String, for stream: Stream) {
        guard let logURL = logURL(for: stream), let data = text.data(using: .utf8) else {
            return
        }

        guard let handle = try? FileHandle(forWritingTo: logURL) else {
            return
        }

        handle.seekToEndOfFile()
        try? handle.write(contentsOf: data)
        try? handle.close()
    }

    private func accumulate(_ text: String, for stream: Stream) {
        switch stream {
        case .stdout:
            stdoutBuffer.append(text)
            consumeBuffer(for: .stdout)
        case .stderr:
            stderrBuffer.append(text)
            consumeBuffer(for: .stderr)
        }
    }

    private func consumeBuffer(for stream: Stream) {
        var buffer = self.buffer(for: stream)
        let newlineScalars = CharacterSet.newlines

        while let scalarIndex = buffer.unicodeScalars.firstIndex(where: { newlineScalars.contains($0) }) {
            let stringIndex = String.Index(scalarIndex, within: buffer) ?? buffer.endIndex
            let line = String(buffer[..<stringIndex])
            buffer.removeSubrange(..<buffer.index(after: stringIndex))
            observeLine(line)
        }

        setBuffer(buffer, for: stream)
    }

    private func flushBuffer(for stream: Stream) {
        let buffer = self.buffer(for: stream)
        guard !buffer.isEmpty else {
            return
        }

        setBuffer("", for: stream)
        observeLine(buffer)
    }

    private func observeLine(_ line: String) {
        guard !hasReportedRunning else {
            return
        }

        if detector.observe(line: line) {
            hasReportedRunning = true
            cancelStartupTimer()
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

        emit(.error("Launcher did not become ready within \(Int(startupTimeout)) seconds"))
    }

    private func cancelStartupTimer() {
        startupTimer?.cancel()
        startupTimer = nil
    }

    private func cleanupIO() {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        stdoutPipe = nil
        stderrPipe = nil
        stdoutLogURL = nil
        stderrLogURL = nil
        stdoutBuffer = ""
        stderrBuffer = ""
    }

    private func logURL(for stream: Stream) -> URL? {
        switch stream {
        case .stdout:
            return stdoutLogURL
        case .stderr:
            return stderrLogURL
        }
    }

    private func buffer(for stream: Stream) -> String {
        switch stream {
        case .stdout:
            return stdoutBuffer
        case .stderr:
            return stderrBuffer
        }
    }

    private func setBuffer(_ buffer: String, for stream: Stream) {
        switch stream {
        case .stdout:
            stdoutBuffer = buffer
        case .stderr:
            stderrBuffer = buffer
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
