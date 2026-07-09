# AAMP macOS 菜单栏 App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可分发的 macOS 菜单栏 App，用原生 UI 启动、停止、诊断现有 AAMP Feishu Task one-click launcher。

**Architecture:** 新增 `apps/aamp-menubar-mac/` SwiftPM 工程，核心逻辑放在可测试的 `AampMenuBarCore` library target，AppKit 菜单栏和设置窗口放在 `AampMenuBarApp` executable target。App 启动经过验证的本地 bootstrap 脚本，优先使用用户确认过的缓存版本，缓存不可用时回退到随 App 打包的 `0.1.0-dev.138` 脚本。

**Tech Stack:** Swift 6、Swift Package Manager、AppKit `NSStatusItem`、Foundation `Process` / `URLSession` / `UserDefaults`、bash bootstrap、macOS `.app` bundle assembly script。

## Global Constraints

- App 工程路径固定为 `apps/aamp-menubar-mac/`。
- 第一版使用原生 Swift/AppKit，不引入 Electron、Tauri 或 Node GUI runtime。
- 内置兜底 launcher 版本固定为 `@zengxingyuan/aamp-feishu-task-agent@0.1.0-dev.138`。
- App 允许检查 npm 更新，但下载后的 launcher 必须经过用户确认才会成为 active cached script。
- 不允许把网络响应直接 pipe 到 `bash`。
- 默认开启 debug mode，对齐用户当前启动命令里的 `--debug`。
- 启动命令必须使用 `/bin/bash <validated-bootstrap-script> --agent <agent> --env <env> --aamp-host <host> [--boe-env-name <name>] [--debug]`。
- 启动超时固定为 180 秒。
- 停止时先向父 launcher 进程发送 `SIGTERM`，等待 15 秒后仅对父进程发送 `SIGKILL`。
- App 自有状态放在 `~/Library/Application Support/AAMP Menu Bar/`。
- 现有 AAMP runtime 状态仍归 `~/.aamp/`、`~/.aamp/logs/`、`~/.aamp/bin/aamp-logs` 和 `~/.aamp/feishu-bridge/` 管理。
- App 不保存 Feishu app secret、用户 auth token 或 mailbox token。
- App 不上传日志；诊断 bundle 只通过本地 `aamp-logs collect` 产生。
- 构建脚本必须在没有签名证书时产出 unsigned `.app`，并明确打印 unsigned 状态。

---

## File Structure

创建这些文件：

- `apps/aamp-menubar-mac/Package.swift`：SwiftPM package，包含 `AampMenuBarCore` library、`AampMenuBarApp` executable、`AampMenuBarCoreTests` test target。
- `apps/aamp-menubar-mac/Sources/AampMenuBarCore/AppPaths.swift`：集中计算 Application Support、cached launcher、app-side run log、AAMP log root 路径。
- `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherSettings.swift`：Agent、环境、debug、AAMP host 等设置模型。
- `apps/aamp-menubar-mac/Sources/AampMenuBarCore/SettingsStore.swift`：`UserDefaults` 读写。
- `apps/aamp-menubar-mac/Sources/AampMenuBarCore/RuntimeState.swift`：`Stopped`、`Starting`、`Running`、`Error` 状态和 readiness parser。
- `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherStore.swift`：bundled/cached launcher 选择、校验、激活。
- `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherUpdater.swift`：npm metadata 解析、版本选择、tarball 下载与 bootstrap 提取。
- `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherProcess.swift`：启动、停止、观察 bash launcher。
- `apps/aamp-menubar-mac/Sources/AampMenuBarCore/AampDiagnostics.swift`：打开日志目录、运行 `aamp-logs collect --latest`。
- `apps/aamp-menubar-mac/Sources/AampMenuBarApp/main.swift`：AppKit 入口。
- `apps/aamp-menubar-mac/Sources/AampMenuBarApp/AppDelegate.swift`：组装依赖，管理 App 生命周期。
- `apps/aamp-menubar-mac/Sources/AampMenuBarApp/MenuBarController.swift`：`NSStatusItem` 菜单和动作。
- `apps/aamp-menubar-mac/Sources/AampMenuBarApp/SettingsWindowController.swift`：设置窗口。
- `apps/aamp-menubar-mac/Sources/AampMenuBarApp/Resources/aamp-feishu-task-agent-bootstrap.sh`：从 npm tarball 提取的内置 bootstrap。
- `apps/aamp-menubar-mac/Packaging/Info.plist`：App bundle metadata，包含 `LSUIElement=true`。
- `apps/aamp-menubar-mac/scripts/build_app.sh`：构建 `.app`，可选签名、公证、`.dmg`。
- `apps/aamp-menubar-mac/README.md`：本地构建、运行、签名变量说明。
- `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/*.swift`：核心逻辑测试。

---

### Task 1: SwiftPM 工程骨架、设置模型和路径模型

**Files:**
- Create: `apps/aamp-menubar-mac/Package.swift`
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarCore/AppPaths.swift`
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherSettings.swift`
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarCore/SettingsStore.swift`
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarCore/RuntimeState.swift`
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarApp/main.swift`
- Create: `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/SettingsStoreTests.swift`
- Create: `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/AppPathsTests.swift`

**Interfaces:**
- Produces: `LauncherSettings`, `AgentKind`, `AampEnvironment`, `SettingsStore`, `AppPaths`, `RuntimeState`。
- Later tasks consume these exact types from `AampMenuBarCore`。

- [ ] **Step 1: Write failing tests for settings defaults and persistence**

Create `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/SettingsStoreTests.swift`:

```swift
import XCTest
import Foundation
@testable import AampMenuBarCore

final class SettingsStoreTests: XCTestCase {
    func testDefaultsMatchOneClickLauncher() throws {
        let suiteName = "SettingsStoreTests.defaults.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = SettingsStore(defaults: defaults)
        let settings = store.load()

        XCTAssertEqual(settings.agent, .codex)
        XCTAssertEqual(settings.environment, .online)
        XCTAssertEqual(settings.boeEnvironmentName, "boe_task_event")
        XCTAssertEqual(settings.aampHost.absoluteString, "https://meshmail.ai")
        XCTAssertTrue(settings.debugMode)
        XCTAssertEqual(settings.launcherVersion, "0.1.0-dev.138")
    }

    func testSaveAndLoadRoundTrip() throws {
        let suiteName = "SettingsStoreTests.roundtrip.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = SettingsStore(defaults: defaults)
        let original = LauncherSettings(
            agent: .codem,
            environment: .boe,
            boeEnvironmentName: "boe_custom",
            aampHost: URL(string: "https://example.com")!,
            debugMode: false,
            launcherVersion: "0.1.0-dev.139",
            checkForUpdatesOnLaunch: false,
            startAtLogin: true
        )

        store.save(original)

        XCTAssertEqual(store.load(), original)
    }
}
```

- [ ] **Step 2: Write failing tests for Application Support paths**

Create `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/AppPathsTests.swift`:

```swift
import XCTest
import Foundation
@testable import AampMenuBarCore

final class AppPathsTests: XCTestCase {
    func testPathsUseApplicationSupportRoot() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("AAMP Menu Bar Tests")
            .appendingPathComponent(UUID().uuidString)
        let home = root.appendingPathComponent("home")
        let appSupport = root.appendingPathComponent("Application Support")

        let paths = AppPaths(homeDirectory: home, applicationSupportDirectory: appSupport)

        XCTAssertEqual(paths.appRoot, appSupport.appendingPathComponent("AAMP Menu Bar", isDirectory: true))
        XCTAssertEqual(paths.cachedLauncherRoot, paths.appRoot.appendingPathComponent("launcher/cached", isDirectory: true))
        XCTAssertEqual(paths.activeLauncherMetadata, paths.appRoot.appendingPathComponent("launcher/active.json"))
        XCTAssertEqual(paths.appRunRoot, paths.appRoot.appendingPathComponent("runs", isDirectory: true))
        XCTAssertEqual(paths.aampLogRoot, home.appendingPathComponent(".aamp/logs", isDirectory: true))
        XCTAssertEqual(paths.aampLogsBinary, home.appendingPathComponent(".aamp/bin/aamp-logs"))
    }
}
```

- [ ] **Step 3: Run tests to confirm package does not exist yet**

Run:

```bash
cd apps/aamp-menubar-mac && swift test
```

Expected: command fails because `apps/aamp-menubar-mac/Package.swift` is not present.

- [ ] **Step 4: Add SwiftPM package and minimal executable entry**

Create `apps/aamp-menubar-mac/Package.swift`:

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AampMenuBar",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(name: "AampMenuBarCore", targets: ["AampMenuBarCore"]),
        .executable(name: "AampMenuBar", targets: ["AampMenuBarApp"])
    ],
    targets: [
        .target(name: "AampMenuBarCore"),
        .executableTarget(
            name: "AampMenuBarApp",
            dependencies: ["AampMenuBarCore"],
            resources: [
                .copy("Resources")
            ]
        ),
        .testTarget(
            name: "AampMenuBarCoreTests",
            dependencies: ["AampMenuBarCore"]
        )
    ]
)
```

Create `apps/aamp-menubar-mac/Sources/AampMenuBarApp/main.swift`:

```swift
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.run()
```

- [ ] **Step 5: Implement settings and path models**

Create `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherSettings.swift`:

```swift
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
```

Create `apps/aamp-menubar-mac/Sources/AampMenuBarCore/AppPaths.swift`:

```swift
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

    public var aampLatestLogSymlink: URL {
        aampLogRoot.appendingPathComponent("latest", isDirectory: true)
    }

    public var aampLogsBinary: URL {
        homeDirectory.appendingPathComponent(".aamp/bin/aamp-logs")
    }
}
```

Create `apps/aamp-menubar-mac/Sources/AampMenuBarCore/SettingsStore.swift`:

```swift
import Foundation

public final class SettingsStore {
    private enum Key {
        static let settings = "launcherSettings"
    }

    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> LauncherSettings {
        guard let data = defaults.data(forKey: Key.settings),
              let settings = try? decoder.decode(LauncherSettings.self, from: data)
        else {
            return .defaults
        }
        return settings
    }

    public func save(_ settings: LauncherSettings) {
        let data = try? encoder.encode(settings)
        defaults.set(data, forKey: Key.settings)
    }
}
```

Create `apps/aamp-menubar-mac/Sources/AampMenuBarCore/RuntimeState.swift`:

```swift
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
```

- [ ] **Step 6: Run tests and build**

Run:

```bash
cd apps/aamp-menubar-mac
swift test
swift build
```

Expected: both commands pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add apps/aamp-menubar-mac
git commit -m "feat: scaffold mac menu bar app"
```

---

### Task 2: Bundled launcher resource and LauncherStore

**Files:**
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherStore.swift`
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarApp/Resources/aamp-feishu-task-agent-bootstrap.sh`
- Create: `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/LauncherStoreTests.swift`

**Interfaces:**
- Consumes: `AppPaths`, `LauncherSettings.bundledLauncherVersion`。
- Produces: `LauncherScript`, `LauncherScriptSource`, `LauncherStore.activeScript()`, `LauncherStore.installCachedScript(version:data:)`, `LauncherStore.activateCachedVersion(_:)`。

- [ ] **Step 1: Write failing LauncherStore tests**

Create `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/LauncherStoreTests.swift`:

```swift
import XCTest
import Foundation
@testable import AampMenuBarCore

final class LauncherStoreTests: XCTestCase {
    func testActiveScriptUsesBundledScriptWhenNoCacheExists() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)

        let script = try store.activeScript()

        XCTAssertEqual(script.version, LauncherSettings.bundledLauncherVersion)
        XCTAssertEqual(script.source, .bundled)
        XCTAssertEqual(script.url, fixture.bundledScript)
    }

    func testInstallingAndActivatingCachedScriptWinsOverBundledScript() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)
        let data = Data("#!/usr/bin/env bash\nset -euo pipefail\nprintf 'cached\\n'\n".utf8)

        let installed = try store.installCachedScript(version: "0.1.0-dev.139", data: data)
        try store.activateCachedVersion("0.1.0-dev.139")

        let active = try store.activeScript()
        XCTAssertEqual(installed.source, .cached)
        XCTAssertEqual(active.version, "0.1.0-dev.139")
        XCTAssertEqual(active.source, .cached)
        XCTAssertTrue(FileManager.default.fileExists(atPath: active.url.path))
    }

    func testInvalidCachedScriptFallsBackToBundledScript() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)
        let versionRoot = fixture.paths.cachedLauncherRoot.appendingPathComponent("bad", isDirectory: true)
        try FileManager.default.createDirectory(at: versionRoot, withIntermediateDirectories: true)
        try Data("not a shell script".utf8).write(to: versionRoot.appendingPathComponent("aamp-feishu-task-agent-bootstrap.sh"))
        try Data("{\"version\":\"bad\"}".utf8).write(to: fixture.paths.activeLauncherMetadata)

        let active = try store.activeScript()

        XCTAssertEqual(active.source, .bundled)
        XCTAssertEqual(active.version, LauncherSettings.bundledLauncherVersion)
    }

    func testRejectsEmptyScriptInstall() throws {
        let fixture = try makeFixture()
        let store = LauncherStore(paths: fixture.paths, bundledScriptURL: fixture.bundledScript)

        XCTAssertThrowsError(try store.installCachedScript(version: "0.1.0-dev.139", data: Data()))
    }

    private func makeFixture() throws -> (paths: AppPaths, bundledScript: URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("LauncherStoreTests")
            .appendingPathComponent(UUID().uuidString)
        let home = root.appendingPathComponent("home")
        let appSupport = root.appendingPathComponent("Application Support")
        let paths = AppPaths(homeDirectory: home, applicationSupportDirectory: appSupport)
        let bundledScript = root.appendingPathComponent("bundled.sh")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("#!/usr/bin/env bash\nset -euo pipefail\nprintf 'bundled\\n'\n".utf8).write(to: bundledScript)
        return (paths, bundledScript)
    }
}
```

- [ ] **Step 2: Run tests to confirm failures**

Run:

```bash
cd apps/aamp-menubar-mac
swift test --filter LauncherStoreTests
```

Expected: FAIL because `LauncherStore` types do not exist.

- [ ] **Step 3: Add LauncherStore implementation**

Create `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherStore.swift`:

```swift
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

    public var errorDescription: String? {
        switch self {
        case .bundledScriptMissing(let url):
            return "Bundled launcher script is missing at \(url.path)"
        case .invalidScript:
            return "Launcher script did not pass validation"
        case .cachedVersionMissing(let version):
            return "Cached launcher version \(version) is missing"
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
        guard isValidScript(data: data) else {
            throw LauncherStoreError.invalidScript
        }
        let versionRoot = paths.cachedLauncherRoot.appendingPathComponent(version, isDirectory: true)
        try fileManager.createDirectory(at: versionRoot, withIntermediateDirectories: true)
        let scriptURL = versionRoot.appendingPathComponent("aamp-feishu-task-agent-bootstrap.sh")
        try data.write(to: scriptURL, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)
        return LauncherScript(version: version, url: scriptURL, source: .cached)
    }

    public func activateCachedVersion(_ version: String) throws {
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
        let scriptURL = paths.cachedLauncherRoot
            .appendingPathComponent(version, isDirectory: true)
            .appendingPathComponent("aamp-feishu-task-agent-bootstrap.sh")
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
              let prefix = String(data: data.prefix(256), encoding: .utf8)
        else {
            return false
        }
        return prefix.hasPrefix("#!/usr/bin/env bash")
            || prefix.hasPrefix("#!/bin/bash")
            || prefix.contains("set -euo pipefail")
    }
}
```

- [ ] **Step 4: Vendor the bundled bootstrap script**

Run this from the repository root to extract the fixed version:

```bash
mkdir -p apps/aamp-menubar-mac/Sources/AampMenuBarApp/Resources
curl -fsSL https://registry.npmjs.org/@zengxingyuan/aamp-feishu-task-agent/-/aamp-feishu-task-agent-0.1.0-dev.138.tgz \
  | tar -xzO package/bootstrap/aamp-feishu-task-agent-bootstrap.sh \
  > apps/aamp-menubar-mac/Sources/AampMenuBarApp/Resources/aamp-feishu-task-agent-bootstrap.sh
chmod +x apps/aamp-menubar-mac/Sources/AampMenuBarApp/Resources/aamp-feishu-task-agent-bootstrap.sh
```

Verify:

```bash
head -5 apps/aamp-menubar-mac/Sources/AampMenuBarApp/Resources/aamp-feishu-task-agent-bootstrap.sh
```

Expected: output starts with `#!/usr/bin/env bash` and `set -euo pipefail`.

- [ ] **Step 5: Run tests**

```bash
cd apps/aamp-menubar-mac
swift test --filter LauncherStoreTests
swift test
```

Expected: all tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/aamp-menubar-mac
git commit -m "feat: add mac launcher store"
```

---

### Task 3: LauncherUpdater for npm metadata and tarball extraction

**Files:**
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherUpdater.swift`
- Create: `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/LauncherUpdaterTests.swift`

**Interfaces:**
- Consumes: `LauncherStore.installCachedScript(version:data:)` from Task 2.
- Produces: `LauncherUpdater.newerVersion(from:currentVersion:)`, `LauncherUpdater.extractBootstrap(fromTarball:)`, `LauncherUpdater.downloadAndInstall(version:tarballURL:store:)`。

- [ ] **Step 1: Write failing updater tests**

Create `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/LauncherUpdaterTests.swift`:

```swift
import XCTest
import Foundation
@testable import AampMenuBarCore

final class LauncherUpdaterTests: XCTestCase {
    func testFindsNewerVersionFromNpmMetadata() throws {
        let metadata = Data("""
        {
          "versions": {
            "0.1.0-dev.138": { "dist": { "tarball": "https://example.com/138.tgz" } },
            "0.1.0-dev.139": { "dist": { "tarball": "https://example.com/139.tgz" } }
          }
        }
        """.utf8)

        let update = try LauncherUpdater.newerVersion(from: metadata, currentVersion: "0.1.0-dev.138")

        XCTAssertEqual(update?.version, "0.1.0-dev.139")
        XCTAssertEqual(update?.tarballURL.absoluteString, "https://example.com/139.tgz")
    }

    func testReturnsNilWhenCurrentVersionIsNewest() throws {
        let metadata = Data("""
        {
          "versions": {
            "0.1.0-dev.138": { "dist": { "tarball": "https://example.com/138.tgz" } }
          }
        }
        """.utf8)

        let update = try LauncherUpdater.newerVersion(from: metadata, currentVersion: "0.1.0-dev.138")

        XCTAssertNil(update)
    }

    func testExtractsBootstrapFromTarball() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("LauncherUpdaterTests")
            .appendingPathComponent(UUID().uuidString)
        let packageRoot = root.appendingPathComponent("package/bootstrap", isDirectory: true)
        try FileManager.default.createDirectory(at: packageRoot, withIntermediateDirectories: true)
        let script = packageRoot.appendingPathComponent("aamp-feishu-task-agent-bootstrap.sh")
        try Data("#!/usr/bin/env bash\nset -euo pipefail\nprintf 'ok\\n'\n".utf8).write(to: script)

        let tarball = root.appendingPathComponent("package.tgz")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-czf", tarball.path, "-C", root.path, "package"]
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)

        let data = try LauncherUpdater.extractBootstrap(fromTarball: tarball)

        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("set -euo pipefail"))
    }
}
```

- [ ] **Step 2: Run updater tests to confirm failures**

```bash
cd apps/aamp-menubar-mac
swift test --filter LauncherUpdaterTests
```

Expected: FAIL because `LauncherUpdater` does not exist.

- [ ] **Step 3: Implement LauncherUpdater**

Create `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherUpdater.swift`:

```swift
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
```

- [ ] **Step 4: Run updater tests and full test suite**

```bash
cd apps/aamp-menubar-mac
swift test --filter LauncherUpdaterTests
swift test
```

Expected: all tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/aamp-menubar-mac
git commit -m "feat: add mac launcher updater"
```

---

### Task 4: LauncherProcess, command builder, and readiness detection

**Files:**
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherProcess.swift`
- Modify: `apps/aamp-menubar-mac/Sources/AampMenuBarCore/RuntimeState.swift`
- Create: `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/LauncherProcessTests.swift`
- Create: `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/ReadinessDetectorTests.swift`

**Interfaces:**
- Consumes: `LauncherSettings`, `RuntimeState`, `AppPaths`。
- Produces: `LauncherCommandBuilder.arguments(for:)`, `ReadinessDetector.observe(line:)`, `LauncherProcess.start(script:settings:)`, `LauncherProcess.stop()`。

- [ ] **Step 1: Write command and readiness tests**

Create `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/ReadinessDetectorTests.swift`:

```swift
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
```

Create `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/LauncherProcessTests.swift`:

```swift
import XCTest
import Foundation
@testable import AampMenuBarCore

final class LauncherProcessTests: XCTestCase {
    func testCommandBuilderIncludesExpectedArguments() {
        let settings = LauncherSettings(
            agent: .codem,
            environment: .boe,
            boeEnvironmentName: "boe_custom",
            aampHost: URL(string: "https://meshmail.ai")!,
            debugMode: true,
            launcherVersion: "0.1.0-dev.138",
            checkForUpdatesOnLaunch: true,
            startAtLogin: false
        )

        let arguments = LauncherCommandBuilder.arguments(for: settings)

        XCTAssertEqual(arguments, [
            "--agent", "codem",
            "--env", "boe",
            "--aamp-host", "https://meshmail.ai",
            "--boe-env-name", "boe_custom",
            "--debug"
        ])
    }

    func testFakeBootstrapTransitionsToRunning() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        printf '🟢 codex 已接入飞书任务，可以开始对话 & 派发任务。\\n'
        sleep 30
        """)
        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let expectation = expectation(description: "running state")
        var observed: [RuntimeState] = []

        try process.start(script: fixture.script, settings: .defaults) { state in
            observed.append(state)
            if state == .running {
                expectation.fulfill()
            }
        }

        wait(for: [expectation], timeout: 5)
        process.stop()

        XCTAssertTrue(observed.contains(.starting))
        XCTAssertTrue(observed.contains(.running))
    }

    func testFakeBootstrapFailureTransitionsToError() throws {
        let fixture = try makeFixture(scriptBody: """
        #!/usr/bin/env bash
        set -euo pipefail
        printf 'boom\\n' >&2
        exit 3
        """)
        let process = LauncherProcess(paths: fixture.paths, startupTimeout: 5)
        let expectation = expectation(description: "error state")

        try process.start(script: fixture.script, settings: .defaults) { state in
            if case .error = state {
                expectation.fulfill()
            }
        }

        wait(for: [expectation], timeout: 5)
    }

    private func makeFixture(scriptBody: String) throws -> (paths: AppPaths, script: URL) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("LauncherProcessTests")
            .appendingPathComponent(UUID().uuidString)
        let home = root.appendingPathComponent("home")
        let appSupport = root.appendingPathComponent("Application Support")
        let paths = AppPaths(homeDirectory: home, applicationSupportDirectory: appSupport)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let script = root.appendingPathComponent("fake-bootstrap.sh")
        try Data(scriptBody.utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return (paths, script)
    }
}
```

- [ ] **Step 2: Run tests to confirm failures**

```bash
cd apps/aamp-menubar-mac
swift test --filter ReadinessDetectorTests
swift test --filter LauncherProcessTests
```

Expected: FAIL because `ReadinessDetector`, `LauncherCommandBuilder`, and `LauncherProcess` do not exist.

- [ ] **Step 3: Extend RuntimeState with readiness detector**

Modify `apps/aamp-menubar-mac/Sources/AampMenuBarCore/RuntimeState.swift` to include:

```swift
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
```

- [ ] **Step 4: Implement LauncherProcess**

Create `apps/aamp-menubar-mac/Sources/AampMenuBarCore/LauncherProcess.swift`:

```swift
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

public final class LauncherProcess {
    private let paths: AppPaths
    private let startupTimeout: TimeInterval
    private let fileManager: FileManager
    private var process: Process?
    private var detector = ReadinessDetector()
    private var stateHandler: ((RuntimeState) -> Void)?
    private var startupTimer: DispatchSourceTimer?
    private var isStopping = false
    private let queue = DispatchQueue(label: "aamp.menu-bar.launcher-process")

    public init(paths: AppPaths, startupTimeout: TimeInterval = 180, fileManager: FileManager = .default) {
        self.paths = paths
        self.startupTimeout = startupTimeout
        self.fileManager = fileManager
    }

    public var isRunning: Bool {
        process?.isRunning == true
    }

    public func start(script: URL, settings: LauncherSettings, onStateChange: @escaping (RuntimeState) -> Void) throws {
        guard process == nil || process?.isRunning == false else {
            throw LauncherProcessError.alreadyRunning
        }
        guard fileManager.fileExists(atPath: script.path) else {
            throw LauncherProcessError.scriptMissing(script)
        }

        stateHandler = onStateChange
        detector = ReadinessDetector()
        isStopping = false
        emit(.starting)

        let runDirectory = try createRunDirectory()
        let stdout = Pipe()
        let stderr = Pipe()
        let stdoutLog = runDirectory.appendingPathComponent("stdout.log")
        let stderrLog = runDirectory.appendingPathComponent("stderr.log")
        fileManager.createFile(atPath: stdoutLog.path, contents: nil)
        fileManager.createFile(atPath: stderrLog.path, contents: nil)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [script.path] + LauncherCommandBuilder.arguments(for: settings)
        process.standardOutput = stdout
        process.standardError = stderr
        process.terminationHandler = { [weak self] process in
            self?.queue.async {
                self?.startupTimer?.cancel()
                self?.startupTimer = nil
                if self?.isStopping == true || process.terminationStatus == 0 {
                    self?.emit(.stopped)
                } else {
                    self?.emit(.error("Launcher exited with status \(process.terminationStatus)"))
                }
                self?.isStopping = false
                self?.process = nil
            }
        }

        observe(pipe: stdout, logURL: stdoutLog)
        observe(pipe: stderr, logURL: stderrLog)
        try process.run()
        self.process = process
        startTimeout()
    }

    public func stop() {
        guard let process else {
            emit(.stopped)
            return
        }
        startupTimer?.cancel()
        startupTimer = nil
        if process.isRunning {
            isStopping = true
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 15) { [weak process] in
                guard let process, process.isRunning else {
                    return
                }
                kill(pid_t(process.processIdentifier), SIGKILL)
            }
        }
    }

    private func createRunDirectory() throws -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyyMMdd'T'HHmmss"
        let runID = "\(formatter.string(from: Date()))-\(ProcessInfo.processInfo.processIdentifier)"
        let directory = paths.appRunRoot.appendingPathComponent(runID, isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func observe(pipe: Pipe, logURL: URL) {
        let handle = pipe.fileHandleForReading
        handle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            if let output = String(data: data, encoding: .utf8) {
                self?.append(output, to: logURL)
                output.split(whereSeparator: { $0.isNewline }).map(String.init).forEach { line in
                    self?.queue.async {
                        if self?.detector.observe(line: line) == true {
                            self?.startupTimer?.cancel()
                            self?.startupTimer = nil
                            self?.emit(.running)
                        }
                    }
                }
            }
        }
    }

    private func append(_ text: String, to url: URL) {
        guard let data = text.data(using: .utf8),
              let handle = try? FileHandle(forWritingTo: url)
        else {
            return
        }
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    }

    private func startTimeout() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + startupTimeout)
        timer.setEventHandler { [weak self] in
            self?.emit(.error("Launcher did not become ready within \(Int(self?.startupTimeout ?? 0)) seconds"))
        }
        startupTimer = timer
        timer.resume()
    }

    private func emit(_ state: RuntimeState) {
        DispatchQueue.main.async { [stateHandler] in
            stateHandler?(state)
        }
    }
}
```

- [ ] **Step 5: Run process tests and full suite**

```bash
cd apps/aamp-menubar-mac
swift test --filter ReadinessDetectorTests
swift test --filter LauncherProcessTests
swift test
```

Expected: all tests pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add apps/aamp-menubar-mac
git commit -m "feat: run mac launcher process"
```

---

### Task 5: Diagnostics helpers

**Files:**
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarCore/AampDiagnostics.swift`
- Create: `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/AampDiagnosticsTests.swift`

**Interfaces:**
- Consumes: `AppPaths.aampLatestLogSymlink`, `AppPaths.aampLogsBinary`。
- Produces: `AampDiagnostics.latestLogsURL()`, `AampDiagnostics.collectLatestLogs()`。

- [ ] **Step 1: Write failing diagnostics tests**

Create `apps/aamp-menubar-mac/Tests/AampMenuBarCoreTests/AampDiagnosticsTests.swift`:

```swift
import XCTest
import Foundation
@testable import AampMenuBarCore

final class AampDiagnosticsTests: XCTestCase {
    func testLatestLogsURLReturnsSymlinkWhenPresent() throws {
        let fixture = try makeFixture()
        let latest = fixture.paths.aampLatestLogSymlink
        try FileManager.default.createDirectory(at: latest, withIntermediateDirectories: true)

        let diagnostics = AampDiagnostics(paths: fixture.paths)

        XCTAssertEqual(diagnostics.latestLogsURL(), latest)
    }

    func testCollectLatestLogsParsesCreatedArchivePath() throws {
        let fixture = try makeFixture()
        let bin = fixture.paths.aampLogsBinary
        try FileManager.default.createDirectory(at: bin.deletingLastPathComponent(), withIntermediateDirectories: true)
        let archive = fixture.root.appendingPathComponent("bundle.tar.gz")
        try Data("""
        #!/usr/bin/env bash
        printf 'Created local logs bundle:\\n\(archive.path)\\n'
        """.utf8).write(to: bin)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bin.path)

        let diagnostics = AampDiagnostics(paths: fixture.paths)
        let result = try diagnostics.collectLatestLogs()

        XCTAssertEqual(result, archive)
    }

    private func makeFixture() throws -> (root: URL, paths: AppPaths) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("AampDiagnosticsTests")
            .appendingPathComponent(UUID().uuidString)
        let home = root.appendingPathComponent("home")
        let appSupport = root.appendingPathComponent("Application Support")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        return (root, AppPaths(homeDirectory: home, applicationSupportDirectory: appSupport))
    }
}
```

- [ ] **Step 2: Run diagnostics tests to confirm failures**

```bash
cd apps/aamp-menubar-mac
swift test --filter AampDiagnosticsTests
```

Expected: FAIL because `AampDiagnostics` does not exist.

- [ ] **Step 3: Implement diagnostics helper**

Create `apps/aamp-menubar-mac/Sources/AampMenuBarCore/AampDiagnostics.swift`:

```swift
import Foundation

public enum AampDiagnosticsError: Error, LocalizedError {
    case logsMissing
    case logsBinaryMissing(URL)
    case collectFailed(String)
    case archivePathMissing(String)

    public var errorDescription: String? {
        switch self {
        case .logsMissing:
            return "AAMP latest log directory does not exist"
        case .logsBinaryMissing(let url):
            return "aamp-logs command is missing at \(url.path)"
        case .collectFailed(let output):
            return "aamp-logs collect failed: \(output)"
        case .archivePathMissing(let output):
            return "aamp-logs output did not include an archive path: \(output)"
        }
    }
}

public final class AampDiagnostics {
    private let paths: AppPaths
    private let fileManager: FileManager

    public init(paths: AppPaths, fileManager: FileManager = .default) {
        self.paths = paths
        self.fileManager = fileManager
    }

    public func latestLogsURL() -> URL? {
        fileManager.fileExists(atPath: paths.aampLatestLogSymlink.path) ? paths.aampLatestLogSymlink : nil
    }

    public func collectLatestLogs() throws -> URL {
        guard fileManager.fileExists(atPath: paths.aampLogsBinary.path) else {
            throw AampDiagnosticsError.logsBinaryMissing(paths.aampLogsBinary)
        }

        let process = Process()
        let stdout = Pipe()
        let stderr = Pipe()
        process.executableURL = paths.aampLogsBinary
        process.arguments = ["collect", "--latest"]
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()
        process.waitUntilExit()

        let output = String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let errorOutput = String(decoding: stderr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        if process.terminationStatus != 0 {
            throw AampDiagnosticsError.collectFailed(output + errorOutput)
        }

        guard let archiveLine = output
            .split(whereSeparator: { $0.isNewline })
            .map(String.init)
            .last(where: { $0.hasSuffix(".tar.gz") })
        else {
            throw AampDiagnosticsError.archivePathMissing(output)
        }
        return URL(fileURLWithPath: archiveLine)
    }
}
```

- [ ] **Step 4: Run diagnostics tests and full suite**

```bash
cd apps/aamp-menubar-mac
swift test --filter AampDiagnosticsTests
swift test
```

Expected: all tests pass.

- [ ] **Step 5: Commit Task 5**

```bash
git add apps/aamp-menubar-mac
git commit -m "feat: add mac diagnostics helpers"
```

---

### Task 6: AppKit menu bar and settings window

**Files:**
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarApp/AppDelegate.swift`
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarApp/MenuBarController.swift`
- Create: `apps/aamp-menubar-mac/Sources/AampMenuBarApp/SettingsWindowController.swift`
- Modify: `apps/aamp-menubar-mac/Sources/AampMenuBarApp/main.swift`

**Interfaces:**
- Consumes: `SettingsStore`, `LauncherStore`, `LauncherUpdater`, `LauncherProcess`, `AampDiagnostics`。
- Produces: a working menu bar app with Start, Stop, Restart, Open Logs, Collect Latest Logs, Settings, Check for Launcher Update, Quit。

- [ ] **Step 1: Replace App entry with delegate wiring**

Modify `apps/aamp-menubar-mac/Sources/AampMenuBarApp/main.swift`:

```swift
import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
```

- [ ] **Step 2: Add AppDelegate dependency assembly**

Create `apps/aamp-menubar-mac/Sources/AampMenuBarApp/AppDelegate.swift`:

```swift
import AppKit
import AampMenuBarCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var menuBarController: MenuBarController?
    private var settingsWindowController: SettingsWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let paths = AppPaths()
        let settingsStore = SettingsStore()
        let bundledScript = Bundle.main.url(forResource: "aamp-feishu-task-agent-bootstrap", withExtension: "sh")
            ?? Bundle.main.resourceURL!.appendingPathComponent("aamp-feishu-task-agent-bootstrap.sh")
        let launcherStore = LauncherStore(paths: paths, bundledScriptURL: bundledScript)
        let launcherUpdater = LauncherUpdater()
        let launcherProcess = LauncherProcess(paths: paths)
        let diagnostics = AampDiagnostics(paths: paths)

        let settingsController = SettingsWindowController(settingsStore: settingsStore)
        self.settingsWindowController = settingsController

        let menu = MenuBarController(
            settingsStore: settingsStore,
            launcherStore: launcherStore,
            launcherUpdater: launcherUpdater,
            launcherProcess: launcherProcess,
            diagnostics: diagnostics,
            showSettings: { [weak settingsController] in
                settingsController?.showWindow(nil)
                NSApp.activate(ignoringOtherApps: true)
            }
        )
        menuBarController = menu
    }

    func applicationWillTerminate(_ notification: Notification) {
        menuBarController?.stopBeforeQuit()
    }
}
```

- [ ] **Step 3: Add MenuBarController**

Create `apps/aamp-menubar-mac/Sources/AampMenuBarApp/MenuBarController.swift`:

```swift
import AppKit
import AampMenuBarCore

final class MenuBarController: NSObject {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let settingsStore: SettingsStore
    private let launcherStore: LauncherStore
    private let launcherUpdater: LauncherUpdater
    private let launcherProcess: LauncherProcess
    private let diagnostics: AampDiagnostics
    private let showSettings: () -> Void
    private var state: RuntimeState = .stopped {
        didSet { rebuildMenu() }
    }

    init(
        settingsStore: SettingsStore,
        launcherStore: LauncherStore,
        launcherUpdater: LauncherUpdater,
        launcherProcess: LauncherProcess,
        diagnostics: AampDiagnostics,
        showSettings: @escaping () -> Void
    ) {
        self.settingsStore = settingsStore
        self.launcherStore = launcherStore
        self.launcherUpdater = launcherUpdater
        self.launcherProcess = launcherProcess
        self.diagnostics = diagnostics
        self.showSettings = showSettings
        super.init()
        statusItem.button?.title = "AAMP"
        rebuildMenu()
    }

    func stopBeforeQuit() {
        launcherProcess.stop()
    }

    private func rebuildMenu() {
        statusItem.button?.title = title(for: state)
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: state.menuTitle, action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(item("Start", #selector(start), enabled: canStart))
        menu.addItem(item("Stop", #selector(stop), enabled: canStop))
        menu.addItem(item("Restart", #selector(restart), enabled: canRestart))
        menu.addItem(.separator())
        menu.addItem(item("Open Logs", #selector(openLogs), enabled: diagnostics.latestLogsURL() != nil))
        menu.addItem(item("Collect Latest Logs", #selector(collectLatestLogs), enabled: true))
        menu.addItem(.separator())
        menu.addItem(item("Settings...", #selector(openSettings), enabled: true))
        menu.addItem(item("Check for Launcher Update", #selector(checkForUpdate), enabled: true))
        menu.addItem(.separator())
        menu.addItem(item("Quit", #selector(quit), enabled: true))
        statusItem.menu = menu
    }

    private var canStart: Bool {
        switch state {
        case .stopped, .error:
            return true
        case .starting, .running:
            return false
        }
    }

    private var canStop: Bool {
        switch state {
        case .starting, .running:
            return true
        case .stopped, .error:
            return false
        }
    }

    private var canRestart: Bool {
        switch state {
        case .running, .error:
            return true
        case .stopped, .starting:
            return false
        }
    }

    private func item(_ title: String, _ action: Selector, enabled: Bool) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.isEnabled = enabled
        return item
    }

    private func title(for state: RuntimeState) -> String {
        switch state {
        case .stopped: return "AAMP"
        case .starting: return "AAMP..."
        case .running: return "AAMP On"
        case .error: return "AAMP !"
        }
    }

    @objc private func start() {
        do {
            let script = try launcherStore.activeScript()
            try launcherProcess.start(script: script.url, settings: settingsStore.load()) { [weak self] state in
                self?.state = state
            }
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    @objc private func stop() {
        launcherProcess.stop()
        state = .stopped
    }

    @objc private func restart() {
        launcherProcess.stop()
        state = .stopped
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.start()
        }
    }

    @objc private func openLogs() {
        guard let url = diagnostics.latestLogsURL() else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func collectLatestLogs() {
        do {
            let archive = try diagnostics.collectLatestLogs()
            NSWorkspace.shared.activateFileViewerSelecting([archive])
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    @objc private func openSettings() {
        showSettings()
    }

    @objc private func checkForUpdate() {
        Task { [weak self] in
            await self?.checkForUpdateAsync()
        }
    }

    @MainActor
    private func checkForUpdateAsync() async {
        do {
            let current = settingsStore.load()
            let metadata = try await launcherUpdater.fetchMetadata()
            guard let update = try LauncherUpdater.newerVersion(from: metadata, currentVersion: current.launcherVersion) else {
                showInfo(title: "Launcher is up to date", message: "Current version: \(current.launcherVersion)")
                return
            }
            guard confirmUpdate(update) else {
                return
            }
            let installed = try await launcherUpdater.downloadAndInstall(
                version: update.version,
                tarballURL: update.tarballURL,
                store: launcherStore
            )
            try launcherStore.activateCachedVersion(installed.version)
            var settings = settingsStore.load()
            settings.launcherVersion = installed.version
            settingsStore.save(settings)
            showInfo(title: "Launcher updated", message: "Active launcher version: \(installed.version)")
        } catch {
            state = .error(error.localizedDescription)
        }
    }

    private func confirmUpdate(_ update: LauncherUpdate) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Use launcher \(update.version)?"
        alert.informativeText = "The app will download this npm package, extract the bootstrap script, validate it, and cache it locally before activating it."
        alert.addButton(withTitle: "Download and Use")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func showInfo(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }

    @objc private func quit() {
        launcherProcess.stop()
        NSApp.terminate(nil)
    }
}
```

- [ ] **Step 4: Add SettingsWindowController**

Create `apps/aamp-menubar-mac/Sources/AampMenuBarApp/SettingsWindowController.swift`:

```swift
import AppKit
import AampMenuBarCore

final class SettingsWindowController: NSWindowController {
    private let settingsStore: SettingsStore
    private let agentPopup = NSPopUpButton()
    private let environmentPopup = NSPopUpButton()
    private let boeField = NSTextField()
    private let hostField = NSTextField()
    private let debugCheckbox = NSButton(checkboxWithTitle: "Debug mode", target: nil, action: nil)

    init(settingsStore: SettingsStore) {
        self.settingsStore = settingsStore
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 260),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "AAMP Settings"
        super.init(window: window)
        buildUI()
        loadSettings()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func buildUI() {
        let content = NSStackView()
        content.orientation = .vertical
        content.spacing = 12
        content.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        content.translatesAutoresizingMaskIntoConstraints = false

        AgentKind.allCases.forEach { agentPopup.addItem(withTitle: $0.rawValue) }
        AampEnvironment.allCases.forEach { environmentPopup.addItem(withTitle: $0.rawValue) }
        boeField.placeholderString = "boe_task_event"
        hostField.placeholderString = "https://meshmail.ai"

        content.addArrangedSubview(row("Agent", agentPopup))
        content.addArrangedSubview(row("Environment", environmentPopup))
        content.addArrangedSubview(row("BOE env", boeField))
        content.addArrangedSubview(row("AAMP host", hostField))
        content.addArrangedSubview(debugCheckbox)

        let saveButton = NSButton(title: "Save", target: self, action: #selector(save))
        content.addArrangedSubview(saveButton)

        window?.contentView = NSView()
        window?.contentView?.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: window!.contentView!.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: window!.contentView!.trailingAnchor),
            content.topAnchor.constraint(equalTo: window!.contentView!.topAnchor),
            content.bottomAnchor.constraint(equalTo: window!.contentView!.bottomAnchor)
        ])
    }

    private func row(_ label: String, _ control: NSView) -> NSView {
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 12
        let text = NSTextField(labelWithString: label)
        text.widthAnchor.constraint(equalToConstant: 110).isActive = true
        control.widthAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        stack.addArrangedSubview(text)
        stack.addArrangedSubview(control)
        return stack
    }

    private func loadSettings() {
        let settings = settingsStore.load()
        agentPopup.selectItem(withTitle: settings.agent.rawValue)
        environmentPopup.selectItem(withTitle: settings.environment.rawValue)
        boeField.stringValue = settings.boeEnvironmentName
        hostField.stringValue = settings.aampHost.absoluteString
        debugCheckbox.state = settings.debugMode ? .on : .off
    }

    @objc private func save() {
        let agent = AgentKind(rawValue: agentPopup.titleOfSelectedItem ?? "") ?? .codex
        let environment = AampEnvironment(rawValue: environmentPopup.titleOfSelectedItem ?? "") ?? .online
        let host = URL(string: hostField.stringValue).flatMap { $0.scheme == nil ? nil : $0 } ?? LauncherSettings.defaults.aampHost
        let current = settingsStore.load()
        settingsStore.save(LauncherSettings(
            agent: agent,
            environment: environment,
            boeEnvironmentName: boeField.stringValue.isEmpty ? "boe_task_event" : boeField.stringValue,
            aampHost: host,
            debugMode: debugCheckbox.state == .on,
            launcherVersion: current.launcherVersion,
            checkForUpdatesOnLaunch: current.checkForUpdatesOnLaunch,
            startAtLogin: current.startAtLogin
        ))
        window?.close()
    }
}
```

- [ ] **Step 5: Build app target**

```bash
cd apps/aamp-menubar-mac
swift build
```

Expected: PASS.

- [ ] **Step 6: Fix compile issues from AppKit wiring**

Apply these expected corrections if Swift reports them:

```swift
private var canRestart: Bool {
    switch state {
    case .running, .error:
        return true
    case .stopped, .starting:
        return false
    }
}
```

Use `menu.addItem(item("Restart", #selector(restart), enabled: canRestart))` in `MenuBarController`.

- [ ] **Step 7: Run full test and build**

```bash
cd apps/aamp-menubar-mac
swift test
swift build
```

Expected: all tests pass and app target builds.

- [ ] **Step 8: Commit Task 6**

```bash
git add apps/aamp-menubar-mac
git commit -m "feat: add mac menu bar UI"
```

---

### Task 7: Packaging, unsigned app build, and signing hooks

**Files:**
- Create: `apps/aamp-menubar-mac/Packaging/Info.plist`
- Create: `apps/aamp-menubar-mac/scripts/build_app.sh`
- Create: `apps/aamp-menubar-mac/README.md`

**Interfaces:**
- Consumes: SwiftPM executable product `AampMenuBar` and resource script from earlier tasks.
- Produces: `apps/aamp-menubar-mac/dist/AAMP Menu Bar.app` and optional `dist/AAMP Menu Bar.dmg`。

- [ ] **Step 1: Add Info.plist**

Create `apps/aamp-menubar-mac/Packaging/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>AAMP Menu Bar</string>
  <key>CFBundleIdentifier</key>
  <string>ai.meshmail.aamp-menubar</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>AAMP Menu Bar</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
```

- [ ] **Step 2: Add build script**

Create `apps/aamp-menubar-mac/scripts/build_app.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DIST="$ROOT/dist"
APP="$DIST/AAMP Menu Bar.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
BINARY="$ROOT/.build/release/AampMenuBar"

mkdir -p "$DIST"
rm -rf "$APP"

swift build --package-path "$ROOT" -c release

mkdir -p "$MACOS" "$RESOURCES"
cp "$BINARY" "$MACOS/AAMP Menu Bar"
cp "$ROOT/Packaging/Info.plist" "$CONTENTS/Info.plist"
cp "$ROOT/Sources/AampMenuBarApp/Resources/aamp-feishu-task-agent-bootstrap.sh" "$RESOURCES/aamp-feishu-task-agent-bootstrap.sh"
chmod +x "$MACOS/AAMP Menu Bar" "$RESOURCES/aamp-feishu-task-agent-bootstrap.sh"

if [ -n "${APPLE_DEVELOPER_ID_APPLICATION:-}" ]; then
  echo "Signing app with Developer ID: $APPLE_DEVELOPER_ID_APPLICATION"
  codesign --force --deep --options runtime --sign "$APPLE_DEVELOPER_ID_APPLICATION" "$APP"
else
  echo "Built unsigned app: $APP"
  echo "Set APPLE_DEVELOPER_ID_APPLICATION to enable Developer ID signing."
fi

if command -v hdiutil >/dev/null 2>&1; then
  DMG="$DIST/AAMP Menu Bar.dmg"
  rm -f "$DMG"
  hdiutil create -volname "AAMP Menu Bar" -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null
  echo "Built dmg: $DMG"
fi

if [ -n "${APPLE_NOTARYTOOL_PROFILE:-}" ]; then
  echo "Submitting dmg for notarization with keychain profile: $APPLE_NOTARYTOOL_PROFILE"
  xcrun notarytool submit "$DIST/AAMP Menu Bar.dmg" --keychain-profile "$APPLE_NOTARYTOOL_PROFILE" --wait
  xcrun stapler staple "$DIST/AAMP Menu Bar.dmg"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  echo "Submitting dmg for notarization with APPLE_ID and APPLE_TEAM_ID"
  xcrun notarytool submit "$DIST/AAMP Menu Bar.dmg" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --wait
  xcrun stapler staple "$DIST/AAMP Menu Bar.dmg"
else
  echo "Notarization skipped. Set APPLE_NOTARYTOOL_PROFILE or APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_SPECIFIC_PASSWORD."
fi
```

Run:

```bash
chmod +x apps/aamp-menubar-mac/scripts/build_app.sh
```

- [ ] **Step 3: Add README**

Create `apps/aamp-menubar-mac/README.md`:

```markdown
# AAMP Menu Bar for macOS

Native macOS menu bar wrapper for the AAMP Feishu Task one-click launcher.

## Build

```bash
cd apps/aamp-menubar-mac
swift test
./scripts/build_app.sh
```

The unsigned app is written to:

```text
apps/aamp-menubar-mac/dist/AAMP Menu Bar.app
```

The script also creates:

```text
apps/aamp-menubar-mac/dist/AAMP Menu Bar.dmg
```

## Signing

Set `APPLE_DEVELOPER_ID_APPLICATION` to sign the app:

```bash
APPLE_DEVELOPER_ID_APPLICATION="Developer ID Application: Example, Inc. (TEAMID)" \
  ./scripts/build_app.sh
```

## Notarization

Use a notarytool keychain profile:

```bash
APPLE_DEVELOPER_ID_APPLICATION="Developer ID Application: Example, Inc. (TEAMID)" \
APPLE_NOTARYTOOL_PROFILE="notary-profile" \
  ./scripts/build_app.sh
```

Or provide Apple ID credentials through environment variables:

```bash
APPLE_DEVELOPER_ID_APPLICATION="Developer ID Application: Example, Inc. (TEAMID)" \
APPLE_ID="developer@example.com" \
APPLE_TEAM_ID="TEAMID" \
APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
  ./scripts/build_app.sh
```

Without signing credentials, the script still builds an unsigned internal app.
```

- [ ] **Step 4: Validate packaging script syntax**

```bash
bash -n apps/aamp-menubar-mac/scripts/build_app.sh
```

Expected: PASS with no output.

- [ ] **Step 5: Build unsigned app**

```bash
apps/aamp-menubar-mac/scripts/build_app.sh
```

Expected:

- prints `Built unsigned app: .../dist/AAMP Menu Bar.app`
- creates `apps/aamp-menubar-mac/dist/AAMP Menu Bar.app`
- creates `apps/aamp-menubar-mac/dist/AAMP Menu Bar.dmg` when `hdiutil` is available

- [ ] **Step 6: Verify bundle contents**

```bash
test -x "apps/aamp-menubar-mac/dist/AAMP Menu Bar.app/Contents/MacOS/AAMP Menu Bar"
test -x "apps/aamp-menubar-mac/dist/AAMP Menu Bar.app/Contents/Resources/aamp-feishu-task-agent-bootstrap.sh"
/usr/libexec/PlistBuddy -c 'Print :LSUIElement' "apps/aamp-menubar-mac/dist/AAMP Menu Bar.app/Contents/Info.plist"
```

Expected: the first two commands exit 0; the final command prints `true`.

- [ ] **Step 7: Commit Task 7**

```bash
git add apps/aamp-menubar-mac
git commit -m "build: package mac menu bar app"
```

---

### Task 8: End-to-end verification and docs wiring

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Consumes: built `.app` and `apps/aamp-menubar-mac/README.md`。
- Produces: top-level docs pointing users at the macOS menu bar app。

- [ ] **Step 1: Add top-level README mention**

In `README.md`, add a short subsection under the quick-run area:

```markdown
### macOS menu bar launcher

An internal native macOS menu bar wrapper lives at
[`apps/aamp-menubar-mac`](./apps/aamp-menubar-mac). It ships with a bundled
`@zengxingyuan/aamp-feishu-task-agent@0.1.0-dev.138` bootstrap script, can use
confirmed cached launcher updates, and keeps AAMP runtime logs under
`~/.aamp/logs`.
```

- [ ] **Step 2: Add Chinese README mention**

In `README.zh-CN.md`, add the matching subsection:

```markdown
### macOS 菜单栏启动器

内部原生 macOS 菜单栏封装位于
[`apps/aamp-menubar-mac`](./apps/aamp-menubar-mac)。它内置
`@zengxingyuan/aamp-feishu-task-agent@0.1.0-dev.138` bootstrap 脚本，
也可以使用用户确认后的缓存 launcher 更新；AAMP runtime 日志仍写入
`~/.aamp/logs`。
```

- [ ] **Step 3: Run all targeted verification**

```bash
cd apps/aamp-menubar-mac
swift test
swift build
./scripts/build_app.sh
```

Expected: tests pass, build succeeds, unsigned `.app` is produced.

- [ ] **Step 4: Manually launch internal app**

Run:

```bash
open "apps/aamp-menubar-mac/dist/AAMP Menu Bar.app"
```

Expected:

- menu bar shows `AAMP`
- Settings opens
- Start begins the one-click launcher using the bundled or active cached script
- Open Logs becomes available after `~/.aamp/logs/latest` exists
- Stop terminates the app-managed launcher process

- [ ] **Step 5: Commit Task 8**

```bash
git add README.md README.zh-CN.md
git commit -m "docs: mention mac menu bar launcher"
```

---

## Self-Review

- Spec coverage: Task 1 covers native SwiftPM structure and preferences. Task 2 covers bundled `0.1.0-dev.138` launcher and cached fallback. Task 3 covers npm update metadata and tarball extraction without piping network output into bash. Task 4 covers process lifecycle, 180 second startup timeout, readiness markers, and stop semantics. Task 5 covers local diagnostics. Task 6 covers menu bar and settings UI. Task 7 covers unsigned app, optional signing, optional notarization, `.dmg`, and `LSUIElement`. Task 8 covers repository docs.
- Scope check: the plan stays within the first internal distributable App. Full log viewer, automatic update prompt polish, and production release operations are not required for this first build.
- Placeholder scan: no unresolved requirement marker remains in this plan.
- Type consistency: `LauncherSettings`, `AppPaths`, `LauncherStore`, `LauncherUpdater`, `LauncherProcess`, `AampDiagnostics`, and `RuntimeState` are defined before downstream tasks consume them.
